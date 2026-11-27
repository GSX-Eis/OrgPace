"""Regression tests for NERE-1375: planning & proposal forecast baseline integration."""

from collections.abc import Generator
from datetime import date, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, delete, select

from app.core.security import create_access_token
from app.domains.audit.models import AuditEvent
from app.domains.base import utc_now
from app.domains.capability.models import (
    CapabilityDefinition,
    CapabilitySchemaVersion,
    SchemaStatus,
)
from app.domains.capacity import forecast as capacity_forecast
from app.domains.capacity.calendar import this_week
from app.domains.capacity.models import (
    CapacityApproval,
    CapacityAssignment,
    CapacityDemand,
    CapacityDemandEvent,
    CapacityProposal,
    CapacityProposalLine,
    CapacitySetting,
    CapacityWeek,
    CapacityWeekForecast,
    DemandStatus,
    ForecastSource,
)
from app.domains.org.models import (
    Department,
    Employee,
    Organization,
    OrgMembership,
    RoleGrant,
)
from app.domains.planning import simulator, validator
from app.domains.planning.cpsat import CpSatSolver
from app.domains.planning.models import PlanningCase, PlanningOption, PlanningSnapshot
from app.domains.planning.solver import Role
from app.models import User
from tests.api.routes.test_m7_planning_validator import _publish_initial_profile
from tests.utils.org import cleanup_new_users, delete_test_organization


@pytest.fixture
def forecast_org(db: Session) -> Generator[tuple[Any, ...]]:
    existing_users = set(db.exec(select(User.id)).all())
    org = Organization(slug=f"nere1375-{uuid4().hex}", name="NERE-1375 预测方案测试")
    db.add(org)
    db.flush()
    dept_a = Department(org_id=org.id, name="需求部门")
    dept_b = Department(org_id=org.id, name="交付部门")
    dept_isolated = Department(
        org_id=org.id, name="独立子组", parent_department_id=None
    )
    db.add_all([dept_a, dept_b, dept_isolated])
    db.flush()
    dept_isolated.parent_department_id = dept_b.id
    db.add(dept_isolated)
    db.flush()

    people: dict[str, Employee] = {}
    users: dict[str, User] = {}
    specs = [
        ("A1", dept_a, "需求经理", True),
        ("M1", dept_b, "交付经理一", True),
        ("M2", dept_b, "交付经理二", True),
        ("B_BUSY", dept_b, "忙碌下属", False),
        ("B_FREE", dept_b, "有余量下属", False),
        ("B_NEW", dept_isolated, "零历史新人", False),
    ]
    for code, dept, name, is_mgr in specs:
        emp = Employee(
            org_id=org.id,
            department_id=dept.id,
            employee_code=code,
            display_name=name,
            work_email=f"{code.lower()}-{uuid4().hex[:6]}@example.com",
            hire_date=utc_now().date() - timedelta(days=30 if code == "B_NEW" else 500),
        )
        db.add(emp)
        db.flush()
        people[code] = emp
        user = User(
            username=f"u-{code.lower()}-{uuid4().hex[:6]}",
            email=emp.work_email,
            hashed_password="unused",
        )
        db.add(user)
        db.flush()
        users[code] = user
        member = OrgMembership(org_id=org.id, user_id=user.id, employee_id=emp.id)
        db.add(member)
        db.flush()
        if is_mgr:
            db.add(
                RoleGrant(
                    org_id=org.id,
                    membership_id=member.id,
                    role="dept_manager",
                    department_id=dept.id,
                )
            )
    admin_user = User(
        username=f"u-admin-{uuid4().hex[:6]}",
        email=f"admin-{uuid4().hex[:6]}@example.com",
        hashed_password="unused",
    )
    db.add(admin_user)
    db.flush()
    admin_member = OrgMembership(org_id=org.id, user_id=admin_user.id, employee_id=None)
    db.add(admin_member)
    db.flush()
    db.add(RoleGrant(org_id=org.id, membership_id=admin_member.id, role="org_admin"))
    users["ADMIN"] = admin_user
    schema = CapabilitySchemaVersion(
        org_id=org.id, version=1, status=SchemaStatus.ACTIVE
    )
    db.add(schema)
    db.flush()
    db.add(
        CapabilityDefinition(
            org_id=org.id,
            schema_version_id=schema.id,
            key="backend_api",
            name="后端接口",
            level_rubric={
                "levels": [
                    {"key": "beginner", "label": "初级"},
                    {"key": "routine", "label": "独立完成"},
                    {"key": "expert", "label": "精通"},
                ]
            },
        )
    )
    db.add(
        CapacitySetting(
            org_id=org.id,
            enabled=True,
            default_allocation_cap_percent=70,
            updated_by_user_id=users["M1"].id,
        )
    )
    db.commit()

    start = this_week(db, org.id)
    # Seed recent 4 weeks of confirmed history so refresh_org_forecasts produces differentiated forecasts:
    # M1=10%, B_BUSY=200% (decays to 25% at +8w), B_FREE=20% (decays to 0% at +8w).
    # B_NEW is in dept_isolated with no colleagues, so gets NO forecast.
    for offset in range(4):
        wk = start + timedelta(weeks=offset)
        for code, pct in (("M1", 10), ("B_BUSY", 200), ("B_FREE", 20)):
            db.add(
                CapacityWeek(
                    org_id=org.id,
                    employee_id=people[code].id,
                    week_start=wk,
                    other_percent=pct,
                    confirmed_by_user_id=users["M2"].id,
                )
            )
    db.commit()

    auth = {
        code: {
            "Authorization": f"Bearer {create_access_token(users[code].id, expires_delta=timedelta(hours=1))}"
        }
        for code in users
    }
    try:
        yield f"/api/v1/orgs/{org.id}", org, dept_a, dept_b, people, users, auth, start
    finally:
        db.rollback()
        for model in (
            PlanningOption,
            PlanningSnapshot,
            PlanningCase,
            CapacityAssignment,
            CapacityApproval,
            CapacityProposalLine,
            CapacityProposal,
            CapacityDemandEvent,
            CapacityDemand,
            CapacityWeekForecast,
            CapacityWeek,
            CapacitySetting,
        ):
            db.exec(delete(model).where(model.org_id == org.id))
        db.commit()
        delete_test_organization(db, org.id)
        cleanup_new_users(db, existing_users)
        db.commit()


