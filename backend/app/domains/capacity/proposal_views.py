"""Proposal query helpers and projection views."""

from collections import defaultdict
from collections.abc import Iterable, Sequence
from datetime import date, datetime
from uuid import UUID

from sqlmodel import Session, col, select

from app.authz.policies import employee_scope_clause
from app.authz.principal import Principal
from app.domains.capacity.common import can_view_demand_internals
from app.domains.capacity.demand_schemas import (
    ChangeProposalParticipant,
    CommitmentArrangement,
    ParticipantChangeStatus,
    ParticipantPublic,
    ProposalApprovalPublic,
    ProposalDecision,
    ProposalDetail,
    ProposalLinePublic,
    ProposalParticipant,
    ProposalSchedule,
    ProposalSegment,
    ProposalSummary,
    SchedulePhase,
)
from app.domains.capacity.models import (
    AssignmentStatus,
    CapacityApproval,
    CapacityAssignment,
    CapacityDemand,
    CapacityDemandEvent,
    CapacityProposal,
    CapacityProposalLine,
    DemandEventKind,
    ProposalStatus,
)
from app.domains.org.models import Employee
from app.i18n import tr

BORROW_ACCEPTED_PENDING = "排期已确认，等待借调完成"
BORROW_COMMITTED = "借调已生效"


def latest(
    session: Session,
    org_id: UUID,
    demand_id: UUID,
    *,
    lock: bool = False,
    status: ProposalStatus | None = None,
) -> CapacityProposal | None:
    query = (
        select(CapacityProposal)
        .where(
            CapacityProposal.org_id == org_id,
            CapacityProposal.demand_id == demand_id,
            *([CapacityProposal.status == status] if status is not None else []),
        )
        .order_by(
            col(CapacityProposal.created_at).desc(), col(CapacityProposal.id).desc()
        )
        .limit(1)
    )
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    return session.exec(query).first()


def lines_for(session: Session, row: CapacityProposal) -> list[CapacityProposalLine]:
    return list(
        session.exec(
            select(CapacityProposalLine)
            .where(
                CapacityProposalLine.org_id == row.org_id,
                CapacityProposalLine.proposal_id == row.id,
            )
            .order_by(
                col(CapacityProposalLine.employee_id),
                col(CapacityProposalLine.start_date),
                col(CapacityProposalLine.id),
            )
        ).all()
    )


def approvals_for(session: Session, row: CapacityProposal) -> list[CapacityApproval]:
    return list(
        session.exec(
            select(CapacityApproval)
            .where(
                CapacityApproval.org_id == row.org_id,
                CapacityApproval.proposal_id == row.id,
            )
            .order_by(col(CapacityApproval.created_at), col(CapacityApproval.id))
        ).all()
    )


def active_segments(
    session: Session, org_id: UUID, demand_id: UUID, proposal_id: UUID
) -> list[tuple[CapacityAssignment, CapacityProposalLine]]:
    return list(
        session.exec(
            select(CapacityAssignment, CapacityProposalLine)
            .join(
                CapacityProposalLine,
                (col(CapacityAssignment.org_id) == CapacityProposalLine.org_id)
                & (col(CapacityAssignment.proposal_line_id) == CapacityProposalLine.id),
            )
            .where(
                CapacityAssignment.org_id == org_id,
                CapacityAssignment.demand_id == demand_id,
                CapacityAssignment.status == AssignmentStatus.ACTIVE,
                CapacityProposalLine.proposal_id == proposal_id,
            )
            .order_by(col(CapacityAssignment.id))
        ).all()
    )


def reply_superseded(demand: CapacityDemand, row: CapacityProposal) -> bool:
    # Ending a proposal advances the demand once; a new reply advances it again.
    return (
        row.kind == "initial"
        and row.status in (ProposalStatus.FAILED, ProposalStatus.WITHDRAWN)
        and demand.revision > row.demand_revision + 1
    )


