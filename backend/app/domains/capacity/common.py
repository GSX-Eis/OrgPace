"""Acyclic leaf helpers shared across capacity domain modules."""

import re
from collections import defaultdict
from collections.abc import Iterator
from datetime import date
from uuid import UUID

from fastapi import HTTPException
from pydantic import JsonValue
from sqlmodel import Session, col, func, or_, select

from app.authz.policies import (
    can_manage_department,
    employee_scope_clause,
    manages_department,
)
from app.authz.principal import Principal
from app.domains.audit.service import record_audit
from app.domains.base import utc_now
from app.domains.capability.search import (
    PeopleSearchInput,
    PeopleSearchRow,
    find_people,
)
from app.domains.capacity.demand_schemas import DetailedCapacityReference
from app.domains.capacity.models import (
    CapacityDemand,
    CapacityInboxLink,
    CapacitySetting,
    CapacityWeek,
)
from app.domains.capacity.schemas import REASON_LABELS, ReasonCode, Via
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.inbox.service import add_item
from app.domains.org.models import (
    Department,
    Employee,
    EmploymentStatus,
    ExternalIdentity,
    OrgMembership,
    Role,
    RoleGrant,
)
from app.domains.org.service import department_ancestry, managed_scope
from app.domains.source.models import SourceConnection
from app.domains.work.models import Task
from app.i18n import tr
from app.models import User

WORKLOAD_REVIEW_NOTICE = "有负荷调整申请等你审批"
EXTENSION_REVIEW_NOTICE = "有延期申请等你审批"
LOAD_WORDS = (
    "超负荷",
    "基本满",
    "有余量",
    "饱和",
    "已满",
    "满负荷",
    "满员",
    "排满",
    "人手紧",
    "人手不足",
    "忙不过来",
    "空闲",
    "有空",
    "闲置",
    "余量",
)
DEMAND_NOT_FOUND = "未找到该需求，或你无权查看（仅发起人及双方部门经理可见）。"


class CapacityNotFound(HTTPException):
    def __init__(self, detail: str = "未找到该员工或申请") -> None:
        super().__init__(404, detail)


class CapacityForbidden(HTTPException):
    def __init__(self) -> None:
        super().__init__(403, "没有权限执行此操作")


class CapacityConflict(HTTPException):
    def __init__(self) -> None:
        super().__init__(409, "已有待处理申请或申请已处理")


class DemandReplyInvalid(HTTPException):
    def __init__(self) -> None:
        super().__init__(422, "回复将发送给对方部门，请勿填写本部门员工姓名")


class DemandReplyLoadInvalid(HTTPException):
    def __init__(self) -> None:
        super().__init__(
            422, "回复将发送给对方部门，请勿填写负荷描述，仅说明能否承接、时间及条件"
        )


class RejectionReasonInvalid(HTTPException):
    def __init__(self, message: str) -> None:
        super().__init__(422, message)


