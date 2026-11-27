from uuid import UUID

from fastapi import APIRouter
from sqlmodel import select

from app.api.deps import SessionDep
from app.authz.deps import OrgAdminDep, OrgPrincipalDep
from app.domains.change_request import employee
from app.domains.change_request.models import (
    ChangeItem,
    ItemDecision,
    ProfileChangeRequest,
)
from app.domains.review import appeal
from app.domains.review.appeal_schemas import (
    AppealInput,
    AppealPublic,
    AppealResolution,
    ResolveAppealInput,
)
from app.domains.review.models import ReviewAppeal

router = APIRouter(prefix="/orgs/{org_id}/appeals", tags=["appeals"])
playwright_router = APIRouter(
    prefix="/private", tags=["private"], include_in_schema=False
)


@router.post("")
def create_appeal(
    principal: OrgPrincipalDep, session: SessionDep, body: AppealInput
) -> AppealPublic:
    return appeal.appeal_decision(
        principal, session, body.request_id, body.item_id, body.reason
    )


@router.get("")
def list_disputes(
    principal: OrgAdminDep, session: SessionDep, employee_id: UUID | None = None
) -> list[AppealPublic]:
    return appeal.list_disputes(principal, session, employee_id=employee_id)


@router.get("/{appeal_id}")
def read_appeal(
    principal: OrgPrincipalDep, session: SessionDep, appeal_id: UUID
) -> AppealPublic:
    return appeal.read_appeal(principal, session, appeal_id)


@router.post("/{appeal_id}/resolve")
def resolve_appeal(
    principal: OrgAdminDep,
    session: SessionDep,
    appeal_id: UUID,
    body: ResolveAppealInput,
) -> AppealResolution:
    result = appeal.resolve_appeal(principal, session, appeal_id, body)
    session.commit()
    return result


@playwright_router.post("/orgs/{org_id}/legacy-appeals")
def seed_legacy_appeal(
    principal: OrgAdminDep, session: SessionDep, body: AppealInput
) -> AppealPublic:
    request = session.exec(
        select(ProfileChangeRequest).where(
            ProfileChangeRequest.org_id == principal.org_id,
            ProfileChangeRequest.id == body.request_id,
        )
    ).one_or_none()
    if request is None:
        raise employee.EmployeeRecordNotFound()
    item = session.exec(
        select(ChangeItem).where(
            ChangeItem.org_id == principal.org_id,
            ChangeItem.request_id == request.id,
            ChangeItem.id == body.item_id,
        )
    ).one_or_none()
    if item is None:
        raise employee.EmployeeRecordNotFound()
    if item.decision not in (ItemDecision.REJECTED, ItemDecision.CHANGES_REQUESTED):
        raise employee.RequestConflict("只能为被拒绝的改动构造历史申诉")
    row = ReviewAppeal(
        org_id=principal.org_id,
        request_id=request.id,
        item_id=item.id,
        employee_id=request.subject_employee_id,
        reason=body.reason,
    )
    session.add(row)
    session.commit()
    return AppealPublic.model_validate(row)
