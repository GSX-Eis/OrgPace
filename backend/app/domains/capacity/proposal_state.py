"""Proposal hold lifecycle, acceptance recheck, withdrawal, and expiration."""

from collections import defaultdict
from datetime import date, timedelta
from typing import cast
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import Session, col, select

from app.authz.deps import get_org_principal
from app.authz.principal import Principal
from app.domains.base import utc_now
from app.domains.capacity.common import (
    CapacityForbidden,
    CapacityNotFound,
    audit,
    demand_row,
    notify_employee,
    represents_department,
    require_rejection_reason,
    responder_user_ids,
    validate_department_text,
    validate_load_words,
)
from app.domains.capacity.demand_schemas import (
    BorrowLineInput,
    ChangeProposalInput,
    ProposalLineInput,
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
    DemandStatus,
    ProposalStatus,
)
from app.domains.capacity.proposal_validation import (
    ProposalConflict,
    check_lines,
    is_direct_commit,
)
from app.domains.capacity.proposal_views import (
    active_segments,
    approvals_for,
    latest,
    lines_for,
)
from app.domains.capacity.schemas import ReasonCode, Via
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.inbox.service import add_item
from app.i18n import bilingual, tr, use_locale
from app.models import User

HOLD_DURATION = timedelta(hours=72)


class ProposalFailed(ProposalConflict):
    """A known recheck failure; the REST boundary must commit before returning 409."""


class ProposalOwnershipError(ValueError):
    pass


class ProposalSelfApprovalForbidden(HTTPException):
    def __init__(self) -> None:
        super().__init__(403, "不能审批自己提交的方案")


def decided(row: CapacityProposal) -> ProposalConflict:
    return ProposalConflict(
        "方案已处理，请刷新后查看", code="proposal_decided", status=row.status
    )


def check_pending(row: CapacityProposal, revision: int, expected: int) -> None:
    if row.status != ProposalStatus.PENDING or revision != expected:
        raise decided(row)


def notify_parties(
    principal: Principal, session: Session, demand: CapacityDemand, message: str
) -> None:
    requesters = {demand.requester_user_id} | responder_user_ids(
        session, principal.org_id, demand.requesting_department_id
    )
    recipients = requesters | responder_user_ids(
        session, principal.org_id, demand.target_department_id
    )
    with use_locale("zh-CN"):
        head_zh = tr(message)
        req_zh = tr(
            "{head}（{cap}，{start} 至 {end}）。请前往「已发出的需求」查看方案状态。",
            head=head_zh,
            cap=demand.capability_name,
            start=demand.window_start,
            end=demand.window_end,
        )
        tgt_zh = tr(
            "{head}（{cap}，{start} 至 {end}）。请打开方案页查看需求状态。\n{url}",
            head=head_zh,
            cap=demand.capability_name,
            start=demand.window_start,
            end=demand.window_end,
            url=f"/capacity?tab=incoming&demand={demand.id}&plans=1",
        )
    with use_locale("en"):
        head_en = tr(message)
        req_en = tr(
            "{head}（{cap}，{start} 至 {end}）。请前往「已发出的需求」查看方案状态。",
            head=head_en,
            cap=demand.capability_name,
            start=demand.window_start,
            end=demand.window_end,
        )
        tgt_en = tr(
            "{head}（{cap}，{start} 至 {end}）。请打开方案页查看需求状态。\n{url}",
            head=head_en,
            cap=demand.capability_name,
            start=demand.window_start,
            end=demand.window_end,
            url=f"/capacity?tab=incoming&demand={demand.id}&plans=1",
        )
    for user_id in sorted(recipients):
        is_req = user_id in requesters
        add_item(
            session,
            InboxItem(
                org_id=principal.org_id,
                recipient_user_id=user_id,
                kind=InboxKind.CAPACITY,
                message=req_zh if is_req else tgt_zh,
                message_en=req_en if is_req else tgt_en,
            ),
        )


