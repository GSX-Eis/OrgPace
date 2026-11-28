"""Compose planning reads/snapshots with capacity demand & proposal mutations."""

from uuid import UUID

from sqlmodel import Session, col, select

from app.authz.principal import Principal
from app.domains.capacity.demand import (
    can_view_demand_internals,
    decision_history,
    demand_row,
    get_demand,
    reply_demand,
    represents_department,
)
from app.domains.capacity.demand_schemas import (
    ChangeProposalInput,
    DemandHistory,
    DemandPublic,
    PlanReplyInput,
    SnapshotDecision,
    SnapshotOptionDecision,
)
from app.domains.capacity.models import DemandOutcome
from app.domains.capacity.proposal import (
    ProposalConflict,
    is_direct_commit,
    plan_lines,
)
from app.domains.capacity.proposal import (
    create as create_proposal,
)
from app.domains.capacity.schemas import Via
from app.domains.planning import service as planning
from app.domains.planning.models import (
    OptionKind,
    PlanningCase,
    PlanningOption,
    PlanningSnapshot,
    PlanVerdict,
)
from app.domains.planning.schemas import KIND_LABELS, VERDICT_LABELS
from app.i18n import tr


def demand_snapshot_history(
    principal: Principal, session: Session, demand_id: UUID
) -> DemandHistory:
    row = demand_row(principal, session, demand_id)
    history = decision_history(principal, session, row)
    if can_view_demand_internals(principal, row):
        snapshots: dict[UUID, SnapshotDecision] = {}
        for snapshot_id, created_at, kind, verdict in session.exec(
            select(
                PlanningSnapshot.id,
                PlanningSnapshot.created_at,
                PlanningOption.kind,
                PlanningOption.verdict,
            )
            .join(
                PlanningCase,
                (col(PlanningCase.org_id) == PlanningSnapshot.org_id)
                & (col(PlanningCase.id) == PlanningSnapshot.case_id),
            )
            .outerjoin(
                PlanningOption,
                (col(PlanningOption.org_id) == PlanningSnapshot.org_id)
                & (col(PlanningOption.snapshot_id) == PlanningSnapshot.id),
            )
            .where(
                PlanningCase.org_id == principal.org_id,
                PlanningCase.demand_id == row.id,
            )
            .order_by(
                col(PlanningSnapshot.created_at),
                col(PlanningSnapshot.id),
                col(PlanningOption.created_at),
                col(PlanningOption.id),
            )
        ):
            snapshot = snapshots.setdefault(
                snapshot_id, SnapshotDecision(id=snapshot_id, created_at=created_at)
            )
            if kind is not None and verdict is not None:
                snapshot.options.append(
                    SnapshotOptionDecision(
                        kind_label=tr(KIND_LABELS[OptionKind(kind)]),
                        verdict_label=tr(VERDICT_LABELS[PlanVerdict(verdict)]),
                    )
                )
        history.snapshots = list(snapshots.values())
    return history


def propose_plan(
    principal: Principal,
    session: Session,
    demand_id: UUID,
    body: PlanReplyInput | ChangeProposalInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
    include_previous: bool = False,
) -> DemandPublic:
    """Compose Planning option verification with Capacity reply and proposal writes."""
    assert body.option_id is not None
    row = demand_row(principal, session, demand_id, lock=True)
    if not represents_department(principal, row.target_department_id):
        raise planning.PlanningStale()
    if isinstance(body, PlanReplyInput) and body.outcome == DemandOutcome.NOT_NOW:
        raise ProposalConflict("暂不能承接的答复不能带方案")
    found = session.exec(
        select(PlanningOption, PlanningSnapshot.case_id)
        .join(
            PlanningSnapshot,
            (col(PlanningSnapshot.org_id) == PlanningOption.org_id)
            & (col(PlanningSnapshot.id) == PlanningOption.snapshot_id),
        )
        .where(
            PlanningOption.org_id == principal.org_id,
            PlanningOption.id == body.option_id,
        )
    ).one_or_none()
    if found is None:
        raise planning.PlanningStale()
    saved, case_id = found
    _, snapshot, case_demand = planning.authorized_case(principal, session, case_id)
    if case_demand.id != demand_id or saved.snapshot_id != snapshot.id:
        raise planning.PlanningStale()
    if saved.verdict not in (PlanVerdict.FEASIBLE, PlanVerdict.CONDITIONAL):
        raise ProposalConflict("只有可行或有条件可行的方案可以提议")
    lines = plan_lines(
        principal,
        session,
        row,
        body,
        saved.params,
        borrow=saved.kind == OptionKind.BORROW,
    )
    current = planning.get_case(principal, session, case_id)
    if current.stale or current.snapshot_id != saved.snapshot_id:
        raise planning.PlanningStale()
    if isinstance(body, ChangeProposalInput):
        create_proposal(principal, session, row, body.option_id, lines, change=body)
    else:
        direct = is_direct_commit(row, lines, is_borrow=saved.kind == OptionKind.BORROW)
        reply_demand(
            principal,
            session,
            demand_id,
            **body.model_dump(
                exclude={
                    "demand_id",
                    "lender_department_id",
                    "borrow_headcount",
                    "option_id",
                    "outside_basis",
                    "start_date",
                    "end_date",
                }
            ),
            start_date=min(line.start_date for line in lines),
            end_date=max(line.end_date for line in lines),
            via=via,
            client_name=client_name,
            allow_legacy_reply=True,
            notify_requester=not direct,
        )
        create_proposal(
            principal,
            session,
            row,
            body.option_id,
            lines,
            direct_commit=direct,
            via=via,
        )
    return get_demand(principal, session, demand_id, include_previous=include_previous)
