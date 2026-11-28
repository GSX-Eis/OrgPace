from datetime import date, timedelta
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import Session, col, or_, select

from app.authz.principal import Principal
from app.domains.base import utc_now
from app.domains.capacity import calendar
from app.domains.capacity.common import (
    EXTENSION_REVIEW_NOTICE as EXTENSION_REVIEW_NOTICE,
)
from app.domains.capacity.common import (
    WORKLOAD_REVIEW_NOTICE as WORKLOAD_REVIEW_NOTICE,
)
from app.domains.capacity.common import (
    CapacityConflict,
    CapacityNotFound,
    audit,
    employee,
    notify_employee,
    record_capacity_inbox_link,
    user_names,
)
from app.domains.capacity.forecast import refresh_org_forecasts
from app.domains.capacity.models import (
    CapacityRequestStatus,
    CapacityWeek,
    CapacityWorkloadRequest,
)
from app.domains.capacity.schemas import (
    Via,
    WorkloadDecisionInput,
    WorkloadRequestInput,
    WorkloadRequestList,
    WorkloadRequestPublic,
)
from app.domains.capacity.settings import require_enabled
from app.domains.capacity.workload_views import (
    workload_reviewer_names,
    workload_reviewers,
)
from app.domains.capacity.workload_weeks import set_week
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.inbox.service import add_item
from app.domains.org.models import Employee, EmploymentStatus
from app.domains.review.routing import can_review, reviewable_employees, reviewers_for
from app.i18n import bilingual, tr, use_locale


class WorkloadWeekExpired(HTTPException):
    def __init__(self) -> None:
        super().__init__(422, "结束周不能早于本周")


def validate_request_week(end_week: date, current: date) -> None:
    if end_week < current:
        raise WorkloadWeekExpired()


