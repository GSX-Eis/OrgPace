"""Thin facade re-exporting capacity demand submodules."""

from app.domains.capability.search import find_people as find_people
from app.domains.capacity.common import (
    DEMAND_NOT_FOUND as DEMAND_NOT_FOUND,
)
from app.domains.capacity.common import (
    LOAD_WORDS as LOAD_WORDS,
)
from app.domains.capacity.common import (
    CapacityConflict as CapacityConflict,
)
from app.domains.capacity.common import (
    CapacityForbidden as CapacityForbidden,
)
from app.domains.capacity.common import (
    CapacityNotFound as CapacityNotFound,
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
from app.domains.capacity.demand_actions import (
    DemandAwaitingSchedule as DemandAwaitingSchedule,
)
from app.domains.capacity.demand_actions import (
    create_demand as create_demand,
)
from app.domains.capacity.demand_actions import (
    reply_demand as reply_demand,
)
from app.domains.capacity.demand_actions import (
    require_requesting_department as require_requesting_department,
)
from app.domains.capacity.demand_actions import (
    respond_demand as respond_demand,
)
from app.domains.capacity.demand_actions import (
    submit_demand as submit_demand,
)
from app.domains.capacity.demand_actions import (
    validate_reply_text as validate_reply_text,
)
from app.domains.capacity.demand_views import (
    _active_target_people as _active_target_people,
)
from app.domains.capacity.demand_views import (
    _legacy_verbal_reply_clause as _legacy_verbal_reply_clause,
)
from app.domains.capacity.demand_views import (
    _public_extra_capability as _public_extra_capability,
)
from app.domains.capacity.demand_views import (
    capacity_reference as capacity_reference,
)
from app.domains.capacity.demand_views import (
    decision_history as decision_history,
)
from app.domains.capacity.demand_views import (
    demand_public as demand_public,
)
from app.domains.capacity.demand_views import (
    demands_public as demands_public,
)
from app.domains.capacity.demand_views import (
    department_reference as department_reference,
)
from app.domains.capacity.demand_views import (
    get_demand as get_demand,
)
from app.domains.capacity.demand_views import (
    get_demand_basis as get_demand_basis,
)
from app.domains.capacity.demand_views import (
    is_legacy_verbal_reply as is_legacy_verbal_reply,
)
from app.domains.capacity.demand_views import (
    list_capacity_departments as list_capacity_departments,
)
from app.domains.capacity.demand_views import (
    list_demands as list_demands,
)
from app.domains.capacity.demand_views import (
    project_role_summary as project_role_summary,
)
from app.domains.capacity.demand_views import (
    reference_for_viewer as reference_for_viewer,
)
from app.domains.capacity.demand_views import (
    require_requester as require_requester,
)
from app.domains.capacity.demand_views import (
    verified_skill_shortage as verified_skill_shortage,
)
from app.domains.capacity.models import CapacityDemand as CapacityDemand

__all__ = [
    "DEMAND_NOT_FOUND",
    "LOAD_WORDS",
    "CapacityConflict",
    "CapacityDemand",
    "CapacityForbidden",
    "CapacityNotFound",
    "DemandAwaitingSchedule",
    "DemandReplyInvalid",
    "DemandReplyLoadInvalid",
    "RejectionReasonInvalid",
    "can_view_demand_internals",
    "capacity_reference",
    "create_demand",
    "decision_history",
    "demand_public",
    "demand_row",
    "demands_public",
    "department",
    "department_reference",
    "find_people",
    "get_demand",
    "get_demand_basis",
    "is_legacy_verbal_reply",
    "list_capacity_departments",
    "list_demands",
    "project_role_summary",
    "qualified_people",
    "reference_for_viewer",
    "reply_demand",
    "represents_department",
    "require_rejection_reason",
    "require_requester",
    "require_requesting_department",
    "respond_demand",
    "responder_user_ids",
    "responders_by_department",
    "submit_demand",
    "validate_department_text",
    "validate_load_words",
    "validate_reply_text",
    "verified_skill_shortage",
]
