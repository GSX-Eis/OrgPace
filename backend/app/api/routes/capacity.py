from fastapi import APIRouter
from fastapi.routing import APIRoute

from app.api.routes import (
    capacity_assignments,
    capacity_demands,
    capacity_forecast,
    capacity_workload,
)

# Preserve OpenAPI path insertion order so clean-checkout client generation produces zero diff.
_LEGACY_ROUTE_ORDER = (
    "list_unavailability",
    "register_unavailability",
    "delete_unavailability",
    "list_demand_assignments",
    "create_assignment",
    "update_assignment",
    "list_my_assignments",
    "list_capacity_departments",
    "capacity_reference",
    "submit_project",
    "list_projects",
    "get_project",
    "submit_demand",
    "list_demands",
    "get_demand",
    "get_demand_history",
    "get_demand_basis",
    "reply_demand",
    "propose_change",
    "respond_demand",
    "list_borrow_requests",
    "decide_borrow_request",
    "withdraw_proposal",
    "get_capacity_settings",
    "put_capacity_settings",
    "get_my_workload",
    "list_workloads",
    "set_capacity_weeks",
    "override_capacity_forecasts",
    "reset_capacity_forecasts",
    "refresh_capacity_forecasts",
    "list_capacity_forecast_policies",
    "upsert_capacity_forecast_policy",
    "delete_capacity_forecast_policy",
    "list_capacity_forecast_events",
    "create_capacity_forecast_event",
    "update_capacity_forecast_event",
    "delete_capacity_forecast_event",
    "preview_capacity_carry_over",
    "commit_capacity_carry_over",
    "preview_capacity_carry_over_revert",
    "revert_capacity_carry_over",
    "request_workload_change",
    "list_workload_requests",
    "decide_workload_request",
    "request_extension",
    "list_extension_requests",
    "decide_extension_request",
)
_ROUTE_RANK = {name: idx for idx, name in enumerate(_LEGACY_ROUTE_ORDER)}

router = APIRouter()
_sub_routes = [
    route
    for sub_router in (
        capacity_workload.router,
        capacity_assignments.router,
        capacity_demands.router,
        capacity_forecast.router,
    )
    for route in sub_router.routes
    if isinstance(route, APIRoute)
]
_sub_routes.sort(key=lambda route: _ROUTE_RANK.get(route.name, len(_ROUTE_RANK)))
router.routes.extend(_sub_routes)
