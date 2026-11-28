from uuid import UUID

from fastapi import APIRouter

from app.api.deps import SessionDep
from app.authz.deps import OrgPrincipalDep
from app.domains.capacity import assignment, extension
from app.domains.capacity.assignment_schemas import (
    AssignmentInput,
    AssignmentPublic,
    AssignmentUpdateInput,
    DemandAssignmentList,
    DepartedAssignmentCancelled,
    MyAssignmentList,
)
from app.domains.capacity.extension_schemas import (
    ExtensionDecisionInput,
    ExtensionInput,
    ExtensionList,
    ExtensionPublic,
)

router = APIRouter(prefix="/orgs/{org_id}", tags=["capacity"])


@router.get("/capacity/demands/{demand_id}/assignments")
def list_demand_assignments(
    principal: OrgPrincipalDep, session: SessionDep, demand_id: UUID
) -> DemandAssignmentList:
    return assignment.list_demand_assignments(principal, session, demand_id)


@router.post("/capacity/demands/{demand_id}/assignments")
def create_assignment(
    principal: OrgPrincipalDep,
    session: SessionDep,
    demand_id: UUID,
    body: AssignmentInput,
) -> AssignmentPublic:
    result = assignment.create_assignment(principal, session, demand_id, body)
    session.commit()
    return result


@router.patch("/capacity/assignments/{assignment_id}")
def update_assignment(
    principal: OrgPrincipalDep,
    session: SessionDep,
    assignment_id: UUID,
    body: AssignmentUpdateInput,
) -> AssignmentPublic | DepartedAssignmentCancelled:
    result = assignment.update_assignment(principal, session, assignment_id, body)
    session.commit()
    return result


@router.get("/capacity/assignments/me")
def list_my_assignments(
    principal: OrgPrincipalDep, session: SessionDep
) -> MyAssignmentList:
    return assignment.list_my_assignments(principal, session)


@router.post("/capacity/assignments/{assignment_id}/extension-requests")
def request_extension(
    principal: OrgPrincipalDep,
    session: SessionDep,
    assignment_id: UUID,
    body: ExtensionInput,
) -> ExtensionPublic:
    result = extension.request_extension(
        principal, session, assignment_id, **body.model_dump()
    )
    session.commit()
    return result


@router.get("/capacity/extension-requests")
def list_extension_requests(
    principal: OrgPrincipalDep, session: SessionDep, exclude_own: bool = False
) -> ExtensionList:
    return extension.list_extension_requests(
        principal, session, exclude_own=exclude_own
    )


@router.post("/capacity/extension-requests/{request_id}/decision")
def decide_extension_request(
    principal: OrgPrincipalDep,
    session: SessionDep,
    request_id: UUID,
    body: ExtensionDecisionInput,
) -> ExtensionPublic:
    result = extension.decide_extension_request(principal, session, request_id, body)
    session.commit()
    return result
