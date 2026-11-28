from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from app.api.deps import SessionDep
from app.authz.deps import OrgPrincipalDep
from app.domains.capacity import (
    inbox_detail,  # noqa: F401  # Registers CapacityInboxProvider on router import.
    settings,
    workload,
)
from app.domains.capacity.schemas import (
    CapacitySettingsInput,
    CarryOverBatchPublic,
    CarryOverCommitInput,
    CarryOverPreview,
    CarryOverQuery,
    CarryOverRevertInput,
    CarryOverRevertPreview,
    MyWorkload,
    UnavailabilityInput,
    UnavailabilityList,
    UnavailabilityPublic,
    UnavailabilityQuery,
    WorkloadDecisionInput,
    WorkloadList,
    WorkloadListQuery,
    WorkloadQuery,
    WorkloadRequestInput,
    WorkloadRequestList,
    WorkloadRequestPublic,
    WorkloadWeeksInput,
)

router = APIRouter(prefix="/orgs/{org_id}", tags=["capacity"])


@router.get("/capacity/unavailability")
def list_unavailability(
    principal: OrgPrincipalDep,
    session: SessionDep,
    query: Annotated[UnavailabilityQuery, Query()],
) -> UnavailabilityList:
    return workload.list_unavailability(principal, session, **query.model_dump())


@router.post("/capacity/unavailability")
def register_unavailability(
    principal: OrgPrincipalDep,
    session: SessionDep,
    body: UnavailabilityInput,
) -> UnavailabilityPublic:
    result = workload.register_unavailability(principal, session, body)
    session.commit()
    return result


@router.delete("/capacity/unavailability/{unavailability_id}")
def delete_unavailability(
    principal: OrgPrincipalDep,
    session: SessionDep,
    unavailability_id: UUID,
) -> UnavailabilityPublic:
    result = workload.delete_unavailability(principal, session, unavailability_id)
    session.commit()
    return result


@router.get("/capacity-settings")
def get_capacity_settings(
    principal: OrgPrincipalDep, session: SessionDep
) -> CapacitySettingsInput:
    return settings.read_settings(principal, session)


@router.put("/capacity-settings")
def put_capacity_settings(
    principal: OrgPrincipalDep, session: SessionDep, body: CapacitySettingsInput
) -> CapacitySettingsInput:
    result = settings.save_settings(principal, session, body)
    session.commit()
    return result


@router.get("/capacity/workloads/me")
def get_my_workload(
    principal: OrgPrincipalDep,
    session: SessionDep,
    query: Annotated[WorkloadQuery, Query()],
) -> MyWorkload:
    return workload.get_my_workload(principal, session, **query.model_dump())


@router.get("/capacity/workloads")
def list_workloads(
    principal: OrgPrincipalDep,
    session: SessionDep,
    query: Annotated[WorkloadListQuery, Query()],
) -> WorkloadList:
    return workload.list_workloads(principal, session, **query.model_dump())


@router.put("/capacity/weeks")
def set_capacity_weeks(
    principal: OrgPrincipalDep,
    session: SessionDep,
    body: WorkloadWeeksInput,
) -> WorkloadList:
    result = workload.set_weeks(principal, session, body)
    session.commit()
    return result


@router.get("/capacity/weeks/carry-over/preview")
def preview_capacity_carry_over(
    principal: OrgPrincipalDep,
    session: SessionDep,
    query: Annotated[CarryOverQuery, Query()],
) -> CarryOverPreview:
    return workload.preview_carry_over(principal, session, query.department_id)


@router.post("/capacity/weeks/carry-over")
def commit_capacity_carry_over(
    principal: OrgPrincipalDep,
    session: SessionDep,
    body: CarryOverCommitInput,
) -> CarryOverBatchPublic:
    result = workload.commit_carry_over(principal, session, body)
    session.commit()
    return result


@router.get("/capacity/weeks/carry-over/revert/preview")
def preview_capacity_carry_over_revert(
    principal: OrgPrincipalDep,
    session: SessionDep,
) -> CarryOverRevertPreview:
    return workload.preview_carry_over_revert(principal, session)


@router.post("/capacity/weeks/carry-over/revert")
def revert_capacity_carry_over(
    principal: OrgPrincipalDep,
    session: SessionDep,
    body: CarryOverRevertInput | None = None,
) -> CarryOverBatchPublic:
    result = workload.revert_carry_over(
        principal, session, batch_id=body.batch_id if body else None
    )
    session.commit()
    return result


@router.post("/capacity/workloads/me/requests")
def request_workload_change(
    principal: OrgPrincipalDep, session: SessionDep, body: WorkloadRequestInput
) -> WorkloadRequestPublic:
    result = workload.request_workload_change(principal, session, **body.model_dump())
    session.commit()
    return result


@router.get("/capacity/workload-requests")
def list_workload_requests(
    principal: OrgPrincipalDep, session: SessionDep
) -> WorkloadRequestList:
    return workload.list_workload_requests(principal, session)


@router.post("/capacity/workload-requests/{request_id}/decision")
def decide_workload_request(
    principal: OrgPrincipalDep,
    session: SessionDep,
    request_id: UUID,
    body: WorkloadDecisionInput,
) -> WorkloadRequestPublic:
    result = workload.decide_workload_request(principal, session, request_id, body)
    session.commit()
    return result
