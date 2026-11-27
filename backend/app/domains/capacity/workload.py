from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy.engine import Row
from sqlalchemy.orm import Bundle
from sqlmodel import Session, case, col, func, or_, select

from app.authz.deps import get_org_principal
from app.authz.policies import can_view_employee, employee_scope_clause
from app.authz.principal import Principal
from app.domains.base import utc_now
from app.domains.capacity import calendar
from app.domains.capacity.forecast import open_jira_task_counts, refresh_org_forecasts
from app.domains.capacity.models import (
    AssignmentStatus,
    CapacityApproval,
    CapacityAssignment,
    CapacityCarryOver,
    CapacityCarryOverItem,
    CapacityDemand,
    CapacityProject,
    CapacityProposal,
    CapacityProposalLine,
    CapacityRequestStatus,
    CapacityUnavailability,
    CapacityWeek,
    CapacityWorkloadRequest,
    ProposalStatus,
)
from app.domains.capacity.schemas import (
    CarryOverBatchItemPublic,
    CarryOverBatchPublic,
    CarryOverCommitInput,
    CarryOverPlanItem,
    CarryOverPreview,
    CarryOverRevertPreview,
    LastConfirmed,
    MyWorkload,
    UnavailabilityInput,
    UnavailabilityList,
    UnavailabilityPublic,
    Via,
    WorkloadAssignmentSegment,
    WorkloadDecisionInput,
    WorkloadHoldSegment,
    WorkloadList,
    WorkloadPublic,
    WorkloadRequestInput,
    WorkloadRequestList,
    WorkloadRequestPublic,
    WorkloadUnavailabilitySegment,
    WorkloadWeeksInput,
)
from app.domains.capacity.settings import (
    CapacityConflict,
    CapacityForbidden,
    CapacityNotFound,
    audit,
    require_enabled,
)
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.inbox.service import add_item
from app.domains.org.models import (
    Department,
    Employee,
    EmploymentStatus,
    OrgMembership,
)
from app.domains.review.routing import (
    can_review,
    review_participants,
    reviewable_employees,
    reviewers_for,
)
from app.i18n import bilingual, tr, use_locale
from app.models import User

AVAILABLE_BELOW = 80
WORKLOAD_REVIEW_NOTICE = "有负荷调整申请等你审批"
EXTENSION_REVIEW_NOTICE = "有延期申请等你审批"


class WorkloadWeekExpired(HTTPException):
    def __init__(self) -> None:
        super().__init__(422, "结束周不能早于本周")


def validate_request_week(end_week: date, current: date) -> None:
    if end_week < current:
        raise WorkloadWeekExpired()


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


@dataclass
class WorkloadSegments:
    assignments: list[WorkloadAssignmentSegment] = field(default_factory=list)
    holds: list[WorkloadHoldSegment] = field(default_factory=list)
    unavailabilities: list[WorkloadUnavailabilitySegment] = field(default_factory=list)


def _can_view_borrow_segment(
    principal: Principal,
    subject: Employee,
    lender_department_id: UUID,
    requester_user_id: UUID,
    requesting_department_id: UUID,
    target_department_id: UUID,
) -> bool:
    managed = principal.managed_department_ids
    return subject.id == principal.employee_id or (
        lender_department_id in managed
        and subject.department_id in managed
        and principal.user_id != requester_user_id
        and requesting_department_id not in managed
        and target_department_id not in managed
    )


