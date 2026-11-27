from datetime import timedelta

from fastapi.testclient import TestClient
from sqlmodel import Session, col, select

from app.domains.audit.models import AuditEvent
from app.domains.base import utc_now
from app.domains.capacity import calendar
from app.domains.capacity.forecast import FORECAST_HORIZON_WEEKS, refresh_org_forecasts
from app.domains.capacity.models import (
    CapacityAssignment,
    CapacityDemand,
    CapacitySetting,
    CapacityWeek,
    CapacityWeekForecast,
    ForecastSource,
)
from app.domains.org.models import EmploymentStatus, ExternalIdentity
from app.domains.source.models import SourceConnection
from app.domains.work.models import Task
from tests.api.routes.test_m6_capacity_workload import (
    capacity as capacity,
)
from tests.api.routes.test_m6_capacity_workload import (
    enable,
    user_id,
    week_body,
)


def test_default_allocation_cap_validation_audit_and_auto_refresh(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = capacity
    e02 = employees["E02"]
    mgr_user_id = user_id(db, employees["E01"])
    w0 = calendar.this_week(db, e02.org_id)

    for bad_cap in (49, 101, True, 70.5, "70"):
        resp = client.put(
            f"{url}/capacity-settings",
            headers=auth["admin"],
            json={
                "enabled": True,
                "requester_policy": "everyone",
                "default_allocation_cap_percent": bad_cap,
            },
        )
        assert resp.status_code == 422

    enable(client, capacity)
    # Seed high historical workload (90%) on E02 so far-term regression reflects cap changes.
    db.add(
        CapacityWeek(
            org_id=e02.org_id,
            employee_id=e02.id,
            week_start=w0,
            other_percent=90,
            confirmed_by_user_id=mgr_user_id,
        )
    )
    db.commit()
    assert refresh_org_forecasts(db, e02.org_id) > 0
    db.commit()

    far_week = w0 + timedelta(weeks=6)
    before_row = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == e02.org_id,
            CapacityWeekForecast.employee_id == e02.id,
            CapacityWeekForecast.week_start == far_week,
        )
    ).one()
    # Implicit default decays from 90% with retention_rate=0.65: offset=6 (steps=6) -> round_5(90 * 0.65^6) = 5%.
    assert before_row.forecast_other_percent == 5

    # Changing default_allocation_cap_percent from 70 to 60 or 80 does NOT alter forecast_other_percent.
    updated = client.put(
        f"{url}/capacity-settings",
        headers=auth["admin"],
        json={
            "enabled": True,
            "requester_policy": "everyone",
            "default_allocation_cap_percent": 60,
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["default_allocation_cap_percent"] == 60

    refresh_org_forecasts(db, e02.org_id)
    db.commit()
    db.expire_all()
    after_row = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == e02.org_id,
            CapacityWeekForecast.employee_id == e02.id,
            CapacityWeekForecast.week_start == far_week,
        )
    ).one()
    assert after_row.forecast_other_percent == 5
    assert (
        db.exec(select(CapacitySetting).where(CapacitySetting.org_id == e02.org_id))
        .one()
        .default_allocation_cap_percent
        == 60
    )
    audits = db.exec(
        select(AuditEvent)
        .where(
            AuditEvent.org_id == e02.org_id,
            AuditEvent.action == "capacity.settings_updated",
        )
        .order_by(col(AuditEvent.created_at), col(AuditEvent.id))
    ).all()
    assert audits[-1].details["default_allocation_cap_percent"] == 60