def require_enabled(principal: Principal, session: Session) -> None:
    row = session.exec(
        select(CapacitySetting)
        .where(CapacitySetting.org_id == principal.org_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    ).one_or_none()
    if row is None or not row.enabled:
        raise CapacityNotFound("规划与负荷功能未开启")


def require_rejection_reason(reason_code: ReasonCode | None, text: str | None) -> None:
    if reason_code is None:
        reasons = " / ".join(tr(label) for label in REASON_LABELS.values())
        raise RejectionReasonInvalid(tr("请选择原因类型（{reasons}）", reasons=reasons))
    if reason_code == "other" and not (text and text.strip()):
        raise RejectionReasonInvalid("选择「其他」时必须填写说明")


def department(session: Session, org_id: UUID, department_id: UUID) -> Department:
    row = session.exec(
        select(Department).where(
            Department.org_id == org_id, Department.id == department_id
        )
    ).one_or_none()
    if row is None:
        raise CapacityNotFound("未找到该部门")
    return row


def represents_department(principal: Principal, target_department_id: UUID) -> bool:
    return can_manage_department(principal, target_department_id)


def can_view_demand_internals(principal: Principal, row: CapacityDemand) -> bool:
    return principal.user_id != row.requester_user_id and represents_department(
        principal, row.target_department_id
    )


def responder_user_ids(
    session: Session,
    org_id: UUID,
    target_department_id: UUID,
    *,
    fallback_to_admin: bool = True,
) -> set[UUID]:
    return responders_by_department(
        session, org_id, {target_department_id}, fallback_to_admin=fallback_to_admin
    )[target_department_id]


def responders_by_department(
    session: Session,
    org_id: UUID,
    target_department_ids: set[UUID],
    *,
    fallback_to_admin: bool = True,
) -> dict[UUID, set[UUID]]:
    if not target_department_ids:
        return {}
    rows = session.exec(
        select(OrgMembership.user_id, RoleGrant.role, RoleGrant.department_id)
        .join(
            RoleGrant,
            (col(RoleGrant.org_id) == OrgMembership.org_id)
            & (col(RoleGrant.membership_id) == OrgMembership.id),
        )
        .join(User, col(User.id) == OrgMembership.user_id)
        .outerjoin(
            Employee,
            (col(Employee.org_id) == OrgMembership.org_id)
            & (col(Employee.id) == OrgMembership.employee_id),
        )
        .where(
            OrgMembership.org_id == org_id,
            User.is_active,
            or_(
                col(OrgMembership.employee_id).is_(None),
                Employee.employment_status == EmploymentStatus.ACTIVE,
            ),
        )
    ).all()
    admins: set[UUID] = set()
    managers: dict[UUID, set[UUID]] = defaultdict(set)
    for user_id, role, department_id in rows:
        if role == Role.DEPT_MANAGER and department_id is not None:
            managers[department_id].add(user_id)
        elif role == Role.ORG_ADMIN and fallback_to_admin:
            admins.add(user_id)
    departments = {
        row.id: row
        for row in session.exec(
            select(Department).where(Department.org_id == org_id)
        ).all()
    }
    if target_department_ids - departments.keys():
        raise CapacityNotFound("未找到该部门")
    return {
        target: next(
            (
                managers[ancestor]
                for ancestor in department_ancestry(departments, target)
                if ancestor in managers
            ),
            admins,
        ).copy()
        for target in target_department_ids
    }


def demand_row(
    principal: Principal, session: Session, demand_id: UUID, *, lock: bool = False
) -> CapacityDemand:
    require_enabled(principal, session)
    query = select(CapacityDemand).where(
        CapacityDemand.org_id == principal.org_id,
        CapacityDemand.id == demand_id,
    )
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    row = session.exec(query).one_or_none()
    if row is None or not (
        row.requester_user_id == principal.user_id
        or manages_department(principal, row.requesting_department_id)
        or represents_department(principal, row.target_department_id)
    ):
        raise CapacityNotFound(DEMAND_NOT_FOUND)
    return row


def _search_people(
    principal: Principal, session: Session, search: PeopleSearchInput
) -> Iterator[PeopleSearchRow]:
    while True:
        page = find_people(session, principal, search)
        yield from page.data
        skip = search.skip + len(page.data)
        if skip >= page.count or not page.data:
            return
        search = search.model_copy(update={"skip": skip})


def qualified_people(
    principal: Principal, session: Session, row: CapacityDemand, department_id: UUID
) -> dict[UUID, PeopleSearchRow]:
    search = PeopleSearchInput(
        department_id=department_id,
        capability_key=row.capability_key,
        minimum_level=row.minimum_level,
        limit=100,
    )
    people: dict[UUID, PeopleSearchRow] = {}
    for person in _search_people(principal, session, search):
        if person.level is not None:
            people.setdefault(person.employee_id, person)
    return people


def validate_department_text(
    principal: Principal, session: Session, target_department_id: UUID, text: str
) -> None:
    target_ids = managed_scope(
        session, principal.org_id, frozenset({target_department_id})
    )
    people = session.exec(
        select(Employee).where(
            employee_scope_clause(principal),
            col(Employee.department_id).in_(target_ids),
            Employee.employment_status == EmploymentStatus.ACTIVE,
        )
    ).all()
    if any(
        private and private in text
        for person in people
        for private in (person.display_name, person.employee_code, str(person.id))
    ):
        raise DemandReplyInvalid()


def validate_load_words(
    principal: Principal,
    session: Session,
    demand_row: CapacityDemand,
    text: str,
    reference: DetailedCapacityReference | None = None,
) -> None:
    checked_text = text.replace("已满足", "").replace("空调", "")
    if not (
        any(word in checked_text for word in LOAD_WORDS)
        or re.search(r"负荷[^。；，,;\n]{0,4}(尚未|未)确认", checked_text)
    ):
        return
    if reference is None:
        department(session, principal.org_id, demand_row.target_department_id)
        count = len(
            qualified_people(
                Principal.system_worker(principal.org_id),
                session,
                demand_row,
                demand_row.target_department_id,
            )
        )
    else:
        count = reference.count
    if count < 3:
        raise DemandReplyLoadInvalid()


def set_week(
    principal: Principal, session: Session, employee_id: UUID, percent: int, start: date
) -> int | None:
    if principal.user_id is None:
        raise CapacityForbidden()
    row = session.exec(
        select(CapacityWeek).where(
            CapacityWeek.org_id == principal.org_id,
            CapacityWeek.employee_id == employee_id,
            CapacityWeek.week_start == start,
        )
    ).one_or_none()
    before = row.other_percent if row else None
    if row is None:
        row = CapacityWeek(
            org_id=principal.org_id,
            employee_id=employee_id,
            week_start=start,
            other_percent=percent,
            confirmed_by_user_id=principal.user_id,
        )
    row.other_percent, row.confirmed_at, row.confirmed_by_user_id = (
        percent,
        utc_now(),
        principal.user_id,
    )
    session.add(row)
    session.flush()
    return before


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