def workload_segments(
    session: Session,
    principal: Principal,
    employees_by_id: dict[UUID, Employee],
    start: date,
    end: date,
) -> dict[UUID, WorkloadSegments]:
    ids = list(employees_by_id)
    if not ids:
        return {}
    org_id = principal.org_id
    labels = (
        select(
            CapacityDemand.id,
            CapacityDemand.capability_name,
            col(Department.name).label("department_name"),
            case(
                (
                    col(CapacityProject.title).is_not(None),
                    col(CapacityProject.title) + " · " + col(CapacityDemand.role_name),
                ),
                else_=col(CapacityDemand.capability_name),
            ).label("title"),
        )
        .add_columns(
            col(CapacityDemand.requester_user_id),
            col(CapacityDemand.requesting_department_id),
            col(CapacityDemand.target_department_id),
        )
        .join(
            Department,
            (col(Department.org_id) == CapacityDemand.org_id)
            & (col(Department.id) == CapacityDemand.requesting_department_id),
        )
        .outerjoin(
            CapacityProject,
            (col(CapacityProject.org_id) == CapacityDemand.org_id)
            & (col(CapacityProject.id) == CapacityDemand.project_id),
        )
        .where(col(CapacityDemand.org_id) == org_id)
        .subquery()
    )
    label_columns: Bundle[Row[tuple[str, str, str, UUID, UUID, UUID]]] = Bundle(
        "demand_labels",
        labels.c.capability_name,
        labels.c.department_name,
        labels.c.title,
        labels.c.requester_user_id,
        labels.c.requesting_department_id,
        labels.c.target_department_id,
    )
    segments: dict[UUID, WorkloadSegments] = defaultdict(WorkloadSegments)
    assignments = session.exec(
        select(
            CapacityAssignment, CapacityProposalLine.lender_department_id, label_columns
        )
        .select_from(CapacityAssignment)
        .join(labels, labels.c.id == CapacityAssignment.demand_id)
        .outerjoin(
            CapacityProposalLine,
            (col(CapacityProposalLine.org_id) == CapacityAssignment.org_id)
            & (col(CapacityProposalLine.id) == CapacityAssignment.proposal_line_id),
        )
        .where(
            col(CapacityAssignment.org_id) == org_id,
            col(CapacityAssignment.employee_id).in_(ids),
            col(CapacityAssignment.status) == AssignmentStatus.ACTIVE,
            col(CapacityAssignment.due_date) >= start,
            or_(
                col(CapacityAssignment.start_date).is_(None),
                col(CapacityAssignment.start_date) < end,
            ),
        )
        .order_by(col(CapacityAssignment.start_date), col(CapacityAssignment.id))
    )
    for row, lender_id, label in assignments:
        if lender_id is not None and not _can_view_borrow_segment(
            principal,
            employees_by_id[row.employee_id],
            lender_id,
            label.requester_user_id,
            label.requesting_department_id,
            label.target_department_id,
        ):
            continue
        effective_start = row.start_date or calendar.week_start(row.created_at.date())
        if effective_start < end:
            segments[row.employee_id].assignments.append(
                WorkloadAssignmentSegment(
                    id=row.id,
                    demand_id=row.demand_id,
                    title=label.title,
                    capability_name=label.capability_name,
                    requesting_department_name=label.department_name,
                    kind="borrow" if lender_id is not None else "committed",
                    allocation_percent=row.allocation_percent,
                    start_date=effective_start,
                    due_date=row.due_date,
                    legacy_start=row.start_date is None,
                )
            )
    holds = session.exec(
        select(
            CapacityProposalLine, CapacityProposal, CapacityApproval.id, label_columns
        )
        .select_from(CapacityProposalLine)
        .join(
            CapacityProposal,
            (col(CapacityProposal.org_id) == CapacityProposalLine.org_id)
            & (col(CapacityProposal.id) == CapacityProposalLine.proposal_id),
        )
        .join(labels, labels.c.id == CapacityProposal.demand_id)
        .outerjoin(
            CapacityApproval,
            (col(CapacityApproval.org_id) == CapacityProposalLine.org_id)
            & (col(CapacityApproval.proposal_id) == CapacityProposalLine.proposal_id)
            & (col(CapacityApproval.line_id) == CapacityProposalLine.id)
            & (col(CapacityApproval.party) == "employee")
            & (col(CapacityApproval.decision) == "approved"),
        )
        .where(
            col(CapacityProposalLine.org_id) == org_id,
            col(CapacityProposalLine.employee_id).in_(ids),
            col(CapacityProposal.status) == ProposalStatus.PENDING,
            col(CapacityProposal.hold_expires_at) > utc_now(),
            col(CapacityProposalLine.end_date) >= start,
            col(CapacityProposalLine.start_date) < end,
        )
        .order_by(col(CapacityProposalLine.start_date), col(CapacityProposalLine.id))
    )
    for line, proposal, approval_id, label in holds:
        assert line.employee_id is not None
        if line.lender_department_id is not None and (
            approval_id is None
            or not _can_view_borrow_segment(
                principal,
                employees_by_id[line.employee_id],
                line.lender_department_id,
                label.requester_user_id,
                label.requesting_department_id,
                label.target_department_id,
            )
        ):
            continue
        segments[line.employee_id].holds.append(
            WorkloadHoldSegment(
                proposal_id=proposal.id,
                demand_id=proposal.demand_id,
                title=label.title,
                capability_name=label.capability_name,
                requesting_department_name=label.department_name,
                is_borrow=line.lender_department_id is not None,
                allocation_percent=line.allocation_percent,
                start_date=line.start_date,
                end_date=line.end_date,
                expires_at=proposal.hold_expires_at,
            )
        )
    for interval in session.exec(
        select(CapacityUnavailability)
        .where(
            CapacityUnavailability.org_id == org_id,
            col(CapacityUnavailability.employee_id).in_(ids),
            CapacityUnavailability.end_date >= start,
            CapacityUnavailability.start_date < end,
        )
        .order_by(
            col(CapacityUnavailability.start_date), col(CapacityUnavailability.id)
        )
    ):
        segments[interval.employee_id].unavailabilities.append(
            WorkloadUnavailabilitySegment.model_validate(interval, from_attributes=True)
        )
    return segments


def views(
    principal: Principal,
    session: Session,
    employees: list[Employee],
    from_week: date | None = None,
    weeks: int = 8,
    *,
    include_segments: bool = False,
) -> list[WorkloadPublic]:
    ids = [e.id for e in employees]
    org_id = principal.org_id
    current = calendar.this_week(session, org_id)
    start = from_week or current
    weekly = calendar.loads(session, org_id, ids, start, weeks)
    segments = (
        workload_segments(
            session,
            principal,
            {e.id: e for e in employees},
            start,
            start + timedelta(weeks=weeks),
        )
        if include_segments
        else {}
    )
    pending = {
        r.employee_id: r
        for r in session.exec(
            select(CapacityWorkloadRequest).where(
                CapacityWorkloadRequest.org_id == org_id,
                col(CapacityWorkloadRequest.employee_id).in_(ids),
                CapacityWorkloadRequest.status == CapacityRequestStatus.PENDING,
            )
        ).all()
    }
    current_loads = (
        weekly if start == current else calendar.loads(session, org_id, ids, current, 1)
    )
    cutoff = utc_now() - timedelta(days=calendar.FRESH_DAYS)
    latest = {
        record.employee_id: record
        for record in session.exec(
            select(CapacityWeek)
            .where(
                CapacityWeek.org_id == org_id,
                col(CapacityWeek.employee_id).in_(ids),
                CapacityWeek.confirmed_at >= cutoff,
            )
            .distinct(col(CapacityWeek.employee_id))
            .order_by(
                col(CapacityWeek.employee_id), col(CapacityWeek.week_start).desc()
            )
        ).all()
    }
    jira = open_jira_task_counts(session, org_id, ids)
    departments = {
        d.id: d.name
        for d in session.exec(
            select(Department).where(Department.org_id == org_id)
        ).all()
    }
    result = []
    empty_segments = WorkloadSegments()
    for e in employees:
        request = pending.get(e.id)
        load = current_loads[e.id][0]
        base, platform = load.other_percent, load.platform_percent
        last = latest.get(e.id)
        total = None if base is None else base + platform
        intervals = segments.get(e.id, empty_segments)
        result.append(
            WorkloadPublic(
                employee_id=e.id,
                employee_name=e.display_name,
                department_id=e.department_id,
                department_name=departments.get(e.department_id)
                if e.department_id
                else None,
                jira_task_count=jira.get(e.id),
                base_percent=base,
                platform_percent=platform,
                confirmed_percent=total,
                band="unconfirmed"
                if load.status != "confirmed" or total is None
                else "available"
                if total < load.capacity_percent * AVAILABLE_BELOW // 100
                else "overloaded"
                if total > load.capacity_percent
                else "full",
                weeks=weekly[e.id],
                assignments=intervals.assignments,
                holds=intervals.holds,
                unavailabilities=intervals.unavailabilities,
                correction_pending={
                    w.week_start: request is not None
                    and (request.start_week or current)
                    <= w.week_start
                    <= (request.end_week or current)
                    for w in weekly[e.id]
                },
                last_confirmed=LastConfirmed(
                    percent=last.other_percent,
                    week_start=last.week_start,
                    confirmed_at=last.confirmed_at,
                )
                if last
                else None,
            )
        )
    return result


