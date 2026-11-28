from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from app.api.deps import SessionDep
from app.authz.deps import OrgPrincipalDep
from app.domains.capacity import demand, project, proposal
from app.domains.capacity.demand_schemas import (
    BorrowDecisionInput,
    BorrowRequest,
    CapacityReference,
    ChangeProposalInput,
    DemandBasis,
    DemandHistory,
    DemandInput,
    DemandList,
    DemandListInput,
    DemandPublic,
    PlanReplyInput,
    ProjectDetail,
    ProjectInput,
    ProjectSummary,
    ProposalWithdrawInput,
    ReferenceInput,
    RespondInput,
)
from app.domains.org.schemas import DepartmentsPublic
from app.domains.planning import compose as planning_compose

router = APIRouter(prefix="/orgs/{org_id}", tags=["capacity"])


@router.get("/capacity/departments")
def list_capacity_departments(
    principal: OrgPrincipalDep, session: SessionDep
) -> DepartmentsPublic:
    return demand.list_capacity_departments(principal, session)


@router.get("/capacity/reference")
def capacity_reference(
    principal: OrgPrincipalDep,
    session: SessionDep,
    query: Annotated[ReferenceInput, Query()],
) -> CapacityReference:
    return demand.capacity_reference(principal, session, **query.model_dump())


@router.post("/capacity/projects")
def submit_project(
    principal: OrgPrincipalDep, session: SessionDep, body: ProjectInput
) -> ProjectSummary:
    result = project.submit_project(principal, session, body)
    session.commit()
    return result


@router.get("/capacity/projects")
def list_projects(
    principal: OrgPrincipalDep, session: SessionDep
) -> list[ProjectSummary]:
    return project.list_projects(principal, session)


@router.get("/capacity/projects/{project_id}")
def get_project(
    principal: OrgPrincipalDep, session: SessionDep, project_id: UUID
) -> ProjectDetail:
    return project.get_project(principal, session, project_id)


@router.post("/capacity/demands")
def submit_demand(
    principal: OrgPrincipalDep, session: SessionDep, body: DemandInput
) -> DemandPublic:
    result = demand.submit_demand(principal, session, **body.model_dump())
    session.commit()
    return result


@router.get("/capacity/demands")
def list_demands(
    principal: OrgPrincipalDep,
    session: SessionDep,
    query: Annotated[DemandListInput, Query()],
) -> DemandList:
    return demand.list_demands(principal, session, **query.model_dump())


@router.get("/capacity/demands/{demand_id}")
def get_demand(
    principal: OrgPrincipalDep, session: SessionDep, demand_id: UUID
) -> DemandPublic:
    return demand.get_demand(principal, session, demand_id, include_previous=True)


@router.get("/capacity/demands/{demand_id}/history")
def get_demand_history(
    principal: OrgPrincipalDep, session: SessionDep, demand_id: UUID
) -> DemandHistory:
    return planning_compose.demand_snapshot_history(principal, session, demand_id)


@router.get("/capacity/demands/{demand_id}/basis")
def get_demand_basis(
    principal: OrgPrincipalDep, session: SessionDep, demand_id: UUID
) -> DemandBasis:
    return demand.get_demand_basis(principal, session, demand_id)


@router.post("/capacity/demands/{demand_id}/reply")
def reply_demand(
    principal: OrgPrincipalDep,
    session: SessionDep,
    demand_id: UUID,
    body: PlanReplyInput,
) -> DemandPublic:
    if body.option_id is None:
        if body.lender_department_id is not None or body.borrow_headcount is not None:
            raise proposal.ProposalConflict("只有借调方案可以指定借出部门和人数")
        result = demand.reply_demand(
            principal,
            session,
            demand_id,
            **body.model_dump(exclude={"lender_department_id", "borrow_headcount"}),
        )
    else:
        result = planning_compose.propose_plan(
            principal, session, demand_id, body, include_previous=True
        )
    session.commit()
    return result


@router.post("/capacity/demands/{demand_id}/change")
def propose_change(
    principal: OrgPrincipalDep,
    session: SessionDep,
    demand_id: UUID,
    body: ChangeProposalInput,
) -> DemandPublic:
    result = planning_compose.propose_plan(
        principal, session, demand_id, body, include_previous=True
    )
    session.commit()
    return result


@router.post("/capacity/demands/{demand_id}/respond")
def respond_demand(
    principal: OrgPrincipalDep, session: SessionDep, demand_id: UUID, body: RespondInput
) -> DemandPublic:
    try:
        result = demand.respond_demand(
            principal, session, demand_id, **body.model_dump()
        )
    except proposal.ProposalFailed:
        session.commit()
        raise
    session.commit()
    return result


@router.get("/capacity/borrow-requests")
def list_borrow_requests(
    principal: OrgPrincipalDep, session: SessionDep, mine: bool = False
) -> list[BorrowRequest]:
    return proposal.borrow_requests(principal, session, mine=mine)


@router.post("/capacity/borrow-requests/{line_id}/decision", status_code=204)
def decide_borrow_request(
    principal: OrgPrincipalDep,
    session: SessionDep,
    line_id: UUID,
    body: BorrowDecisionInput,
) -> None:
    try:
        proposal.decide_borrow(principal, session, line_id, body)
    except proposal.ProposalFailed:
        session.commit()
        raise
    session.commit()


@router.post("/capacity/proposals/{proposal_id}/withdraw")
def withdraw_proposal(
    principal: OrgPrincipalDep,
    session: SessionDep,
    proposal_id: UUID,
    body: ProposalWithdrawInput,
) -> DemandPublic:
    try:
        result = proposal.withdraw(principal, session, proposal_id, body.revision)
    except proposal.ProposalFailed:
        session.commit()
        raise
    session.commit()
    return result
