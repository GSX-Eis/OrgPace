"""Acyclic leaf helpers shared across capacity domain modules."""

from uuid import UUID

from fastapi import HTTPException
from pydantic import JsonValue
from sqlmodel import Session, col, func, select

from app.authz.principal import Principal
from app.domains.audit.service import record_audit
from app.domains.capacity.models import CapacityInboxLink
from app.domains.capacity.schemas import Via
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.inbox.service import add_item
from app.domains.org.models import (
    Employee,
    EmploymentStatus,
    ExternalIdentity,
    OrgMembership,
)
from app.domains.source.models import SourceConnection
from app.domains.work.models import Task
from app.i18n import tr
from app.models import User

WORKLOAD_REVIEW_NOTICE = "有负荷调整申请等你审批"
EXTENSION_REVIEW_NOTICE = "有延期申请等你审批"


class CapacityNotFound(HTTPException):
    def __init__(self, detail: str = "未找到该员工或申请") -> None:
        super().__init__(404, detail)


class CapacityForbidden(HTTPException):
    def __init__(self) -> None:
        super().__init__(403, "没有权限执行此操作")


class CapacityConflict(HTTPException):
    def __init__(self) -> None:
        super().__init__(409, "已有待处理申请或申请已处理")


def audit(
    principal: Principal,
    session: Session,
    action: str,
    target_type: str,
    target_id: UUID,
    via: Via,
    client_name: str | None,
    details: dict[str, JsonValue],
) -> None:
    record_audit(
        session,
        org_id=principal.org_id,
        actor_type=principal.actor_type,
        actor_id=str(principal.user_id),
        action=action,
        target_type=target_type,
        target_id=str(target_id),
        details={**details, "via": via, "client_name": client_name},
    )


def employee(
    principal: Principal,
    session: Session,
    employee_id: UUID | None,
    *,
    lock: bool = False,
) -> Employee:
    query = select(Employee).where(
        Employee.org_id == principal.org_id, Employee.id == employee_id
    )
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    row = session.exec(query).one_or_none()
    if row is None or row.employment_status != EmploymentStatus.ACTIVE:
        raise CapacityNotFound()
    return row


def user_names(session: Session, org_id: UUID, user_ids: set[UUID]) -> dict[UUID, str]:
    if not user_ids:
        return {}
    return {
        user_id: employee_name or full_name or tr("企业管理员")
        for user_id, employee_name, full_name in session.exec(
            select(OrgMembership.user_id, Employee.display_name, User.full_name)
            .join(User, col(User.id) == OrgMembership.user_id)
            .outerjoin(
                Employee,
                (col(Employee.org_id) == OrgMembership.org_id)
                & (col(Employee.id) == OrgMembership.employee_id),
            )
            .where(
                OrgMembership.org_id == org_id, col(OrgMembership.user_id).in_(user_ids)
            )
            .order_by(col(User.id))
        ).all()
    }


def record_capacity_inbox_link(
    session: Session,
    item: InboxItem,
    *,
    workload_request_id: UUID | None = None,
    extension_request_id: UUID | None = None,
) -> None:
    if workload_request_id is None and extension_request_id is None:
        return
    session.add(
        CapacityInboxLink(
            org_id=item.org_id,
            inbox_item_id=item.id,
            workload_request_id=workload_request_id,
            extension_request_id=extension_request_id,
        )
    )
    session.flush()


def notify_employee(
    principal: Principal,
    session: Session,
    employee_id: UUID,
    message: str,
    *,
    message_en: str | None = None,
    workload_request_id: UUID | None = None,
    extension_request_id: UUID | None = None,
) -> None:
    item = InboxItem(
        org_id=principal.org_id,
        recipient_employee_id=employee_id,
        kind=InboxKind.CAPACITY,
        message=message,
        message_en=message_en,
    )
    add_item(session, item)
    record_capacity_inbox_link(
        session,
        item,
        workload_request_id=workload_request_id,
        extension_request_id=extension_request_id,
    )


def open_jira_task_counts(
    session: Session, org_id: UUID, employee_ids: list[UUID]
) -> dict[UUID, int]:
    """Return open Jira task counts per employee (absent if Jira is not linked)."""
    if not employee_ids:
        return {}
    # shortcut: Unsynced or stale unresolved tasks still count; revisit when Jira sync freshness is exposed.
    jira_connected = session.exec(
        select(
            select(SourceConnection.id)
            .where(SourceConnection.org_id == org_id, SourceConnection.kind == "jira")
            .exists()
        )
    ).one()
    if not jira_connected:
        return {}
    rows = session.exec(
        select(ExternalIdentity.employee_id, func.count(func.distinct(Task.id)))
        .outerjoin(
            Task,
            (col(Task.org_id) == ExternalIdentity.org_id)
            & (col(Task.source) == ExternalIdentity.source)
            & col(Task.attributes)["resolved"].astext.is_(None)
            & col(Task.attributes).contains(
                func.jsonb_build_object(
                    "people",
                    func.jsonb_build_array(
                        func.jsonb_build_object(
                            "id", ExternalIdentity.external_id, "role", "assignee"
                        )
                    ),
                )
            ),
        )
        .where(
            ExternalIdentity.org_id == org_id,
            ExternalIdentity.source == "jira",
            col(ExternalIdentity.employee_id).in_(employee_ids),
        )
        .group_by(col(ExternalIdentity.employee_id))
    ).all()
    return {eid: count for eid, count in rows if eid is not None}