def request_workload_change(
    principal: Principal,
    session: Session,
    requested_percent: int,
    reason: str,
    start_week: date,
    end_week: date,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> WorkloadRequestPublic:
    body = WorkloadRequestInput(
        requested_percent=requested_percent,
        reason=reason,
        start_week=start_week,
        end_week=end_week,
    )
    require_enabled(principal, session)
    subject = employee(principal, session, principal.employee_id, lock=True)
    validate_request_week(body.end_week, calendar.this_week(session, principal.org_id))
    pending = session.exec(
        select(CapacityWorkloadRequest.id).where(
            CapacityWorkloadRequest.org_id == principal.org_id,
            CapacityWorkloadRequest.employee_id == subject.id,
            CapacityWorkloadRequest.status == CapacityRequestStatus.PENDING,
        )
    ).first()
    if pending:
        raise CapacityConflict()
    row = CapacityWorkloadRequest(
        org_id=principal.org_id, employee_id=subject.id, **body.model_dump()
    )
    session.add(row)
    reviewers = workload_reviewers(principal, session, subject.id)
    primary_ids = set(reviewers_for(session, principal.org_id, subject.id))
    for user in reviewers:
        if user.id not in primary_ids:
            continue
        msg_zh, msg_en = bilingual(
            "有负荷调整申请等你审批（周次 {start} 至 {end}）。请前往「待审批 → 负荷与延期」处理。",
            start=body.start_week,
            end=body.end_week,
        )
        add_item(
            session,
            InboxItem(
                org_id=principal.org_id,
                recipient_user_id=user.id,
                kind=InboxKind.CAPACITY,
                message=msg_zh,
                message_en=msg_en,
            ),
        )
    base = session.exec(
        select(CapacityWeek.other_percent).where(
            CapacityWeek.org_id == principal.org_id,
            CapacityWeek.employee_id == subject.id,
            CapacityWeek.week_start == calendar.this_week(session, principal.org_id),
        )
    ).one_or_none()
    audit(
        principal,
        session,
        "capacity.workload_requested",
        "capacity_workload_request",
        row.id,
        via,
        client_name,
        {"before_percent": base, "after_percent": body.requested_percent},
    )
    result = WorkloadRequestPublic.model_validate(row)
    result.reviewer_names = workload_reviewer_names(principal, session, reviewers)
    return result


def list_workload_requests(
    principal: Principal, session: Session
) -> WorkloadRequestList:
    require_enabled(principal, session)
    query = (
        select(CapacityWorkloadRequest, Employee.display_name)
        .join(
            Employee,
            (col(Employee.org_id) == CapacityWorkloadRequest.org_id)
            & (col(Employee.id) == CapacityWorkloadRequest.employee_id),
        )
        .where(
            CapacityWorkloadRequest.org_id == principal.org_id,
            Employee.employment_status == EmploymentStatus.ACTIVE,
            or_(
                CapacityWorkloadRequest.status == CapacityRequestStatus.PENDING,
                CapacityWorkloadRequest.decided_by_user_id == principal.user_id,
                CapacityWorkloadRequest.decided_for_user_id == principal.user_id,
            ),
        )
        .order_by(
            col(CapacityWorkloadRequest.created_at).desc(),
            col(CapacityWorkloadRequest.id),
        )
    )
    rows = list(
        session.exec(
            query.where(CapacityWorkloadRequest.status == CapacityRequestStatus.PENDING)
        ).all()
    )
    rows.extend(
        session.exec(
            query.where(
                CapacityWorkloadRequest.status != CapacityRequestStatus.PENDING
            ).limit(100)
        ).all()
    )
    rows.sort(key=lambda r: (-r[0].created_at.timestamp(), r[0].id))
    reviewers = reviewable_employees(
        session, principal, {row.employee_id for row, _ in rows}
    )
    delegated = {
        reviewer
        for reviewer in reviewers.values()
        if reviewer is not None and reviewer != principal.user_id
    }
    reviewer_names = user_names(session, principal.org_id, delegated)
    data = [
        WorkloadRequestPublic(
            **row.model_dump(),
            employee_name=employee_name,
            on_behalf_of_name=reviewer_names.get(reviewer),
        )
        for row, employee_name in rows
        if (reviewer := reviewers.get(row.employee_id)) is not None
    ]
    return WorkloadRequestList(data=data, count=len(data))


def decide_workload_request(
    principal: Principal,
    session: Session,
    request_id: UUID,
    body: WorkloadDecisionInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> WorkloadRequestPublic:
    require_enabled(principal, session)
    row = session.exec(
        select(CapacityWorkloadRequest).where(
            CapacityWorkloadRequest.org_id == principal.org_id,
            CapacityWorkloadRequest.id == request_id,
        )
    ).one_or_none()
    if row is None:
        raise CapacityNotFound()
    subject_row = employee(principal, session, row.employee_id, lock=True)
    manager_id = can_review(session, principal, row.employee_id)
    if manager_id is None:
        raise CapacityNotFound()
    row = session.exec(
        select(CapacityWorkloadRequest)
        .where(
            CapacityWorkloadRequest.org_id == principal.org_id,
            CapacityWorkloadRequest.id == request_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one()
    if row.status != CapacityRequestStatus.PENDING:
        raise CapacityConflict()
    start = row.start_week or calendar.this_week(session, principal.org_id)
    end = row.end_week or start
    before = session.exec(
        select(CapacityWeek.other_percent).where(
            CapacityWeek.org_id == principal.org_id,
            CapacityWeek.employee_id == row.employee_id,
            CapacityWeek.week_start == start,
        )
    ).one_or_none()
    if body.approve:
        for offset in range((end - start).days // 7 + 1):
            set_week(
                principal,
                session,
                row.employee_id,
                row.requested_percent,
                start + timedelta(weeks=offset),
            )
        refresh_org_forecasts(session, principal.org_id, employee_ids=[row.employee_id])
    row.status = (
        CapacityRequestStatus.APPROVED
        if body.approve
        else CapacityRequestStatus.RETURNED
    )
    row.decided_by_user_id, row.decided_for_user_id = (
        principal.user_id,
        manager_id if manager_id != principal.user_id else None,
    )
    row.decided_at, row.decision_note = utc_now(), body.note
    session.add(row)
    audit(
        principal,
        session,
        "capacity.workload_request_approved"
        if body.approve
        else "capacity.workload_request_returned",
        "capacity_workload_request",
        row.id,
        via,
        client_name,
        {
            "before_percent": before,
            "after_percent": row.requested_percent if body.approve else before,
            **(
                {
                    "acting_for_user_id": str(row.decided_for_user_id),
                    "delegation_mode": "org_hierarchy",
                }
                if row.decided_for_user_id is not None
                else {}
            ),
        },
    )
    if row.start_week or body.approve:
        msg_zh, msg_en = bilingual(
            "负荷调整申请已同意（周次 {start} 至 {end}）。请前往「我的负荷」查看处理结果。"
            if body.approve
            else "负荷调整申请已退回（周次 {start} 至 {end}）。请前往「我的负荷」查看处理结果。",
            start=start,
            end=end,
        )
    else:
        msg_zh, msg_en = bilingual(
            "负荷调整申请已同意。请前往「我的负荷」查看处理结果。"
            if body.approve
            else "负荷调整申请已退回。请前往「我的负荷」查看处理结果。"
        )
    notify_employee(
        principal,
        session,
        row.employee_id,
        msg_zh,
        message_en=msg_en,
        workload_request_id=row.id,
    )
    if row.decided_for_user_id is not None:
        assert principal.user_id is not None
        with use_locale("zh-CN"):
            actor_zh = user_names(session, principal.org_id, {principal.user_id}).get(
                principal.user_id, "上级审批人"
            )
            msg_zh = tr(
                "员工 {subject} 的负荷调整申请（已同意）已由上级 {actor} 代为审批"
                if body.approve
                else "员工 {subject} 的负荷调整申请（已退回）已由上级 {actor} 代为审批",
                subject=subject_row.display_name,
                actor=actor_zh,
            )
        with use_locale("en"):
            actor_en = user_names(session, principal.org_id, {principal.user_id}).get(
                principal.user_id, tr("上级审批人")
            )
            msg_en = tr(
                "员工 {subject} 的负荷调整申请（已同意）已由上级 {actor} 代为审批"
                if body.approve
                else "员工 {subject} 的负荷调整申请（已退回）已由上级 {actor} 代为审批",
                subject=subject_row.display_name,
                actor=actor_en,
            )
        notice = InboxItem(
            org_id=principal.org_id,
            recipient_user_id=row.decided_for_user_id,
            kind=InboxKind.CAPACITY,
            message=msg_zh,
            message_en=msg_en,
        )
        add_item(session, notice)
        record_capacity_inbox_link(session, notice, workload_request_id=row.id)
    return WorkloadRequestPublic.model_validate(row)