def _public_approvals(
    principal: Principal, approvals: list[CapacityApproval], *, detailed: bool
) -> list[ProposalApprovalPublic]:
    result = []
    for approval in approvals:
        if approval.party in ("employee", "lender_manager"):
            continue
        can_read_reason = detailed or (
            approval.party == "requester" and approval.user_id == principal.user_id
        )
        result.append(
            ProposalApprovalPublic(
                party=approval.party,
                decision=approval.decision,
                created_at=approval.created_at,
                reason=approval.reason if can_read_reason else None,
                reason_code=approval.reason_code if can_read_reason else None,
            )
        )
    return result


def decision_history(
    principal: Principal, session: Session, demand: CapacityDemand
) -> list[ProposalDecision]:
    detailed = can_view_demand_internals(principal, demand)
    rows = session.exec(
        select(CapacityProposal)
        .where(
            CapacityProposal.org_id == principal.org_id,
            CapacityProposal.demand_id == demand.id,
        )
        .order_by(col(CapacityProposal.created_at), col(CapacityProposal.id))
    ).all()
    if not rows:
        return []
    ids = [row.id for row in rows]
    borrowed = set(
        session.exec(
            select(CapacityProposalLine.proposal_id)
            .where(
                CapacityProposalLine.org_id == principal.org_id,
                col(CapacityProposalLine.proposal_id).in_(ids),
                col(CapacityProposalLine.lender_department_id).is_not(None),
            )
            .distinct()
        ).all()
    )
    approvals: dict[UUID, list[CapacityApproval]] = defaultdict(list)
    for approval in session.exec(
        select(CapacityApproval)
        .where(
            CapacityApproval.org_id == principal.org_id,
            col(CapacityApproval.proposal_id).in_(ids),
        )
        .order_by(col(CapacityApproval.created_at), col(CapacityApproval.id))
    ):
        approvals[approval.proposal_id].append(approval)
    return [
        ProposalDecision(
            id=row.id,
            kind=row.kind,
            status=row.status,
            fail_reason=(
                "borrow_unsuccessful"
                if row.fail_reason and row.id in borrowed
                else row.fail_reason
            ),
            created_at=row.created_at,
            approvals=_public_approvals(
                principal, approvals.get(row.id, []), detailed=detailed
            ),
        )
        for row in rows
    ]


def _grouped_lines(
    principal: Principal,
    session: Session,
    lines: list[CapacityProposalLine],
    *,
    detailed: bool,
) -> tuple[dict[UUID, list[ProposalSegment]], list[ProposalLinePublic] | None]:
    people = {}
    if detailed:
        people = {
            p.id: p
            for p in session.exec(
                select(Employee).where(
                    employee_scope_clause(principal),
                    col(Employee.id).in_(
                        {
                            line.employee_id
                            for line in lines
                            if line.lender_department_id is None
                            and line.employee_id is not None
                        }
                    ),
                )
            ).all()
        }
    groups: dict[UUID, list[ProposalSegment]] = {}
    details = []
    for line in sorted(
        lines, key=lambda line: (line.start_date, line.created_at, line.id)
    ):
        borrowed = line.lender_department_id is not None
        key = line.employee_id if line.employee_id is not None else line.id
        groups.setdefault(key, []).append(ProposalSegment.model_validate(line))
        if not borrowed and line.employee_id is not None and line.employee_id in people:
            details.append(
                ProposalLinePublic(
                    id=line.id,
                    employee_id=line.employee_id,
                    employee_name=people[line.employee_id].display_name,
                    start_date=line.start_date,
                    end_date=line.end_date,
                    allocation_percent=line.allocation_percent,
                    outside_basis=line.outside_basis,
                )
            )
    return groups, details if detailed else None


def arrangement(
    principal: Principal,
    session: Session,
    lines: list[CapacityProposalLine],
    *,
    detailed: bool,
) -> CommitmentArrangement:
    groups, details = _grouped_lines(principal, session, lines, detailed=detailed)
    return CommitmentArrangement(
        participants=[
            ProposalParticipant(number=index, segments=segments)
            for index, segments in enumerate(groups.values(), start=1)
        ],
        lines=details,
    )