def get_my_workload(
    principal: Principal,
    session: Session,
    from_week: date | None = None,
    weeks: int = 8,
) -> MyWorkload:
    require_enabled(principal, session)
    subject = employee(principal, session, principal.employee_id)
    requests = session.exec(
        select(CapacityWorkloadRequest)
        .where(
            CapacityWorkloadRequest.org_id == principal.org_id,
            CapacityWorkloadRequest.employee_id == subject.id,
        )
        .order_by(
            col(CapacityWorkloadRequest.created_at).desc(),
            col(CapacityWorkloadRequest.id),
        )
    ).all()
    return MyWorkload(
        **views(principal, session, [subject], from_week, weeks, include_segments=True)[
            0
        ].model_dump(),
        requests=[WorkloadRequestPublic.model_validate(r) for r in requests],
        reviewer_names=workload_reviewer_names(
            principal, session, workload_reviewers(principal, session, subject.id)
        ),
    )


def list_workloads(
    principal: Principal,
    session: Session,
    department_id: UUID | None = None,
    from_week: date | None = None,
    weeks: int = 8,
    *,
    employee_name: str | None = None,
) -> WorkloadList:
    require_enabled(principal, session)
    if not principal.is_org_admin and not principal.managed_department_ids:
        raise CapacityForbidden()
    query = (
        select(Employee)
        .outerjoin(
            Department,
            (col(Department.org_id) == Employee.org_id)
            & (col(Department.id) == Employee.department_id),
        )
        .where(
            employee_scope_clause(principal),
            Employee.employment_status == EmploymentStatus.ACTIVE,
        )
    )
    if department_id is not None:
        if (
            not principal.is_org_admin
            and department_id not in principal.managed_department_ids
        ):
            raise CapacityNotFound()
        query = query.where(Employee.department_id == department_id)
    if employee_name is not None:
        query = query.where(
            func.lower(Employee.display_name) == func.lower(employee_name)
        )
    rows = list(
        session.exec(
            query.order_by(
                col(Department.name), col(Employee.display_name), col(Employee.id)
            )
        ).all()
    )
    data = views(principal, session, rows, from_week, weeks, include_segments=True)
    return WorkloadList(data=data, count=len(data))


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
    from app.domains.capacity.inbox_detail import record_capacity_inbox_link

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


def workload_reviewers(
    principal: Principal, session: Session, employee_id: UUID
) -> list[User]:
    managers, delegates = review_participants(session, principal.org_id, employee_id)
    recipients = set(managers) | delegates
    if not recipients:
        return []
    users = session.exec(
        select(User)
        .join(OrgMembership, col(OrgMembership.user_id) == User.id)
        .where(
            OrgMembership.org_id == principal.org_id,
            col(User.id).in_(recipients),
            User.is_active,
        )
        .order_by(col(User.id))
    ).all()
    return [
        user
        for user in users
        if user.id != principal.user_id
        and can_review(
            session,
            get_org_principal(principal.org_id, user, session),
            employee_id,
        )
        is not None
    ]


def workload_reviewer_names(
    principal: Principal, session: Session, users: list[User]
) -> list[str]:
    from app.domains.capacity.extension import user_names

    return list(
        user_names(session, principal.org_id, {user.id for user in users}).values()
    )


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


def _group_dates(days: list[date]) -> list[tuple[date, date]]:
    if not days:
        return []
    ordered = sorted(days)
    ranges: list[tuple[date, date]] = []
    start = end = ordered[0]
    for day in ordered[1:]:
        if day == end + timedelta(days=1):
            end = day
        else:
            ranges.append((start, end))
            start = end = day
    ranges.append((start, end))
    return ranges


def _audit_and_notify_unavailability_removed(
    principal: Principal,
    session: Session,
    subject: Employee,
    target_id: UUID,
    start_date: date,
    end_date: date,
    *,
    via: Via,
    client_name: str | None,
) -> None:
    audit(
        principal,
        session,
        "capacity.unavailability_deleted",
        "capacity_unavailability",
        target_id,
        via,
        client_name,
        {
            "employee_id": str(subject.id),
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
        },
    )
    if subject.id != principal.employee_id:
        msg_zh, msg_en = bilingual(
            "你的不可用时段已撤销（{start} 至 {end}）。请前往「我的负荷」核对。",
            start=start_date,
            end=end_date,
        )
        notify_employee(
            principal,
            session,
            subject.id,
            msg_zh,
            message_en=msg_en,
        )


