from collections.abc import Generator
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlmodel import Session, select

from app.domains.audit.models import AuditEvent
from app.domains.capacity.calendar import this_week
from app.domains.capacity.models import CapacityUnavailability
from app.domains.inbox.models import InboxItem, InboxKind
from tests.api.routes.test_m6_capacity_workload import (
    capacity as base_capacity,
)
from tests.api.routes.test_m6_capacity_workload import (
    enable,
)

base_capacity_fixture = base_capacity


@pytest.fixture
def capacity(base_capacity_fixture: tuple, db: Session) -> Generator[tuple]:
    yield base_capacity_fixture
    db.rollback()
    org_id = base_capacity_fixture[1]["E01"].org_id
    db.execute(
        delete(CapacityUnavailability).where(CapacityUnavailability.org_id == org_id)
    )
    db.commit()


def test_multi_week_other_percent_preserves_heterogeneous_leave(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = capacity
    enable(client, capacity)
    e2 = people["E02"]
    w0 = this_week(db, e2.org_id)
    w1 = w0 + timedelta(weeks=1)
    w2 = w0 + timedelta(weeks=2)
    w3 = w0 + timedelta(weeks=3)

    # Seed heterogeneous leave: W0=100%, W1=1d (80%), W2=2d (60%), W3=3d (40%)
    w1_wed = w1 + timedelta(days=2)
    w2_thu, w2_fri = w2 + timedelta(days=3), w2 + timedelta(days=4)
    w3_mon, w3_wed = w3, w3 + timedelta(days=2)
    seeded_ids: list = []
    for start_d, end_d in [
        (w1_wed, w1_wed),
        (w2_thu, w2_fri),
        (w3_mon, w3_wed),
    ]:
        res = client.post(
            f"{url}/capacity/unavailability",
            headers=auth["employee"],
            json={
                "employee_id": str(e2.id),
                "start_date": start_d.isoformat(),
                "end_date": end_d.isoformat(),
            },
        )
        assert res.status_code == 200, res.text
        seeded_ids.append(res.json()["id"])

    # Manager saves W0..W3 updating only other_percent (no capacity_percent/on_leave)
    resp = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "start_week": w0.isoformat(),
            "end_week": w3.isoformat(),
            "items": [{"employee_id": str(e2.id), "other_percent": 25}],
        },
    )
    assert resp.status_code == 200, resp.text

    mine = client.get(f"{url}/capacity/workloads/me", headers=auth["employee"]).json()
    assert [w["other_percent"] for w in mine["weeks"][:4]] == [25, 25, 25, 25]
    assert [w["capacity_percent"] for w in mine["weeks"][:4]] == [100, 80, 60, 40]
    assert [item["id"] for item in mine["unavailabilities"]] == seeded_ids

    # Also verify starting from a leave week (W1..W2) preserves both weeks' leave
    resp2 = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "start_week": w1.isoformat(),
            "end_week": w2.isoformat(),
            "items": [{"employee_id": str(e2.id), "other_percent": 35}],
        },
    )
    assert resp2.status_code == 200, resp2.text
    mine2 = client.get(f"{url}/capacity/workloads/me", headers=auth["employee"]).json()
    assert [w["other_percent"] for w in mine2["weeks"][:4]] == [25, 35, 35, 25]
    assert [w["capacity_percent"] for w in mine2["weeks"][:4]] == [100, 80, 60, 40]
    assert [item["id"] for item in mine2["unavailabilities"]] == seeded_ids

    # No unavailability deletion/registration audit or D-012 revocation notice emitted
    audits = db.exec(select(AuditEvent).where(AuditEvent.org_id == e2.org_id)).all()
    assert not any(a.action == "capacity.unavailability_deleted" for a in audits)
    inbox = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == e2.org_id,
            InboxItem.recipient_employee_id == e2.id,
            InboxItem.kind == InboxKind.CAPACITY,
        )
    ).all()
    assert not any("不可用时段已撤销" in i.message for i in inbox)


def test_single_week_edit_explicit_leave_change_and_d012_revocation(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = capacity
    enable(client, capacity)
    e2 = people["E02"]
    w0 = this_week(db, e2.org_id)
    w1 = w0 + timedelta(weeks=1)
    w2 = w0 + timedelta(weeks=2)

    w1_wed = w1 + timedelta(days=2)
    w2_thu, w2_fri = w2 + timedelta(days=3), w2 + timedelta(days=4)
    for start_d, end_d in [(w1_wed, w1_wed), (w2_thu, w2_fri)]:
        res = client.post(
            f"{url}/capacity/unavailability",
            headers=auth["employee"],
            json={
                "employee_id": str(e2.id),
                "start_date": start_d.isoformat(),
                "end_date": end_d.isoformat(),
            },
        )
        assert res.status_code == 200, res.text

    # Single-week normal edit of W1 other_percent only -> preserves W1 80% leave
    resp_w1 = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "start_week": w1.isoformat(),
            "end_week": w1.isoformat(),
            "items": [{"employee_id": str(e2.id), "other_percent": 40}],
        },
    )
    assert resp_w1.status_code == 200, resp_w1.text
    mine = client.get(f"{url}/capacity/workloads/me", headers=auth["employee"]).json()
    assert mine["weeks"][1]["other_percent"] == 40
    assert mine["weeks"][1]["capacity_percent"] == 80

    # Single-week explicit leave change on W0 (60%, on_leave=True, explicit Mon-Tue)
    resp_w0 = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "items": [
                {
                    "employee_id": str(e2.id),
                    "other_percent": 15,
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
    assert resp_w0.status_code == 200, resp_w0.text

    # Single-week explicit leave revocation on W1 (100%, on_leave=False, leave_dates=[]) -> D-012 audit + notice
    resp_revoke = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "start_week": w1.isoformat(),
            "end_week": w1.isoformat(),
            "items": [
                {
                    "employee_id": str(e2.id),
                    "other_percent": 40,
                    "capacity_percent": 100,
                    "on_leave": False,
                    "leave_dates": [],
                }
            ],
        },
    )
    assert resp_revoke.status_code == 200, resp_revoke.text

    mine2 = client.get(f"{url}/capacity/workloads/me", headers=auth["employee"]).json()
    assert [w["capacity_percent"] for w in mine2["weeks"][:3]] == [60, 100, 60]
    remaining = db.exec(
        select(CapacityUnavailability)
        .where(
            CapacityUnavailability.org_id == e2.org_id,
            CapacityUnavailability.employee_id == e2.id,
        )
        .order_by(CapacityUnavailability.start_date)
    ).all()
    assert [(r.start_date, r.end_date) for r in remaining] == [
        (w0, w0 + timedelta(days=1)),
        (w2_thu, w2_fri),
    ]

    audits = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == e2.org_id,
            AuditEvent.action == "capacity.unavailability_deleted",
        )
    ).all()
    assert any(a.details.get("start_date") == w1_wed.isoformat() for a in audits)
    inbox = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == e2.org_id,
            InboxItem.recipient_employee_id == e2.id,
            InboxItem.kind == InboxKind.CAPACITY,
        )
    ).all()
    assert any(
        f"你的不可用时段已撤销（{w1_wed.isoformat()} 至 {w1_wed.isoformat()}）"
        in i.message
        for i in inbox
    )