def _aligned_participants(
    prev_groups: dict[UUID, list[ProposalSegment]],
    curr_groups: dict[UUID, list[ProposalSegment]],
) -> tuple[list[ParticipantPublic], list[ParticipantPublic]]:
    prev_numbers = {key: index for index, key in enumerate(prev_groups, start=1)}
    removed = [key for key in prev_groups if key not in curr_groups]
    added = [key for key in curr_groups if key not in prev_groups]
    replaced = removed[0] if len(removed) == len(added) == 1 else None
    replaced_curr = {added[0]: prev_numbers[replaced]} if replaced is not None else {}
    next_number = len(prev_groups) + 1
    prev_participants: list[ParticipantPublic] = [
        ChangeProposalParticipant(
            number=prev_numbers[key],
            segments=segments,
            status=(
                "replaced"
                if key == replaced
                else "removed"
                if key not in curr_groups
                else "unchanged"
            ),
        )
        for key, segments in prev_groups.items()
    ]
    curr_participants: list[ParticipantPublic] = []
    for key, segments in curr_groups.items():
        status: ParticipantChangeStatus
        if key in prev_numbers:
            number, status = prev_numbers[key], "unchanged"
        elif key in replaced_curr:
            number, status = replaced_curr[key], "replaced"
        else:
            number, status = next_number, "added"
            next_number += 1
        curr_participants.append(
            ChangeProposalParticipant(number=number, segments=segments, status=status)
        )
    curr_participants.sort(key=lambda item: item.number)
    return prev_participants, curr_participants


def _schedule_phases(dates: Iterable[tuple[date, date]]) -> list[SchedulePhase]:
    return [
        SchedulePhase(start_date=start, end_date=end)
        for start, end in sorted(set(dates))
    ]


def schedule_summary(
    status: ProposalStatus, hold_expires_at: datetime, phases: list[SchedulePhase]
) -> ProposalSchedule:
    return ProposalSchedule(
        status=status,
        start_date=phases[0].start_date,
        end_date=max(phase.end_date for phase in phases),
        schedule_phases=phases,
        hold_expires_at=hold_expires_at if status == ProposalStatus.PENDING else None,
    )


def schedules_for_demands(
    session: Session, org_id: UUID, demands: Sequence[CapacityDemand]
) -> dict[UUID, ProposalSchedule]:
    by_id = {demand.id: demand for demand in demands}
    if not by_id:
        return {}
    proposals = [
        row
        for row in session.exec(
            select(CapacityProposal)
            .where(
                CapacityProposal.org_id == org_id,
                col(CapacityProposal.demand_id).in_(by_id),
            )
            .distinct(col(CapacityProposal.demand_id))
            .order_by(
                col(CapacityProposal.demand_id),
                col(CapacityProposal.created_at).desc(),
                col(CapacityProposal.id).desc(),
            )
        )
        if not reply_superseded(by_id[row.demand_id], row)
    ]
    if not proposals:
        return {}
    dates: dict[UUID, list[tuple[date, date]]] = defaultdict(list)
    for proposal_id, start, end in session.exec(
        select(
            CapacityProposalLine.proposal_id,
            col(CapacityProposalLine.start_date),
            col(CapacityProposalLine.end_date),
        ).where(
            CapacityProposalLine.org_id == org_id,
            col(CapacityProposalLine.proposal_id).in_([row.id for row in proposals]),
        )
    ):
        dates[proposal_id].append((start, end))
    return {
        row.demand_id: schedule_summary(
            row.status, row.hold_expires_at, _schedule_phases(dates[row.id])
        )
        for row in proposals
        if row.id in dates
    }


