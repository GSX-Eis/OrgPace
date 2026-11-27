from uuid import UUID

from fastapi import APIRouter

from app.api.deps import SessionDep
from app.authz.deps import OrgPrincipalDep
from app.domains.review import delegation

router = APIRouter(
    prefix="/orgs/{org_id}/me/review-delegations", tags=["review-delegations"]
)


@router.get("")
def read_delegations(
    session: SessionDep, principal: OrgPrincipalDep
) -> delegation.DelegationView:
    return delegation.delegation_view(session, principal)


@router.post("", status_code=410)
def create_delegation(principal: OrgPrincipalDep) -> delegation.DelegationView:
    del principal
    raise delegation.DelegationDisabled()


@router.delete("/{delegation_id}", status_code=410)
def revoke_delegation(principal: OrgPrincipalDep, delegation_id: UUID) -> None:
    del principal, delegation_id
    raise delegation.DelegationDisabled()