def test_forecast_engine_signals_priority_and_no_fabrication(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = capacity
    e01 = employees["E01"]
    e02 = employees["E02"]
    e03 = employees["E03"]
    e04 = employees["E04"]  # Different department with no history
    org_id = e02.org_id
    mgr_user_id = user_id(db, e01)
    w0 = calendar.this_week(db, org_id)

    # Disabled org creates 0 forecast rows.
    assert refresh_org_forecasts(db, org_id) == 0
    enable(client, capacity)

    # No confirmed history anywhere -> 0 rows (no fabricated forecasts).
    assert refresh_org_forecasts(db, org_id) == 0
    assert not db.exec(
        select(CapacityWeekForecast).where(CapacityWeekForecast.org_id == org_id)
    ).all()

    # Seed E02 with 88% in w0 -> rounds to 90% near-term, exceeds 70% cap; add 5 open Jira tasks.
    db.add(
        CapacityWeek(
            org_id=org_id,
            employee_id=e02.id,
            week_start=w0,
            other_percent=88,
            confirmed_by_user_id=mgr_user_id,
        )
    )
    db.add(
        SourceConnection(
            org_id=org_id,
            kind="jira",
            updated_by_user_id=mgr_user_id,
        )
    )
    db.add(
        ExternalIdentity(
            org_id=org_id,
            employee_id=e02.id,
            source="jira",
            external_id="jira-e02",
        )
    )
    for idx in range(5):
        db.add(
            Task(
                org_id=org_id,
                source="jira",
                external_key=f"SYN-{idx}",
                title=f"合成任务 {idx}",
                attributes={"people": [{"id": "jira-e02", "role": "assignee"}]},
            )
        )
    # Seed an expired forecast row (> 4w old) to verify cleanup.
    db.add(
        CapacityWeekForecast(
            org_id=org_id,
            employee_id=e02.id,
            week_start=w0 - timedelta(weeks=5),
            forecast_other_percent=50,
            source=ForecastSource.AGENT_AUTO,
            basis_summary="过期基线",
            signals={},
            generated_at=utc_now(),
        )
    )
    db.commit()

    updated = refresh_org_forecasts(db, org_id)
    db.commit()
    assert updated > 0

    # Expired row cleaned up.
    assert (
        db.exec(
            select(CapacityWeekForecast).where(
                CapacityWeekForecast.org_id == org_id,
                CapacityWeekForecast.week_start == w0 - timedelta(weeks=5),
            )
        ).first()
        is None
    )
    # E04 department has no history -> no forecast rows fabricated.
    assert not db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == e04.id,
        )
    ).all()
    # Only E02 has history in this department (< 2 colleagues) -> E03 gets no department fallback.
    assert not db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == e03.id,
        )
    ).all()
    # Adding E01's confirmed history (now 2 colleagues) enables department fallback for E03.
    db.add(
        CapacityWeek(
            org_id=org_id,
            employee_id=e01.id,
            week_start=w0,
            other_percent=80,
            confirmed_by_user_id=mgr_user_id,
        )
    )
    db.commit()
    refresh_org_forecasts(db, org_id)
    db.commit()
    # E03 (same dept as E01/E02, no personal history) falls back to department mean (84%) and decays at w5: round_5(84 * 0.65^5) = 10%.
    e03_w5 = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == e03.id,
            CapacityWeekForecast.week_start == w0 + timedelta(weeks=5),
        )
    ).one()
    assert e03_w5.forecast_other_percent == 10
    assert "同部门" in e03_w5.basis_summary

    # E02 has 26 weeks generated; Jira tasks do NOT interfere with retention_rate=0.65 decay:
    # w1 -> round_5(88*0.65) = 55%, w4 -> round_5(88*0.65^4) = 15%, w8 -> round_5(88*0.65^8) = 5%.
    e02_rows = {
        r.week_start: r
        for r in db.exec(
            select(CapacityWeekForecast).where(
                CapacityWeekForecast.org_id == org_id,
                CapacityWeekForecast.employee_id == e02.id,
            )
        ).all()
    }
    assert len(e02_rows) == FORECAST_HORIZON_WEEKS
    assert e02_rows[w0 + timedelta(weeks=1)].forecast_other_percent == 55
    assert e02_rows[w0 + timedelta(weeks=4)].forecast_other_percent == 15
    assert e02_rows[w0 + timedelta(weeks=8)].forecast_other_percent == 5
    assert "未闭环 Jira" not in e02_rows[w0 + timedelta(weeks=4)].basis_summary

    # Priority: confirmed > manager_override > agent_auto; shortfalls() remains strict.
    w1 = w0 + timedelta(weeks=1)
    w6 = w0 + timedelta(weeks=6)
    loaded = calendar.loads(db, org_id, [e02.id], w0, 8)[e02.id]
    assert loaded[0].status == "confirmed"
    assert loaded[0].forecast_other_percent is None
    assert loaded[0].forecast_source is None
    assert loaded[1].status == "unconfirmed"
    assert loaded[1].forecast_other_percent == 55
    assert loaded[1].forecast_source == "agent_auto"
    unconfirmed, _ = calendar.shortfalls(loaded, 10)
    assert w1 in unconfirmed and w6 in unconfirmed

    # Manager overrides w6 to 55%; subsequent refresh_org_forecasts must NOT overwrite manager_override.
    ov_resp = client.put(
        f"{url}/capacity/forecasts",
        headers=auth["manager"],
        json={
            "employee_id": str(e02.id),
            "start_week": w6.isoformat(),
            "end_week": w6.isoformat(),
            "forecast_other_percent": 55,
            "note": "下月集中支持客户交付",
        },
    )
    assert ov_resp.status_code == 200, ov_resp.text
    refresh_org_forecasts(db, org_id)
    db.commit()
    loaded_after = calendar.loads(db, org_id, [e02.id], w6, 1)[e02.id][0]
    assert loaded_after.forecast_other_percent == 55
    assert loaded_after.forecast_source == "manager_override"
    assert "下月集中支持客户交付" in (loaded_after.forecast_basis or "")

    # Confirming w6 formally via set_weeks replaces forecast display in calendar.loads().
    set_resp = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "items": [{"employee_id": str(e02.id), "other_percent": 40}],
            "start_week": w6.isoformat(),
            "end_week": w6.isoformat(),
        },
    )
    assert set_resp.status_code == 200, set_resp.text
    loaded_confirmed = calendar.loads(db, org_id, [e02.id], w6, 1)[e02.id][0]
    assert loaded_confirmed.status == "confirmed"
    assert loaded_confirmed.other_percent == 40
    assert loaded_confirmed.forecast_other_percent is None
    assert loaded_confirmed.forecast_source is None