def _create_demand(
    db: Session,
    org_id: UUID,
    dept_a_id: UUID,
    dept_b_id: UUID,
    requester_user_id: UUID,
    window_start: Any,
    window_end: Any,
    *,
    allocation_percent: int = 50,
    headcount: int = 1,
) -> CapacityDemand:
    demand = CapacityDemand(
        org_id=org_id,
        requesting_department_id=dept_a_id,
        requester_user_id=requester_user_id,
        target_department_id=dept_b_id,
        capability_key="backend_api",
        capability_name="后端接口",
        minimum_level="routine",
        headcount=headcount,
        allocation_percent=allocation_percent,
        window_start=window_start,
        window_end=window_end,
        description="远期预测基线排期需求",
    )
    db.add(demand)
    db.commit()
    return demand


def test_effective_other_and_actor_guard() -> None:
    sub = str(uuid4())
    mgr = str(uuid4())
    start = "2027-01-04"
    base = {
        "demand": {
            "minimum_level": None,
            "headcount": 1,
            "allocation_percent": 50,
            "window_start": start,
            "window_end": "2027-01-10",
            "committed_end_date": "2027-01-10",
        },
        "rules": {
            "levels": [],
            "current_week": start,
            "default_allocation_cap_percent": 70,
            "allow_elastic": False,
            "actor_employee_id": mgr,
        },
        "candidates": [
            {
                "employee_id": mgr,
                "in_basis": True,
                "newcomer": False,
                "employment_status": "active",
                "level": None,
                "weeks": [
                    {
                        "week_start": start,
                        "capacity_percent": 100,
                        "other_percent": None,
                        "platform_percent": 0,
                        "status": "unconfirmed",
                        "confirmed_at": None,
                        "legacy_start": False,
                        "forecast_other_percent": 10,
                    }
                ],
            },
            {
                "employee_id": sub,
                "in_basis": True,
                "newcomer": False,
                "employment_status": "active",
                "level": None,
                "weeks": [
                    {
                        "week_start": start,
                        "capacity_percent": 100,
                        "other_percent": None,
                        "platform_percent": 0,
                        "status": "unconfirmed",
                        "confirmed_at": None,
                        "legacy_start": False,
                        "forecast_other_percent": 15,
                    }
                ],
            },
        ],
    }
    assert validator.effective_other(
        base["candidates"][0]["weeks"][0], allow_forecast=False
    ) == (None, False)
    assert validator.effective_other(
        base["candidates"][1]["weeks"][0], allow_forecast=True
    ) == (15, True)

    ranked = simulator.ranked_candidates(
        base, date.fromisoformat(start), date(2027, 1, 10)
    )
    assert [p["employee_id"] for p, _ in ranked] == [sub, mgr]

    sub_res = validator.validate(
        base,
        {
            "assignees": [
                {
                    "employee_id": sub,
                    "allocation_percent": 50,
                    "start_date": start,
                    "end_date": "2027-01-10",
                }
            ]
        },
    )
    assert sub_res.verdict == "feasible"
    assert [f["code"] for f in sub_res.findings] == ["forecast_week"]

    mgr_res = validator.validate(
        base,
        {
            "assignees": [
                {
                    "employee_id": mgr,
                    "allocation_percent": 50,
                    "start_date": start,
                    "end_date": "2027-01-10",
                }
            ]
        },
    )
    assert mgr_res.verdict == "insufficient_data"
    assert [f["code"] for f in mgr_res.findings] == ["unconfirmed"]

    solved = CpSatSolver().solve([Role("1", base)])
    assert solved.filled["1"][0]["employee_id"] == sub