def fail(
    principal: Principal,
    session: Session,
    demand: CapacityDemand,
    row: CapacityProposal,
    reason: str,
    message: str,
    *,
    via: Via = "web",
    event_detail: str | None = None,
) -> None:
    if reason == "borrow_declined":
        principal = Principal.system_worker(row.org_id)
    row.status, row.fail_reason = ProposalStatus.FAILED, reason
    row.revision += 1
    if row.kind != "change":
        demand.status = DemandStatus.SUBMITTED
        demand.committed_start_date = demand.committed_end_date = None
    demand.revision += 1
    session.add_all(
        [
            row,
            demand,
            CapacityDemandEvent(
                org_id=principal.org_id,
                demand_id=demand.id,
                kind=DemandEventKind.PROPOSAL_FAILED,
                actor_user_id=principal.user_id or row.proposed_by_user_id,
                text=f"{message}：{event_detail}" if event_detail else message,
                via=via,
            ),
        ]
    )
    audit(
        principal,
        session,
        "capacity.demand_follow_up",
        "capacity_demand",
        demand.id,
        via,
        None,
        {"proposal_id": str(row.id), "fail_reason": reason},
    )
    notify_parties(principal, session, demand, message)
    session.flush()


def current_principal(session: Session, org_id: UUID, user_id: UUID) -> Principal:
    user = session.exec(
        select(User).where(User.id == user_id, User.is_active)
    ).one_or_none()
    if user is None:
        raise ProposalConflict("方案审批人的账号已停用")
    try:
        return get_org_principal(org_id, user, session)
    except HTTPException as error:
        if error.status_code != 404:
            raise
        raise ProposalConflict("方案审批人已不在本企业") from error


def expire_locked(
    principal: Principal,
    session: Session,
    demand: CapacityDemand,
    row: CapacityProposal,
    *,
    via: Via = "web",
) -> bool:
    if row.status != ProposalStatus.PENDING or row.hold_expires_at > utc_now():
        return False
    fail(
        principal, session, demand, row, "expired", "方案已过期，需要重新规划", via=via
    )
    return True


def assert_assignment_line(session: Session, assignment: CapacityAssignment) -> None:
    row = session.exec(
        select(CapacityProposalLine, CapacityProposal.demand_id)
        .join(
            CapacityProposal,
            (col(CapacityProposal.org_id) == CapacityProposalLine.org_id)
            & (col(CapacityProposal.id) == CapacityProposalLine.proposal_id),
        )
        .where(
            CapacityProposalLine.org_id == assignment.org_id,
            CapacityProposalLine.id == assignment.proposal_line_id,
        )
    ).one_or_none()
    if (
        row is None
        or row[1] != assignment.demand_id
        or row[0].employee_id != assignment.employee_id
    ):
        raise ProposalOwnershipError(
            "Assignment must belong to its proposal line's demand and employee"
        )


def check_requester_decision(
    principal: Principal,
    row: CapacityProposal,
    approvals: list[CapacityApproval],
    lines: list[CapacityProposalLine],
) -> None:
    if any(a.party == "requester" for a in approvals):
        raise decided(row)
    if any(
        a.user_id == principal.user_id and a.party in ("lender_manager", "employee")
        for a in approvals
    ) or any(
        line.lender_department_id is not None
        and line.employee_id is not None
        and line.employee_id == principal.employee_id
        for line in lines
    ):
        raise ProposalSelfApprovalForbidden()


def _ready_requester_approval(
    principal: Principal,
    session: Session,
    row: CapacityProposal,
    lines: list[CapacityProposalLine],
    approvals: list[CapacityApproval],
    employee_approvals: dict[UUID | None, UUID],
    *,
    via: Via,
    requester_accepts: bool,
) -> CapacityApproval | None:
    requester = next((a for a in approvals if a.party == "requester"), None)
    if requester_accepts:
        check_requester_decision(principal, row, approvals, lines)
        assert principal.user_id is not None
        requester = CapacityApproval(
            org_id=principal.org_id,
            proposal_id=row.id,
            party="requester",
            decision="approved",
            user_id=principal.user_id,
            via=via,
        )
    if lines[0].lender_department_id is not None and (
        requester is None or set(employee_approvals) != {line.id for line in lines}
    ):
        if requester_accepts:
            session.add(requester)
            row.revision += 1
            session.add(row)
            session.flush()
        return None
    assert requester is not None
    return requester


