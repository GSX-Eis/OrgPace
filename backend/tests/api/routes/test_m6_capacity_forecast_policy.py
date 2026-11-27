from collections.abc import Generator
from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlmodel import Session, col, select

from app.core.security import create_access_token
from app.domains.audit.models import AuditEvent
from app.domains.capacity import calendar
from app.domains.capacity.forecast import FORECAST_HORIZON_WEEKS, refresh_org_forecasts
from app.domains.capacity.models import (
    CapacityAssignment,
    CapacityDemand,
    CapacityForecastEvent,
    CapacityForecastPolicy,
    CapacityWeek,
    CapacityWeekForecast,
)
from app.domains.org.models import (
    Department,
    Employee,
    ExternalIdentity,
    OrgMembership,
    Role,
    RoleGrant,
)
from app.domains.source.models import SourceConnection
from app.domains.work.models import Task
from app.models import User
from tests.api.routes.test_m6_capacity_demand import demand as demand
from tests.api.routes.test_m6_capacity_workload import (
    capacity as capacity,
)
from tests.api.routes.test_m6_capacity_workload import (
    enable,
    user_id,
)


@pytest.fixture
def forecast_policy_ctx(capacity: tuple, db: Session) -> Generator[tuple]:
    yield capacity
    db.rollback()
    org_id = capacity[1]["E01"].org_id
    db.execute(
        delete(CapacityForecastEvent).where(CapacityForecastEvent.org_id == org_id)
    )
    db.execute(
        delete(CapacityForecastPolicy).where(CapacityForecastPolicy.org_id == org_id)
    )
    db.commit()


def _seed_confirmed_week(
    db: Session,
    *,
    org_id: object,
    employee_id: object,
    week_start: object,
    percent: int,
    by_user_id: object,
) -> None:
    db.add(
        CapacityWeek(
            org_id=org_id,
            employee_id=employee_id,
            week_start=week_start,
            other_percent=percent,
            confirmed_by_user_id=by_user_id,
        )
    )


def _create_pure_admin(db: Session, org_id: object) -> dict[str, str]:
    user = User(
        username=f"pure-admin-{uuid4()}@example.com",
        hashed_password="unused-synthetic",
    )
    db.add(user)
    db.flush()
    membership = OrgMembership(org_id=org_id, user_id=user.id, employee_id=None)
    db.add(membership)
    db.flush()
    db.add(
        RoleGrant(
            org_id=org_id,
            membership_id=membership.id,
            role=Role.ORG_ADMIN,
            department_id=None,
        )
    )
    db.commit()
    token = create_access_token(user.id, expires_delta=timedelta(minutes=10))
    return {"Authorization": f"Bearer {token}"}


