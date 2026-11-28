"""Thin facade re-exporting capacity proposal submodules."""

from uuid import UUID

from sqlmodel import Session

from app.authz.principal import Principal
from app.domains.capacity.demand import get_demand
from app.domains.capacity.demand_schemas import DemandPublic
from app.domains.capacity.models import CapacityDemand, CapacityProposal
from app.domains.capacity.proposal_borrow import (
    borrow_requests as borrow_requests,
)
from app.domains.capacity.proposal_borrow import (
    decide_borrow as decide_borrow,
)
from app.domains.capacity.proposal_state import (
    HOLD_DURATION as HOLD_DURATION,
)
from app.domains.capacity.proposal_state import (
    ProposalFailed as ProposalFailed,
)
from app.domains.capacity.proposal_state import (
    ProposalOwnershipError as ProposalOwnershipError,
)
from app.domains.capacity.proposal_state import (
    ProposalSelfApprovalForbidden as ProposalSelfApprovalForbidden,
)
from app.domains.capacity.proposal_state import (
    _ready_requester_approval as _ready_requester_approval,
)
from app.domains.capacity.proposal_state import (
    _recheck_acceptance as _recheck_acceptance,
)
from app.domains.capacity.proposal_state import (
    _replace_segments as _replace_segments,
)
from app.domains.capacity.proposal_state import (
    accept as accept,
)
from app.domains.capacity.proposal_state import (
    assert_assignment_line as assert_assignment_line,
)
from app.domains.capacity.proposal_state import (
    check_pending as check_pending,
)
from app.domains.capacity.proposal_state import (
    check_requester_decision as check_requester_decision,
)
from app.domains.capacity.proposal_state import (
    create as create,
)
from app.domains.capacity.proposal_state import (
    current_principal as current_principal,
)
from app.domains.capacity.proposal_state import (
    decided as decided,
)
from app.domains.capacity.proposal_state import (
    expire as expire,
)
from app.domains.capacity.proposal_state import (
    expire_locked as expire_locked,
)
from app.domains.capacity.proposal_state import (
    fail as fail,
)
from app.domains.capacity.proposal_state import (
    notify_parties as notify_parties,
)
from app.domains.capacity.proposal_state import (
    respond_proposal,
    withdraw_proposal,
)
from app.domains.capacity.proposal_state import (
    withdraw_locked as withdraw_locked,
)
from app.domains.capacity.proposal_validation import (
    ProposalConflict as ProposalConflict,
)
from app.domains.capacity.proposal_validation import (
    _over_week_entry as _over_week_entry,
)
from app.domains.capacity.proposal_validation import (
    _verify_employee_weeks as _verify_employee_weeks,
)
from app.domains.capacity.proposal_validation import (
    check_lines as check_lines,
)
from app.domains.capacity.proposal_validation import (
    conflict_sources as conflict_sources,
)
from app.domains.capacity.proposal_validation import (
    is_direct_commit as is_direct_commit,
)
from app.domains.capacity.proposal_validation import (
    plan_lines as plan_lines,
)
from app.domains.capacity.proposal_views import (
    BORROW_ACCEPTED_PENDING as BORROW_ACCEPTED_PENDING,
)
from app.domains.capacity.proposal_views import (
    BORROW_COMMITTED as BORROW_COMMITTED,
)
from app.domains.capacity.proposal_views import (
    _aligned_participants as _aligned_participants,
)
from app.domains.capacity.proposal_views import (
    _grouped_lines as _grouped_lines,
)
from app.domains.capacity.proposal_views import (
    _public_approvals as _public_approvals,
)
from app.domains.capacity.proposal_views import (
    _schedule_phases as _schedule_phases,
)
from app.domains.capacity.proposal_views import (
    active_segments as active_segments,
)
from app.domains.capacity.proposal_views import (
    approvals_for as approvals_for,
)
from app.domains.capacity.proposal_views import (
    arrangement as arrangement,
)
from app.domains.capacity.proposal_views import (
    decision_history as decision_history,
)
from app.domains.capacity.proposal_views import (
    latest as latest,
)
from app.domains.capacity.proposal_views import (
    lines_for as lines_for,
)
from app.domains.capacity.proposal_views import (
    public as public,
)
from app.domains.capacity.proposal_views import (
    reply_superseded as reply_superseded,
)
from app.domains.capacity.proposal_views import (
    schedule_summary as schedule_summary,
)
from app.domains.capacity.proposal_views import (
    schedules_for_demands as schedules_for_demands,
)
from app.domains.capacity.schemas import ReasonCode, Via


def respond(
    principal: Principal,
    session: Session,
    demand: CapacityDemand,
    row: CapacityProposal,
    action: str,
    revision: int,
    text: str | None,
    *,
    reason_code: ReasonCode | None = None,
    via: Via,
) -> DemandPublic:
    respond_proposal(
        principal,
        session,
        demand,
        row,
        action,
        revision,
        text,
        reason_code=reason_code,
        via=via,
    )
    return get_demand(principal, session, demand.id)


def withdraw(
    principal: Principal, session: Session, proposal_id: UUID, revision: int
) -> DemandPublic:
    demand_id = withdraw_proposal(principal, session, proposal_id, revision)
    return get_demand(principal, session, demand_id)


__all__ = [
    "BORROW_ACCEPTED_PENDING",
    "BORROW_COMMITTED",
    "HOLD_DURATION",
    "ProposalConflict",
    "ProposalFailed",
    "ProposalOwnershipError",
    "ProposalSelfApprovalForbidden",
    "accept",
    "active_segments",
    "approvals_for",
    "arrangement",
    "assert_assignment_line",
    "borrow_requests",
    "check_lines",
    "check_pending",
    "check_requester_decision",
    "conflict_sources",
    "create",
    "current_principal",
    "decide_borrow",
    "decided",
    "decision_history",
    "expire",
    "expire_locked",
    "fail",
    "is_direct_commit",
    "latest",
    "lines_for",
    "notify_parties",
    "plan_lines",
    "public",
    "reply_superseded",
    "respond",
    "schedule_summary",
    "schedules_for_demands",
    "withdraw",
    "withdraw_locked",
]