def test_plan_generation_picks_subordinate_by_forecast_and_confirms_in_tx(
    forecast_org: tuple[Any, ...], client: TestClient, db: Session
) -> None:
    url, org, dept_a, dept_b, people, users, auth, start = forecast_org
    for code in ("M1", "B_BUSY", "B_FREE", "B_NEW"):
        _publish_initial_profile(
            client, url, auth["ADMIN"], people[code], "backend_api"
        )

    # Future demand 8 weeks out (2 weeks span): unconfirmed manually, but B_FREE/B_BUSY have forecasts.
    future_start = start + timedelta(weeks=8)
    future_end = future_start + timedelta(days=13)
    demand = _create_demand(
        db, org.id, dept_a.id, dept_b.id, users["A1"].id, future_start, future_end
    )

    # Create case as M1: refreshes agent_auto forecasts, selects B_FREE (not M1, not B_BUSY).
    created = client.post(
        f"{url}/planning/demands/{demand.id}/cases", headers=auth["M1"]
    )
    assert created.status_code == 200, created.text
    case = created.json()
    assert case["stale"] is False
    assert case["data"]["rules"]["actor_employee_id"] == str(people["M1"].id)
    direct = next(o for o in case["options"] if o["kind"] == "direct")
    assert direct["verdict"] == "feasible"
    assert [a["employee_id"] for a in direct["params"]["assignees"]] == [
        str(people["B_FREE"].id)
    ]
    assert {f["code"] for f in direct["findings"]} == {"forecast_week"}
    optimized = next(o for o in case["options"] if o["kind"] == "optimized")
    assert optimized["verdict"] == "feasible"
    assert [a["employee_id"] for a in optimized["params"]["assignees"]] == [
        str(people["B_FREE"].id)
    ]

    # Overriding B_FREE's forecast makes the existing snapshot stale.
    override_resp = client.put(
        f"{url}/capacity/forecasts",
        headers=auth["M1"],
        json={
            "employee_id": str(people["B_FREE"].id),
            "start_week": future_start.isoformat(),
            "end_week": future_start.isoformat(),
            "forecast_other_percent": 15,
            "note": "合成预测微调",
        },
    )
    assert override_resp.status_code == 200, override_resp.text
    stale_case = client.get(
        f"{url}/planning/cases/{case['id']}", headers=auth["M1"]
    ).json()
    assert stale_case["stale"] is True

    # Re-simulate after forecast override: manager_override is preserved, direct uses 15%.
    created2 = client.post(
        f"{url}/planning/demands/{demand.id}/cases", headers=auth["M1"]
    )
    assert created2.status_code == 200, created2.text
    case2 = created2.json()
    direct2 = next(o for o in case2["options"] if o["kind"] == "direct")
    assert direct2["verdict"] == "feasible"
    assert any(
        f["code"] == "forecast_week" and "15%" in f["message"]
        for f in direct2["findings"]
    )

    # Confirm direct2 in one step: auto-confirms B_FREE's 2 forecast weeks + creates assignment + audit.
    reply = client.post(
        f"{url}/capacity/demands/{demand.id}/reply",
        headers=auth["M1"],
        json={
            "option_id": direct2["id"],
            "outcome": "can_do",
            "text": "按预测基线可承接",
            "revision": demand.revision,
        },
    )
    assert reply.status_code == 200, reply.text
    assert reply.json()["status"] == "accepted"
    assert reply.json()["proposal"]["status"] == "committed"

    confirmed_weeks = db.exec(
        select(CapacityWeek)
        .where(
            CapacityWeek.org_id == org.id,
            CapacityWeek.employee_id == people["B_FREE"].id,
            CapacityWeek.week_start >= future_start,
        )
        .order_by(CapacityWeek.week_start)
    ).all()
    assert len(confirmed_weeks) == 2
    assert confirmed_weeks[0].other_percent == 15
    assert confirmed_weeks[0].confirmed_by_user_id == users["M1"].id

    audits = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == org.id,
            AuditEvent.action == "capacity.workload_confirmed_from_forecast",
        )
    ).all()
    assert len(audits) == 2
    assignments = db.exec(
        select(CapacityAssignment).where(
            CapacityAssignment.org_id == org.id,
            CapacityAssignment.demand_id == demand.id,
        )
    ).all()
    assert len(assignments) == 1 and assignments[0].employee_id == people["B_FREE"].id