def _recheck_acceptance(
    session: Session,
    demand: CapacityDemand,
    row: CapacityProposal,
    requester: CapacityApproval,
    lines: list[CapacityProposalLine],
    approvals: list[CapacityApproval],
    employee_approvals: dict[UUID | None, UUID],
) -> Principal:
    proposer = current_principal(session, row.org_id, row.proposed_by_user_id)
    accepter = current_principal(session, row.org_id, requester.user_id)
    if not represents_department(proposer, demand.target_department_id):
        raise ProposalConflict("提议人已没有目标部门的审批权限")
    if not (
        accepter.user_id == demand.requester_user_id
        or demand.requesting_department_id in accepter.managed_department_ids
    ):
        raise ProposalConflict("接受人已没有需求方审批权限")
    if demand.revision != row.demand_revision or demand.status != (
        DemandStatus.ACCEPTED if row.kind == "change" else DemandStatus.REPLIED
    ):
        raise ProposalConflict("需求版本已变化，请重新规划")
    if any(line.employee_id is None for line in lines):
        raise ProposalConflict("借调尚未完成审批")
    inputs = [ProposalLineInput.model_validate(line) for line in lines]
    lender_department_id = lines[0].lender_department_id
    if lender_department_id is None:
        check_lines(
            proposer,
            session,
            demand,
            inputs,
            exclude=row.id,
            replace=row.kind == "change",
            conflict_viewer=accepter,
        )
    else:
        representatives = responder_user_ids(session, row.org_id, lender_department_id)
        selected = {
            a.line_id: a.user_id
            for a in approvals
            if a.party == "lender_manager" and a.decision == "approved"
        }
        if (
            set(selected) != {line.id for line in lines}
            or not set(selected.values()) <= representatives
        ):
            raise ProposalConflict("原部门审批权限已变化")
        if any(
            current_principal(
                session, row.org_id, employee_approvals[line.id]
            ).employee_id
            != line.employee_id
            for line in lines
        ):
            raise ProposalConflict("借调员工的账号已变化")
        lenders = {
            line_input.employee_id: current_principal(
                session, row.org_id, selected[line.id]
            )
            for line, line_input in zip(lines, inputs, strict=True)
        }
        check_lines(
            next(iter(lenders.values())),
            session,
            demand,
            inputs,
            exclude=row.id,
            replace=row.kind == "change",
            lender_department_id=lender_department_id,
            lenders=lenders,
        )
    return accepter


def _replace_segments(
    session: Session,
    demand: CapacityDemand,
    row: CapacityProposal,
    lines: list[CapacityProposalLine],
    accepter: Principal,
    acceptance_via: Via,
) -> set[UUID]:
    old_segments = (
        active_segments(session, row.org_id, demand.id, row.replaces_proposal_id)
        if row.replaces_proposal_id is not None
        else []
    )
    unchanged: dict[tuple[UUID, date | None, date, int], list[CapacityAssignment]] = (
        defaultdict(list)
    )
    for assignment, _ in old_segments:
        unchanged[
            (
                assignment.employee_id,
                assignment.start_date,
                assignment.due_date,
                assignment.allocation_percent,
            )
        ].append(assignment)
    added = []
    for line in lines:
        assert line.employee_id is not None
        retained = unchanged.get(
            (line.employee_id, line.start_date, line.end_date, line.allocation_percent)
        )
        if retained:
            kept = retained.pop()
            kept.proposal_line_id = line.id
            assert_assignment_line(session, kept)
            session.add(kept)
        else:
            added.append(line)
    for replaced in unchanged.values():
        for assignment in replaced:
            assignment.status, assignment.closed_at = (
                AssignmentStatus.CANCELLED,
                utc_now(),
            )
            session.add(assignment)
    if old_segments:
        session.flush()
    for line in added:
        assert line.employee_id is not None
        assignment = CapacityAssignment(
            org_id=row.org_id,
            demand_id=demand.id,
            employee_id=line.employee_id,
            proposal_line_id=line.id,
            allocation_percent=line.allocation_percent,
            start_date=line.start_date,
            due_date=line.end_date,
            assigned_by_user_id=row.proposed_by_user_id,
        )
        assert_assignment_line(session, assignment)
        session.add(assignment)
        audit(
            accepter,
            session,
            "capacity.assignment_created",
            "capacity_assignment",
            assignment.id,
            acceptance_via,
            None,
            {
                "proposal_id": str(row.id),
                "proposal_line_id": str(line.id),
                "outside_basis": line.outside_basis,
            },
        )
    return {line.employee_id for line in added if line.employee_id is not None} | {
        assignment.employee_id
        for replaced in unchanged.values()
        for assignment in replaced
    }