def public(
    principal: Principal,
    session: Session,
    demand: CapacityDemand,
    *,
    include_previous: bool = False,
) -> ProposalDetail | ProposalSummary | None:
    row = latest(session, principal.org_id, demand.id)
    if row is None or reply_superseded(demand, row):
        return None
    lines = lines_for(session, row)
    approvals = approvals_for(session, row)
    borrowed = any(line.lender_department_id is not None for line in lines)
    detailed = can_view_demand_internals(principal, demand)
    progress = None
    if borrowed:
        if row.status == ProposalStatus.FAILED:
            progress = tr("借调未达成")
        elif row.status == ProposalStatus.PENDING:
            if detailed:
                lender_count = sum(
                    a.party == "lender_manager" and a.decision == "approved"
                    for a in approvals
                )
                progress = (
                    tr(
                        "原部门已同意 {count}/{total}",
                        count=lender_count,
                        total=len(lines),
                    )
                    if lender_count < len(lines)
                    else tr("原部门已安排人员，等待本人同意")
                    if sum(
                        a.party == "employee" and a.decision == "approved"
                        for a in approvals
                    )
                    < len(lines)
                    else tr("借调已获同意，等待需求方接受")
                )
            else:
                progress = tr(
                    BORROW_ACCEPTED_PENDING
                    if any(
                        a.party == "requester" and a.decision == "approved"
                        for a in approvals
                    )
                    else "等待需求方确认"
                )
        else:
            progress = tr(
                BORROW_COMMITTED
                if row.status == ProposalStatus.COMMITTED
                else "借调已撤回"
            )
    conditions = ""
    if detailed and row.kind == "change":
        conditions = next(
            (a.reason or "" for a in approvals if a.party == "resource_manager"), ""
        )
    elif detailed:
        reply = session.exec(
            select(CapacityDemandEvent)
            .where(
                CapacityDemandEvent.org_id == principal.org_id,
                CapacityDemandEvent.demand_id == demand.id,
                CapacityDemandEvent.kind == DemandEventKind.REPLIED,
            )
            .order_by(
                col(CapacityDemandEvent.created_at).desc(),
                col(CapacityDemandEvent.id).desc(),
            )
        ).first()
        conditions = reply.text if reply else ""
    curr_phases = _schedule_phases((line.start_date, line.end_date) for line in lines)
    previous = None
    if (
        include_previous
        and row.replaces_proposal_id is not None
        and row.status == ProposalStatus.PENDING
    ):
        prev_lines = [
            line.model_copy(update={"start_date": a.start_date, "end_date": a.due_date})
            for a, line in active_segments(
                session, row.org_id, row.demand_id, row.replaces_proposal_id
            )
        ]
        prev_phases = _schedule_phases(
            (line.start_date, line.end_date) for line in prev_lines
        )
        if detailed:
            prev_groups, prev_details = _grouped_lines(
                principal, session, prev_lines, detailed=True
            )
            curr_groups, curr_details = _grouped_lines(
                principal, session, lines, detailed=True
            )
            prev_participants, curr_participants = _aligned_participants(
                prev_groups, curr_groups
            )
            previous = CommitmentArrangement(
                participants=prev_participants,
                lines=prev_details,
                schedule_phases=prev_phases,
            )
            current = CommitmentArrangement(
                participants=curr_participants,
                lines=curr_details,
                schedule_phases=curr_phases,
            )
        else:
            previous = CommitmentArrangement(
                participants=[], lines=None, schedule_phases=prev_phases
            )
            current = CommitmentArrangement(
                participants=[], lines=None, schedule_phases=curr_phases
            )
    elif detailed:
        current = arrangement(principal, session, lines, detailed=True)
        current.schedule_phases = curr_phases
    else:
        current = CommitmentArrangement(
            participants=[], lines=None, schedule_phases=curr_phases
        )
    summary = ProposalSummary(
        id=row.id,
        status=row.status,
        fail_reason=None if borrowed else row.fail_reason,
        revision=row.revision,
        hold_expires_at=row.hold_expires_at,
        committed_at=row.committed_at,
        kind="change" if row.kind == "change" else "initial",
        previous=previous,
        headcount=len(current.participants) if detailed else None,
        borrow_progress=progress,
        participants=(
            current.participants
            if detailed and (not borrowed or row.kind == "change")
            else []
        ),
        allocation_percents=(
            sorted({line.allocation_percent for line in lines}) if detailed else []
        ),
        schedule_phases=curr_phases,
        start_date=min(line.start_date for line in lines),
        end_date=max(line.end_date for line in lines),
        conditions=conditions,
        approvals=_public_approvals(principal, approvals, detailed=detailed),
    )
    if not detailed:
        return summary
    return ProposalDetail(**summary.model_dump(), lines=current.lines or [])
