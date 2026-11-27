from collections.abc import Generator
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlmodel import Session, select

from app.domains.audit.models import AuditEvent
from app.domains.base import utc_now
from app.domains.capacity.calendar import FRESH_DAYS, this_week
from app.domains.capacity.models import (
    CapacityAssignment,
    CapacityCarryOver,
    CapacityCarryOverItem,
    CapacityDemand,
    CapacityUnavailability,
    CapacityWeek,
)
from app.domains.inbox.models import InboxItem, InboxKind
from tests.api.routes.test_m6_capacity_workload import (
    capacity as base_capacity,
)
from tests.api.routes.test_m6_capacity_workload import (
    enable,
    user_id,
)

base_capacity_fixture = base_capacity


@pytest.fixture
def capacity(base_capacity_fixture: tuple, db: Session) -> Generator[tuple]:
    yield base_capacity_fixture
    db.rollback()
    org_id = base_capacity_fixture[1]["E01"].org_id
    for model in (
        CapacityCarryOverItem,
        CapacityCarryOver,
        CapacityUnavailability,
    ):
        db.execute(delete(model).where(model.org_id == org_id))
    db.commit()


def test_carry_over_step_by_step_baseline_and_undo(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    from app.domains.capacity.models import CapacityCarryOver

    url, people, auth = capacity
    enable(client, capacity)
    e2 = people["E02"]
    e3 = people["E03"]
    w0 = this_week(db, e2.org_id)
    w1 = w0 + timedelta(weeks=1)
    w2 = w0 + timedelta(weeks=2)
    w3 = w0 + timedelta(weeks=3)
    w4 = w0 + timedelta(weeks=4)
    w5 = w0 + timedelta(weeks=5)

    # Seed E02: W0=40% confirmed, W1=unconfirmed, W2=75% confirmed (last confirmed!),
    # W3=stale (should not block or act as baseline), W4=90% already confirmed (must NOT be overwritten).
    # Seed E03: W0=50% confirmed, W1=unconfirmed.
    manager_user = user_id(db, people["E01"])
    db.add_all(
        [
            CapacityWeek(
                org_id=e2.org_id,
                employee_id=e2.id,
                week_start=w0,
                other_percent=40,
                confirmed_by_user_id=manager_user,
            ),
            CapacityWeek(
                org_id=e2.org_id,
                employee_id=e2.id,
                week_start=w2,
                other_percent=75,
                confirmed_by_user_id=manager_user,
            ),
            CapacityWeek(
                org_id=e2.org_id,
                employee_id=e2.id,
                week_start=w3,
                other_percent=15,
                confirmed_by_user_id=manager_user,
                confirmed_at=utc_now() - timedelta(days=FRESH_DAYS + 2),
            ),
            CapacityWeek(
                org_id=e2.org_id,
                employee_id=e2.id,
                week_start=w4,
                other_percent=90,
                confirmed_by_user_id=manager_user,
            ),
            CapacityWeek(
                org_id=e3.org_id,
                employee_id=e3.id,
                week_start=w0,
                other_percent=50,
                confirmed_by_user_id=manager_user,
            ),
        ]
    )
    db.commit()

    # Wait: for E02, W4 is the latest confirmed week (90%), so W5 is next!
    # Let's first test when W2 (75%) is the latest confirmed and W4 is NOT yet confirmed,
    # and also confirm W5 later to verify confirmed week skipping; or better:
    # Check preview right now: E02 baseline is W4 (90%) -> target W5 (90%); E03 baseline is W0 (50%) -> target W1 (50%).
    preview = client.get(
        f"{url}/capacity/weeks/carry-over/preview", headers=auth["manager"]
    )
    assert preview.status_code == 200, preview.text
    items_by_emp = {item["employee_id"]: item for item in preview.json()["items"]}
    assert items_by_emp[str(e2.id)]["baseline_week_start"] == w4.isoformat()
    assert items_by_emp[str(e2.id)]["target_week_start"] == w5.isoformat()
    assert items_by_emp[str(e2.id)]["other_percent"] == 90
    assert items_by_emp[str(e3.id)]["baseline_week_start"] == w0.isoformat()
    assert items_by_emp[str(e3.id)]["target_week_start"] == w1.isoformat()
    assert items_by_emp[str(e3.id)]["other_percent"] == 50

    # Also test skipping a confirmed week when W2 was stale or W1 already confirmed:
    # Delete E02's W4 so W2 (75%) is baseline and W3 (stale) is target!
    db.execute(
        delete(CapacityWeek).where(
            CapacityWeek.org_id == e2.org_id,
            CapacityWeek.employee_id == e2.id,
            CapacityWeek.week_start == w4,
        )
    )
    db.commit()
    preview1 = client.get(
        f"{url}/capacity/weeks/carry-over/preview", headers=auth["manager"]
    ).json()
    p1_e2 = next(i for i in preview1["items"] if i["employee_id"] == str(e2.id))
    assert (
        p1_e2["baseline_week_start"],
        p1_e2["target_week_start"],
        p1_e2["other_percent"],
    ) == (
        w2.isoformat(),
        w3.isoformat(),
        75,
    )

    # Pre-confirm E03's W2 = 88% so Click 2 for E03 must skip W2 and fill W3, not overwrite W2!
    db.add(
        CapacityWeek(
            org_id=e3.org_id,
            employee_id=e3.id,
            week_start=w2,
            other_percent=88,
            confirmed_by_user_id=manager_user,
        )
    )
    db.commit()
    # Wait: for E03, W2 is already confirmed (88%), so E03's latest confirmed week is W2 -> target is W3!
    # Check that W2 (88%) is never overwritten across 3 consecutive clicks.

    # Click 1..3: fill 3 weeks step by step
    for _step in range(3):
        plan = client.get(
            f"{url}/capacity/weeks/carry-over/preview", headers=auth["manager"]
        ).json()
        commit_resp = client.post(
            f"{url}/capacity/weeks/carry-over",
            headers=auth["manager"],
            json={
                "items": [
                    {
                        "employee_id": i["employee_id"],
                        "week_start": i["target_week_start"],
                        "baseline_week_start": i["baseline_week_start"],
                        "other_percent": i["other_percent"],
                    }
                    for i in plan["items"]
                ]
            },
        )
        assert commit_resp.status_code == 200, commit_resp.text

    # E02 should now have W3=75, W4=75, W5=75 (and W1 still None)
    e2_weeks = {
        r.week_start: r.other_percent
        for r in db.exec(
            select(CapacityWeek).where(
                CapacityWeek.org_id == e2.org_id, CapacityWeek.employee_id == e2.id
            )
        ).all()
    }
    assert e2_weeks[w3] == 75
    assert e2_weeks[w4] == 75
    assert e2_weeks[w5] == 75
    assert w1 not in e2_weeks

    # E03 W2 must remain 88% (not overwritten!), and W3, W4, W5 filled with 88%
    e3_weeks = {
        r.week_start: r.other_percent
        for r in db.exec(
            select(CapacityWeek).where(
                CapacityWeek.org_id == e3.org_id, CapacityWeek.employee_id == e3.id
            )
        ).all()
    }
    assert e3_weeks[w0] == 50
    assert e3_weeks[w2] == 88
    assert e3_weeks[w3] == 88
    assert e3_weeks[w4] == 88
    assert e3_weeks[w5] == 88

    # Revert 2 times
    for _ in range(2):
        rev = client.post(
            f"{url}/capacity/weeks/carry-over/revert",
            headers=auth["manager"],
        )
        assert rev.status_code == 200, rev.text

    db.expire_all()
    e2_after = {
        r.week_start: (r.other_percent, r.confirmed_at)
        for r in db.exec(
            select(CapacityWeek).where(
                CapacityWeek.org_id == e2.org_id, CapacityWeek.employee_id == e2.id
            )
        ).all()
    }
    # W3 was restored to its original stale 15% (from Click 1, not reverted!)
    assert e2_after[w3][0] == 75
    assert w4 not in e2_after
    assert w5 not in e2_after

    # Revert the remaining 1st batch too -> W3 must restore to original stale 15%!
    rev3 = client.post(
        f"{url}/capacity/weeks/carry-over/revert",
        headers=auth["manager"],
    )
    assert rev3.status_code == 200, rev3.text
    db.expire_all()
    w3_restored = db.exec(
        select(CapacityWeek).where(
            CapacityWeek.org_id == e2.org_id,
            CapacityWeek.employee_id == e2.id,
            CapacityWeek.week_start == w3,
        )
    ).one()
    assert w3_restored.other_percent == 15
    assert w3_restored.confirmed_at < utc_now() - timedelta(days=FRESH_DAYS)

    # Batch history must NOT be deleted (all 3 rows remain with reverted_at set)
    batches = db.exec(
        select(CapacityCarryOver).where(CapacityCarryOver.org_id == e2.org_id)
    ).all()
    assert len(batches) == 3
    assert all(b.reverted_at is not None for b in batches)

    # Audit events recorded
    audits = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == e2.org_id,
            AuditEvent.action.in_(
                [
                    "capacity.workload_carried_over",
                    "capacity.workload_carry_over_reverted",
                ]
            ),
        )
    ).all()
    assert [a.action for a in audits].count("capacity.workload_carried_over") == 3
    assert [a.action for a in audits].count(
        "capacity.workload_carry_over_reverted"
    ) == 3


