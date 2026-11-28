"""Cross-department borrow request listing and approval decisions."""

from uuid import UUID

from sqlmodel import Session, col, select

from app.authz.policies import employee_scope_clause
from app.authz.principal import Principal
from app.domains.base import utc_now
from app.domains.capacity.common import (
    CapacityNotFound,
    department,
    qualified_people,
    require_enabled,
    require_rejection_reason,
    responder_user_ids,
)
from app.domains.capacity.demand_schemas import (
    BorrowCandidate,
    BorrowDecisionInput,
    BorrowRequest,
    ProposalLineInput,
)
from app.domains.capacity.models import (
    CapacityApproval,
    CapacityDemand,
    CapacityProposal,
    CapacityProposalLine,
    ProposalStatus,
)
from app.domains.capacity.proposal_state import (
    ProposalFailed,
    ProposalSelfApprovalForbidden,
    accept,
    decided,
    expire_locked,
    fail,
)
from app.domains.capacity.proposal_validation import ProposalConflict, check_lines
from app.domains.capacity.proposal_views import approvals_for, lines_for
from app.domains.inbox.models import InboxItem, InboxKind, InboxTargetType
from app.domains.inbox.service import add_item
from app.domains.org.models import Employee, OrgMembership
from app.i18n import bilingual
from app.models import User


def borrow_requests(
    principal: Principal, session: Session, *, mine: bool
) -> list[BorrowRequest]:
    require_enabled(principal, session)
    if mine and principal.employee_id is None:
        return []
    rows = session.exec(
        select(CapacityProposalLine, CapacityProposal, CapacityDemand)
        .join(
            CapacityProposal,
            (col(CapacityProposal.id) == CapacityProposalLine.proposal_id)
            & (col(CapacityProposal.org_id) == CapacityProposalLine.org_id),
        )
        .join(
            CapacityDemand,
            (col(CapacityDemand.id) == CapacityProposal.demand_id)
            & (col(CapacityDemand.org_id) == CapacityProposal.org_id),
        )
        .where(
            CapacityProposalLine.org_id == principal.org_id,
            col(CapacityProposalLine.lender_department_id).is_not(None),
            col(CapacityProposal.status).in_(
                (ProposalStatus.PENDING, ProposalStatus.FAILED)
            ),
            *(
                [CapacityProposalLine.employee_id == principal.employee_id]
                if mine
                else []
            ),
        )
        .order_by(col(CapacityProposal.created_at).desc(), col(CapacityProposalLine.id))
    ).all()
    result: list[BorrowRequest] = []
    representatives: dict[UUID, set[UUID]] = {}
    candidates: dict[UUID, list[BorrowCandidate]] = {}
    for line, row, demand in rows:
        lender = line.lender_department_id
        assert lender is not None
        if not mine:
            if lender not in representatives:
                representatives[lender] = responder_user_ids(
                    session, row.org_id, lender
                )
            if principal.user_id not in representatives[lender]:
                continue
        own = None
        if mine:
            own = next(
                (
                    a
                    for a in approvals_for(session, row)
                    if a.party == "employee"
                    and a.line_id == line.id
                    and a.user_id == principal.user_id
                ),
                None,
            )
        if row.status == ProposalStatus.FAILED or row.hold_expires_at <= utc_now():
            status = "failed"
        elif mine:
            status = "waiting_commitment" if own is not None else "pending_consent"
        else:
            status = "pending_selection" if line.employee_id is None else "selected"
        if status == "pending_selection" and demand.id not in candidates:
            candidates[demand.id] = [
                BorrowCandidate(
                    employee_id=person.employee_id, display_name=person.display_name
                )
                for person in qualified_people(
                    principal, session, demand, lender
                ).values()
                if person.employee_id != principal.employee_id
            ]
        result.append(
            BorrowRequest(
                id=line.id,
                description=demand.description,
                capability_name=demand.capability_name,
                borrower_department=department(
                    session, row.org_id, demand.target_department_id
                ).name,
                allocation_percent=line.allocation_percent,
                start_date=line.start_date,
                end_date=line.end_date,
                status=status,
                reason=own.reason if mine and own else None,
                reason_code=own.reason_code if own else None,
                candidates=candidates[demand.id]
                if status == "pending_selection"
                else [],
            )
        )
    return result