def create(
    principal: Principal,
    session: Session,
    demand: CapacityDemand,
    option_id: UUID,
    lines: list[ProposalLineInput | BorrowLineInput],
    *,
    change: ChangeProposalInput | None = None,
    direct_commit: bool = False,
    via: Via = "web",
) -> CapacityProposal:
    assert principal.user_id is not None
    if direct_commit:
        assert change is None and is_direct_commit(demand, lines, is_borrow=False)
        proposal_inputs = [
            line for line in lines if isinstance(line, ProposalLineInput)
        ]
        check_lines(
            principal,
            session,
            demand,
            proposal_inputs,
            confirm_forecasts=True,
            via=via,
        )
        now = utc_now()
        row = CapacityProposal(
            org_id=principal.org_id,
            demand_id=demand.id,
            source_option_id=option_id,
            kind="initial",
            status=ProposalStatus.COMMITTED,
            committed_at=now,
            revision=2,
            proposed_by_user_id=principal.user_id,
            demand_revision=demand.revision,
            hold_expires_at=now + HOLD_DURATION,
        )
        session.add(row)
        session.flush()
        proposal_lines = [
            CapacityProposalLine(
                org_id=principal.org_id, proposal_id=row.id, **line.model_dump()
            )
            for line in proposal_inputs
        ]
        session.add_all(proposal_lines)
        session.add(
            CapacityApproval(
                org_id=principal.org_id,
                proposal_id=row.id,
                party="resource_manager",
                decision="approved",
                user_id=principal.user_id,
                via=via,
            )
        )
        session.flush()
        assigned_people = _replace_segments(
            session, demand, row, proposal_lines, principal, via
        )
        demand.status = DemandStatus.ACCEPTED
        demand.committed_start_date = min(line.start_date for line in proposal_inputs)
        demand.committed_end_date = max(line.end_date for line in proposal_inputs)
        demand.revision += 1
        session.add(demand)
        session.add(
            CapacityDemandEvent(
                org_id=principal.org_id,
                demand_id=demand.id,
                actor_user_id=principal.user_id,
                kind=DemandEventKind.COMMITTED,
                text="",
                via=via,
            )
        )
        msg_zh, msg_en = bilingual(
            "协作分配已生效（{cap}，{start} 至 {end}）。请前往「我的负荷」核对安排。",
            cap=demand.capability_name,
            start=demand.window_start,
            end=demand.window_end,
        )
        for employee_id in sorted(assigned_people):
            notify_employee(
                principal,
                session,
                employee_id,
                msg_zh,
                message_en=msg_en,
            )
        notify_parties(principal, session, demand, "需求已接收并排期生效")
        audit(
            principal,
            session,
            "capacity.demand_accepted",
            "capacity_demand",
            demand.id,
            via,
            None,
            {"proposal_id": str(row.id), "direct_commit": True},
        )
        session.flush()
        return row
    previous = None
    if change is not None:
        previous = latest(
            session, demand.org_id, demand.id, status=ProposalStatus.COMMITTED
        )
        if (
            previous is None
            or demand.status != DemandStatus.ACCEPTED
            or demand.revision != change.revision
            or latest(
                session,
                demand.org_id,
                demand.id,
                lock=True,
                status=ProposalStatus.PENDING,
            )
            is not None
        ):
            raise ProposalConflict("需求状态或版本已变化，请刷新后重新发起变更")
        if principal.user_id == demand.requester_user_id:
            raise ProposalSelfApprovalForbidden()
        validate_department_text(
            principal, session, demand.target_department_id, change.reason
        )
        if change.lender_department_id is not None:
            validate_department_text(
                principal, session, change.lender_department_id, change.reason
            )
        validate_load_words(principal, session, demand, change.reason)
        if (
            demand.committed_end_date
            and max(line.end_date for line in lines) > demand.committed_end_date
        ):
            raise ProposalConflict("推迟完成日期请走延期审批")
    if proposal_inputs := [
        line for line in lines if isinstance(line, ProposalLineInput)
    ]:
        check_lines(
            principal,
            session,
            demand,
            proposal_inputs,
            replace=change is not None,
            confirm_forecasts=True,
            via=via,
        )
    if change is not None:
        demand.revision += 1
        session.add(demand)
        notify_parties(principal, session, demand, "有新的安排变更等待确认")
    row = CapacityProposal(
        org_id=principal.org_id,
        demand_id=demand.id,
        source_option_id=option_id,
        kind="change" if previous else "initial",
        replaces_proposal_id=previous.id if previous else None,
        proposed_by_user_id=principal.user_id,
        demand_revision=demand.revision,
        hold_expires_at=utc_now() + HOLD_DURATION,
    )
    session.add(row)
    session.flush()
    session.add_all(
        [
            CapacityProposalLine(
                org_id=principal.org_id, proposal_id=row.id, **line.model_dump()
            )
            for line in lines
        ]
    )
    session.add(
        CapacityApproval(
            org_id=principal.org_id,
            proposal_id=row.id,
            party="resource_manager",
            reason=change.reason if change is not None else None,
            decision="approved",
            user_id=principal.user_id,
            via=via,
        )
    )
    session.flush()
    if isinstance(lines[0], BorrowLineInput):
        msg_zh, msg_en = bilingual(
            "借调请求（{cap}，{start} 至 {end}）。请前往「待审批 → 借调确认」选择借出人员。",
            cap=demand.capability_name,
            start=demand.window_start,
            end=demand.window_end,
        )
        for user_id in responder_user_ids(
            session, principal.org_id, lines[0].lender_department_id
        ):
            add_item(
                session,
                InboxItem(
                    org_id=principal.org_id,
                    recipient_user_id=user_id,
                    kind=InboxKind.CAPACITY,
                    message=msg_zh,
                    message_en=msg_en,
                ),
            )
    return row