def test_policy_inheritance_presets_and_bidirectional_regression(
    forecast_policy_ctx: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = forecast_policy_ctx
    enable(client, forecast_policy_ctx)
    e01 = employees["E01"]
    e02 = employees["E02"]
    e04 = employees["E04"]
    org_id = e02.org_id
    admin_uid = user_id(db, e01)
    w0 = calendar.this_week(db, org_id)

    # Create a child department under E02's department and assign job families.
    parent_dept_id = e02.department_id
    assert parent_dept_id is not None
    child_dept = Department(
        org_id=org_id,
        name="冷链仓储组",
        parent_department_id=parent_dept_id,
    )
    db.add(child_dept)
    db.flush()

    e02.job_family = "理货"
    e04.job_family = "后端"
    child_worker = Employee(
        org_id=org_id,
        department_id=child_dept.id,
        display_name="合成子部门理货员",
        job_family="理货",
    )
    child_other_jf = Employee(
        org_id=org_id,
        department_id=child_dept.id,
        display_name="合成子部门质检员",
        job_family="质检",
    )
    db.add_all([e02, e04, child_worker, child_other_jf])
    db.flush()

    for emp, pct in (
        (e02, 90),
        (e04, 20),
        (child_worker, 90),
        (child_other_jf, 90),
    ):
        _seed_confirmed_week(
            db,
            org_id=org_id,
            employee_id=emp.id,
            week_start=w0,
            percent=pct,
            by_user_id=admin_uid,
        )
    # Give e02 5 open Jira tasks and an active assignment to test Jira/assignment gate.
    db.add(SourceConnection(org_id=org_id, kind="jira", updated_by_user_id=admin_uid))
    db.add(
        ExternalIdentity(
            org_id=org_id,
            employee_id=e02.id,
            source="jira",
            external_id="jira-e02-policy",
        )
    )
    for idx in range(5):
        db.add(
            Task(
                org_id=org_id,
                source="jira",
                external_key=f"POL-{idx}",
                title=f"合成测试单 {idx}",
                attributes={"people": [{"id": "jira-e02-policy", "role": "assignee"}]},
            )
        )
    demand_row = CapacityDemand(
        org_id=org_id,
        requesting_department_id=e04.department_id,
        target_department_id=parent_dept_id,
        requester_user_id=admin_uid,
        capability_key="synthetic",
        capability_name="合成能力",
        headcount=1,
        allocation_percent=20,
        window_start=w0,
        window_end=w0 + timedelta(weeks=2),
        description="信号测试需求",
    )
    db.add(demand_row)
    db.flush()
    db.add(
        CapacityAssignment(
            org_id=org_id,
            demand_id=demand_row.id,
            employee_id=e02.id,
            allocation_percent=20,
            start_date=w0,
            due_date=w0 + timedelta(weeks=2),
            assigned_by_user_id=admin_uid,
        )
    )
    db.commit()

    # 1. Org default: retention_rate=0.5 (regular balanced, halves each week)
    r_org = client.put(
        f"{url}/capacity/forecast-policies",
        headers=auth["admin"],
        json={
            "department_id": None,
            "job_family": None,
            "retention_rate": 0.5,
        },
    )
    assert r_org.status_code == 200, r_org.text
    assert r_org.json()["policy"]["label"] == "常规均衡型"

    # E04 (20% at w0) inherits org default and halves each week: w1=10%, w2=5%, w10=0%.
    e04_w1 = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == e04.id,
            CapacityWeekForecast.week_start == w0 + timedelta(weeks=1),
        )
    ).one()
    assert e04_w1.forecast_other_percent == 10
    assert e04_w1.signals["policy_scope"] == "org_default"
    e04_w10 = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == e04.id,
            CapacityWeekForecast.week_start == w0 + timedelta(weeks=10),
        )
    ).one()
    assert e04_w10.forecast_other_percent == 0

    # 2. Org-level job_family override ("后端" -> retention_rate=0.8) beats org default.
    r_org_jf = client.put(
        f"{url}/capacity/forecast-policies",
        headers=auth["admin"],
        json={
            "department_id": None,
            "job_family": "后端",
            "retention_rate": 0.8,
        },
    )
    assert r_org_jf.status_code == 200, r_org_jf.text
    assert r_org_jf.json()["policy"]["label"] == "项目延续型"
    db.expire_all()
    e04_w2 = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == e04.id,
            CapacityWeekForecast.week_start == w0 + timedelta(weeks=2),
        )
    ).one()
    # round_5(20 * 0.8^2 = 12.8) = 15%
    assert e04_w2.forecast_other_percent == 15
    assert e04_w2.signals["policy_scope"] == "org_job_family"

    # 3. Parent department policy (pulse: retention_rate=0.0)
    r_parent = client.put(
        f"{url}/capacity/forecast-policies",
        headers=auth["manager"],
        json={
            "department_id": str(parent_dept_id),
            "job_family": None,
            "retention_rate": 0.0,
        },
    )
    assert r_parent.status_code == 200, r_parent.text
    assert r_parent.json()["policy"]["label"] == "脉冲波次型"
    db.expire_all()

    # E02 has 90% history, 5 open Jira, 1 active assignment, and pulse drops immediately to 0% after w0.
    e02_loads = calendar.loads(db, org_id, [e02.id], w0, 4)[e02.id]
    assert e02_loads[1].forecast_other_percent == 0
    assert e02_loads[2].forecast_other_percent == 0
    assert "周延续系数 0（" in (e02_loads[1].forecast_basis or "")
    assert "末次确认周后归零" in (e02_loads[1].forecast_basis or "")
    assert "未闭环 Jira" not in (e02_loads[1].forecast_basis or "")
    assert "在途协作" not in (e02_loads[1].forecast_basis or "")
    assert e02_loads[1].forecast_policy_label is not None
    assert e02_loads[1].forecast_policy_label.startswith("周延续系数 0（")

    # Child department employees inherit parent department policy when child has none.
    cw_w2 = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == child_worker.id,
            CapacityWeekForecast.week_start == w0 + timedelta(weeks=2),
        )
    ).one()
    assert cw_w2.forecast_other_percent == 0
    assert cw_w2.signals["policy_id"] == r_parent.json()["policy"]["id"]

    # 4. Child department policy (retention_rate=1.0) overrides parent for child_other_jf.
    r_child = client.put(
        f"{url}/capacity/forecast-policies",
        headers=auth["manager"],
        json={
            "department_id": str(child_dept.id),
            "job_family": None,
            "retention_rate": 1.0,
        },
    )
    assert r_child.status_code == 200, r_child.text

    # 5. Child department + job_family ("理货") overrides child department policy (retention_rate=0.8)!
    r_child_jf = client.put(
        f"{url}/capacity/forecast-policies",
        headers=auth["manager"],
        json={
            "department_id": str(child_dept.id),
            "job_family": "理货",
            "retention_rate": 0.8,
        },
    )
    assert r_child_jf.status_code == 200, r_child_jf.text
    db.expire_all()
    cw_w4 = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == child_worker.id,
            CapacityWeekForecast.week_start == w0 + timedelta(weeks=4),
        )
    ).one()
    cw_w8 = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == child_worker.id,
            CapacityWeekForecast.week_start == w0 + timedelta(weeks=8),
        )
    ).one()
    co_w4 = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == child_other_jf.id,
            CapacityWeekForecast.week_start == w0 + timedelta(weeks=4),
        )
    ).one()
    # round_5(90 * 0.8^4 = 36.864) = 35%, round_5(90 * 0.8^8 = 15.1) = 15%
    assert cw_w4.forecast_other_percent == 35
    assert cw_w8.forecast_other_percent == 15
    assert cw_w4.signals["policy_scope"] == "department_job_family"
    assert co_w4.forecast_other_percent == 90  # child dept retention_rate=1.0
    assert co_w4.signals["policy_scope"] == "department"

    # Deleting child+jf policy reverts child_worker back to child dept policy.
    del_resp = client.delete(
        f"{url}/capacity/forecast-policies/{r_child_jf.json()['policy']['id']}",
        headers=auth["manager"],
    )
    assert del_resp.status_code == 200, del_resp.text
    assert del_resp.json()["updated_rows"] > 0
    db.expire_all()
    cw_w4_after = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == child_worker.id,
            CapacityWeekForecast.week_start == w0 + timedelta(weeks=4),
        )
    ).one()
    assert cw_w4_after.forecast_other_percent == 90
    assert cw_w4_after.signals["policy_scope"] == "department"

    # Legacy DB row compatibility: row with decay_rate=0.2 reads back as retention_rate=0.8.
    legacy_row = db.exec(
        select(CapacityForecastPolicy).where(
            CapacityForecastPolicy.id == r_child.json()["policy"]["id"]
        )
    ).one()
    legacy_row.decay_rate = 0.2
    legacy_row.baseline_percent = 70
    legacy_row.near_weeks = 6
    db.add(legacy_row)
    db.commit()

    # Check GET /forecast-policies returns default_retention_rate + job_families + policies (no presets).
    cfg = client.get(f"{url}/capacity/forecast-policies", headers=auth["admin"])
    assert cfg.status_code == 200, cfg.text
    cfg_json = cfg.json()
    assert cfg_json["default_allocation_cap_percent"] == 70
    assert cfg_json["default_retention_rate"] == 0.65
    assert "presets" not in cfg_json
    assert {"理货", "后端", "质检"} <= set(cfg_json["job_families"])
    child_pol = next(
        p
        for p in cfg_json["policies"]
        if p["id"] == str(r_child.json()["policy"]["id"])
    )
    assert child_pol["retention_rate"] == 0.8
    assert child_pol["label"] == "项目延续型"