def decide_borrow(
    principal: Principal, session: Session, line_id: UUID, body: BorrowDecisionInput
) -> None:
    require_enabled(principal, session)
    line, row = session.exec(
        select(CapacityProposalLine, CapacityProposal)
        .join(
            CapacityProposal,
            (col(CapacityProposal.id) == CapacityProposalLine.proposal_id)
            & (col(CapacityProposal.org_id) == CapacityProposalLine.org_id),
        )
        .where(
            CapacityProposalLine.org_id == principal.org_id,
            CapacityProposalLine.id == line_id,
        )
    ).one_or_none() or (None, None)
    if (
        line is None
        or row is None
        or line.lender_department_id is None
        or principal.user_id is None
    ):
        raise CapacityNotFound()
    demand = session.exec(
        select(CapacityDemand)
        .where(CapacityDemand.org_id == row.org_id, CapacityDemand.id == row.demand_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one()
    session.refresh(row, with_for_update=True)
    session.refresh(line)
    manager = body.action in ("select", "reject")
    if manager:
        if principal.user_id not in responder_user_ids(
            session, row.org_id, line.lender_department_id
        ):
            raise CapacityNotFound()
    elif line.employee_id is None or line.employee_id != principal.employee_id:
        raise CapacityNotFound()
    if row.status != ProposalStatus.PENDING:
        raise decided(row)
    declined = body.action in ("reject", "decline")
    if declined:
        require_rejection_reason(body.reason_code, body.reason)
    failure_actor = principal if manager else Principal.system_worker(row.org_id)
    if expire_locked(failure_actor, session, demand, row):
        raise ProposalFailed("借调未达成", code="proposal_expired")
    party = "lender_manager" if manager else "employee"
    approvals = approvals_for(session, row)
    if any(a.party == party and a.line_id == line.id for a in approvals):
        raise decided(row)
    lines = lines_for(session, row)
    if (
        principal.user_id in (row.proposed_by_user_id, demand.requester_user_id)
        or any(a.user_id == principal.user_id and a.party != party for a in approvals)
        or (
            manager
            and any(
                other.employee_id is not None
                and other.employee_id == principal.employee_id
                for other in lines
            )
        )
    ):
        raise ProposalSelfApprovalForbidden()
    if body.action == "select":
        if body.employee_id is None:
            raise ProposalConflict("请选择借调员工")
        if any(other.employee_id == body.employee_id for other in lines):
            raise ProposalConflict("这名员工已在本次借调中")
        member = session.exec(
            select(OrgMembership)
            .join(User, col(OrgMembership.user_id) == User.id)
            .join(
                Employee,
                (col(Employee.org_id) == OrgMembership.org_id)
                & (col(Employee.id) == OrgMembership.employee_id),
            )
            .where(
                employee_scope_clause(principal),
                OrgMembership.org_id == row.org_id,
                OrgMembership.employee_id == body.employee_id,
                User.is_active,
            )
        ).one_or_none()
        if member is None:
            raise ProposalConflict("借调员工需要可登录的账号")
        if member.user_id in (
            principal.user_id,
            row.proposed_by_user_id,
            demand.requester_user_id,
            *(a.user_id for a in approvals if a.party != "employee"),
        ):
            raise ProposalSelfApprovalForbidden()
        check_lines(
            principal,
            session,
            demand,
            [
                ProposalLineInput(
                    employee_id=body.employee_id,
                    allocation_percent=line.allocation_percent,
                    start_date=line.start_date,
                    end_date=line.end_date,
                )
            ],
            lender_department_id=line.lender_department_id,
            replace=row.kind == "change",
        )
        if expire_locked(principal, session, demand, row):
            raise ProposalFailed("借调未达成", code="proposal_expired")
        line.employee_id = body.employee_id
        session.add(line)
        msg_zh, msg_en = bilingual(
            "借调请求待你确认（{cap}，{start} 至 {end}）。请前往「待审批 → 借调确认」处理。",
            cap=demand.capability_name,
            start=line.start_date,
            end=line.end_date,
        )
        add_item(
            session,
            InboxItem(
                org_id=row.org_id,
                recipient_employee_id=line.employee_id,
                kind=InboxKind.CAPACITY,
                target_type=InboxTargetType.REVIEWS_BORROW,
                message=msg_zh,
                message_en=msg_en,
            ),
        )
    if body.action == "reject" and body.reason is None:
        raise ProposalConflict("请填写拒绝理由")
    session.add(
        CapacityApproval(
            org_id=row.org_id,
            proposal_id=row.id,
            line_id=line.id,
            user_id=principal.user_id,
            party=party,
            via="web",
            decision="rejected" if declined else "approved",
            reason=(body.reason or "未填写理由") if declined else None,
            reason_code=body.reason_code if declined else None,
        )
    )
    if declined:
        fail(
            principal,
            session,
            demand,
            row,
            "rejected" if manager else "borrow_declined",
            "借调未达成",
        )
    else:
        row.revision += 1
        session.add(row)
        session.flush()
        if not manager:
            accept(principal, session, demand, row, via="web", requester_accepts=False)