def accept(
    principal: Principal,
    session: Session,
    demand: CapacityDemand,
    row: CapacityProposal,
    *,
    via: Via,
    requester_accepts: bool = True,
) -> None:
    failure_actor = (
        principal if requester_accepts else Principal.system_worker(row.org_id)
    )
    if expire_locked(failure_actor, session, demand, row, via=via):
        raise ProposalFailed("方案已过期，请对方重新安排", code="proposal_expired")
    lines = lines_for(session, row)
    lender_department_id = lines[0].lender_department_id
    approvals = approvals_for(session, row)
    employee_approvals = {
        a.line_id: a.user_id
        for a in approvals
        if a.party == "employee" and a.decision == "approved"
    }
    requester = _ready_requester_approval(
        principal,
        session,
        row,
        lines,
        approvals,
        employee_approvals,
        via=via,
        requester_accepts=requester_accepts,
    )
    if requester is None:
        return
    try:
        accepter = _recheck_acceptance(
            session,
            demand,
            row,
            requester,
            lines,
            approvals,
            employee_approvals,
        )
    except ProposalConflict as error:
        if expire_locked(failure_actor, session, demand, row, via=via):
            raise ProposalFailed(
                "方案已过期，请对方重新安排", code="proposal_expired"
            ) from error
        fail(
            failure_actor,
            session,
            demand,
            row,
            "recheck_failed",
            "借调未达成"
            if lender_department_id is not None
            else "方案复核未通过，需要重新规划",
            via=via,
        )
        if lender_department_id is not None:
            raise ProposalFailed(
                "借调未达成", code="proposal_recheck_failed"
            ) from error
        # The accepter only receives department-level failure details.
        raise ProposalFailed(
            "方案复核未通过，请对方重新安排",
            code="proposal_recheck_failed",
            reason=error.detail,
        ) from error
    if expire_locked(failure_actor, session, demand, row, via=via):
        raise ProposalFailed("方案已过期，请对方重新安排", code="proposal_expired")
    if requester_accepts:
        session.add(requester)
    acceptance_via = cast(Via, requester.via)
    previous_end = demand.committed_end_date
    changed_people = _replace_segments(
        session, demand, row, lines, accepter, acceptance_via
    )
    change = row.kind == "change"
    if change:
        demand.committed_start_date = min(line.start_date for line in lines)
        demand.committed_end_date = max(line.end_date for line in lines)
    row.status, row.committed_at = ProposalStatus.COMMITTED, utc_now()
    row.revision += 1
    demand.status = DemandStatus.ACCEPTED
    demand.revision += 1
    session.add_all([row, demand])
    event_kinds = (
        (DemandEventKind.COMMITMENT_CHANGED,)
        if change
        else (
            DemandEventKind.ACCEPTED,
            DemandEventKind.COMMITTED,
        )
    )
    for kind in event_kinds:
        session.add(
            CapacityDemandEvent(
                org_id=principal.org_id,
                demand_id=demand.id,
                actor_user_id=requester.user_id,
                kind=kind,
                text="安排变更已生效" if change else "",
                start_date=demand.committed_start_date if change else None,
                end_date=demand.committed_end_date if change else None,
                basis={
                    "previous_end_date": previous_end.isoformat(),
                    "revision": demand.revision,
                }
                if change and previous_end
                else {},
                via=acceptance_via,
            )
        )
    msg_zh, msg_en = bilingual(
        "协作分配已更新（{cap}，{start} 至 {end}）。请前往「我的负荷」核对安排。"
        if change
        else "协作分配已生效（{cap}，{start} 至 {end}）。请前往「我的负荷」核对安排。",
        cap=demand.capability_name,
        start=demand.window_start,
        end=demand.window_end,
    )
    for employee_id in sorted(changed_people):
        notify_employee(
            principal,
            session,
            employee_id,
            msg_zh,
            message_en=msg_en,
        )
    notify_parties(
        principal,
        session,
        demand,
        "安排变更已生效" if change else "方案已接受，安排已生效",
    )
    audit(
        accepter,
        session,
        "capacity.commitment_changed" if change else "capacity.demand_accepted",
        "capacity_demand",
        demand.id,
        acceptance_via,
        None,
        {
            "proposal_id": str(row.id),
            **(
                {"replaces_proposal_id": str(row.replaces_proposal_id)}
                if change
                else {}
            ),
        },
    )
    session.flush()


