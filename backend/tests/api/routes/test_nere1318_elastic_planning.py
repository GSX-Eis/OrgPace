from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.authz.principal import Principal
from app.domains.audit.models import ActorKind
from app.domains.bot import tools as bot_tools
from app.domains.capacity.models import CapacityWeek
from app.domains.planning import service, simulator
from app.domains.planning import tools as planning_tools
from app.domains.planning.cpsat import CpSatSolver
from app.domains.planning.models import OptionKind, PlanVerdict
from app.domains.planning.schemas import CasePerson, CasePublic, OptionPublic
from app.domains.planning.solver import Role
from app.domains.planning.validator import validate
from tests.api.routes.test_m7_planning_readonly import business_rows_without_forecast
from tests.api.routes.test_m7_planning_validator import (
    _publish_initial_profile,
    params,
    snapshot,
)
from tests.api.routes.test_m7_planning_validator import (
    planning_setup as planning_setup,
)

START = date(2026, 11, 16)
END = date(2026, 11, 29)


def _two_tier_snapshot(
    *,
    default_cap: int | None = 70,
    allow_elastic: bool | None = False,
    capacity: int = 100,
    other: int = 30,
    newcomer: bool = False,
    eid: str | None = None,
) -> dict[str, Any]:
    data = snapshot(capacity=capacity, other=other)
    if eid is not None:
        data["candidates"][0]["employee_id"] = eid
    data["candidates"][0]["newcomer"] = newcomer
    if default_cap is not None:
        data["rules"]["default_allocation_cap_percent"] = default_cap
    if allow_elastic is not None:
        data["rules"]["allow_elastic"] = allow_elastic
    return data


def test_validator_two_tier_cap_and_leave_min() -> None:
    regular_data = _two_tier_snapshot(default_cap=70, allow_elastic=False, other=30)
    blocked = validate(regular_data, params(percent=50))
    assert blocked.verdict == "infeasible"
    assert blocked.summary["regular_cap_percent"] == 70
    assert blocked.summary["uses_elastic"] is False
    assert blocked.summary["elastic_used_percent"] == 0
    assert any(
        f["code"] == "over_regular_cap"
        and f["message"] == "该周超出常规配额上限（70%）10%，需允许动用弹性空间"
        for f in blocked.findings
    )

    elastic_data = _two_tier_snapshot(default_cap=70, allow_elastic=True, other=30)
    allowed = validate(elastic_data, params(percent=50))
    assert allowed.verdict == "feasible"
    assert allowed.summary["regular_cap_percent"] == 70
    assert allowed.summary["uses_elastic"] is True
    assert allowed.summary["elastic_used_percent"] == 10
    assert any(
        f["code"] == "elastic_used" and f["message"] == "已占用弹性配额 10%"
        for f in allowed.findings
    )

    over_physical = _two_tier_snapshot(default_cap=70, allow_elastic=True, other=60)
    physical_fail = validate(over_physical, params(percent=50))
    assert physical_fail.verdict == "infeasible"
    assert physical_fail.summary["uses_elastic"] is False
    assert physical_fail.summary["elastic_used_percent"] == 0
    assert any(
        f["code"] == "over_capacity" and f["message"] == "该周超出可用容量 10%"
        for f in physical_fail.findings
    )

    # Employee on leave (60% physical < 70% default cap): regular_cap=60, elastic space=0%.
    leave_ok = _two_tier_snapshot(
        default_cap=70, allow_elastic=False, capacity=60, other=20
    )
    leave_ok["demand"]["allocation_percent"] = 40
    assert validate(leave_ok, params(percent=40)).verdict == "feasible"
    leave_over = _two_tier_snapshot(
        default_cap=70, allow_elastic=True, capacity=60, other=20
    )
    leave_res = validate(leave_over, params(percent=50))
    assert leave_res.verdict == "infeasible"
    assert leave_res.summary["uses_elastic"] is False
    assert leave_res.summary["elastic_used_percent"] == 0
    assert any(f["code"] == "over_capacity" for f in leave_res.findings)

    # Employee on 40% leave (< 70% default cap) with 50% demand is infeasible.
    leave_40 = _two_tier_snapshot(
        default_cap=70, allow_elastic=True, capacity=40, other=0
    )
    leave_40_res = validate(leave_40, params(percent=50))
    assert leave_40_res.verdict == "infeasible"
    assert leave_40_res.summary["uses_elastic"] is False
    assert leave_40_res.summary["elastic_used_percent"] == 0
    assert any(f["code"] == "over_capacity" for f in leave_40_res.findings)

    # Custom default_cap=60 with partial leave capacity=80 allows 60..80 in elastic mode.
    custom_cap = _two_tier_snapshot(
        default_cap=60, allow_elastic=True, capacity=80, other=20
    )
    custom_res = validate(custom_cap, params(percent=50))
    assert custom_res.verdict == "feasible"
    assert custom_res.summary["regular_cap_percent"] == 60
    assert custom_res.summary["elastic_used_percent"] == 10

    # Legacy snapshot without default_allocation_cap_percent falls back to 100.
    legacy = _two_tier_snapshot(default_cap=None, allow_elastic=None, other=40)
    legacy_res = validate(legacy, params(percent=50))
    assert legacy_res.verdict == "feasible"
    assert legacy_res.summary["regular_cap_percent"] == 100
    assert legacy_res.summary["uses_elastic"] is False


