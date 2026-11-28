from uuid import UUID

from fastapi import APIRouter

from app import crud
from app.api.deps import SessionDep
from app.authz.deps import OrgAdminDep
from app.domains.capability.models import CapabilityProposal
from app.domains.capability.proposals import name_key
from app.domains.capacity import demand, proposal, settings
from app.domains.capacity.models import (
    CapacityDemandEvent,
    DemandEventKind,
    DemandStatus,
)
from app.domains.org.models import Employee, Organization, OrgMembership
from app.domains.setup.schemas import SetupTokenInput, SetupTokenResult
from app.domains.setup.service import issue_token
from app.models import (
    User,
    UserCreate,
    UserPublic,
)

router = APIRouter(tags=["private"], prefix="/private")
playwright_router = APIRouter(
    prefix="/private", tags=["private"], include_in_schema=False
)


@router.post("/setup-tokens")
def create_setup_token(data: SetupTokenInput, session: SessionDep) -> SetupTokenResult:
    token = issue_token(session, data.purpose)
    session.commit()
    return SetupTokenResult(token=token)


class PrivateUserCreate(UserCreate):
    must_change_password: bool = False


@router.post("/users/", response_model=UserPublic)
def create_user(
    user_in: PrivateUserCreate, session: SessionDep, with_empty_profile: bool = False
) -> User:
    """
    Create a new user.
    """

    user = crud.create_user(session=session, user_create=user_in)
    user.must_change_password = user_in.must_change_password
    session.add(user)
    if with_empty_profile:
        org = Organization(slug=f"test-{user.id}", name="空画像测试企业")
        session.add(org)
        session.flush()
        employee = Employee(
            org_id=org.id,
            employee_code=user.username,
            display_name=user.full_name or "测试员工",
        )
        session.add(employee)
        session.flush()
        session.add(
            OrgMembership(org_id=org.id, user_id=user.id, employee_id=employee.id)
        )
    session.commit()
    session.refresh(user)
    return user


@router.post("/capability-proposals", status_code=204)
def seed_capability_proposal(org_id: UUID, name: str, session: SessionDep) -> None:
    session.add(
        CapabilityProposal(
            org_id=org_id,
            name=name,
            name_key=name_key(name),
            category="工程",
            description="合成能力说明",
            reason="多条合成工作记录涉及这项能力",
        )
    )
    session.commit()


@playwright_router.post(
    "/orgs/{org_id}/legacy-accepted-demands/{demand_id}", status_code=204
)
def seed_legacy_accepted_demand(
    principal: OrgAdminDep, session: SessionDep, demand_id: UUID
) -> None:
    row = demand.demand_row(principal, session, demand_id, lock=True)
    if (
        not demand.is_legacy_verbal_reply(session, row)
        or proposal.latest(session, principal.org_id, row.id) is not None
        or row.committed_start_date is None
        or row.committed_end_date is None
    ):
        raise settings.CapacityConflict()
    row.status = DemandStatus.ACCEPTED
    row.revision += 1
    session.add(row)
    session.add(
        CapacityDemandEvent(
            org_id=principal.org_id,
            demand_id=row.id,
            actor_user_id=row.requester_user_id,
            kind=DemandEventKind.ACCEPTED,
            text="",
            via="web",
        )
    )
    session.commit()