def test_forecast_respects_regular_cap_and_elastic_toggle(
    forecast_org: tuple[Any, ...], client: TestClient, db: Session
) -> None:
    url, org, dept_a, dept_b, people, users, auth, start = forecast_org
    _publish_initial_profile(
        client, url, auth["ADMIN"], people["B_FREE"], "backend_api"
    )
    future_start = start + timedelta(weeks=8)
    future_end = future_start + timedelta(days=6)
    # Set B_FREE forecast to 35% so 35% + 50% = 85% (> 70% regular cap, <= 100% elastic cap).
    capacity_forecast.refresh_org_forecasts(db, org.id)
    fc = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org.id,
            CapacityWeekForecast.employee_id == people["B_FREE"].id,
            CapacityWeekForecast.week_start == future_start,
        )
    ).one()
    fc.forecast_other_percent = 35
    fc.source = ForecastSource.MANAGER_OVERRIDE
    db.add(fc)
    db.commit()

    demand = _create_demand(
        db, org.id, dept_a.id, dept_b.id, users["A1"].id, future_start, future_end
    )
    reg_case = client.post(
        f"{url}/planning/demands/{demand.id}/cases", headers=auth["M1"]
    ).json()
    opt = client.post(
        f"{url}/planning/cases/{reg_case['id']}/options",
        headers=auth["M1"],
        json={
            "assignees": [
                {
                    "employee_id": str(people["B_FREE"].id),
                    "allocation_percent": 50,
                    "start_date": future_start.isoformat(),
                    "end_date": future_end.isoformat(),
                }
            ]
        },
    ).json()
    assert opt["verdict"] == "infeasible"
    assert any(f["code"] == "over_regular_cap" for f in opt["findings"])

    elastic_case = client.post(
        f"{url}/planning/demands/{demand.id}/cases",
        headers=auth["M1"],
        json={"allow_elastic": True},
    ).json()
    elastic_opt = client.post(
        f"{url}/planning/cases/{elastic_case['id']}/options",
        headers=auth["M1"],
        json={
            "assignees": [
                {
                    "employee_id": str(people["B_FREE"].id),
                    "allocation_percent": 50,
                    "start_date": future_start.isoformat(),
                    "end_date": future_end.isoformat(),
                }
            ]
        },
    ).json()
    assert elastic_opt["verdict"] == "feasible"
    assert elastic_opt["summary"]["uses_elastic"] is True
    assert elastic_opt["summary"]["elastic_used_percent"] == 15
    assert {f["code"] for f in elastic_opt["findings"]} == {
        "forecast_week",
        "elastic_used",
    }