def _remove_unavailability_dates(
    principal: Principal,
    session: Session,
    subject: Employee,
    overlapping: list[CapacityUnavailability],
    remove_days: set[date],
    *,
    via: Via,
    client_name: str | None,
) -> None:
    for row in overlapping:
        matched = sorted(d for d in remove_days if row.start_date <= d <= row.end_date)
        if not matched:
            continue
        kept_days: list[date] = []
        cursor = row.start_date
        while cursor <= row.end_date:
            if cursor not in remove_days:
                kept_days.append(cursor)
            cursor += timedelta(days=1)
        kept_ranges = _group_dates(kept_days)
        removed_ranges = _group_dates(matched)
        row_id = row.id
        created_by = row.created_by_user_id
        if not kept_ranges:
            session.delete(row)
            session.flush()
        else:
            row.start_date, row.end_date = kept_ranges[0]
            session.add(row)
            for ks, ke in kept_ranges[1:]:
                session.add(
                    CapacityUnavailability(
                        org_id=principal.org_id,
                        employee_id=subject.id,
                        start_date=ks,
                        end_date=ke,
                        created_by_user_id=created_by,
                    )
                )
            session.flush()
        for rs, re in removed_ranges:
            _audit_and_notify_unavailability_removed(
                principal,
                session,
                subject,
                row_id,
                rs,
                re,
                via=via,
                client_name=client_name,
            )


def _sync_week_unavailability(
    principal: Principal,
    session: Session,
    subject: Employee,
    week_start: date,
    requested_capacity: int | None,
    on_leave: bool | None,
    leave_dates: list[date] | None,
    *,
    via: Via,
    client_name: str | None,
) -> None:
    from app.domains.capacity.tracking import notify_unavailability

    if requested_capacity is None and on_leave is None and leave_dates is None:
        return
    if principal.user_id is None:
        raise CapacityForbidden()
    mon = week_start
    sun = mon + timedelta(days=6)
    overlapping = list(
        session.exec(
            select(CapacityUnavailability)
            .where(
                CapacityUnavailability.org_id == principal.org_id,
                CapacityUnavailability.employee_id == subject.id,
                CapacityUnavailability.start_date <= sun,
                CapacityUnavailability.end_date >= mon,
            )
            .order_by(
                col(CapacityUnavailability.start_date), col(CapacityUnavailability.id)
            )
        ).all()
    )
    weekdays = [mon + timedelta(days=d) for d in range(5)]
    covered = [
        day
        for day in weekdays
        if any(r.start_date <= day <= r.end_date for r in overlapping)
    ]
    covered_set = set(covered)
    if leave_dates is None:
        if requested_capacity is not None:
            target_unavail = (100 - requested_capacity) // 20
        elif on_leave is True:
            target_unavail = len(covered) or 1
        else:
            target_unavail = 0
        if target_unavail != len(covered):
            raise HTTPException(
                422,
                "调整可用上限或请假状态会改变请假天数，请在周详情中选定具体请假日期",
            )
        return

    week_set = set(weekdays)
    if any(day not in week_set for day in leave_dates):
        raise HTTPException(422, "请假日期须在当前周的工作日（周一至周五）内")
    target_set = set(leave_dates)
    if (
        requested_capacity is not None
        and len(target_set) != (100 - requested_capacity) // 20
    ):
        raise HTTPException(422, "所选请假日期天数与可用上限不匹配，请核对具体日期")
    if on_leave is True and not target_set:
        raise HTTPException(422, "标记请假时请选定具体请假日期")
    if on_leave is False and target_set:
        raise HTTPException(422, "未标记请假时不能保留请假日期")

    to_add = [day for day in weekdays if day in target_set and day not in covered_set]
    to_remove = {day for day in covered_set if day not in target_set}
    if to_remove:
        _remove_unavailability_dates(
            principal,
            session,
            subject,
            overlapping,
            to_remove,
            via=via,
            client_name=client_name,
        )
    for rs, re in _group_dates(to_add):
        row = CapacityUnavailability(
            org_id=principal.org_id,
            employee_id=subject.id,
            start_date=rs,
            end_date=re,
            created_by_user_id=principal.user_id,
        )
        session.add(row)
        session.flush()
        audit(
            principal,
            session,
            "capacity.unavailability_registered",
            "capacity_unavailability",
            row.id,
            via,
            client_name,
            {
                "employee_id": str(subject.id),
                "start_date": rs.isoformat(),
                "end_date": re.isoformat(),
            },
        )
        msg_zh, msg_en = bilingual(
            "你的不可用时段已登记（{start} 至 {end}）。请前往「我的负荷」核对。",
            start=row.start_date,
            end=row.end_date,
        )
        notify_employee(
            principal,
            session,
            subject.id,
            msg_zh,
            message_en=msg_en,
        )
        notify_unavailability(session, row)