def test_simulator_and_cpsat_minimize_elastic_usage() -> None:
    regular_eid = str(uuid4())
    elastic_newcomer_eid = str(uuid4())
    base = _two_tier_snapshot(
        default_cap=70,
        allow_elastic=False,
        other=40,
        newcomer=True,
        eid=elastic_newcomer_eid,
    )
    regular_candidate = _two_tier_snapshot(
        default_cap=70, allow_elastic=False, other=10, newcomer=False, eid=regular_eid
    )["candidates"][0]
    base["candidates"].append(regular_candidate)

    # Regular mode: only regular candidate is feasible; newcomer needing elastic is skipped.
    reg_ranked = simulator.ranked_candidates(base, START, END)
    assert reg_ranked[0][0]["employee_id"] == regular_eid
    assert (
        CpSatSolver().solve([Role("1", base)]).filled["1"][0]["employee_id"]
        == regular_eid
    )

    # Elastic mode: CP-SAT still prefers regular candidate (0 elastic) over elastic newcomer.
    elastic_base = {**base, "rules": {**base["rules"], "allow_elastic": True}}
    solved = CpSatSolver().solve([Role("1", elastic_base)])
    assert solved.filled["1"][0]["employee_id"] == regular_eid

    # When all candidates need elastic space, CP-SAT picks the one using less elastic quota.
    low_elastic_eid = str(uuid4())
    high_elastic_eid = str(uuid4())
    both_elastic = _two_tier_snapshot(
        default_cap=70,
        allow_elastic=False,
        other=50,
        newcomer=True,
        eid=high_elastic_eid,
    )
    both_elastic["candidates"].append(
        _two_tier_snapshot(
            default_cap=70,
            allow_elastic=False,
            other=30,
            newcomer=False,
            eid=low_elastic_eid,
        )["candidates"][0]
    )
    assert CpSatSolver().solve([Role("1", both_elastic)]).filled == {}
    both_elastic_allowed = {
        **both_elastic,
        "rules": {**both_elastic["rules"], "allow_elastic": True},
    }
    min_solved = CpSatSolver().solve([Role("1", both_elastic_allowed)])
    assert min_solved.filled["1"][0]["employee_id"] == low_elastic_eid

    # When regular_available is negative (other=80 vs other=70 for 20% demand), picks 70.
    neg_high = str(uuid4())
    neg_low = str(uuid4())
    neg_data = _two_tier_snapshot(
        default_cap=70, allow_elastic=True, other=80, eid=neg_high
    )
    neg_data["demand"]["allocation_percent"] = 20
    neg_data["candidates"].append(
        _two_tier_snapshot(default_cap=70, allow_elastic=True, other=70, eid=neg_low)[
            "candidates"
        ][0]
    )
    neg_solved = CpSatSolver().solve([Role("1", neg_data)])
    assert neg_solved.filled["1"][0]["employee_id"] == neg_low


