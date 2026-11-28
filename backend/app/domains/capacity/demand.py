from collections import defaultdict
from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import ColumnElement
from sqlmodel import Session, and_, col, func, or_, select

from app.authz.policies import (
    can_manage_department,
    can_view_org_aggregates,
    employee_scope_clause,
    manages_department,
)
from app.authz.principal import Principal
from app.domains.capability.models import CapabilityDefinition
from app.domains.capability.search import (
    PeopleSearchInput,
    find_people,
)
from app.domains.capability.service import get_schema, list_capabilities
from app.domains.capacity.common import (
    DEMAND_NOT_FOUND as DEMAND_NOT_FOUND,
)
from app.domains.capacity.common import (
    LOAD_WORDS as LOAD_WORDS,
)
from app.domains.capacity.common import (
    CapacityConflict,
    CapacityForbidden,
    CapacityNotFound,
    _search_people,
    audit,
    employee,
)
from app.domains.capacity.common import (
    DemandReplyInvalid as DemandReplyInvalid,
)
from app.domains.capacity.common import (
    DemandReplyLoadInvalid as DemandReplyLoadInvalid,
)
from app.domains.capacity.common import (
    RejectionReasonInvalid as RejectionReasonInvalid,
)
from app.domains.capacity.common import (
    can_view_demand_internals as can_view_demand_internals,
)
from app.domains.capacity.common import (
    demand_row as demand_row,
)
from app.domains.capacity.common import (
    department as department,
)
from app.domains.capacity.common import (
    qualified_people as qualified_people,
)
from app.domains.capacity.common import (
    represents_department as represents_department,
)
from app.domains.capacity.common import (
    require_rejection_reason as require_rejection_reason,
)
from app.domains.capacity.common import (
    responder_user_ids as responder_user_ids,
)
from app.domains.capacity.common import (
    responders_by_department as responders_by_department,
)
from app.domains.capacity.common import (
    validate_department_text as validate_department_text,
)
from app.domains.capacity.common import (
    validate_load_words as validate_load_words,
)
from app.domains.capacity.demand_schemas import (
    CapacityReference,
    CommitmentChange,
    ConclusionCapacityReference,
    DemandBasis,
    DemandBasisPerson,
    DemandEventPublic,
    DemandExtraCapability,
    DemandHistory,
    DemandHistoryEvent,
    DemandInput,
    DemandList,
    DemandOtherPerson,
    DemandProject,
    DemandPublic,
    DetailedCapacityReference,
    ExtraCapability,
    FeasibilityConclusion,
    ProjectRoleInput,
    ProjectRoleSummary,
    ProposalSchedule,
    ReplyInput,
    RespondInput,
)
from app.domains.capacity.models import (
    CapacityDemand,
    CapacityDemandDependency,
    CapacityDemandEvent,
    CapacityProject,
    CapacityProposal,
    DemandEventKind,
    DemandOutcome,
    DemandStatus,
    ProposalStatus,
    RequesterPolicy,
)
from app.domains.capacity.proposal_state import respond_proposal
from app.domains.capacity.proposal_views import (
    decision_history as proposal_decision_history,
)
from app.domains.capacity.proposal_views import (
    latest,
    public,
    reply_superseded,
    schedule_summary,
    schedules_for_demands,
)
from app.domains.capacity.schemas import ReasonCode, Via
from app.domains.capacity.settings import read_settings, require_enabled
from app.domains.capacity.workload_views import views
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.inbox.service import add_item
from app.domains.org.models import (
    Department,
    Employee,
    EmploymentStatus,
    OrgMembership,
)
from app.domains.org.schemas import DepartmentPublic, DepartmentsPublic
from app.domains.org.service import managed_scope
from app.i18n import bilingual, tr
from app.models import User


class DemandAwaitingSchedule(CapacityConflict):
    def __init__(self) -> None:
        super().__init__()
        self.detail = "请等待目标部门经理排期。"


def require_requester(principal: Principal, session: Session) -> None:
    require_enabled(principal, session)
    if principal.user_id is None:
        raise CapacityForbidden()
    if can_view_org_aggregates(principal):
        return
    if read_settings(principal, session).requester_policy != RequesterPolicy.EVERYONE:
        raise CapacityForbidden()
    employee(principal, session, principal.employee_id)