def test_safety_guardrails_block_self_newcomer_and_overload_rollback(
    forecast_org: tuple[Any, ...], client: TestClient, db: Session
) -> None:
    url, org, dept_a, dept_b, people, users, auth, start = forecast_org
    for code in ("M1", "B_BUSY", "B_FREE", "B_NEW"):
        _publish_initial_profile(
            client, url, auth["ADMIN"], people[code], "backend_api"
        )

    future_start = start + timedelta(weeks=8)
    future_end = future_start + timedelta(days=6)
    demand = _create_demand(
        db, org.id, dept_a.id, dept_b.id, users["A1"].id, future_start, future_end
    )

    # M2 simulates (M1 is a subordinate/colleague to M2, so M2 sees M1 with forecast).
    # Then M1 tries to confirm an option assigning M1 himself -> MUST be blocked with 409!
    m2_case = client.post(
        f"{url}/planning/demands/{demand.id}/cases", headers=auth["M2"]
    ).json()
    m1_opt = client.post(
        f"{url}/planning/cases/{m2_case['id']}/options",
        headers=auth["M2"],
        json={
            "assignees": [
                {
                    "employee_id": str(people["M1"].id),
                    "allocation_percent": 50,
                    "start_date": future_start.isoformat(),
                    "end_date": future_end.isoformat(),
                }
            ]
        },
    ).json()
    assert m1_opt["verdict"] == "feasible"

    # When M1 creates his own option with himself, validator flags unconfirmed.
    m1_case = client.post(
        f"{url}/planning/demands/{demand.id}/cases", headers=auth["M1"]
    ).json()
    m1_self_opt = client.post(
        f"{url}/planning/cases/{m1_case['id']}/options",
        headers=auth["M1"],
        json={
            "assignees": [
                {
                    "employee_id": str(people["M1"].id),
                    "allocation_percent": 50,
                    "start_date": future_start.isoformat(),
                    "end_date": future_end.isoformat(),
                }
            ]
        },
    ).json()
    assert m1_self_opt["verdict"] == "insufficient_data"
    assert any(f["code"] == "unconfirmed" for f in m1_self_opt["findings"])

    # Trying to reply as M1 using M2's feasible option (which assigns M1) MUST fail 409!
    self_reply = client.post(
        f"{url}/capacity/demands/{demand.id}/reply",
        headers=auth["M1"],
        json={
            "option_id": m1_opt["id"],
            "outcome": "can_do",
            "text": "尝试确认本人周负荷",
            "revision": demand.revision,
        },
    )
    assert self_reply.status_code == 409
    assert not db.exec(
        select(CapacityWeek).where(
            CapacityWeek.org_id == org.id,
            CapacityWeek.employee_id == people["M1"].id,
            CapacityWeek.week_start == future_start,
        )
    ).all()

    # Zero-history newcomer (B_NEW) without forecast -> insufficient_data + unconfirmed.
    new_opt = client.post(
        f"{url}/planning/cases/{m1_case['id']}/options",
        headers=auth["M1"],
        json={
            "assignees": [
                {
                    "employee_id": str(people["B_NEW"].id),
                    "allocation_percent": 50,
                    "start_date": future_start.isoformat(),
                    "end_date": future_end.isoformat(),
                }
            ]
        },
    ).json()
    assert new_opt["verdict"] == "insufficient_data"
    assert any(f["code"] == "unconfirmed" for f in new_opt["findings"])

    # Overload transaction rollback: B_FREE is valid, B_BUSY has forecast=90% + 50% = 140% > 100%.
    # Even if an option was feasible when simulated (e.g. before B_BUSY's forecast jumped to 90%),
    # confirming when over capacity MUST return 409 and write ZERO CapacityWeek rows (not even B_FREE).
    fc_busy = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org.id,
            CapacityWeekForecast.employee_id == people["B_BUSY"].id,
            CapacityWeekForecast.week_start == future_start,
        )
    ).one()
    fc_busy.forecast_other_percent = 20
    fc_busy.source = ForecastSource.MANAGER_OVERRIDE
    db.add(fc_busy)
    db.commit()

    ok_case = client.post(
        f"{url}/planning/demands/{demand.id}/cases",
        headers=auth["M1"],
        json={"allow_elastic": True},
    ).json()
    two_opt = client.post(
        f"{url}/planning/cases/{ok_case['id']}/options",
        headers=auth["M1"],
        json={
            "assignees": [
                {
                    "employee_id": str(people["B_FREE"].id),
                    "allocation_percent": 50,
                    "start_date": future_start.isoformat(),
                    "end_date": future_end.isoformat(),
                },
                {
                    "employee_id": str(people["B_BUSY"].id),
                    "allocation_percent": 50,
                    "start_date": future_start.isoformat(),
                    "end_date": future_end.isoformat(),
                },
            ]
        },
    ).json()
    assert two_opt["verdict"] == "feasible"

    # Now push B_BUSY's forecast to 60% (60 + 50 = 110 > 100), keeping B_FREE valid,
    # Wait: if forecast changed, get_case is stale (409). Also test direct proposal.create overload rollback!
    from app.authz.deps import get_org_principal
    from app.domains.capacity import proposal as capacity_proposal
    from app.domains.capacity.demand_schemas import ProposalLineInput

    fc_busy.forecast_other_percent = 60
    db.add(fc_busy)
    db.commit()
    mgr_principal = get_org_principal(org.id, users["M1"], db)
    with pytest.raises(capacity_proposal.ProposalConflict):
        capacity_proposal.create(
            mgr_principal,
            db,
            demand,
            UUID(two_opt["id"]),
            [
                ProposalLineInput(
                    employee_id=people["B_FREE"].id,
                    allocation_percent=50,
                    start_date=future_start,
                    end_date=future_end,
                ),
                ProposalLineInput(
                    employee_id=people["B_BUSY"].id,
                    allocation_percent=50,
                    start_date=future_start,
                    end_date=future_end,
                ),
            ],
            direct_commit=True,
        )
    db.rollback()
    assert not db.exec(
        select(CapacityWeek).where(
            CapacityWeek.org_id == org.id,
            CapacityWeek.week_start == future_start,
        )
    ).all()

    # Manual assignment endpoint MUST STILL reject unconfirmed weeks even when forecast exists.
    demand.status = DemandStatus.ACCEPTED
    demand.committed_start_date = future_start
    demand.committed_end_date = future_end
    db.add(demand)
    db.commit()
    manual_assign = client.post(
        f"{url}/capacity/demands/{demand.id}/assignments",
        headers=auth["M1"],
        json={
            "employee_id": str(people["B_FREE"].id),
            "allocation_percent": 30,
            "start_date": future_start.isoformat(),
            "due_date": future_end.isoformat(),
            "outside_basis": True,
        },
    )
    assert manual_assign.status_code == 409
    assert "确认" in manual_assign.text