def test_api_elastic_case_setting_stale_and_tools_plan_card(
    planning_setup: tuple[Any, ...], db: Session, client: TestClient
) -> None:
    url, employees, auth, demand = planning_setup
    for code in ("E04", "E05"):
        _publish_initial_profile(
            client, url, auth["admin"], employees[code], demand.capability_key
        )
    for week in db.exec(
        select(CapacityWeek).where(CapacityWeek.org_id == demand.org_id)
    ).all():
        week.other_percent = 30
    for code in ("E04", "E05"):
        for offset in range(2, 10):
            db.add(
                CapacityWeek(
                    org_id=demand.org_id,
                    employee_id=employees[code].id,
                    week_start=demand.window_start + timedelta(weeks=offset),
                    other_percent=30,
                    confirmed_by_user_id=demand.requester_user_id,
                )
            )
    db.commit()
    before = business_rows_without_forecast(db, demand.org_id)

    # 1. Default POST (no body) uses allow_elastic=False and respects 70% regular cap.
    regular_resp = client.post(
        f"{url}/planning/demands/{demand.id}/cases", headers=auth["b"]
    )
    assert regular_resp.status_code == 200, regular_resp.text
    regular_case = regular_resp.json()
    assert regular_case["data"]["rules"]["default_allocation_cap_percent"] == 70
    assert regular_case["data"]["rules"]["allow_elastic"] is False
    direct_reg = next(o for o in regular_case["options"] if o["kind"] == "direct")
    assert direct_reg["verdict"] == "infeasible"
    assert any(f["code"] == "over_regular_cap" for f in direct_reg["findings"])
    assert not any(o["kind"] == "optimized" for o in regular_case["options"])
    assert business_rows_without_forecast(db, demand.org_id) == before

    mgr_principal = Principal(
        actor_type=ActorKind.USER,
        org_id=demand.org_id,
        user_id=demand.requester_user_id,
        employee_id=employees["E05"].id,
        is_org_admin=True,
        managed_department_ids=frozenset({demand.target_department_id}),
    )
    reg_case_public = service.get_case(mgr_principal, db, UUID(regular_case["id"]))
    reg_opt_public = next(o for o in reg_case_public.options if o.kind == "direct")
    assert not any(
        field.label == "弹性配额占用"
        for field in bot_tools.plan_card(reg_opt_public, reg_case_public).fields
    )

    # 2. Explicit allow_elastic=True unlocks elastic space and stays non-stale on GET.
    elastic_resp = client.post(
        f"{url}/planning/demands/{demand.id}/cases",
        headers=auth["b"],
        json={"allow_elastic": True},
    )
    assert elastic_resp.status_code == 200, elastic_resp.text
    elastic_case = elastic_resp.json()
    assert elastic_case["stale"] is False
    assert elastic_case["data"]["rules"]["allow_elastic"] is True
    fetched = client.get(
        f"{url}/planning/cases/{elastic_case['id']}", headers=auth["b"]
    )
    assert fetched.status_code == 200
    assert fetched.json()["stale"] is False
    direct_el = next(o for o in elastic_case["options"] if o["kind"] == "direct")
    assert direct_el["verdict"] == "feasible"
    assert direct_el["summary"]["regular_cap_percent"] == 70
    assert direct_el["summary"]["uses_elastic"] is True
    assert direct_el["summary"]["elastic_used_percent"] == 10
    assert any(f["code"] == "elastic_used" for f in direct_el["findings"])
    assert any(o["kind"] == "optimized" for o in elastic_case["options"])
    assert business_rows_without_forecast(db, demand.org_id) == before

    # 3. Planning tool simulate_plan + bot plan_card display elastic usage field.
    tool_res = planning_tools.simulate_plan(
        mgr_principal,
        db,
        planning_tools.SimulateInput(demand_id=demand.id, allow_elastic=True),
    )
    assert tool_res.root["options"][0]["summary"]["uses_elastic"] is True
    case_public = service.get_case(mgr_principal, db, UUID(elastic_case["id"]))
    opt_public = next(o for o in case_public.options if o.kind == "direct")
    card = bot_tools.plan_card(opt_public, case_public)
    assert any(
        field.label == "弹性配额占用" and field.value == "已占用弹性配额 10%"
        for field in card.fields
    )
    db.rollback()

    # 4. Updating org default_allocation_cap_percent marks existing snapshot stale.
    updated_setting = client.put(
        f"{url}/capacity-settings",
        headers=auth["admin"],
        json={
            "enabled": True,
            "requester_policy": "everyone",
            "default_allocation_cap_percent": 80,
        },
    )
    assert updated_setting.status_code == 200, updated_setting.text
    stale_check = client.get(
        f"{url}/planning/cases/{elastic_case['id']}", headers=auth["b"]
    )
    assert stale_check.status_code == 200
    assert stale_check.json()["stale"] is True
    rejected_option = client.post(
        f"{url}/planning/cases/{elastic_case['id']}/options",
        headers=auth["b"],
        json={
            "assignees": [
                {
                    "employee_id": str(employees["E04"].id),
                    "allocation_percent": 50,
                    "start_date": demand.window_start.isoformat(),
                    "end_date": demand.window_end.isoformat(),
                }
            ]
        },
    )
    assert rejected_option.status_code == 409


def test_validator_clears_elastic_usage_when_another_week_over_capacity() -> None:
    eid = str(uuid4())
    data = _two_tier_snapshot(
        default_cap=70, allow_elastic=True, capacity=100, other=60, eid=eid
    )
    data["demand"]["allocation_percent"] = 20
    for week in data["candidates"][0]["weeks"]:
        if week["week_start"] == "2026-11-23":
            week["other_percent"] = 95

    plan_params = params(employee_id=eid, percent=20)
    result = validate(data, plan_params)

    assert result.verdict == "infeasible"
    assert result.summary["uses_elastic"] is False
    assert result.summary["elastic_used_percent"] == 0
    assert any(f["code"] == "over_capacity" for f in result.findings)
    assert not any(f["code"] == "elastic_used" for f in result.findings)

    snapshot_id = uuid4()
    now = datetime.now(UTC)
    option = OptionPublic(
        id=uuid4(),
        snapshot_id=snapshot_id,
        kind=OptionKind.DIRECT,
        params=plan_params,
        verdict=PlanVerdict(result.verdict),
        findings=result.findings,
        summary=result.summary,
        created_at=now,
    )
    case = CasePublic(
        id=uuid4(),
        demand_id=uuid4(),
        snapshot_id=snapshot_id,
        snapshot_created_at=now,
        data=data,
        stale=False,
        notes=[],
        people=[CasePerson(employee_id=UUID(eid), display_name="测试员工")],
        options=[option],
    )
    card = bot_tools.plan_card(option, case)
    assert not any(field.label == "弹性配额占用" for field in card.fields)
