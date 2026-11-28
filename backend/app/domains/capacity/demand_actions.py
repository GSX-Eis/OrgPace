"""Capacity demand creation, reply, and response state transitions."""

from datetime import date
from typing import Literal
from uuid import UUID

from sqlmodel import Session

from app.authz.policies import (
    can_manage_department,
    can_view_org_aggregates,
    manages_department,
)
from app.authz.principal import Principal
from app.domains.capacity.common import (
    DEMAND_NOT_FOUND,
    CapacityConflict,
    CapacityForbidden,
    CapacityNotFound,
    audit,
    demand_row,
    department,
    employee,
    represents_department,
    require_rejection_reason,
    responder_user_ids,
    validate_department_text,
    validate_load_words,
)
from app.domains.capacity.demand_schemas import (
    DemandInput,
    DemandPublic,
    DetailedCapacityReference,
    ProjectRoleInput,
    ReplyInput,
    RespondInput,
)
from app.domains.capacity.demand_views import (
    demand_public,
    department_reference,
    get_demand,
    is_legacy_verbal_reply,
    require_requester,
)
from app.domains.capacity.models import (
    CapacityDemand,
    CapacityDemandEvent,
    DemandEventKind,
    DemandOutcome,
    DemandStatus,
    ProposalStatus,
)
from app.domains.capacity.proposal_state import respond_proposal
from app.domains.capacity.proposal_views import latest, reply_superseded
from app.domains.capacity.schemas import ReasonCode, Via
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.inbox.service import add_item
from app.i18n import bilingual


class DemandAwaitingSchedule(CapacityConflict):
    def __init__(self) -> None:
        super().__init__()
        self.detail = "请等待目标部门经理排期。"