def list_capacity_departments(
    principal: Principal, session: Session
) -> DepartmentsPublic:
    require_requester(principal, session)
    rows = session.exec(
        select(Department)
        .where(Department.org_id == principal.org_id)
        .order_by(Department.name, col(Department.id))
    ).all()
    return DepartmentsPublic(
        data=[DepartmentPublic.model_validate(d) for d in rows], count=len(rows)
    )


def department_reference(
    session: Session,
    org_id: UUID,
    target_department_id: UUID,
    capability_key: str,
    minimum_level: str | None = None,
) -> DetailedCapacityReference:
    target = department(session, org_id, target_department_id)
    worker = Principal.system_worker(org_id)
    ids: set[UUID] = set()
    skip = 0
    while True:
        page = find_people(
            session,
            worker,
            PeopleSearchInput(
                department_id=target.id,
                capability_key=capability_key,
                minimum_level=minimum_level,
                skip=skip,
                limit=100,
            ),
        )
        ids.update(r.employee_id for r in page.data if r.level is not None)
        skip += len(page.data)
        if skip >= page.count or not page.data:
            break
    capability = next(
        c
        for c in list_capabilities(session, org_id, get_schema(session, org_id).id)
        if c.key == capability_key
    )
    result = DetailedCapacityReference(
        department_name=target.name, capability_name=capability.name, count=len(ids)
    )
    employees = list(
        session.exec(
            select(Employee).where(
                employee_scope_clause(worker),
                col(Employee.id).in_(ids),
            )
        ).all()
    )
    for workload in views(worker, session, employees):
        setattr(result, workload.band, getattr(result, workload.band) + 1)
    return result


def capacity_reference(
    principal: Principal,
    session: Session,
    target_department_id: UUID,
    capability_key: str,
    minimum_level: str | None = None,
) -> CapacityReference:
    require_requester(principal, session)
    return reference_for_viewer(
        principal,
        target_department_id,
        department_reference(
            session,
            principal.org_id,
            target_department_id,
            capability_key,
            minimum_level,
        ),
    )


def reference_for_viewer(
    principal: Principal,
    target_department_id: UUID,
    reference: DetailedCapacityReference,
    *,
    requester_view: bool = False,
) -> CapacityReference:
    if not requester_view and represents_department(principal, target_department_id):
        return reference
    conclusion: FeasibilityConclusion
    if reference.count == 0:
        conclusion = "cannot_do"
    elif reference.available > 0 or reference.unconfirmed > 0:
        conclusion = "can_do"
    else:
        conclusion = "later"
    return ConclusionCapacityReference(
        department_name=reference.department_name,
        capability_name=reference.capability_name,
        conclusion=conclusion,
    )


def _public_extra_capability(
    item: dict[str, JsonValue], definitions: dict[str, CapabilityDefinition]
) -> DemandExtraCapability:
    key = str(item["key"])
    minimum = item.get("minimum_level")
    definition = definitions.get(key)
    rubric = (definition.level_rubric or {}) if definition else {}
    levels = rubric.get("levels", [])
    label = None
    if minimum is not None and isinstance(levels, list):
        label = next(
            (
                level_label
                for level in levels
                if isinstance(level, dict)
                and level.get("key") == minimum
                and isinstance(level_label := level.get("label"), str)
            ),
            None,
        )
    return DemandExtraCapability.model_validate(
        {
            **item,
            "capability_name": definition.name if definition else key,
            "minimum_level_label": label,
        }
    )


def demand_public(
    principal: Principal, session: Session, row: CapacityDemand
) -> DemandPublic:
    return demands_public(principal, session, [row])[0]