def test_forecast_manager_apis_permissions_and_triggers(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = capacity
    enable(client, capacity)
    e01 = employees["E01"]
    e02 = employees["E02"]
    e04 = employees["E04"]
    org_id = e02.org_id
    w0 = calendar.this_week(db, org_id)
    w5 = w0 + timedelta(weeks=5)

    # Active assignment signal in [w0, w0+4w) + set_weeks triggers forecast refresh automatically.
    mgr_uid = user_id(db, e01)
    demand = CapacityDemand(
        org_id=org_id,
        requesting_department_id=e04.department_id,
        target_department_id=e02.department_id,
        requester_user_id=mgr_uid,
        capability_key="synthetic",
        capability_name="合成能力",
        headcount=1,
        allocation_percent=20,
        window_start=w0,
        window_end=w0 + timedelta(weeks=2),
        description="合成远期预测测试需求",
    )
    db.add(demand)
    db.flush()
    db.add(
        CapacityAssignment(
            org_id=org_id,
            demand_id=demand.id,
            employee_id=e02.id,
            allocation_percent=20,
            start_date=w0,
            due_date=w0 + timedelta(weeks=2),
            assigned_by_user_id=mgr_uid,
        )
    )
    db.commit()

    # set_weeks triggers forecast refresh for E02 (90% at w0; assignments do not interfere, w5 decays to round_5(90*0.65^5)=10%).
    res = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json=week_body(e02.id, 90),
    )
    assert res.status_code == 200, res.text
    w5_load = calendar.loads(db, org_id, [e02.id], w5, 1)[e02.id][0]
    assert w5_load.forecast_other_percent == 10
    assert "在途协作" not in (w5_load.forecast_basis or "")

    # Permission checks on PUT /capacity/forecasts and DELETE /capacity/forecasts
    ov_payload = {
        "employee_id": str(e02.id),
        "start_week": w5.isoformat(),
        "end_week": w5.isoformat(),
        "forecast_other_percent": 65,
    }
    for role, target_emp, expected in [
        ("admin", e02, 403),
        ("manager", e01, 403),  # cannot modify self
        ("manager", e04, 404),  # outside managed department
        ("employee", e02, 403),
        ("employee", e03 := employees["E03"], 404),
        ("foreign", e02, 404),
    ]:
        _ = e03
        assert (
            client.put(
                f"{url}/capacity/forecasts",
                headers=auth[role],
                json={**ov_payload, "employee_id": str(target_emp.id)},
            ).status_code
            == expected
        )
        assert (
            client.delete(
                f"{url}/capacity/forecasts",
                headers=auth[role],
                params={
                    "employee_id": str(target_emp.id),
                    "start_week": w5.isoformat(),
                    "end_week": w5.isoformat(),
                },
            ).status_code
            == expected
        )

    # Manager override then reset restores agent_auto and writes both audit events.
    ov = client.put(
        f"{url}/capacity/forecasts", headers=auth["manager"], json=ov_payload
    )
    assert ov.status_code == 200, ov.text
    assert ov.json()["data"][0]["weeks"][0]["forecast_other_percent"] == 65
    assert ov.json()["data"][0]["weeks"][0]["forecast_source"] == "manager_override"

    rst = client.delete(
        f"{url}/capacity/forecasts",
        headers=auth["manager"],
        params={
            "employee_id": str(e02.id),
            "start_week": w5.isoformat(),
            "end_week": w5.isoformat(),
        },
    )
    assert rst.status_code == 200, rst.text
    assert rst.json()["data"][0]["weeks"][0]["forecast_other_percent"] == 10
    assert rst.json()["data"][0]["weeks"][0]["forecast_source"] == "agent_auto"

    actions = set(
        db.exec(select(AuditEvent.action).where(AuditEvent.org_id == org_id)).all()
    )
    assert {"capacity.forecast_overridden", "capacity.forecast_reset"} <= actions

    # Refresh permissions: employee 403, manager scoped to managed dept, admin org-wide or dept.
    assert (
        client.post(
            f"{url}/capacity/forecasts/refresh", headers=auth["employee"]
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"{url}/capacity/forecasts/refresh",
            headers=auth["manager"],
            params={"department_id": str(e04.department_id)},
        ).status_code
        == 404
    )
    mgr_refresh = client.post(
        f"{url}/capacity/forecasts/refresh", headers=auth["manager"]
    )
    assert mgr_refresh.status_code == 200
    assert mgr_refresh.json()["updated_rows"] > 0
    admin_refresh = client.post(
        f"{url}/capacity/forecasts/refresh",
        headers=auth["admin"],
        json={"department_id": str(e02.department_id)},
    )
    assert admin_refresh.status_code == 200
    assert admin_refresh.json()["updated_rows"] > 0