def respond_proposal(
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
) -> None:
    if row.kind == "change" and via != "web":
        raise ProposalConflict("请在网页发起或确认变更")
    if row.kind == "change" and action == "withdraw":
        raise ProposalConflict("已生效的需求不能撤回，可拒绝本次变更")
    if via == "mcp" and action == "accept":
        raise CapacityForbidden()
    if principal.user_id == row.proposed_by_user_id and action in (
        "accept",
        "follow_up",
    ):
        raise ProposalSelfApprovalForbidden()
    expected = (
        row.demand_revision
        if row.kind == "change"
        and action == "accept"
        and revision == row.demand_revision
        else demand.revision
    )
    check_pending(row, revision, expected)
    if action == "follow_up":
        require_rejection_reason(reason_code, text)
    if expire_locked(principal, session, demand, row, via=via):
        raise ProposalFailed("方案已过期，请对方重新安排", code="proposal_expired")
    if action == "accept":
        accept(principal, session, demand, row, via=via)
    elif action == "follow_up":
        check_requester_decision(
            principal, row, approvals_for(session, row), lines_for(session, row)
        )
        if not text or not text.strip() or len(text) > 500:
            raise ProposalConflict("拒绝方案时必须填写不超过 500 字的理由")
        assert principal.user_id is not None
        session.add(
            CapacityApproval(
                org_id=principal.org_id,
                proposal_id=row.id,
                party="requester",
                decision="rejected",
                user_id=principal.user_id,
                via=via,
                reason=text,
                reason_code=reason_code,
            )
        )
        fail(
            principal,
            session,
            demand,
            row,
            "rejected",
            "安排变更被拒绝" if row.kind == "change" else "方案被拒，需要重新规划",
            via=via,
            event_detail=text if row.kind != "change" else None,
        )
    else:
        withdraw_locked(principal, session, demand, row, withdraw_demand=True, via=via)