def test_manager_set_capacity_cap_and_leave_flag(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = capacity
    enable(client, capacity)
    e2 = people["E02"]
    w0 = this_week(db, e2.org_id)
    actor = user_id(db, people["E01"])

    # Assign 30% platform task in W0
    demand = CapacityDemand(
        org_id=e2.org_id,
        requesting_department_id=e2.department_id,
        target_department_id=e2.department_id,
        requester_user_id=actor,
        capability_key="synthetic",
        capability_name="合成能力",
        headcount=1,
        allocation_percent=30,
        window_start=w0,
        window_end=w0 + timedelta(days=4),
        description="合成需求",
    )
    db.add(demand)
    db.flush()
    db.add(
        CapacityAssignment(
            org_id=e2.org_id,
            demand_id=demand.id,
            employee_id=e2.id,
            allocation_percent=30,
            start_date=w0,
            due_date=w0 + timedelta(days=4),
            assigned_by_user_id=actor,
        )
    )
    db.commit()

    # Manager sets other_percent=20, capacity_percent=60, on_leave=True with explicit leave_dates for W0
    resp = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "items": [
                {
                    "employee_id": str(e2.id),
                    "other_percent": 20,
                    "capacity_percent": 60,
                    "on_leave": True,
                    "leave_dates": [
                        w0.isoformat(),
                        (w0 + timedelta(days=1)).isoformat(),
                    ],
                }
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    mine = client.get(f"{url}/capacity/workloads/me", headers=auth["employee"]).json()
    week0 = mine["weeks"][0]
    assert week0["other_percent"] == 20
    assert week0["platform_percent"] == 30
    assert week0["capacity_percent"] == 60
    assert len(mine["unavailabilities"]) == 1

    # Manager sets capacity_percent=100, on_leave=False, leave_dates=[] -> deletes unavailability & notifies employee (D-012)
    resp2 = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "items": [
                {
                    "employee_id": str(e2.id),
                    "other_percent": 20,
                    "capacity_percent": 100,
                    "on_leave": False,
                    "leave_dates": [],
                }
            ],
        },
    )
    assert resp2.status_code == 200, resp2.text
    mine2 = client.get(f"{url}/capacity/workloads/me", headers=auth["employee"]).json()
    assert mine2["weeks"][0]["capacity_percent"] == 100
    assert mine2["unavailabilities"] == []
    inbox = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == e2.org_id,
            InboxItem.recipient_employee_id == e2.id,
            InboxItem.kind == InboxKind.CAPACITY,
        )
    ).all()
    assert any("不可用时段已撤销" in i.message for i in inbox)