def test_forecast_events_stacking_priority_and_recompute(
    forecast_policy_ctx: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = forecast_policy_ctx
    enable(client, forecast_policy_ctx)
    e01 = employees["E01"]
    e02 = employees["E02"]
    e04 = employees["E04"]
    org_id = e02.org_id
    admin_uid = user_id(db, e01)
    w0 = calendar.this_week(db, org_id)
    w1 = w0 + timedelta(weeks=1)
    w2 = w0 + timedelta(weeks=2)
    w4 = w0 + timedelta(weeks=4)

    parent_dept_id = e02.department_id
    assert parent_dept_id is not None
    child_dept = Department(
        org_id=org_id,
        name="生鲜仓储组",
        parent_department_id=parent_dept_id,
    )
    db.add(child_dept)
    db.flush()
    e02.job_family = "理货"
    child_clerk = Employee(
        org_id=org_id,
        department_id=child_dept.id,
        display_name="合成子部门理货",
        job_family="理货",
    )
    child_driver = Employee(
        org_id=org_id,
        department_id=child_dept.id,
        display_name="合成子部门配送",
        job_family="配送",
    )
    db.add_all([e02, child_clerk, child_driver])
    db.flush()
    for emp in (e02, child_clerk, child_driver):
        _seed_confirmed_week(
            db,
            org_id=org_id,
            employee_id=emp.id,
            week_start=w0,
            percent=80,
            by_user_id=admin_uid,
        )
    db.commit()

    # Manager overrides w2 on e02 to 65%; later event creation must NOT overwrite it.
    ov = client.put(
        f"{url}/capacity/forecasts",
        headers=auth["manager"],
        json={
            "employee_id": str(e02.id),
            "start_week": w2.isoformat(),
            "end_week": w2.isoformat(),
            "forecast_other_percent": 65,
            "note": "人工固定预估",
        },
    )
    assert ov.status_code == 200, ov.text

    # Add delta event (+10) first on parent_dept (all job_families), covering w1..w2
    ev1 = client.post(
        f"{url}/capacity/forecast-events",
        headers=auth["manager"],
        json={
            "department_id": str(parent_dept_id),
            "job_family": None,
            "title": "盘点备货",
            "start_week": w1.isoformat(),
            "end_week": w2.isoformat(),
            "modifier_kind": "delta",
            "modifier_value": 10,
            "reason": "月度盘点增加理货任务",
        },
    )
    assert ev1.status_code == 200, ev1.text

    # Add multiplier event (×0.5) second, scoped to job_family="理货", covering w1..w4.
    # Multipliers MUST apply before deltas: (80*0.65 * 0.5) + 10 = 36 -> 35% on w1!
    ev2 = client.post(
        f"{url}/capacity/forecast-events",
        headers=auth["manager"],
        json={
            "department_id": str(parent_dept_id),
            "job_family": "理货",
            "title": "下周无进货",
            "start_week": w1.isoformat(),
            "end_week": w4.isoformat(),
            "modifier_kind": "multiplier",
            "modifier_value": 0.5,
            "reason": "供应商停发",
        },
    )
    assert ev2.status_code == 200, ev2.text

    # Past event (should be hidden unless include_past=True)
    past_w = w0 - timedelta(weeks=2)
    ev_past = client.post(
        f"{url}/capacity/forecast-events",
        headers=auth["manager"],
        json={
            "department_id": str(parent_dept_id),
            "title": "历史事件",
            "start_week": past_w.isoformat(),
            "end_week": past_w.isoformat(),
            "modifier_kind": "delta",
            "modifier_value": -10,
            "reason": "历史测试",
        },
    )
    assert ev_past.status_code == 200, ev_past.text

    # Check calendar.loads() for e02 & child_clerk & child_driver
    all_loads = calendar.loads(
        db, org_id, [e02.id, child_clerk.id, child_driver.id], w0, 5
    )
    # w0 is confirmed (80%) -> priority confirmed > manager_override > agent_auto
    assert all_loads[e02.id][0].status == "confirmed"
    assert all_loads[e02.id][0].forecast_events == []
    # w1 on e02: round_5(80 * 0.65 * 0.5 + 10 = 36) = 35%
    assert all_loads[e02.id][1].forecast_other_percent == 35
    assert all_loads[e02.id][1].forecast_events == [
        "盘点备货（+10%）",
        "下周无进货（×0.5）",
    ]
    assert "；业务事件：" in (all_loads[e02.id][1].forecast_basis or "")
    # w2 on e02 keeps manager_override 65%
    assert all_loads[e02.id][2].forecast_other_percent == 65
    assert all_loads[e02.id][2].forecast_source == "manager_override"
    # child_clerk (inherited from parent_dept, job_family="理货") also gets 35% in w1
    assert all_loads[child_clerk.id][1].forecast_other_percent == 35
    # child_driver (job_family="配送") only hits ev1 (+10%): round_5(52 + 10 = 62) = 60% in w1
    assert all_loads[child_driver.id][1].forecast_other_percent == 60
    assert all_loads[child_driver.id][1].forecast_events == ["盘点备货（+10%）"]

    # Update ev2: move scope to child_dept only and multiplier 0.4 -> old scope (e02) + new scope (child_clerk) both recompute!
    ev2_id = ev2.json()["event"]["id"]
    upd = client.put(
        f"{url}/capacity/forecast-events/{ev2_id}",
        headers=auth["manager"],
        json={
            "department_id": str(child_dept.id),
            "job_family": "理货",
            "title": "生鲜停发",
            "start_week": w1.isoformat(),
            "end_week": w4.isoformat(),
            "modifier_kind": "multiplier",
            "modifier_value": 0.4,
            "reason": "仅影响生鲜组",
        },
    )
    assert upd.status_code == 200, upd.text
    db.expire_all()
    after_upd = calendar.loads(db, org_id, [e02.id, child_clerk.id], w1, 1)
    assert after_upd[e02.id][0].forecast_other_percent == 60  # only ev1 (+10)
    assert (
        after_upd[child_clerk.id][0].forecast_other_percent == 30
    )  # round_5(52*0.4 + 10 = 30.8) = 30

    # Delete ev1 & ev2 -> restores 50% at w1 (round_5(80 * 0.65))
    assert (
        client.delete(
            f"{url}/capacity/forecast-events/{ev1.json()['event']['id']}",
            headers=auth["manager"],
        ).status_code
        == 200
    )
    assert (
        client.delete(
            f"{url}/capacity/forecast-events/{ev2_id}",
            headers=auth["manager"],
        ).status_code
        == 200
    )
    db.expire_all()
    after_del = calendar.loads(db, org_id, [child_clerk.id], w1, 1)[child_clerk.id][0]
    assert after_del.forecast_other_percent == 50
    assert after_del.forecast_events == []

    # include_past filtering check
    active_list = client.get(
        f"{url}/capacity/forecast-events",
        headers=auth["manager"],
        params={"department_id": str(parent_dept_id)},
    )
    assert active_list.status_code == 200
    assert active_list.json()["count"] == 0
    all_list = client.get(
        f"{url}/capacity/forecast-events",
        headers=auth["manager"],
        params={"department_id": str(parent_dept_id), "include_past": "true"},
    )
    assert all_list.status_code == 200
    assert all_list.json()["count"] == 1
    assert all_list.json()["data"][0]["title"] == "历史事件"
    _ = e04


def test_permissions_audit_and_validation(
    forecast_policy_ctx: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = forecast_policy_ctx
    e01 = employees["E01"]
    e02 = employees["E02"]
    e04 = employees["E04"]
    org_id = e02.org_id
    w0 = calendar.this_week(db, org_id)

    # Disabled org -> 404
    assert (
        client.get(
            f"{url}/capacity/forecast-policies", headers=auth["admin"]
        ).status_code
        == 404
    )
    enable(client, forecast_policy_ctx)
    pure_admin_headers = _create_pure_admin(db, org_id)

    # Create org-level policy (admin), managed-dept policy (manager), unrelated-dept policy (admin)
    p_org = client.put(
        f"{url}/capacity/forecast-policies",
        headers=pure_admin_headers,
        json={"retention_rate": 0.5},
    )
    assert p_org.status_code == 200, p_org.text
    p_other = client.put(
        f"{url}/capacity/forecast-policies",
        headers=auth["admin"],
        json={"department_id": str(e04.department_id), "retention_rate": 0.8},
    )
    assert p_other.status_code == 200, p_other.text
    p_mgr = client.put(
        f"{url}/capacity/forecast-policies",
        headers=auth["manager"],
        json={"department_id": str(e02.department_id), "retention_rate": 0.0},
    )
    assert p_mgr.status_code == 200, p_mgr.text

    # Events: org-wide, unrelated dept, managed dept
    ev_org = client.post(
        f"{url}/capacity/forecast-events",
        headers=pure_admin_headers,
        json={
            "title": "全员年终盘点",
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "modifier_kind": "delta",
            "modifier_value": 15,
            "reason": "全公司盘点",
        },
    )
    assert ev_org.status_code == 200, ev_org.text
    ev_other = client.post(
        f"{url}/capacity/forecast-events",
        headers=auth["admin"],
        json={
            "department_id": str(e04.department_id),
            "title": "外部门大促",
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "modifier_kind": "multiplier",
            "modifier_value": 1.2,
            "reason": "外部门活动",
        },
    )
    assert ev_other.status_code == 200, ev_other.text

    # Employee -> 403 on all 7 endpoints; foreign -> 404
    for headers, code in ((auth["employee"], 403), (auth["foreign"], 404)):
        assert (
            client.get(f"{url}/capacity/forecast-policies", headers=headers).status_code
            == code
        )
        assert (
            client.put(
                f"{url}/capacity/forecast-policies",
                headers=headers,
                json={"retention_rate": 0.5},
            ).status_code
            == code
        )
        assert (
            client.delete(
                f"{url}/capacity/forecast-policies/{p_mgr.json()['policy']['id']}",
                headers=headers,
            ).status_code
            == code
        )
        assert (
            client.get(f"{url}/capacity/forecast-events", headers=headers).status_code
            == code
        )
        assert (
            client.post(
                f"{url}/capacity/forecast-events",
                headers=headers,
                json={
                    "title": "无权事件",
                    "start_week": w0.isoformat(),
                    "end_week": w0.isoformat(),
                    "modifier_kind": "delta",
                    "modifier_value": 10,
                    "reason": "测试",
                },
            ).status_code
            == code
        )
        assert (
            client.put(
                f"{url}/capacity/forecast-events/{ev_org.json()['event']['id']}",
                headers=headers,
                json={
                    "title": "无权事件",
                    "start_week": w0.isoformat(),
                    "end_week": w0.isoformat(),
                    "modifier_kind": "delta",
                    "modifier_value": 10,
                    "reason": "测试",
                },
            ).status_code
            == code
        )
        assert (
            client.delete(
                f"{url}/capacity/forecast-events/{ev_org.json()['event']['id']}",
                headers=headers,
            ).status_code
            == code
        )

    # Manager visibility & editability
    mgr_policies = client.get(
        f"{url}/capacity/forecast-policies", headers=auth["manager"]
    ).json()["policies"]
    by_id = {p["id"]: p for p in mgr_policies}
    assert p_org.json()["policy"]["id"] in by_id
    assert by_id[p_org.json()["policy"]["id"]]["can_edit"] is False
    assert p_mgr.json()["policy"]["id"] in by_id
    assert by_id[p_mgr.json()["policy"]["id"]]["can_edit"] is True
    assert p_other.json()["policy"]["id"] not in by_id

    mgr_events = client.get(
        f"{url}/capacity/forecast-events", headers=auth["manager"]
    ).json()["data"]
    ev_by_id = {ev["id"]: ev for ev in mgr_events}
    assert ev_org.json()["event"]["id"] in ev_by_id
    assert ev_by_id[ev_org.json()["event"]["id"]]["can_edit"] is False
    assert ev_other.json()["event"]["id"] not in ev_by_id

    # Cross-dept / org-default writes forbidden for manager
    assert (
        client.put(
            f"{url}/capacity/forecast-policies",
            headers=auth["manager"],
            json={"department_id": None, "retention_rate": 0.5},
        ).status_code
        == 403
    )
    assert (
        client.put(
            f"{url}/capacity/forecast-policies",
            headers=auth["manager"],
            json={"department_id": str(e04.department_id), "retention_rate": 0.5},
        ).status_code
        == 403
    )
    assert (
        client.delete(
            f"{url}/capacity/forecast-policies/{p_other.json()['policy']['id']}",
            headers=auth["manager"],
        ).status_code
        == 403
    )
    assert (
        client.delete(
            f"{url}/capacity/forecast-events/{ev_other.json()['event']['id']}",
            headers=auth["manager"],
        ).status_code
        == 403
    )
    assert (
        client.get(
            f"{url}/capacity/forecast-events",
            headers=auth["manager"],
            params={"department_id": str(e04.department_id)},
        ).status_code
        == 403
    )

    # Pure admin can delete org-level policy and event
    assert (
        client.delete(
            f"{url}/capacity/forecast-policies/{p_org.json()['policy']['id']}",
            headers=pure_admin_headers,
        ).status_code
        == 200
    )
    assert (
        client.delete(
            f"{url}/capacity/forecast-events/{ev_org.json()['event']['id']}",
            headers=pure_admin_headers,
        ).status_code
        == 200
    )

    # Validation edge cases (422)
    for bad_policy in (
        {"retention_rate": -0.1},
        {"retention_rate": 1.1},
        {"retention_rate": True},
        {},
        {"retention_rate": 0.5, "baseline_percent": 70},
    ):
        assert (
            client.put(
                f"{url}/capacity/forecast-policies",
                headers=auth["admin"],
                json=bad_policy,
            ).status_code
            == 422
        )
    for bad_event in (
        {
            "title": "   ",
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "modifier_kind": "delta",
            "modifier_value": 10,
            "reason": "原因",
        },
        {
            "title": "非周一",
            "start_week": (w0 + timedelta(days=1)).isoformat(),
            "end_week": (w0 + timedelta(days=1)).isoformat(),
            "modifier_kind": "delta",
            "modifier_value": 10,
            "reason": "原因",
        },
        {
            "title": "超26周",
            "start_week": w0.isoformat(),
            "end_week": (w0 + timedelta(weeks=26)).isoformat(),
            "modifier_kind": "delta",
            "modifier_value": 10,
            "reason": "原因",
        },
        {
            "title": "系数超界",
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "modifier_kind": "multiplier",
            "modifier_value": 2.5,
            "reason": "原因",
        },
        {
            "title": "偏置超界",
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "modifier_kind": "delta",
            "modifier_value": -120,
            "reason": "原因",
        },
    ):
        assert (
            client.post(
                f"{url}/capacity/forecast-events",
                headers=auth["admin"],
                json=bad_event,
            ).status_code
            == 422
        )

    # Audit log completeness for all 4 new actions
    actions = set(
        db.exec(select(AuditEvent.action).where(AuditEvent.org_id == org_id)).all()
    )
    assert {
        "capacity.forecast_policy_saved",
        "capacity.forecast_policy_deleted",
        "capacity.forecast_event_saved",
        "capacity.forecast_event_deleted",
    } <= actions
    _ = e01


def test_cross_dept_feasibility_consumes_policy_event_and_respects_withheld(
    demand: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth, body, _ = demand
    org_id = people["E04"].org_id
    w0 = calendar.this_week(db, org_id)
    far_week = w0 + timedelta(weeks=1)

    # Update E04 and E06 (both in target_department_id) to 90% confirmed load at w0.
    for row in db.exec(
        select(CapacityWeek).where(
            CapacityWeek.org_id == org_id,
            col(CapacityWeek.employee_id).in_([people["E04"].id, people["E06"].id]),
            CapacityWeek.week_start == w0,
        )
    ).all():
        row.other_percent = 90
        db.add(row)
    db.commit()
    refresh_org_forecasts(db, org_id)
    db.commit()

    args = {
        "capability_key": body["capability_key"],
        "minimum_level": body["minimum_level"],
        "window_start": far_week.isoformat(),
        "window_end": far_week.isoformat(),
        "estimated_headcount": 1,
        "estimated_allocation_percent": 20,
    }
    before = client.post(
        f"{url}/planning/feasibility", headers=auth["manager"], json=args
    )
    assert before.status_code == 200, before.text
    before_target = next(
        d
        for d in before.json()["departments"]
        if d["department_id"] == body["target_department_id"]
    )
    # Implicit default at w1: round_5(90 * 0.65) = 60%, 20% demand needs elastic (60 + 20 > 70).
    assert before_target["department_load_percent"] == 60
    assert before_target["needs_elastic"] is True
    assert before_target["data_source"] == "forecast_baseline"

    # Set retention_rate=0.5 + multiplier event (×0.5) on target dept -> triggers immediate recompute!
    pol_resp = client.put(
        f"{url}/capacity/forecast-policies",
        headers=auth["admin"],
        json={
            "department_id": body["target_department_id"],
            "retention_rate": 0.5,
        },
    )
    assert pol_resp.status_code == 200, pol_resp.text
    ev_resp = client.post(
        f"{url}/capacity/forecast-events",
        headers=auth["admin"],
        json={
            "department_id": body["target_department_id"],
            "title": "下周无进货",
            "start_week": far_week.isoformat(),
            "end_week": far_week.isoformat(),
            "modifier_kind": "multiplier",
            "modifier_value": 0.5,
            "reason": "仓储无进货波次",
        },
    )
    assert ev_resp.status_code == 200, ev_resp.text

    after = client.post(
        f"{url}/planning/feasibility", headers=auth["manager"], json=args
    )
    assert after.status_code == 200, after.text
    after_target = next(
        d
        for d in after.json()["departments"]
        if d["department_id"] == body["target_department_id"]
    )
    # 90 * 0.5 * 0.5 = 22.5 -> _round_5 = 25%
    assert after_target["department_load_percent"] == 25
    assert after_target["regular_headroom_percent"] == 45
    assert after_target["load_level"] == "low"
    assert after_target["needs_elastic"] is False
    assert after_target["data_source"] == "forecast_baseline"
    assert not any(
        p.display_name in after.text or str(p.id) in after.text for p in people.values()
    )

    # Withheld redline: remove E06 confirmed history -> only 1 independent source (E04) remains.
    db.exec(
        delete(CapacityWeek).where(
            CapacityWeek.org_id == org_id,
            CapacityWeek.employee_id == people["E06"].id,
        )
    )
    db.commit()
    refresh_org_forecasts(db, org_id)
    db.commit()
    withheld_resp = client.post(
        f"{url}/planning/feasibility", headers=auth["manager"], json=args
    )
    assert withheld_resp.status_code == 200, withheld_resp.text
    withheld_target = next(
        d
        for d in withheld_resp.json()["departments"]
        if d["department_id"] == body["target_department_id"]
    )
    assert withheld_target["load_level"] == "withheld"
    assert withheld_target["department_load_percent"] is None
    assert withheld_target["regular_headroom_percent"] is None
    assert withheld_target["elastic_headroom_percent"] is None
    assert withheld_target["needs_elastic"] is False

    # Cleanup policy & event created in demand fixture org
    db.execute(
        delete(CapacityForecastEvent).where(CapacityForecastEvent.org_id == org_id)
    )
    db.execute(
        delete(CapacityForecastPolicy).where(CapacityForecastPolicy.org_id == org_id)
    )
    db.commit()


def test_implicit_default_ignores_far_future_assignment_due_week(
    forecast_policy_ctx: tuple, db: Session, client: TestClient
) -> None:
    _, employees, _ = forecast_policy_ctx
    enable(client, forecast_policy_ctx)
    e01 = employees["E01"]
    e02 = employees["E02"]
    e04 = employees["E04"]
    org_id = e02.org_id
    admin_uid = user_id(db, e01)
    w0 = calendar.this_week(db, org_id)

    for offset in range(4):
        _seed_confirmed_week(
            db,
            org_id=org_id,
            employee_id=e02.id,
            week_start=w0 - timedelta(weeks=offset),
            percent=90,
            by_user_id=admin_uid,
        )

    start_week = w0 + timedelta(weeks=6)
    due_week = w0 + timedelta(weeks=8)
    demand_row = CapacityDemand(
        org_id=org_id,
        requesting_department_id=e04.department_id,
        target_department_id=e02.department_id,
        requester_user_id=admin_uid,
        capability_key="synthetic-v1-compat",
        capability_name="合成兼容测试能力",
        headcount=1,
        allocation_percent=20,
        window_start=start_week,
        window_end=due_week,
        description="远期在途协作兼容测试",
    )
    db.add(demand_row)
    db.flush()
    db.add(
        CapacityAssignment(
            org_id=org_id,
            demand_id=demand_row.id,
            employee_id=e02.id,
            allocation_percent=20,
            start_date=start_week,
            due_date=due_week,
            assigned_by_user_id=admin_uid,
        )
    )
    db.commit()

    refresh_org_forecasts(db, org_id)
    db.commit()

    rows_by_week = {
        row.week_start: row
        for row in db.exec(
            select(CapacityWeekForecast).where(
                CapacityWeekForecast.org_id == org_id,
                CapacityWeekForecast.employee_id == e02.id,
            )
        ).all()
    }
    assert len(rows_by_week) == FORECAST_HORIZON_WEEKS
    assert rows_by_week[w0].forecast_other_percent == 90
    # Implicit default decays strictly by 90 * 0.65^steps without assignment slowdown.
    expected_with_due = {
        1: 60,
        2: 40,
        3: 25,
        4: 15,
        5: 10,
        6: 5,
        7: 5,
        8: 5,
        9: 0,
        10: 0,
        11: 0,
        12: 0,
    }
    for offset, expected_pct in expected_with_due.items():
        row = rows_by_week[w0 + timedelta(weeks=offset)]
        assert row.forecast_other_percent == expected_pct
        assert row.signals["policy_scope"] == "implicit_default"
        assert "active_assignments" not in row.signals
        assert "在途协作" not in row.basis_summary


def test_implicit_default_decoupled_from_cap_and_decays_month_1_vs_month_2(
    forecast_policy_ctx: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = forecast_policy_ctx
    enable(client, forecast_policy_ctx)
    e01 = employees["E01"]
    e02 = employees["E02"]
    org_id = e02.org_id
    admin_uid = user_id(db, e01)
    w0 = calendar.this_week(db, org_id)

    for offset in range(4):
        _seed_confirmed_week(
            db,
            org_id=org_id,
            employee_id=e02.id,
            week_start=w0 - timedelta(weeks=offset),
            percent=75,
            by_user_id=admin_uid,
        )
    db.commit()
    refresh_org_forecasts(db, org_id)
    db.commit()

    def series() -> list[int]:
        rows = {
            r.week_start: r.forecast_other_percent
            for r in db.exec(
                select(CapacityWeekForecast).where(
                    CapacityWeekForecast.org_id == org_id,
                    CapacityWeekForecast.employee_id == e02.id,
                )
            ).all()
        }
        return [rows[w0 + timedelta(weeks=offset)] for offset in range(12)]

    before_series = series()
    assert before_series == [75, 50, 30, 20, 15, 10, 5, 5, 0, 0, 0, 0]
    assert max(before_series[8:12]) < min(before_series[4:8])

    # Changing default_allocation_cap_percent from 70 to 80 must NOT alter forecast values.
    resp = client.put(
        f"{url}/capacity-settings",
        headers=auth["admin"],
        json={
            "enabled": True,
            "requester_policy": "everyone",
            "default_allocation_cap_percent": 80,
        },
    )
    assert resp.status_code == 200, resp.text
    refresh_org_forecasts(db, org_id)
    db.commit()
    db.expire_all()
    assert series() == before_series


def test_delete_empty_department_cascades_forecast_policy_and_past_event(
    forecast_policy_ctx: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = forecast_policy_ctx
    enable(client, forecast_policy_ctx)
    org_id = employees["E01"].org_id
    w0 = calendar.this_week(db, org_id)
    past_week = w0 - timedelta(weeks=2)

    empty_dept = Department(org_id=org_id, name="历史事件空部门")
    db.add(empty_dept)
    db.commit()
    db.refresh(empty_dept)
    empty_dept_id = empty_dept.id

    pol_resp = client.put(
        f"{url}/capacity/forecast-policies",
        headers=auth["admin"],
        json={
            "department_id": str(empty_dept_id),
            "retention_rate": 0.0,
        },
    )
    assert pol_resp.status_code == 200, pol_resp.text
    policy_id = pol_resp.json()["policy"]["id"]

    ev_resp = client.post(
        f"{url}/capacity/forecast-events",
        headers=auth["admin"],
        json={
            "department_id": str(empty_dept_id),
            "title": "已过期波动事件",
            "start_week": past_week.isoformat(),
            "end_week": past_week.isoformat(),
            "modifier_kind": "delta",
            "modifier_value": -15,
            "reason": "历史清理回归测试",
        },
    )
    assert ev_resp.status_code == 200, ev_resp.text
    event_id = ev_resp.json()["event"]["id"]

    # Past event is hidden from default listing, visible only with include_past=true.
    hidden_list = client.get(
        f"{url}/capacity/forecast-events",
        headers=auth["admin"],
        params={"department_id": str(empty_dept_id)},
    )
    assert hidden_list.status_code == 200
    assert hidden_list.json()["count"] == 0

    del_dept = client.delete(
        f"{url}/departments/{empty_dept_id}",
        headers=auth["admin"],
    )
    assert del_dept.status_code == 200, del_dept.text

    db.expire_all()
    assert db.get(Department, empty_dept_id) is None
    assert (
        db.exec(
            select(CapacityForecastPolicy).where(
                CapacityForecastPolicy.org_id == org_id,
                CapacityForecastPolicy.department_id == empty_dept_id,
            )
        ).all()
        == []
    )
    assert (
        db.exec(
            select(CapacityForecastEvent).where(
                CapacityForecastEvent.org_id == org_id,
                CapacityForecastEvent.department_id == empty_dept_id,
            )
        ).all()
        == []
    )
    audit_pairs = {
        (ev.action, ev.target_id)
        for ev in db.exec(select(AuditEvent).where(AuditEvent.org_id == org_id)).all()
    }
    assert {
        ("department.deleted", str(empty_dept_id)),
        ("capacity.forecast_policy_saved", str(policy_id)),
        ("capacity.forecast_event_saved", str(event_id)),
    } <= audit_pairs