def test_department_fallback_requires_at_least_two_colleagues(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = capacity
    enable(client, capacity)
    e01 = employees["E01"]
    e02 = employees["E02"]
    e03 = employees["E03"]
    org_id = e02.org_id
    mgr_user_id = user_id(db, e01)
    w0 = calendar.this_week(db, org_id)

    # Two-person department (E02, E03): only E03 has confirmed records (even across multiple weeks).
    e01.employment_status = EmploymentStatus.INACTIVE
    db.add(e01)
    for offset in (0, -1):
        db.add(
            CapacityWeek(
                org_id=org_id,
                employee_id=e03.id,
                week_start=w0 + timedelta(weeks=offset),
                other_percent=60,
                confirmed_by_user_id=mgr_user_id,
            )
        )
    db.commit()

    refresh_org_forecasts(db, org_id)
    db.commit()

    assert not db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == e02.id,
        )
    ).all()
    me_two = client.get(f"{url}/capacity/workloads/me", headers=auth["employee"])
    assert me_two.status_code == 200, me_two.text
    for week in me_two.json()["weeks"]:
        assert week["forecast_other_percent"] is None
        assert week["forecast_basis"] is None
        assert week["forecast_source"] is None

    # Three-person department (E01, E02, E03): two colleagues (E01, E03) have records -> department mean fallback applies.
    e01.employment_status = EmploymentStatus.ACTIVE
    db.add(e01)
    db.add(
        CapacityWeek(
            org_id=org_id,
            employee_id=e01.id,
            week_start=w0,
            other_percent=30,
            confirmed_by_user_id=mgr_user_id,
        )
    )
    db.commit()

    refresh_org_forecasts(db, org_id)
    db.commit()

    me_three = client.get(f"{url}/capacity/workloads/me", headers=auth["employee"])
    assert me_three.status_code == 200, me_three.text
    far_week = me_three.json()["weeks"][5]
    assert far_week["forecast_other_percent"] == 5
    assert far_week["forecast_source"] == "agent_auto"
    assert "周延续系数 0.65（系统默认）：基于同部门近期均值 50%逐周衰减" in (
        far_week["forecast_basis"] or ""
    )