def test_carry_over_permissions_conflict_and_preserve_custom_dates(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = capacity
    enable(client, capacity)
    e2 = people["E02"]
    w0 = this_week(db, e2.org_id)
    w1 = w0 + timedelta(weeks=1)

    for role, status in [("employee", 403), ("admin", 403), ("foreign", 404)]:
        assert (
            client.get(
                f"{url}/capacity/weeks/carry-over/preview", headers=auth[role]
            ).status_code
            == status
        )
        assert (
            client.post(
                f"{url}/capacity/weeks/carry-over/revert", headers=auth[role]
            ).status_code
            == status
        )

    # Employee sets Wed-Thu unavailability (2 days -> 60% cap)
    wed = w0 + timedelta(days=2)
    thu = w0 + timedelta(days=3)
    reg = client.post(
        f"{url}/capacity/unavailability",
        headers=auth["employee"],
        json={
            "employee_id": str(e2.id),
            "start_date": wed.isoformat(),
            "end_date": thu.isoformat(),
        },
    )
    assert reg.status_code == 200
    unavail_id = reg.json()["id"]

    # Manager adjusts other_percent=30 while keeping capacity_percent=60 -> custom Wed-Thu preserved
    resp = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "items": [
                {
                    "employee_id": str(e2.id),
                    "other_percent": 30,
                    "capacity_percent": 60,
                    "on_leave": True,
                }
            ],
        },
    )
    assert resp.status_code == 200
    still = db.get(CapacityUnavailability, unavail_id)
    assert still is not None and still.start_date == wed and still.end_date == thu

    # Carry over once to fill W1=30%, then manually change W1 -> revert must return 409
    plan = client.get(
        f"{url}/capacity/weeks/carry-over/preview", headers=auth["manager"]
    ).json()
    e2_item = next(i for i in plan["items"] if i["employee_id"] == str(e2.id))
    assert (
        client.post(
            f"{url}/capacity/weeks/carry-over",
            headers=auth["manager"],
            json={
                "items": [
                    {
                        "employee_id": e2_item["employee_id"],
                        "week_start": e2_item["target_week_start"],
                        "baseline_week_start": e2_item["baseline_week_start"],
                        "other_percent": e2_item["other_percent"],
                    }
                ]
            },
        ).status_code
        == 200
    )
    # Submitting the same confirmed week again must fail with 409 (already confirmed)
    assert (
        client.post(
            f"{url}/capacity/weeks/carry-over",
            headers=auth["manager"],
            json={
                "items": [
                    {
                        "employee_id": e2_item["employee_id"],
                        "week_start": w1.isoformat(),
                        "baseline_week_start": w0.isoformat(),
                        "other_percent": 30,
                    }
                ]
            },
        ).status_code
        == 409
    )
    # Manually overwrite W1 -> revert must fail with 409 instead of clobbering manual edit
    assert (
        client.put(
            f"{url}/capacity/weeks",
            headers=auth["manager"],
            json={
                "start_week": w1.isoformat(),
                "end_week": w1.isoformat(),
                "items": [{"employee_id": str(e2.id), "other_percent": 95}],
            },
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"{url}/capacity/weeks/carry-over/revert", headers=auth["manager"]
        ).status_code
        == 409
    )