def demands_public(
    principal: Principal,
    session: Session,
    rows: list[CapacityDemand],
    *,
    requester_view: bool = False,
) -> list[DemandPublic]:
    if not rows:
        return []
    events = session.exec(
        select(CapacityDemandEvent)
        .where(
            CapacityDemandEvent.org_id == principal.org_id,
            col(CapacityDemandEvent.demand_id).in_([row.id for row in rows]),
        )
        .order_by(col(CapacityDemandEvent.created_at), col(CapacityDemandEvent.id))
    ).all()
    responder_ids = {
        event.actor_user_id for event in events if event.kind == DemandEventKind.REPLIED
    }
    names = (
        {
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
                    OrgMembership.org_id == principal.org_id,
                    col(OrgMembership.user_id).in_(responder_ids),
                )
            ).all()
        }
        if responder_ids and not requester_view
        else {}
    )
    project_ids = {row.project_id for row in rows if row.project_id is not None}
    projects = (
        dict(
            session.exec(
                select(CapacityProject.id, CapacityProject.title).where(
                    CapacityProject.org_id == principal.org_id,
                    col(CapacityProject.id).in_(project_ids),
                )
            ).all()
        )
        if project_ids and not requester_view
        else {}
    )
    definitions = (
        {
            definition.key: definition
            for definition in list_capabilities(
                session, principal.org_id, get_schema(session, principal.org_id).id
            )
        }
        if any(row.extra_capabilities for row in rows)
        else {}
    )
    grouped: dict[UUID, list[CapacityDemandEvent]] = defaultdict(list)
    for event in events:
        grouped[event.demand_id].append(event)
    legacy_candidates = [
        row.id
        for row in rows
        if row.status == DemandStatus.REPLIED
        and not requester_view
        and represents_department(principal, row.target_department_id)
        and principal.user_id is not None
        and principal.user_id != row.requester_user_id
    ]
    legacy_ids = (
        set(
            session.exec(
                select(CapacityDemand.id).where(
                    CapacityDemand.org_id == principal.org_id,
                    col(CapacityDemand.id).in_(legacy_candidates),
                    _legacy_verbal_reply_clause(),
                )
            )
        )
        if legacy_candidates
        else set()
    )
    results = []
    for row in rows:
        result = DemandPublic.model_validate(
            row.model_dump(include=set(DemandPublic.model_fields))
            | {
                "extra_capabilities": [
                    _public_extra_capability(item, definitions)
                    for item in row.extra_capabilities
                ]
            }
        )
        if (
            row.project_id is not None
            and row.project_id in projects
            and row.role_name is not None
        ):
            result.project = DemandProject(
                id=row.project_id,
                title=projects[row.project_id],
                role_name=row.role_name,
            )
        target_view = not requester_view and can_view_demand_internals(principal, row)
        result.can_reply = (
            target_view
            and (row.status == DemandStatus.SUBMITTED or row.id in legacy_ids)
            and principal.user_id is not None
            and principal.user_id != row.requester_user_id
        )
        result.events = [
            DemandEventPublic(
                kind=e.kind,
                text=e.text if target_view or e.kind != DemandEventKind.REPLIED else "",
                created_at=e.created_at,
                via=e.via,
                outcome=e.outcome,
                start_date=e.start_date,
                end_date=e.end_date,
                basis=reference_for_viewer(
                    principal,
                    row.target_department_id,
                    DetailedCapacityReference.model_validate(e.basis),
                    requester_view=not target_view,
                )
                if e.kind == DemandEventKind.REPLIED and e.basis
                else None,
                **(
                    CommitmentChange.model_validate(e.basis).model_dump()
                    if e.kind == DemandEventKind.COMMITMENT_CHANGED
                    else {}
                ),
                responder_name=names.get(e.actor_user_id)
                if e.kind == DemandEventKind.REPLIED and target_view
                else None,
            )
            for e in grouped[row.id]
        ]
        results.append(result)
    return results


def project_role_summary(
    row: CapacityDemand, department_name: str, schedule: ProposalSchedule | None = None
) -> ProjectRoleSummary:
    assert row.role_name is not None
    return ProjectRoleSummary(
        id=row.id,
        role_name=row.role_name,
        target_department_name=department_name,
        status=row.status,
        window_start=row.window_start,
        window_end=row.window_end,
        committed_start_date=row.committed_start_date,
        committed_end_date=row.committed_end_date,
        proposal_schedule=schedule,
    )