def submit_demand(
    principal: Principal,
    session: Session,
    target_department_id: UUID,
    capability_key: str,
    requesting_department_id: UUID,
    headcount: int | None,
    allocation_percent: int | None,
    window_start: date,
    window_end: date,
    description: str,
    minimum_level: str | None = None,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> DemandPublic:
    body = DemandInput(
        target_department_id=target_department_id,
        capability_key=capability_key,
        requesting_department_id=requesting_department_id,
        headcount=headcount,
        allocation_percent=allocation_percent,
        window_start=window_start,
        window_end=window_end,
        description=description,
        minimum_level=minimum_level,
    )
    row = create_demand(principal, session, body, via=via, client_name=client_name)
    return demand_public(principal, session, row)


def require_requesting_department(
    principal: Principal, session: Session, requesting_department_id: UUID
) -> UUID:
    require_requester(principal, session)
    if principal.user_id is None:
        raise CapacityForbidden()
    department(session, principal.org_id, requesting_department_id)
    if not can_manage_department(principal, requesting_department_id):
        if can_view_org_aggregates(principal):
            raise CapacityForbidden()
        if (
            employee(principal, session, principal.employee_id).department_id
            != requesting_department_id
        ):
            raise CapacityForbidden()
    return principal.user_id


def create_demand(
    principal: Principal,
    session: Session,
    body: DemandInput,
    *,
    project_id: UUID | None = None,
    role: ProjectRoleInput | None = None,
    via: Via = "web",
    client_name: str | None = None,
) -> CapacityDemand:
    requester = require_requesting_department(
        principal, session, body.requesting_department_id
    )
    target_department_id = body.target_department_id
    reference = department_reference(
        session,
        principal.org_id,
        target_department_id,
        body.capability_key,
        body.minimum_level,
    )
    row = CapacityDemand(
        org_id=principal.org_id,
        requester_user_id=requester,
        capability_name=reference.capability_name,
        project_id=project_id,
        role_name=role.role_name if role else None,
        extra_capabilities=[
            item.model_dump(mode="json") for item in role.extra_capabilities
        ]
        if role
        else [],
        **body.model_dump(),
    )
    session.add(row)
    session.flush()
    session.add(
        CapacityDemandEvent(
            org_id=principal.org_id,
            demand_id=row.id,
            kind=DemandEventKind.SUBMITTED,
            actor_user_id=requester,
            text=body.description,
            via=via,
        )
    )
    msg_zh, msg_en = bilingual(
        "收到新的协作需求（{cap}，{start} 至 {end}）。请前往「待审批 → 协作需求」答复。\n{url}",
        cap=row.capability_name,
        start=row.window_start,
        end=row.window_end,
        url=f"/capacity?tab=incoming&demand={row.id}",
    )
    for user_id in sorted(
        responder_user_ids(session, principal.org_id, target_department_id)
        - {requester}
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
    audit(
        principal,
        session,
        "capacity.demand_submitted",
        "capacity_demand",
        row.id,
        via,
        client_name,
        {},
    )
    session.flush()
    return row


def validate_reply_text(
    principal: Principal, session: Session, demand_row: CapacityDemand, text: str
) -> DetailedCapacityReference:
    reference = department_reference(
        session,
        principal.org_id,
        demand_row.target_department_id,
        demand_row.capability_key,
        demand_row.minimum_level,
    )
    validate_load_words(principal, session, demand_row, text, reference)
    return reference


def reply_demand(
    principal: Principal,
    session: Session,
    demand_id: UUID,
    outcome: DemandOutcome,
    text: str,
    revision: int,
    start_date: date | None = None,
    end_date: date | None = None,
    option_id: UUID | None = None,
    outside_basis: bool = False,
    *,
    reason_code: ReasonCode | None = None,
    via: Via = "web",
    client_name: str | None = None,
    allow_legacy_reply: bool = False,
    notify_requester: bool = True,
) -> DemandPublic:
    if option_id is not None or outside_basis:
        # Option composition is a REST operation; assistants require confirmation.
        raise CapacityForbidden()
    body = ReplyInput(
        outcome=outcome,
        text=text,
        revision=revision,
        start_date=start_date,
        end_date=end_date,
        reason_code=reason_code,
    )
    row = demand_row(principal, session, demand_id, lock=True)
    if not represents_department(principal, row.target_department_id):
        raise CapacityNotFound(DEMAND_NOT_FOUND)
    if principal.user_id is None or principal.user_id == row.requester_user_id:
        raise CapacityForbidden()
    can_legacy = allow_legacy_reply and is_legacy_verbal_reply(session, row)
    if row.revision != revision or (
        row.status != DemandStatus.SUBMITTED and not can_legacy
    ):
        raise CapacityConflict()
    if body.outcome == DemandOutcome.NOT_NOW:
        require_rejection_reason(body.reason_code, body.text)
    validate_department_text(principal, session, row.target_department_id, body.text)
    reference = validate_reply_text(principal, session, row, body.text)
    session.add(
        CapacityDemandEvent(
            org_id=principal.org_id,
            demand_id=row.id,
            kind=DemandEventKind.REPLIED,
            actor_user_id=principal.user_id,
            text=body.text,
            outcome=body.outcome,
            reason_code=body.reason_code
            if body.outcome == DemandOutcome.NOT_NOW
            else None,
            start_date=body.start_date,
            end_date=body.end_date,
            basis=reference.model_dump(mode="json"),
            via=via,
        )
    )
    row.status = DemandStatus.REPLIED
    row.committed_start_date, row.committed_end_date = body.start_date, body.end_date
    row.revision += 1
    session.add(row)
    if notify_requester:
        msg_zh, msg_en = bilingual(
            "协作需求已收到答复（{cap}，{start} 至 {end}）。请前往「已发出的需求」查看答复并决定下一步。\n{url}",
            cap=row.capability_name,
            start=row.window_start,
            end=row.window_end,
            url=f"/capacity?tab=outgoing&demand={row.id}",
        )
        add_item(
            session,
            InboxItem(
                org_id=principal.org_id,
                recipient_user_id=row.requester_user_id,
                kind=InboxKind.CAPACITY,
                message=msg_zh,
                message_en=msg_en,
            ),
        )
    audit(
        principal,
        session,
        "capacity.demand_replied",
        "capacity_demand",
        row.id,
        via,
        client_name,
        {},
    )
    session.flush()
    return demand_public(principal, session, row)


def respond_demand(
    principal: Principal,
    session: Session,
    demand_id: UUID,
    action: Literal["accept", "follow_up", "withdraw"],
    revision: int,
    text: str | None = None,
    *,
    reason_code: ReasonCode | None = None,
    via: Via = "web",
    client_name: str | None = None,
) -> DemandPublic:
    body = RespondInput(
        action=action, revision=revision, text=text, reason_code=reason_code
    )
    row = demand_row(principal, session, demand_id, lock=True)
    if principal.user_id is None or not (
        row.requester_user_id == principal.user_id
        or manages_department(principal, row.requesting_department_id)
    ):
        raise CapacityNotFound(DEMAND_NOT_FOUND)
    latest_proposal = latest(session, principal.org_id, demand_id, lock=True)
    if (
        latest_proposal is not None
        and not (
            action == "withdraw"
            and row.status == DemandStatus.SUBMITTED
            and revision == row.revision
            and latest_proposal.kind == "initial"
            and latest_proposal.status == ProposalStatus.WITHDRAWN
        )
        and (
            revision <= latest_proposal.demand_revision
            or not reply_superseded(row, latest_proposal)
        )
    ):
        respond_proposal(
            principal,
            session,
            row,
            latest_proposal,
            action,
            revision,
            text,
            reason_code=body.reason_code,
            via=via,
        )
        return get_demand(principal, session, demand_id)
    if row.revision != revision or row.status in (
        DemandStatus.ACCEPTED,
        DemandStatus.WITHDRAWN,
    ):
        raise CapacityConflict()
    if action != "withdraw" and row.status != DemandStatus.REPLIED:
        raise CapacityConflict()
    if action == "accept":
        raise DemandAwaitingSchedule()
    follow_up = action == "follow_up"
    kind = DemandEventKind.FOLLOW_UP if follow_up else DemandEventKind.WITHDRAWN
    row.status = DemandStatus.SUBMITTED if follow_up else DemandStatus.WITHDRAWN
    row.committed_start_date = row.committed_end_date = None
    row.revision += 1
    session.add(row)
    session.add(
        CapacityDemandEvent(
            org_id=principal.org_id,
            demand_id=row.id,
            kind=kind,
            actor_user_id=principal.user_id,
            text=body.text or "",
            via=via,
        )
    )
    msg_zh, msg_en = (
        bilingual(
            "协作需求收到追问（{cap}，{start} 至 {end}）。请前往「待审批 → 协作需求」查看并重新答复。\n{url}",
            cap=row.capability_name,
            start=row.window_start,
            end=row.window_end,
            url=f"/capacity?tab=incoming&demand={row.id}",
        )
        if action == "follow_up"
        else bilingual(
            "协作需求已撤回（{cap}，{start} 至 {end}）。请打开需求的方案页查看撤回状态。\n{url}",
            cap=row.capability_name,
            start=row.window_start,
            end=row.window_end,
            url=f"/capacity?tab=incoming&demand={row.id}&plans=1",
        )
    )
    for user_id in sorted(
        responder_user_ids(session, principal.org_id, row.target_department_id)
        - {principal.user_id}
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
    audit(
        principal,
        session,
        {
            "follow_up": "capacity.demand_follow_up",
            "withdraw": "capacity.demand_withdrawn",
        }[action],
        "capacity_demand",
        row.id,
        via,
        client_name,
        {},
    )
    session.flush()
    return demand_public(principal, session, row)