def withdraw_locked(
    principal: Principal,
    session: Session,
    demand: CapacityDemand,
    row: CapacityProposal,
    *,
    withdraw_demand: bool = False,
    via: Via = "web",
) -> None:
    assert principal.user_id is not None
    row.status, row.fail_reason = ProposalStatus.WITHDRAWN, None
    row.revision += 1
    if row.kind != "change":
        demand.status = (
            DemandStatus.WITHDRAWN if withdraw_demand else DemandStatus.SUBMITTED
        )
        demand.committed_start_date = demand.committed_end_date = None
    demand.revision += 1
    session.add_all(
        [
            row,
            demand,
            CapacityDemandEvent(
                org_id=principal.org_id,
                demand_id=demand.id,
                actor_user_id=principal.user_id,
                kind=DemandEventKind.WITHDRAWN,
                text="需求已撤回" if withdraw_demand else "方案已撤回，需要重新规划",
                via=via,
            ),
        ]
    )
    audit(
        principal,
        session,
        "capacity.demand_withdrawn",
        "capacity_demand",
        demand.id,
        via,
        None,
        {"proposal_id": str(row.id), "withdraw_demand": withdraw_demand},
    )
    notify_parties(
        principal,
        session,
        demand,
        "协作需求已撤回" if withdraw_demand else "方案已撤回，需要重新规划",
    )
    session.flush()


def withdraw_proposal(
    principal: Principal, session: Session, proposal_id: UUID, revision: int
) -> UUID:
    row = session.exec(
        select(CapacityProposal).where(
            CapacityProposal.org_id == principal.org_id,
            CapacityProposal.id == proposal_id,
        )
    ).one_or_none()
    if row is None:
        raise CapacityNotFound()
    demand = demand_row(principal, session, row.demand_id, lock=True)
    if not represents_department(principal, demand.target_department_id):
        raise CapacityNotFound()
    session.refresh(row, with_for_update=True)
    check_pending(row, revision, row.revision)
    if expire_locked(principal, session, demand, row):
        raise ProposalFailed("方案已过期，请重新规划", code="proposal_expired")
    withdraw_locked(principal, session, demand, row)
    return demand.id


def expire(principal: Principal, session: Session) -> int:
    ids = session.exec(
        select(CapacityProposal.id, CapacityProposal.demand_id)
        .where(
            CapacityProposal.org_id == principal.org_id,
            CapacityProposal.status == ProposalStatus.PENDING,
            CapacityProposal.hold_expires_at <= utc_now(),
        )
        .order_by(col(CapacityProposal.demand_id), col(CapacityProposal.id))
    ).all()
    count = 0
    for proposal_id, demand_id in ids:
        # Use the same demand -> proposal lock order as accept and withdraw.
        demand = session.exec(
            select(CapacityDemand)
            .where(
                CapacityDemand.org_id == principal.org_id,
                CapacityDemand.id == demand_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        ).one()
        row = session.exec(
            select(CapacityProposal)
            .where(
                CapacityProposal.org_id == principal.org_id,
                CapacityProposal.id == proposal_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        ).one()
        if expire_locked(principal, session, demand, row):
            count += 1
    return count