def get_demand(
    principal: Principal,
    session: Session,
    demand_id: UUID,
    *,
    include_previous: bool = False,
) -> DemandPublic:
    row = demand_row(principal, session, demand_id)
    result = demand_public(principal, session, row)
    if result.project is not None:
        result.project.prerequisites = [
            project_role_summary(role, name)
            for role, name in session.exec(
                select(CapacityDemand, Department.name)
                .join(
                    CapacityDemandDependency,
                    (col(CapacityDemandDependency.org_id) == CapacityDemand.org_id)
                    & (
                        col(CapacityDemandDependency.depends_on_demand_id)
                        == CapacityDemand.id
                    ),
                )
                .join(
                    Department,
                    (col(Department.org_id) == CapacityDemand.org_id)
                    & (col(Department.id) == CapacityDemand.target_department_id),
                )
                .where(
                    CapacityDemand.org_id == principal.org_id,
                    CapacityDemand.project_id == result.project.id,
                    CapacityDemandDependency.project_id == result.project.id,
                    CapacityDemandDependency.demand_id == row.id,
                )
                .order_by(col(CapacityDemand.created_at), col(CapacityDemand.id))
            ).all()
        ]
    result.proposal = public(principal, session, row, include_previous=include_previous)
    if result.proposal is not None:
        result.proposal_schedule = schedule_summary(
            result.proposal.status,
            result.proposal.hold_expires_at,
            result.proposal.schedule_phases,
        )
    if can_view_demand_internals(principal, row):
        result.basis_url = f"/orgs/{principal.org_id}/capacity/demands/{row.id}/basis"
    return result


def decision_history(
    principal: Principal, session: Session, row: CapacityDemand
) -> DemandHistory:
    detailed = can_view_demand_internals(principal, row)
    events = session.exec(
        select(CapacityDemandEvent)
        .where(
            CapacityDemandEvent.org_id == principal.org_id,
            CapacityDemandEvent.demand_id == row.id,
        )
        .order_by(col(CapacityDemandEvent.created_at), col(CapacityDemandEvent.id))
    ).all()
    return DemandHistory(
        proposals=proposal_decision_history(principal, session, row),
        events=[
            DemandHistoryEvent(
                kind=event.kind,
                created_at=event.created_at,
                text=event.text
                if detailed or event.kind != DemandEventKind.REPLIED
                else None,
                outcome=event.outcome,
                reason_code=event.reason_code,
            )
            for event in events
        ],
    )


def list_demands(
    principal: Principal,
    session: Session,
    side: Literal["outgoing", "incoming"] = "outgoing",
    skip: int = 0,
    limit: int = 50,
    status: DemandStatus | None = None,
    actionable_only: bool = False,
) -> DemandList:
    require_enabled(principal, session)
    query = select(CapacityDemand).where(CapacityDemand.org_id == principal.org_id)
    if not principal.is_org_admin:
        query = query.where(
            or_(
                CapacityDemand.requester_user_id == principal.user_id,
                col(CapacityDemand.requesting_department_id).in_(
                    principal.managed_department_ids
                ),
            )
            if side == "outgoing"
            else col(CapacityDemand.target_department_id).in_(
                principal.managed_department_ids
            )
        )
    if status is not None:
        query = query.where(CapacityDemand.status == status)
    if actionable_only:
        if principal.user_id is None or not can_view_org_aggregates(principal):
            return DemandList(data=[], count=0)
        query = query.where(
            or_(
                CapacityDemand.status == DemandStatus.SUBMITTED,
                _legacy_verbal_reply_clause(),
            ),
            CapacityDemand.requester_user_id != principal.user_id,
        )
        if not principal.is_org_admin and side == "outgoing":
            query = query.where(
                col(CapacityDemand.target_department_id).in_(
                    principal.managed_department_ids
                )
            )
    count = session.exec(select(func.count()).select_from(query.subquery())).one()
    rows = list(
        session.exec(
            query.order_by(
                col(CapacityDemand.created_at).desc(), col(CapacityDemand.id)
            )
            .offset(skip)
            .limit(limit)
        ).all()
    )
    schedules = schedules_for_demands(session, principal.org_id, rows)
    data = demands_public(principal, session, rows)
    for item in data:
        item.proposal_schedule = schedules.get(item.id)
    return DemandList(data=data, count=count)


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


def _active_target_people(
    principal: Principal, session: Session, target_department_id: UUID
) -> list[Employee]:
    target_ids = managed_scope(
        session, principal.org_id, frozenset({target_department_id})
    )
    return list(
        session.exec(
            select(Employee)
            .where(
                employee_scope_clause(principal),
                Employee.employment_status == EmploymentStatus.ACTIVE,
                col(Employee.department_id).in_(target_ids),
            )
            .order_by(Employee.display_name, col(Employee.id))
        ).all()
    )


