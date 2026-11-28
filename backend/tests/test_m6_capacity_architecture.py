"""Keep capacity independent from profile publication and ingestion."""

import ast
from graphlib import TopologicalSorter
from pathlib import Path

import pytest
from sqlalchemy import Column, ForeignKey, Integer, MetaData, Table
from sqlmodel import SQLModel

pytestmark = pytest.mark.unit

APP = Path(__file__).resolve().parents[1] / "app"
ENTRYPOINTS = {
    "api/main.py",
    "api/routes/capacity.py",
    "api/routes/capacity_assignments.py",
    "api/routes/capacity_demands.py",
    "api/routes/capacity_forecast.py",
    "api/routes/capacity_workload.py",
    "api/routes/private.py",
    "domains/__init__.py",
    "mcp/server.py",
}
TRACKING_MODULE = "app.domains.capacity.tracking"
FORBIDDEN = {"profile", "evidence", "drafting", "source", "review", "change_request"}
EXCEPTIONS = {
    "app.domains.review.routing",
    "app.domains.change_request.schemas",
    "app.domains.source.models",
}


def imports(path: Path, relative: str) -> list[str]:
    modules = []
    package = ["app", *Path(relative).parts[:-1]]
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            modules.extend(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            prefix = (
                ".".join(package[: len(package) - node.level + 1]) if node.level else ""
            )
            module = ".".join(filter(None, [prefix, node.module]))
            modules.extend(f"{module}.{a.name}" for a in node.names)
    return modules


def violations(root: Path) -> list[str]:
    errors = []
    for path in root.rglob("*.py"):
        relative = path.relative_to(root).as_posix()
        inside = relative.startswith("domains/capacity/")
        planning = relative.startswith("domains/planning/")
        entrypoint = relative in ENTRYPOINTS or relative.startswith(
            ("domains/bot/", "domains/im/")
        )
        for module in imports(path, relative):
            if (
                not inside
                and not entrypoint
                and not (
                    relative == "domains/admin_assistant/registry.py"
                    and module
                    in {
                        "app.domains.capacity.tools.list_projects",
                        "app.domains.capacity.project.get_project",
                        "app.domains.capacity.demand.list_demands",
                        "app.domains.capacity.demand.get_demand",
                        "app.domains.capacity.demand_schemas.DemandListInput",
                        "app.domains.capacity.demand_schemas.DemandIdInput",
                        "app.domains.capacity.demand_schemas.ProjectIdInput",
                        "app.domains.capacity.settings.CapacityNotFound",
                        "app.domains.capacity.settings.read_settings",
                    }
                )
                and not (
                    relative == "worker/tasks.py"
                    and module
                    in {
                        "app.domains.capacity.forecast.refresh_org_forecasts",
                        "app.domains.capacity.proposal.expire",
                        f"{TRACKING_MODULE}.recompute",
                    }
                )
                and not (
                    relative == "api/routes/capacity_tracking.py"
                    and (
                        module == TRACKING_MODULE
                        or module.startswith(f"{TRACKING_MODULE}.")
                    )
                )
                and not (
                    planning
                    and (
                        module.startswith("app.domains.capacity.models.")
                        or module.startswith("app.domains.capacity.calendar.")
                        or module
                        in {
                            "app.domains.capacity.models",
                            "app.domains.capacity.calendar",
                            "app.domains.capacity.settings.require_enabled",
                            "app.domains.capacity.demand.demand_row",
                            "app.domains.capacity.demand.represents_department",
                            "app.domains.capacity.demand.department_reference",
                            "app.domains.capacity.demand.get_demand_basis",
                            "app.domains.capacity.demand.get_demand",
                            "app.domains.capacity.demand.reference_for_viewer",
                        }
                        or (
                            relative == "domains/planning/service.py"
                            and module
                            == "app.domains.capacity.forecast.refresh_org_forecasts"
                        )
                        or (
                            relative == "domains/planning/compose.py"
                            and (
                                module.startswith(
                                    "app.domains.capacity.demand_schemas."
                                )
                                or module
                                in {
                                    "app.domains.capacity.demand.can_view_demand_internals",
                                    "app.domains.capacity.demand.decision_history",
                                    "app.domains.capacity.demand.reply_demand",
                                    "app.domains.capacity.proposal.ProposalConflict",
                                    "app.domains.capacity.proposal.create",
                                    "app.domains.capacity.proposal.is_direct_commit",
                                    "app.domains.capacity.proposal.plan_lines",
                                    "app.domains.capacity.schemas.Via",
                                }
                            )
                        )
                    )
                )
                and (
                    module == "app.domains.capacity"
                    or module.startswith("app.domains.capacity.")
                )
            ):
                errors.append(f"{relative}: {module}")
            if planning and (
                (
                    module.startswith("app.domains.profile")
                    and not module.startswith(
                        ("app.domains.profile.models", "app.domains.profile.schemas")
                    )
                )
                or module.startswith("app.domains.review")
                or module.startswith("app.domains.change_request")
            ):
                errors.append(f"{relative}: {module}")
            if inside and module.startswith("app.domains.planning"):
                errors.append(f"{relative}: {module}")
            if (
                inside
                and any(
                    module.startswith(f"app.domains.{name}.")
                    or module == f"app.domains.{name}"
                    for name in FORBIDDEN
                )
                and not any(
                    module == allowed or module.startswith(allowed + ".")
                    for allowed in EXCEPTIONS
                )
            ):
                errors.append(f"{relative}: {module}")
    return errors


def test_capacity_import_boundaries() -> None:
    assert violations(APP) == []


@pytest.mark.parametrize(
    ("relative", "source"),
    [
        ("domains/profile/bad.py", "from app.domains import capacity"),
        ("domains/profile/bad.py", "import app.domains.capacity.workload as workload"),
        (
            "domains/admin_assistant/registry.py",
            "from app.domains.capacity import project",
        ),
        (
            "domains/admin_assistant/registry.py",
            "from app.domains.capacity.project import submit_project",
        ),
        (
            "domains/admin_assistant/tools.py",
            "from app.domains.capacity.project import get_project",
        ),
        (
            "domains/admin_assistant/registry.py",
            "from app.domains.capacity import demand",
        ),
        (
            "domains/admin_assistant/registry.py",
            "from app.domains.capacity.demand import submit_demand",
        ),
        (
            "domains/admin_assistant/registry.py",
            "from app.domains.capacity.demand import reply_demand",
        ),
        (
            "domains/admin_assistant/tools.py",
            "from app.domains.capacity.demand import get_demand",
        ),
        ("domains/capacity/bad.py", "from app.domains.review import publish"),
        ("domains/capacity/bad.py", "from ..profile.models import ProfileVersion"),
        (
            "domains/capacity/bad.py",
            "import app.domains.source.service",
        ),
        ("domains/planning/bad.py", "from app.domains.capacity import assignment"),
        (
            "domains/planning/bad.py",
            "from app.domains.capacity.demand import submit_demand",
        ),
        ("domains/planning/bad.py", "from app.domains.profile import service"),
        ("domains/planning/bad.py", "from app.domains.review import publish"),
        ("domains/capacity/bad.py", "from app.domains import planning"),
        ("worker/tasks.py", "from app.domains.capacity.proposal import accept"),
        (
            "worker/tasks.py",
            "from app.domains.capacity.assignment import create_assignment",
        ),
        ("worker/tasks.py", "from app.domains.capacity import proposal"),
        ("worker/other.py", "from app.domains.capacity.proposal import expire"),
        (
            "api/routes/capacity_tracking.py",
            "from app.domains.capacity import proposal",
        ),
        ("api/routes/other.py", "from app.domains.capacity import tracking"),
        ("worker/tasks.py", "from app.domains.capacity import tracking"),
        ("worker/other.py", f"from {TRACKING_MODULE} import recompute"),
        ("domains/source/sync.py", f"from {TRACKING_MODULE} import recompute"),
    ],
)
def test_import_counterexamples(tmp_path: Path, relative: str, source: str) -> None:
    path = tmp_path / relative
    path.parent.mkdir(parents=True)
    path.write_text(source)
    assert violations(tmp_path)


def test_admin_assistant_capacity_read_entrypoint(tmp_path: Path) -> None:
    path = tmp_path / "domains/admin_assistant/registry.py"
    path.parent.mkdir(parents=True)
    path.write_text(
        "from app.domains.capacity.tools import list_projects\n"
        "from app.domains.capacity.project import get_project\n"
        "from app.domains.capacity.demand import get_demand, list_demands\n"
        "from app.domains.capacity.demand_schemas import DemandIdInput, DemandListInput\n"
        "from app.domains.capacity.demand_schemas import ProjectIdInput\n"
        "from app.domains.capacity.settings import CapacityNotFound\n"
        "from app.domains.capacity.settings import read_settings as read_capacity_settings\n"
    )
    assert violations(tmp_path) == []


def test_worker_expiration_entrypoint(tmp_path: Path) -> None:
    path = tmp_path / "worker/tasks.py"
    path.parent.mkdir()
    path.write_text("from app.domains.capacity.proposal import expire")
    assert violations(tmp_path) == []
    path.write_text("from app.domains.capacity.proposal import expire, accept")
    assert violations(tmp_path) == [
        "worker/tasks.py: app.domains.capacity.proposal.accept"
    ]


def test_tracking_route_entrypoint(tmp_path: Path) -> None:
    path = tmp_path / "api/routes/capacity_tracking.py"
    path.parent.mkdir(parents=True)
    path.write_text(
        "from app.domains.capacity import tracking\n"
        f"from {TRACKING_MODULE} import AssignmentTracking, TrackingTask"
    )
    assert violations(tmp_path) == []


def test_worker_tracking_entrypoint(tmp_path: Path) -> None:
    path = tmp_path / "worker/tasks.py"
    path.parent.mkdir()
    path.write_text(f"from {TRACKING_MODULE} import recompute")
    assert violations(tmp_path) == []
    path.write_text(f"from {TRACKING_MODULE} import recompute, set_task_link")
    assert violations(tmp_path) == [f"worker/tasks.py: {TRACKING_MODULE}.set_task_link"]


def test_worker_forecast_entrypoint(tmp_path: Path) -> None:
    path = tmp_path / "worker/tasks.py"
    path.parent.mkdir()
    path.write_text("from app.domains.capacity.forecast import refresh_org_forecasts")
    assert violations(tmp_path) == []
    path.write_text("from app.domains.capacity.forecast import override_forecasts")
    assert violations(tmp_path) == [
        "worker/tasks.py: app.domains.capacity.forecast.override_forecasts"
    ]


def foreign_key_violations(metadata: MetaData) -> list[str]:
    errors = []
    for table in metadata.tables.values():
        if not table.name.startswith(("capacity_", "planning_")):
            errors.extend(
                table.name
                for fk in table.foreign_keys
                if fk.column.table.name.startswith("capacity_")
            )
    return errors


def test_profile_tables_do_not_reference_capacity() -> None:
    assert foreign_key_violations(SQLModel.metadata) == []


def test_foreign_key_counterexample() -> None:
    metadata = MetaData()
    Table("capacity_probe", metadata, Column("id", Integer, primary_key=True))
    Table(
        "profile_probe",
        metadata,
        Column("capacity_id", Integer, ForeignKey("capacity_probe.id")),
    )
    assert foreign_key_violations(metadata) == ["profile_probe"]


def test_workload_split_has_no_delayed_cycle_imports_and_keeps_facade() -> None:
    from app.domains.capacity import (
        common,
        workload,
        workload_carry_over,
        workload_requests,
        workload_views,
        workload_weeks,
    )

    capacity_dir = APP / "domains" / "capacity"
    prefix = "app.domains.capacity."
    targets = (
        f"{prefix}workload",
        f"{prefix}forecast",
        f"{prefix}tracking",
        f"{prefix}extension",
    )
    checked = [
        capacity_dir / name
        for name in (
            "forecast.py",
            "workload.py",
            "workload_views.py",
            "workload_weeks.py",
            "workload_carry_over.py",
            "workload_requests.py",
        )
    ]
    delayed: list[str] = []
    for path in checked:
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for inner in ast.walk(node):
                    if isinstance(inner, ast.Import):
                        for alias in inner.names:
                            if alias.name.startswith(targets):
                                delayed.append(f"{path.name}: {alias.name}")
                    elif isinstance(inner, ast.ImportFrom) and inner.module:
                        if inner.module.startswith(targets):
                            delayed.append(f"{path.name}: {inner.module}")
    assert delayed == []

    # Forbid dynamic __getattr__ / import_module indirection on the workload facade.
    workload_tree = ast.parse((capacity_dir / "workload.py").read_text())
    workload_funcs = {
        n.name for n in workload_tree.body if isinstance(n, ast.FunctionDef)
    }
    assert "__getattr__" not in workload_funcs
    assert "import_module" not in {
        alias.name
        for n in ast.walk(workload_tree)
        if isinstance(n, ast.ImportFrom) and n.module == "importlib"
        for alias in n.names
    }

    # Verify the actual top-level static dependency graph across workload/capacity modules is a strict DAG.
    dag_names = {
        "common",
        "workload",
        "workload_views",
        "workload_weeks",
        "workload_carry_over",
        "workload_requests",
        "forecast",
        "extension",
        "tracking",
        "demand",
    }
    dag: dict[str, set[str]] = {}
    for mod_name in dag_names:
        mod_tree = ast.parse((capacity_dir / f"{mod_name}.py").read_text())
        deps: set[str] = set()
        for stmt in mod_tree.body:
            if isinstance(stmt, ast.ImportFrom) and stmt.module:
                if stmt.module == "app.domains.capacity":
                    deps.update(
                        alias.name for alias in stmt.names if alias.name in dag_names
                    )
                elif stmt.module.startswith(prefix):
                    target = stmt.module.removeprefix(prefix).split(".", 1)[0]
                    if target in dag_names:
                        deps.add(target)
            elif isinstance(stmt, ast.Import):
                for alias in stmt.names:
                    if alias.name.startswith(prefix):
                        target = alias.name.removeprefix(prefix).split(".", 1)[0]
                        if target in dag_names:
                            deps.add(target)
        dag[mod_name] = deps
    assert len(list(TopologicalSorter(dag).static_order())) == len(dag_names)

    expected_sources = {
        "AVAILABLE_BELOW": workload_views,
        "WorkloadSegments": workload_views,
        "get_my_workload": workload_views,
        "list_workloads": workload_views,
        "views": workload_views,
        "workload_reviewer_names": workload_views,
        "workload_reviewers": workload_views,
        "workload_segments": workload_views,
        "set_week": workload_weeks,
        "set_weeks": workload_weeks,
        "unavailability_public": workload_weeks,
        "list_unavailability": workload_weeks,
        "register_unavailability": workload_weeks,
        "delete_unavailability": workload_weeks,
        "ReversibleBatch": workload_carry_over,
        "preview_carry_over": workload_carry_over,
        "preview_carry_over_revert": workload_carry_over,
        "commit_carry_over": workload_carry_over,
        "revert_carry_over": workload_carry_over,
        "WorkloadWeekExpired": workload_requests,
        "validate_request_week": workload_requests,
        "request_workload_change": workload_requests,
        "list_workload_requests": workload_requests,
        "decide_workload_request": workload_requests,
        "employee": common,
        "notify_employee": common,
        "WORKLOAD_REVIEW_NOTICE": common,
        "EXTENSION_REVIEW_NOTICE": common,
    }
    facade_dict = vars(workload)
    assert set(workload.__all__) == set(expected_sources)
    for name, source_mod in expected_sources.items():
        assert name in facade_dict
        assert facade_dict[name] is getattr(source_mod, name)


def test_proposal_split_has_no_delayed_cycle_imports_and_keeps_facade() -> None:
    from app.domains.capacity import (
        demand,
        proposal,
        proposal_borrow,
        proposal_state,
        proposal_validation,
        proposal_views,
    )

    capacity_dir = APP / "domains" / "capacity"
    prefix = "app.domains.capacity."
    targets = (
        f"{prefix}proposal",
        f"{prefix}demand",
    )
    checked = [
        capacity_dir / name
        for name in (
            "common.py",
            "demand.py",
            "proposal.py",
            "proposal_views.py",
            "proposal_validation.py",
            "proposal_state.py",
            "proposal_borrow.py",
        )
    ]
    delayed: list[str] = []
    for path in checked:
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for inner in ast.walk(node):
                    if isinstance(inner, ast.Import):
                        for alias in inner.names:
                            if alias.name.startswith(targets):
                                delayed.append(f"{path.name}: {alias.name}")
                    elif isinstance(inner, ast.ImportFrom) and inner.module:
                        if inner.module.startswith(targets) or (
                            inner.module == "app.domains.capacity"
                            and any(
                                a.name in {"demand", "proposal"} for a in inner.names
                            )
                        ):
                            delayed.append(f"{path.name}: {inner.module}")
    assert delayed == []

    # Forbid dynamic __getattr__ / import_module indirection on the proposal facade.
    proposal_tree = ast.parse((capacity_dir / "proposal.py").read_text())
    proposal_funcs = {
        n.name for n in proposal_tree.body if isinstance(n, ast.FunctionDef)
    }
    assert "__getattr__" not in proposal_funcs
    assert "import_module" not in {
        alias.name
        for n in ast.walk(proposal_tree)
        if isinstance(n, ast.ImportFrom) and n.module == "importlib"
        for alias in n.names
    }

    # Verify the top-level static dependency graph across capacity modules is a strict DAG.
    dag_names = {
        "common",
        "settings",
        "workload_views",
        "workload_weeks",
        "workload_carry_over",
        "workload_requests",
        "workload",
        "forecast_policy",
        "forecast",
        "extension",
        "tracking",
        "assignment",
        "demand",
        "proposal_views",
        "proposal_validation",
        "proposal_state",
        "proposal_borrow",
        "proposal",
    }
    dag: dict[str, set[str]] = {}
    for mod_name in dag_names:
        mod_tree = ast.parse((capacity_dir / f"{mod_name}.py").read_text())
        deps: set[str] = set()
        for stmt in mod_tree.body:
            if isinstance(stmt, ast.ImportFrom) and stmt.module:
                if stmt.module == "app.domains.capacity":
                    deps.update(
                        alias.name for alias in stmt.names if alias.name in dag_names
                    )
                elif stmt.module.startswith(prefix):
                    target = stmt.module.removeprefix(prefix).split(".", 1)[0]
                    if target in dag_names:
                        deps.add(target)
            elif isinstance(stmt, ast.Import):
                for alias in stmt.names:
                    if alias.name.startswith(prefix):
                        target = alias.name.removeprefix(prefix).split(".", 1)[0]
                        if target in dag_names:
                            deps.add(target)
        dag[mod_name] = deps
    assert len(list(TopologicalSorter(dag).static_order())) == len(dag_names)

    expected_reexports = {
        "BORROW_ACCEPTED_PENDING": proposal_views,
        "BORROW_COMMITTED": proposal_views,
        "active_segments": proposal_views,
        "approvals_for": proposal_views,
        "arrangement": proposal_views,
        "decision_history": proposal_views,
        "latest": proposal_views,
        "lines_for": proposal_views,
        "public": proposal_views,
        "reply_superseded": proposal_views,
        "schedule_summary": proposal_views,
        "schedules_for_demands": proposal_views,
        "ProposalConflict": proposal_validation,
        "check_lines": proposal_validation,
        "conflict_sources": proposal_validation,
        "is_direct_commit": proposal_validation,
        "plan_lines": proposal_validation,
        "HOLD_DURATION": proposal_state,
        "ProposalFailed": proposal_state,
        "ProposalOwnershipError": proposal_state,
        "ProposalSelfApprovalForbidden": proposal_state,
        "accept": proposal_state,
        "assert_assignment_line": proposal_state,
        "check_pending": proposal_state,
        "check_requester_decision": proposal_state,
        "create": proposal_state,
        "current_principal": proposal_state,
        "decided": proposal_state,
        "expire": proposal_state,
        "expire_locked": proposal_state,
        "fail": proposal_state,
        "notify_parties": proposal_state,
        "withdraw_locked": proposal_state,
        "borrow_requests": proposal_borrow,
        "decide_borrow": proposal_borrow,
    }
    facade_dict = vars(proposal)
    assert set(proposal.__all__) == set(expected_reexports) | {"respond", "withdraw"}
    for name, source_mod in expected_reexports.items():
        assert name in facade_dict
        assert facade_dict[name] is getattr(source_mod, name)
    for name in (
        "respond",
        "withdraw",
        "_aligned_participants",
        "_grouped_lines",
        "_over_week_entry",
        "_public_approvals",
        "_ready_requester_approval",
        "_recheck_acceptance",
        "_replace_segments",
        "_schedule_phases",
        "_verify_employee_weeks",
    ):
        assert name in facade_dict and callable(facade_dict[name])
    assert demand.respond_demand is not None


def test_demand_split_has_no_delayed_cycle_imports_and_keeps_facade() -> None:
    from app.domains.capability import search
    from app.domains.capacity import (
        common,
        demand,
        demand_actions,
        demand_views,
        models,
    )

    capacity_dir = APP / "domains" / "capacity"
    demand_tree = ast.parse((capacity_dir / "demand.py").read_text())
    demand_funcs = {n.name for n in demand_tree.body if isinstance(n, ast.FunctionDef)}
    assert "__getattr__" not in demand_funcs
    assert "import_module" not in {
        alias.name
        for n in ast.walk(demand_tree)
        if isinstance(n, ast.ImportFrom) and n.module == "importlib"
        for alias in n.names
    }

    expected_reexports = {
        "DEMAND_NOT_FOUND": common,
        "LOAD_WORDS": common,
        "CapacityConflict": common,
        "CapacityDemand": models,
        "CapacityForbidden": common,
        "CapacityNotFound": common,
        "find_people": search,
        "DemandReplyInvalid": common,
        "DemandReplyLoadInvalid": common,
        "RejectionReasonInvalid": common,
        "can_view_demand_internals": common,
        "demand_row": common,
        "department": common,
        "qualified_people": common,
        "represents_department": common,
        "require_rejection_reason": common,
        "responder_user_ids": common,
        "responders_by_department": common,
        "validate_department_text": common,
        "validate_load_words": common,
        "require_requester": demand_views,
        "list_capacity_departments": demand_views,
        "department_reference": demand_views,
        "capacity_reference": demand_views,
        "reference_for_viewer": demand_views,
        "demand_public": demand_views,
        "demands_public": demand_views,
        "project_role_summary": demand_views,
        "get_demand": demand_views,
        "decision_history": demand_views,
        "list_demands": demand_views,
        "verified_skill_shortage": demand_views,
        "get_demand_basis": demand_views,
        "is_legacy_verbal_reply": demand_views,
        "DemandAwaitingSchedule": demand_actions,
        "require_requesting_department": demand_actions,
        "submit_demand": demand_actions,
        "create_demand": demand_actions,
        "validate_reply_text": demand_actions,
        "reply_demand": demand_actions,
        "respond_demand": demand_actions,
    }
    facade_dict = vars(demand)
    assert set(demand.__all__) == set(expected_reexports)
    for name, source_mod in expected_reexports.items():
        assert name in facade_dict
        assert facade_dict[name] is getattr(source_mod, name)


def test_assistant_split_has_no_delayed_cycle_imports_and_keeps_facade() -> None:
    from app.domains.capacity import (
        assistant,
        assistant_demands,
        assistant_forecast,
        assistant_workload,
    )

    facade_dict = vars(assistant)
    expected_reexports = {
        "ChangeOnWeb": assistant_demands,
        "RESPONSES": assistant_demands,
        "DEMAND_REPLY_REASON_GUIDANCE": assistant_demands,
        "DEMAND_REPLY_PLAN_GUIDANCE": assistant_demands,
        "SKILL_REPLY_TEXT": assistant_demands,
        "SKILL_REPLY_UNVERIFIED": assistant_demands,
        "STAFFING_FIELDS": assistant_demands,
        "STAFFING_TEXT": assistant_demands,
        "PRIVATE_TEXT": assistant_demands,
        "DraftTextInvalid": assistant_demands,
        "validate_draft_text": assistant_demands,
        "PrepareDemandInput": assistant_demands,
        "requester_departments": assistant_demands,
        "DemandDepartmentForbidden": assistant_demands,
        "check_demand": assistant_demands,
        "check_demand_response": assistant_demands,
        "check_demand_reply": assistant_demands,
        "PrepareForecastPolicyInput": assistant_forecast,
        "PrepareForecastEventInput": assistant_forecast,
        "_scope_label": assistant_forecast,
        "get_forecast_config_for_bot": assistant_forecast,
        "check_forecast_policy": assistant_forecast,
        "check_forecast_event": assistant_forecast,
        "check_workload_request": assistant_workload,
        "check_leave": assistant_workload,
        "check_team_workload": assistant_workload,
        "check_extension_request": assistant_workload,
    }
    for name, source_mod in expected_reexports.items():
        assert name in facade_dict
        assert facade_dict[name] is getattr(source_mod, name)
    for name in ("READS", "WRITES", "PREPARES", "TITLES", "CHECKS", "RESULTS"):
        assert isinstance(facade_dict[name], dict)
    for name in ("definitions", "read_progress", "call", "act"):
        assert callable(facade_dict[name])


def test_capacity_has_zero_internal_delayed_imports_and_strict_dag() -> None:
    capacity_dir = APP / "domains" / "capacity"
    prefix = "app.domains.capacity."
    mod_paths = [p for p in sorted(capacity_dir.glob("*.py")) if p.stem != "__init__"]
    mod_names = {p.stem for p in mod_paths}
    delayed: list[str] = []
    dag: dict[str, set[str]] = {}
    for path in mod_paths:
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for inner in ast.walk(node):
                    if isinstance(inner, ast.Import):
                        for alias in inner.names:
                            if alias.name.startswith(prefix):
                                delayed.append(f"{path.name}: {alias.name}")
                    elif isinstance(inner, ast.ImportFrom) and inner.module:
                        if inner.module.startswith(prefix) or (
                            inner.module == "app.domains.capacity"
                        ):
                            delayed.append(f"{path.name}: {inner.module}")
        deps: set[str] = set()
        for stmt in tree.body:
            if isinstance(stmt, ast.ImportFrom) and stmt.module:
                if stmt.module == "app.domains.capacity":
                    deps.update(
                        alias.name for alias in stmt.names if alias.name in mod_names
                    )
                elif stmt.module.startswith(prefix):
                    target = stmt.module.removeprefix(prefix).split(".", 1)[0]
                    if target in mod_names:
                        deps.add(target)
            elif isinstance(stmt, ast.Import):
                for alias in stmt.names:
                    if alias.name.startswith(prefix):
                        target = alias.name.removeprefix(prefix).split(".", 1)[0]
                        if target in mod_names:
                            deps.add(target)
        dag[path.stem] = deps
    assert delayed == []
    assert len(list(TopologicalSorter(dag).static_order())) == len(mod_names)


def test_capacity_routes_split_and_private_playwright_router_gating(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fastapi import APIRouter
    from fastapi.routing import APIRoute

    from app.api.main import include_playwright_fixtures
    from app.api.routes import (
        capacity,
        capacity_assignments,
        capacity_demands,
        capacity_forecast,
        capacity_workload,
        private,
    )
    from app.core.config import settings

    split_routes = [
        route
        for mod in (
            capacity_workload,
            capacity_forecast,
            capacity_demands,
            capacity_assignments,
        )
        for route in mod.router.routes
        if isinstance(route, APIRoute)
    ]
    assert len(split_routes) == 48
    assert len(capacity.router.routes) == 48
    assert not hasattr(capacity, "playwright_router")
    assert all(route.tags == ["capacity"] for route in split_routes)
    assert all("legacy-accepted-demands" not in route.path for route in split_routes)
    assert not any(
        isinstance(r, APIRoute) and "legacy-accepted-demands" in r.path
        for r in private.router.routes
    )
    fixture_routes = [
        r for r in private.playwright_router.routes if isinstance(r, APIRoute)
    ]
    assert [r.path for r in fixture_routes] == [
        "/private/orgs/{org_id}/legacy-accepted-demands/{demand_id}"
    ]
    assert all(not r.include_in_schema for r in fixture_routes)

    def mounted_paths() -> list[str]:
        probe = APIRouter()
        include_playwright_fixtures(probe)
        paths: list[str] = []
        for entry in probe.routes:
            if isinstance(entry, APIRoute):
                paths.append(entry.path)
            elif (orig := getattr(entry, "original_router", None)) is not None:
                paths.extend(r.path for r in orig.routes if isinstance(r, APIRoute))
        return paths

    monkeypatch.setattr(settings, "FASTAPI_ENV", "development")
    monkeypatch.setattr(settings, "PLAYWRIGHT_FIXTURES_ENABLED", False)
    assert mounted_paths() == []
    monkeypatch.setattr(settings, "PLAYWRIGHT_FIXTURES_ENABLED", True)
    assert (
        "/private/orgs/{org_id}/legacy-accepted-demands/{demand_id}" in mounted_paths()
    )
    monkeypatch.setattr(settings, "FASTAPI_ENV", "production")
    assert mounted_paths() == []