def set_weeks(
    principal: Principal,
    session: Session,
    body: WorkloadWeeksInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> WorkloadList:
    require_enabled(principal, session)
    subjects: list[Employee] = []
    by_id: dict[UUID, Employee] = {}
    for item in sorted(body.items, key=lambda item: item.employee_id):
        if item.leave_dates is not None and body.start_week != body.end_week:
            raise HTTPException(422, "修改具体请假日期请按单周操作")
        subject = employee(principal, session, item.employee_id, lock=True)
        if not can_view_employee(principal, subject):
            raise CapacityNotFound()
        if (
            subject.id == principal.employee_id
            or subject.department_id not in principal.managed_department_ids
        ):
            raise CapacityForbidden()
        subjects.append(subject)
        by_id[subject.id] = subject
    for item in body.items:
        subject = by_id[item.employee_id]
        for offset in range((body.end_week - body.start_week).days // 7 + 1):
            week = body.start_week + timedelta(weeks=offset)
            before = set_week(
                principal,
                session,
                item.employee_id,
                item.other_percent,
                week,
            )
            audit(
                principal,
                session,
                "capacity.workload_adjusted",
                "employee",
                item.employee_id,
                via,
                client_name,
                {
                    "before_percent": before,
                    "after_percent": item.other_percent,
                    "week_start": week.isoformat(),
                },
            )
            _sync_week_unavailability(
                principal,
                session,
                subject,
                week,
                item.capacity_percent,
                item.on_leave,
                item.leave_dates,
                via=via,
                client_name=client_name,
            )
        msg_zh, msg_en = bilingual(
            "团队负荷已更新（周次 {start} 至 {end}）。请前往「我的负荷」核对。",
            start=body.start_week,
            end=body.end_week,
        )
        notify_employee(
            principal,
            session,
            item.employee_id,
            msg_zh,
            message_en=msg_en,
        )
    session.flush()
    refresh_org_forecasts(session, principal.org_id, employee_ids=list(by_id))
    data = views(principal, session, subjects)
    return WorkloadList(data=data, count=len(data))


def _manageable_employees(
    principal: Principal, session: Session, department_id: UUID | None = None
) -> list[Employee]:
    if principal.is_org_admin or not principal.managed_department_ids:
        raise CapacityForbidden()
    if (
        department_id is not None
        and department_id not in principal.managed_department_ids
    ):
        raise CapacityNotFound()
    query = (
        select(Employee)
        .outerjoin(
            Department,
            (col(Department.org_id) == Employee.org_id)
            & (col(Department.id) == Employee.department_id),
        )
        .where(
            employee_scope_clause(principal),
            Employee.employment_status == EmploymentStatus.ACTIVE,
            Employee.id != principal.employee_id,
            col(Employee.department_id).in_(principal.managed_department_ids),
        )
    )
    if department_id is not None:
        query = query.where(Employee.department_id == department_id)
    return list(
        session.exec(
            query.order_by(
                col(Department.name), col(Employee.display_name), col(Employee.id)
            )
        ).all()
    )


def _carry_over_plan(
    session: Session,
    org_id: UUID,
    employees: list[Employee],
) -> tuple[list[CarryOverPlanItem], int]:
    if not employees:
        return [], 0
    ids = [e.id for e in employees]
    current = calendar.this_week(session, org_id)
    cutoff = utc_now() - timedelta(days=calendar.FRESH_DAYS)
    confirmed_rows = session.exec(
        select(CapacityWeek)
        .where(
            CapacityWeek.org_id == org_id,
            col(CapacityWeek.employee_id).in_(ids),
            CapacityWeek.confirmed_at >= cutoff,
        )
        .order_by(col(CapacityWeek.employee_id), col(CapacityWeek.week_start).desc())
    ).all()
    latest_by_emp: dict[UUID, CapacityWeek] = {}
    confirmed_weeks_by_emp: dict[UUID, set[date]] = defaultdict(set)
    for row in confirmed_rows:
        confirmed_weeks_by_emp[row.employee_id].add(row.week_start)
        if row.employee_id not in latest_by_emp:
            latest_by_emp[row.employee_id] = row
    plan: list[CarryOverPlanItem] = []
    skipped = 0
    for emp in employees:
        baseline = latest_by_emp.get(emp.id)
        if baseline is None:
            skipped += 1
            continue
        confirmed = confirmed_weeks_by_emp[emp.id]
        target = max(current, baseline.week_start + timedelta(weeks=1))
        steps = 0
        while target in confirmed and steps < 260:
            target += timedelta(weeks=1)
            steps += 1
        plan.append(
            CarryOverPlanItem(
                employee_id=emp.id,
                employee_name=emp.display_name,
                baseline_week_start=baseline.week_start,
                target_week_start=target,
                other_percent=baseline.other_percent,
            )
        )
    return plan, skipped


@dataclass
class ReversibleBatch:
    batch: CapacityCarryOver
    items: list[CapacityCarryOverItem]
    names: dict[UUID, str]
    created_by_name: str
    employee_departments: dict[UUID, str]


def _batch_public(info: ReversibleBatch) -> CarryOverBatchPublic:
    department_names = list(
        dict.fromkeys(
            dept
            for item in info.items
            if (dept := info.employee_departments.get(item.employee_id))
        )
    )
    employee_names = list(
        dict.fromkeys(
            name
            for item in info.items
            if (name := info.names.get(item.employee_id, ""))
        )
    )
    week_starts = sorted({item.week_start for item in info.items})
    return CarryOverBatchPublic(
        id=info.batch.id,
        created_at=info.batch.created_at,
        created_by_name=info.created_by_name,
        department_names=department_names,
        employee_names=employee_names,
        week_starts=week_starts,
        reverted_at=info.batch.reverted_at,
        items=[
            CarryOverBatchItemPublic(
                employee_id=item.employee_id,
                employee_name=info.names.get(item.employee_id, ""),
                department_name=info.employee_departments.get(item.employee_id),
                week_start=item.week_start,
                baseline_week_start=item.baseline_week_start,
                other_percent=item.after_percent,
                before_percent=item.before_percent,
            )
            for item in info.items
        ],
    )


def _department_names(
    session: Session, org_id: UUID, employees: list[Employee]
) -> dict[UUID, str]:
    dept_ids = {e.department_id for e in employees if e.department_id is not None}
    if not dept_ids:
        return {}
    by_dept = {
        d.id: d.name
        for d in session.exec(
            select(Department).where(
                Department.org_id == org_id, col(Department.id).in_(dept_ids)
            )
        ).all()
    }
    return {
        e.id: by_dept[e.department_id]
        for e in employees
        if e.department_id is not None and e.department_id in by_dept
    }


def _reversible_batches(
    principal: Principal, session: Session
) -> list[ReversibleBatch]:
    from app.domains.capacity.extension import user_names

    batches = list(
        session.exec(
            select(CapacityCarryOver)
            .where(
                CapacityCarryOver.org_id == principal.org_id,
                col(CapacityCarryOver.reverted_at).is_(None),
            )
            .order_by(
                col(CapacityCarryOver.created_at).desc(),
                col(CapacityCarryOver.id).desc(),
            )
        ).all()
    )
    if not batches:
        return []
    batch_ids = [b.id for b in batches]
    all_items = list(
        session.exec(
            select(CapacityCarryOverItem)
            .where(
                CapacityCarryOverItem.org_id == principal.org_id,
                col(CapacityCarryOverItem.batch_id).in_(batch_ids),
            )
            .order_by(col(CapacityCarryOverItem.id))
        ).all()
    )
    emp_ids = {i.employee_id for i in all_items}
    employees = {
        e.id: e
        for e in session.exec(
            select(Employee).where(
                Employee.org_id == principal.org_id,
                col(Employee.id).in_(emp_ids),
            )
        ).all()
    }
    emp_depts = _department_names(session, principal.org_id, list(employees.values()))
    creator_names = user_names(
        session, principal.org_id, {b.created_by_user_id for b in batches}
    )
    by_batch: dict[UUID, list[CapacityCarryOverItem]] = defaultdict(list)
    for item in all_items:
        by_batch[item.batch_id].append(item)
    visible: list[ReversibleBatch] = []
    for batch in batches:
        items = by_batch.get(batch.id, [])
        if not items:
            continue
        if all(
            (emp := employees.get(item.employee_id)) is not None
            and emp.employment_status == EmploymentStatus.ACTIVE
            and emp.id != principal.employee_id
            and emp.department_id in principal.managed_department_ids
            and can_view_employee(principal, emp)
            for item in items
        ):
            visible.append(
                ReversibleBatch(
                    batch=batch,
                    items=items,
                    names={
                        item.employee_id: employees[item.employee_id].display_name
                        for item in items
                    },
                    created_by_name=creator_names.get(
                        batch.created_by_user_id, tr("部门经理")
                    ),
                    employee_departments={
                        item.employee_id: emp_depts[item.employee_id]
                        for item in items
                        if item.employee_id in emp_depts
                    },
                )
            )
    return visible


def preview_carry_over(
    principal: Principal,
    session: Session,
    department_id: UUID | None = None,
) -> CarryOverPreview:
    require_enabled(principal, session)
    employees = _manageable_employees(principal, session, department_id)
    plan, skipped = _carry_over_plan(session, principal.org_id, employees)
    reversible = _reversible_batches(principal, session)
    latest_batch = _batch_public(reversible[0]) if reversible else None
    return CarryOverPreview(
        items=plan,
        skipped_no_baseline=skipped,
        latest_batch=latest_batch,
        reversible_count=len(reversible),
    )


def preview_carry_over_revert(
    principal: Principal,
    session: Session,
) -> CarryOverRevertPreview:
    require_enabled(principal, session)
    if (
        principal.is_org_admin
        or principal.user_id is None
        or not principal.managed_department_ids
    ):
        raise CapacityForbidden()
    reversible = _reversible_batches(principal, session)
    latest_batch = _batch_public(reversible[0]) if reversible else None
    return CarryOverRevertPreview(
        latest_batch=latest_batch,
        reversible_count=len(reversible),
    )


def commit_carry_over(
    principal: Principal,
    session: Session,
    body: CarryOverCommitInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> CarryOverBatchPublic:
    from app.domains.capacity.extension import user_names

    require_enabled(principal, session)
    if (
        principal.is_org_admin
        or principal.user_id is None
        or not principal.managed_department_ids
    ):
        raise CapacityForbidden()
    subjects: list[Employee] = []
    names: dict[UUID, str] = {}
    for item in sorted(body.items, key=lambda i: i.employee_id):
        subject = employee(principal, session, item.employee_id, lock=True)
        if not can_view_employee(principal, subject):
            raise CapacityNotFound()
        if (
            subject.id == principal.employee_id
            or subject.department_id not in principal.managed_department_ids
        ):
            raise CapacityForbidden()
        subjects.append(subject)
        names[subject.id] = subject.display_name
    plan, _ = _carry_over_plan(session, principal.org_id, subjects)
    plan_by_emp = {p.employee_id: p for p in plan}
    for item in body.items:
        expected = plan_by_emp.get(item.employee_id)
        if (
            expected is None
            or expected.target_week_start != item.week_start
            or expected.baseline_week_start != item.baseline_week_start
            or expected.other_percent != item.other_percent
        ):
            raise HTTPException(409, "部分周次已被确认或变更，请刷新后重试")
    batch = CapacityCarryOver(
        org_id=principal.org_id,
        created_by_user_id=principal.user_id,
    )
    session.add(batch)
    session.flush()
    now = utc_now()
    saved_items: list[CapacityCarryOverItem] = []
    for item in body.items:
        existing = session.exec(
            select(CapacityWeek).where(
                CapacityWeek.org_id == principal.org_id,
                CapacityWeek.employee_id == item.employee_id,
                CapacityWeek.week_start == item.week_start,
            )
        ).one_or_none()
        before_percent = existing.other_percent if existing else None
        before_by = existing.confirmed_by_user_id if existing else None
        before_at = existing.confirmed_at if existing else None
        if existing is None:
            existing = CapacityWeek(
                org_id=principal.org_id,
                employee_id=item.employee_id,
                week_start=item.week_start,
                other_percent=item.other_percent,
                confirmed_by_user_id=principal.user_id,
                confirmed_at=now,
            )
        else:
            existing.other_percent = item.other_percent
            existing.confirmed_by_user_id = principal.user_id
            existing.confirmed_at = now
        session.add(existing)
        record = CapacityCarryOverItem(
            org_id=principal.org_id,
            batch_id=batch.id,
            employee_id=item.employee_id,
            week_start=item.week_start,
            baseline_week_start=item.baseline_week_start,
            after_percent=item.other_percent,
            after_confirmed_at=now,
            before_percent=before_percent,
            before_confirmed_by_user_id=before_by,
            before_confirmed_at=before_at,
        )
        session.add(record)
        saved_items.append(record)
        msg_zh, msg_en = bilingual(
            "团队负荷已更新（沿用 {baseline} 设置至 {week} 当周）。请前往「我的负荷」核对。",
            baseline=item.baseline_week_start,
            week=item.week_start,
        )
        notify_employee(
            principal,
            session,
            item.employee_id,
            msg_zh,
            message_en=msg_en,
        )
    session.flush()
    audit(
        principal,
        session,
        "capacity.workload_carried_over",
        "capacity_carry_over",
        batch.id,
        via,
        client_name,
        {
            "items": [
                {
                    "employee_id": str(i.employee_id),
                    "week_start": i.week_start.isoformat(),
                    "baseline_week_start": i.baseline_week_start.isoformat(),
                    "before_percent": i.before_percent,
                    "after_percent": i.after_percent,
                }
                for i in saved_items
            ]
        },
    )
    emp_depts = _department_names(session, principal.org_id, subjects)
    refresh_org_forecasts(
        session, principal.org_id, employee_ids=[e.id for e in subjects]
    )
    creator_name = user_names(session, principal.org_id, {principal.user_id}).get(
        principal.user_id, tr("部门经理")
    )
    return _batch_public(
        ReversibleBatch(
            batch=batch,
            items=saved_items,
            names=names,
            created_by_name=creator_name,
            employee_departments=emp_depts,
        )
    )


def revert_carry_over(
    principal: Principal,
    session: Session,
    *,
    batch_id: UUID | None = None,
    via: Via = "web",
    client_name: str | None = None,
) -> CarryOverBatchPublic:
    require_enabled(principal, session)
    if (
        principal.is_org_admin
        or principal.user_id is None
        or not principal.managed_department_ids
    ):
        raise CapacityForbidden()
    reversible = _reversible_batches(principal, session)
    if not reversible:
        if batch_id is not None:
            raise HTTPException(409, "该沿用批次已被回撤或已变化，请刷新后重新核对")
        raise CapacityNotFound("没有可回撤的沿用记录")
    target = reversible[0]
    if batch_id is not None and target.batch.id != batch_id:
        raise HTTPException(409, "可回撤的沿用批次已变化，请刷新后重新核对")
    target_batch, items = target.batch, target.items
    batch = session.exec(
        select(CapacityCarryOver)
        .where(
            CapacityCarryOver.org_id == principal.org_id,
            CapacityCarryOver.id == target_batch.id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one()
    if batch.reverted_at is not None:
        raise HTTPException(409, "该沿用批次已被回撤或已变化，请刷新后重新核对")
    for item in sorted(items, key=lambda i: i.employee_id):
        subject = employee(principal, session, item.employee_id, lock=True)
        if not can_view_employee(principal, subject):
            raise CapacityNotFound()
        if (
            subject.id == principal.employee_id
            or subject.department_id not in principal.managed_department_ids
        ):
            raise CapacityForbidden()
    for item in items:
        current = session.exec(
            select(CapacityWeek).where(
                CapacityWeek.org_id == principal.org_id,
                CapacityWeek.employee_id == item.employee_id,
                CapacityWeek.week_start == item.week_start,
            )
        ).one_or_none()
        if (
            current is None
            or current.other_percent != item.after_percent
            or current.confirmed_at != item.after_confirmed_at
        ):
            raise HTTPException(409, "沿用后该周负荷已被修改，无法直接回撤")
        if item.before_percent is None:
            session.delete(current)
        else:
            assert (
                item.before_confirmed_by_user_id is not None
                and item.before_confirmed_at is not None
            )
            current.other_percent = item.before_percent
            current.confirmed_by_user_id = item.before_confirmed_by_user_id
            current.confirmed_at = item.before_confirmed_at
            session.add(current)
        msg_zh, msg_en = bilingual(
            "已撤回沿用的周负荷设置（周次 {week}），已恢复原状态。请前往「我的负荷」核对。",
            week=item.week_start,
        )
        notify_employee(
            principal,
            session,
            item.employee_id,
            msg_zh,
            message_en=msg_en,
        )
    batch.reverted_at = utc_now()
    batch.reverted_by_user_id = principal.user_id
    session.add(batch)
    session.flush()
    refresh_org_forecasts(
        session,
        principal.org_id,
        employee_ids=list({item.employee_id for item in items}),
    )
    audit(
        principal,
        session,
        "capacity.workload_carry_over_reverted",
        "capacity_carry_over",
        batch.id,
        via,
        client_name,
        {
            "items": [
                {
                    "employee_id": str(i.employee_id),
                    "week_start": i.week_start.isoformat(),
                    "restored_percent": i.before_percent,
                    "reverted_from_percent": i.after_percent,
                }
                for i in items
            ]
        },
    )
    return _batch_public(target)


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
    from app.domains.capacity.extension import user_names

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
        from app.domains.capacity.extension import user_names
        from app.domains.capacity.inbox_detail import record_capacity_inbox_link

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


def unavailability_public(
    principal: Principal,
    session: Session,
    row: CapacityUnavailability,
    subject: Employee,
) -> UnavailabilityPublic:
    start = calendar.week_start(row.start_date)
    weekly = calendar.loads(
        session,
        principal.org_id,
        [subject.id],
        start,
        (calendar.week_start(row.end_date) - start).days // 7 + 1,
    )[subject.id]
    return UnavailabilityPublic(
        **row.model_dump(exclude={"org_id"}),
        can_delete=not principal.is_org_admin
        and (
            row.created_by_user_id == principal.user_id
            or subject.department_id in principal.managed_department_ids
        ),
        over_weeks=[week for week, _ in calendar.shortfalls(weekly, 0)[1]],
    )


def list_unavailability(
    principal: Principal,
    session: Session,
    employee_id: UUID,
    from_date: date,
    to_date: date,
) -> UnavailabilityList:
    require_enabled(principal, session)
    subject = session.exec(
        select(Employee).where(
            employee_scope_clause(principal),
            Employee.id == employee_id,
        )
    ).one_or_none()
    if subject is None:
        raise CapacityNotFound()
    rows = session.exec(
        select(CapacityUnavailability)
        .where(
            CapacityUnavailability.org_id == principal.org_id,
            CapacityUnavailability.employee_id == employee_id,
            CapacityUnavailability.start_date <= to_date,
            CapacityUnavailability.end_date >= from_date,
        )
        .order_by(
            col(CapacityUnavailability.start_date), col(CapacityUnavailability.id)
        )
    ).all()
    data = [unavailability_public(principal, session, row, subject) for row in rows]
    return UnavailabilityList(data=data, count=len(data))


def register_unavailability(
    principal: Principal,
    session: Session,
    body: UnavailabilityInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> UnavailabilityPublic:
    from app.domains.capacity.tracking import notify_unavailability

    require_enabled(principal, session)
    subject = employee(principal, session, body.employee_id, lock=True)
    if not can_view_employee(principal, subject):
        raise CapacityNotFound()
    if principal.is_org_admin:
        raise CapacityForbidden()
    if principal.user_id is None or (
        subject.id != principal.employee_id
        and subject.department_id not in principal.managed_department_ids
    ):
        raise CapacityForbidden()
    payload = body.model_dump()
    row = CapacityUnavailability(
        org_id=principal.org_id,
        created_by_user_id=principal.user_id,
        **payload,
    )
    session.add(row)
    session.flush()
    audit(
        principal,
        session,
        "capacity.unavailability_registered",
        "capacity_unavailability",
        row.id,
        via,
        client_name,
        body.model_dump(mode="json"),
    )
    if subject.id != principal.employee_id:
        msg_zh, msg_en = bilingual(
            "你的不可用时段已登记（{start} 至 {end}）。请前往「我的负荷」核对。",
            start=row.start_date,
            end=row.end_date,
        )
        notify_employee(
            principal,
            session,
            subject.id,
            msg_zh,
            message_en=msg_en,
        )
    affected_recipients = notify_unavailability(session, row)
    if subject.id == principal.employee_id:
        for user in workload_reviewers(principal, session, subject.id):
            if user.id in affected_recipients:
                continue
            msg_zh, msg_en = bilingual(
                "{name} 已登记请假（{start} 至 {end}）。已直接生效，请前往「团队负荷」查看。",
                name=subject.display_name,
                start=row.start_date,
                end=row.end_date,
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
    return unavailability_public(principal, session, row, subject)


def delete_unavailability(
    principal: Principal,
    session: Session,
    unavailability_id: UUID,
) -> UnavailabilityPublic:
    require_enabled(principal, session)
    query = select(CapacityUnavailability).where(
        CapacityUnavailability.org_id == principal.org_id,
        CapacityUnavailability.id == unavailability_id,
    )
    row = session.exec(query).one_or_none()
    if row is None:
        raise CapacityNotFound()
    subject = employee(principal, session, row.employee_id, lock=True)
    row = session.exec(query.execution_options(populate_existing=True)).one_or_none()
    if row is None or not can_view_employee(principal, subject):
        raise CapacityNotFound()
    if principal.is_org_admin:
        raise CapacityForbidden()
    if (
        row.created_by_user_id != principal.user_id
        and subject.department_id not in principal.managed_department_ids
    ):
        raise CapacityForbidden()
    session.delete(row)
    session.flush()
    audit(
        principal,
        session,
        "capacity.unavailability_deleted",
        "capacity_unavailability",
        row.id,
        "web",
        None,
        {
            "employee_id": str(subject.id),
            "start_date": row.start_date.isoformat(),
            "end_date": row.end_date.isoformat(),
        },
    )
    if subject.id != principal.employee_id:
        msg_zh, msg_en = bilingual(
            "你的不可用时段已撤销（{start} 至 {end}）。请前往「我的负荷」核对。",
            start=row.start_date,
            end=row.end_date,
        )
        notify_employee(
            principal,
            session,
            subject.id,
            msg_zh,
            message_en=msg_en,
        )
    return unavailability_public(principal, session, row, subject)