def verified_skill_shortage(
    principal: Principal, session: Session, row: CapacityDemand
) -> bool:
    if not represents_department(principal, row.target_department_id):
        raise CapacityNotFound(DEMAND_NOT_FOUND)
    possible = {
        person.id
        for person in _active_target_people(
            principal, session, row.target_department_id
        )
    }
    required_headcount = row.headcount or 1
    if len(possible) < required_headcount:
        return False
    requirements = [(row.capability_key, row.minimum_level)]
    for item in row.extra_capabilities:
        extra = ExtraCapability.model_validate(item)
        if extra.required:
            requirements.append((extra.key, extra.minimum_level))
    schema = get_schema(session, principal.org_id)
    definitions = {
        c.key: c for c in list_capabilities(session, principal.org_id, schema.id)
    }
    for key, minimum in requirements:
        if minimum is None or key not in definitions:
            continue
        raw_levels = (definitions[key].level_rubric or {}).get("levels", [])
        levels = (
            [
                str(level["key"])
                for level in raw_levels
                if isinstance(level, dict) and "key" in level
            ]
            if isinstance(raw_levels, list)
            else []
        )
        if minimum not in levels:
            continue
        below = set(levels[: levels.index(minimum)])
        if not below:
            continue
        search = PeopleSearchInput(
            department_id=row.target_department_id,
            capability_key=key,
            limit=100,
        )
        # An employee with an unknown or unconfirmed grade could still qualify.
        possible.difference_update(
            person.employee_id
            for person in _search_people(principal, session, search)
            if person.status.value == "confirmed" and person.level in below
        )
        if len(possible) < required_headcount:
            return True
    return False


def get_demand_basis(
    principal: Principal, session: Session, demand_id: UUID
) -> DemandBasis:
    row = demand_row(principal, session, demand_id)
    if not represents_department(principal, row.target_department_id):
        raise CapacityNotFound(DEMAND_NOT_FOUND)
    people = qualified_people(principal, session, row, row.target_department_id)
    employees = list(
        session.exec(
            select(Employee).where(
                employee_scope_clause(principal),
                col(Employee.id).in_(people),
            )
        ).all()
    )
    workloads = {w.employee_id: w for w in views(principal, session, employees)}
    return DemandBasis(
        data=[
            DemandBasisPerson(**p.model_dump(), workload=workloads[p.employee_id])
            for p in sorted(
                people.values(), key=lambda p: (p.display_name, str(p.employee_id))
            )
        ],
        others=[
            DemandOtherPerson(employee_id=p.id, display_name=p.display_name)
            for p in _active_target_people(principal, session, row.target_department_id)
            if p.id not in people
        ],
        count=len(people),
        reference=department_reference(
            session,
            principal.org_id,
            row.target_department_id,
            row.capability_key,
            row.minimum_level,
        ),
    )


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


def _legacy_verbal_reply_clause() -> ColumnElement[bool]:
    # An ended initial proposal no longer applies after a new verbal reply.
    has_current_proposal = (
        select(CapacityProposal.id)
        .where(
            CapacityProposal.org_id == CapacityDemand.org_id,
            CapacityProposal.demand_id == CapacityDemand.id,
            or_(
                CapacityProposal.kind != "initial",
                col(CapacityProposal.status).not_in(
                    (ProposalStatus.FAILED, ProposalStatus.WITHDRAWN)
                ),
                CapacityDemand.revision <= CapacityProposal.demand_revision + 1,
            ),
        )
        .exists()
    )
    latest_reply_allows_planning = (
        select(col(CapacityDemandEvent.outcome).is_distinct_from(DemandOutcome.NOT_NOW))
        .where(
            CapacityDemandEvent.org_id == CapacityDemand.org_id,
            CapacityDemandEvent.demand_id == CapacityDemand.id,
            CapacityDemandEvent.kind == DemandEventKind.REPLIED,
        )
        .order_by(
            col(CapacityDemandEvent.created_at).desc(),
            col(CapacityDemandEvent.id).desc(),
        )
        .limit(1)
        .scalar_subquery()
    )
    return and_(
        CapacityDemand.status == DemandStatus.REPLIED,
        ~has_current_proposal,
        latest_reply_allows_planning,
    )


def is_legacy_verbal_reply(session: Session, demand: CapacityDemand) -> bool:
    if demand.status != DemandStatus.REPLIED:
        return False
    return (
        session.exec(
            select(CapacityDemand.id).where(
                CapacityDemand.org_id == demand.org_id,
                CapacityDemand.id == demand.id,
                _legacy_verbal_reply_clause(),
            )
        ).first()
        is not None
    )


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
