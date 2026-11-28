from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from uuid import UUID

from sqlalchemy.engine import Row
from sqlalchemy.orm import Bundle
from sqlmodel import Session, case, col, func, or_, select

from app.authz.deps import get_org_principal
from app.authz.policies import employee_scope_clause
from app.authz.principal import Principal
from app.domains.base import utc_now
from app.domains.capacity import calendar
from app.domains.capacity.common import (
    CapacityForbidden,
    CapacityNotFound,
    employee,
    open_jira_task_counts,
    user_names,
)
from app.domains.capacity.models import (
    AssignmentStatus,
    CapacityApproval,
    CapacityAssignment,
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
    LastConfirmed,
    MyWorkload,
    WorkloadAssignmentSegment,
    WorkloadHoldSegment,
    WorkloadList,
    WorkloadPublic,
    WorkloadRequestPublic,
    WorkloadUnavailabilitySegment,
)
from app.domains.capacity.settings import require_enabled
from app.domains.org.models import (
    Department,
    Employee,
    EmploymentStatus,
    OrgMembership,
)
from app.domains.review.routing import can_review, review_participants
from app.models import User

AVAILABLE_BELOW = 80


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
    return list(
        user_names(session, principal.org_id, {user.id for user in users}).values()
    )


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
