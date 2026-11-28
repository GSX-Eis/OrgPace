from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from app.api.deps import SessionDep
from app.authz.deps import OrgPrincipalDep
from app.domains.capacity import forecast, forecast_policy
from app.domains.capacity.schemas import (
    ForecastConfigPublic,
    ForecastEventInput,
    ForecastEventList,
    ForecastEventMutationResult,
    ForecastOverrideInput,
    ForecastPolicyInput,
    ForecastPolicyMutationResult,
    ForecastRefreshInput,
    ForecastRefreshResult,
    ForecastResetQuery,
    WorkloadList,
)

router = APIRouter(prefix="/orgs/{org_id}", tags=["capacity"])


@router.put("/capacity/forecasts")
def override_capacity_forecasts(
    principal: OrgPrincipalDep,
    session: SessionDep,
    body: ForecastOverrideInput,
) -> WorkloadList:
    result = forecast.override_forecasts(principal, session, body)
    session.commit()
    return result


@router.delete("/capacity/forecasts")
def reset_capacity_forecasts(
    principal: OrgPrincipalDep,
    session: SessionDep,
    query: Annotated[ForecastResetQuery, Query()],
) -> WorkloadList:
    result = forecast.reset_forecasts(principal, session, query)
    session.commit()
    return result


@router.post("/capacity/forecasts/refresh")
def refresh_capacity_forecasts(
    principal: OrgPrincipalDep,
    session: SessionDep,
    department_id: UUID | None = None,
    body: ForecastRefreshInput | None = None,
) -> ForecastRefreshResult:
    result = forecast.refresh_forecasts_for_actor(
        principal,
        session,
        department_id=(body.department_id if body else None) or department_id,
    )
    session.commit()
    return result


@router.get("/capacity/forecast-policies")
def list_capacity_forecast_policies(
    principal: OrgPrincipalDep,
    session: SessionDep,
) -> ForecastConfigPublic:
    return forecast_policy.get_forecast_config(principal, session)


@router.put("/capacity/forecast-policies")
def upsert_capacity_forecast_policy(
    principal: OrgPrincipalDep,
    session: SessionDep,
    body: ForecastPolicyInput,
) -> ForecastPolicyMutationResult:
    result = forecast_policy.upsert_forecast_policy(principal, session, body)
    session.commit()
    return result


@router.delete("/capacity/forecast-policies/{policy_id}")
def delete_capacity_forecast_policy(
    principal: OrgPrincipalDep,
    session: SessionDep,
    policy_id: UUID,
) -> ForecastRefreshResult:
    result = forecast_policy.delete_forecast_policy(principal, session, policy_id)
    session.commit()
    return result


@router.get("/capacity/forecast-events")
def list_capacity_forecast_events(
    principal: OrgPrincipalDep,
    session: SessionDep,
    department_id: UUID | None = None,
    include_past: bool = False,
) -> ForecastEventList:
    return forecast_policy.list_forecast_events(
        principal,
        session,
        department_id=department_id,
        include_past=include_past,
    )


@router.post("/capacity/forecast-events")
def create_capacity_forecast_event(
    principal: OrgPrincipalDep,
    session: SessionDep,
    body: ForecastEventInput,
) -> ForecastEventMutationResult:
    result = forecast_policy.create_forecast_event(principal, session, body)
    session.commit()
    return result


@router.put("/capacity/forecast-events/{event_id}")
def update_capacity_forecast_event(
    principal: OrgPrincipalDep,
    session: SessionDep,
    event_id: UUID,
    body: ForecastEventInput,
) -> ForecastEventMutationResult:
    result = forecast_policy.update_forecast_event(principal, session, event_id, body)
    session.commit()
    return result


@router.delete("/capacity/forecast-events/{event_id}")
def delete_capacity_forecast_event(
    principal: OrgPrincipalDep,
    session: SessionDep,
    event_id: UUID,
) -> ForecastRefreshResult:
    result = forecast_policy.delete_forecast_event(principal, session, event_id)
    session.commit()
    return result
