from collections.abc import Generator
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlmodel import Session, select

from app.core.security import create_access_token
from app.domains.bot import schemas as s
from app.domains.bot import store, tools
from app.domains.capacity.calendar import this_week
from app.domains.capacity.models import (
    CapacityCarryOver,
    CapacityCarryOverItem,
    CapacityUnavailability,
    CapacityWeek,
)
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.org.models import OrgMembership, Role, RoleGrant
from app.models import User
from tests.api.routes.test_m6_capacity_workload import (
    capacity as base_capacity,
)
from tests.api.routes.test_m6_capacity_workload import (
    enable,
    user_id,
)
from tests.domains.test_im_gateway import principal as make_principal

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


def test_d061_leave_notice_only_contains_dates_and_no_note_field(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = capacity
    enable(client, capacity)
    emp = people["E02"]
    mgr = people["E01"]
    mgr_user_id = user_id(db, mgr)
    next_week = this_week(db, emp.org_id) + timedelta(weeks=1)
    leave_end = next_week + timedelta(days=1)

    # 1. prepare_leave tool schema must not expose a free-text note field
    p_emp = make_principal(db, emp.org_id, emp.id)
    coord_tool = next(
        t
        for t in tools.definitions(p_emp, db=db, channel="web")
        if t.name == "coordination"
    )
    assert "note" not in str(coord_tool.parameters)
    leave_schema = tools.BOT_COORDINATION_FUNCTIONS["prepare_leave"]["parameters"]
    assert isinstance(leave_schema, dict)
    assert "note" not in leave_schema.get("properties", {})

    # 2. Submitting note via web API must be rejected and never persisted in inbox
    rejected = client.post(
        f"{url}/capacity/unavailability",
        headers=auth["employee"],
        json={
            "employee_id": str(emp.id),
            "start_date": next_week.isoformat(),
            "end_date": leave_end.isoformat(),
            "note": "合成私密说明不应留存",
        },
    )
    assert rejected.status_code == 422

    # 3. Clean web leave submission notifies manager with dates only
    ok = client.post(
        f"{url}/capacity/unavailability",
        headers=auth["employee"],
        json={
            "employee_id": str(emp.id),
            "start_date": next_week.isoformat(),
            "end_date": leave_end.isoformat(),
        },
    )
    assert ok.status_code == 200, ok.text

    # 4. Assistant prepare_leave card and confirmation notify manager with dates only
    third_week = next_week + timedelta(weeks=1)
    session = store.create_session(db, p_emp, channel="web")
    cards: list[s.Message] = []
    res = tools.call(
        db,
        p_emp,
        session,
        cards,
        "coordination",
        {
            "function": "prepare_leave",
            "arguments": {
                "start_date": third_week.isoformat(),
                "end_date": third_week.isoformat(),
            },
        },
    )
    assert isinstance(res, dict) and res["status"] == "pending"
    assert isinstance(cards[0], s.CapacityCard)
    assert "说明" not in cards[0].content

    mgr_notices = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == emp.org_id,
            InboxItem.recipient_user_id == mgr_user_id,
            InboxItem.kind == InboxKind.CAPACITY,
        )
    ).all()
    assert mgr_notices
    assert any(
        emp.display_name in item.message
        and next_week.isoformat() in item.message
        and leave_end.isoformat() in item.message
        and "说明：" not in item.message
        and "合成私密说明不应留存" not in item.message
        for item in mgr_notices
    )


def test_d066_capacity_change_requires_explicit_leave_dates(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = capacity
    enable(client, capacity)
    e2 = people["E02"]
    w0 = this_week(db, e2.org_id)
    mon, tue, wed, thu, fri = (w0 + timedelta(days=i) for i in range(5))

    # 1. Adjusting capacity_percent on a leave-free week without leave_dates must fail (no implicit Monday)
    implicit_add = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "items": [
                {
                    "employee_id": str(e2.id),
                    "other_percent": 20,
                    "capacity_percent": 80,
                    "on_leave": True,
                }
            ],
        },
    )
    assert implicit_add.status_code == 422, implicit_add.text
    assert "选定具体请假日期" in implicit_add.text
    assert not db.exec(
        select(CapacityUnavailability).where(CapacityUnavailability.org_id == e2.org_id)
    ).all()

    # 2. Explicit leave_dates=[Tue, Thu] registers exact dates (not Mon) and notifies employee
    explicit_add = client.put(
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
                    "leave_dates": [tue.isoformat(), thu.isoformat()],
                }
            ],
        },
    )
    assert explicit_add.status_code == 200, explicit_add.text
    rows = db.exec(
        select(CapacityUnavailability)
        .where(
            CapacityUnavailability.org_id == e2.org_id,
            CapacityUnavailability.employee_id == e2.id,
        )
        .order_by(CapacityUnavailability.start_date)
    ).all()
    assert [(r.start_date, r.end_date) for r in rows] == [(tue, tue), (thu, thu)]
    assert mon not in {r.start_date for r in rows}

    # 3. Increasing capacity_percent without leave_dates must fail (no implicit reverse deletion)
    implicit_reduce = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "items": [
                {
                    "employee_id": str(e2.id),
                    "other_percent": 20,
                    "capacity_percent": 80,
                    "on_leave": True,
                }
            ],
        },
    )
    assert implicit_reduce.status_code == 422
    still = db.exec(
        select(CapacityUnavailability)
        .where(
            CapacityUnavailability.org_id == e2.org_id,
            CapacityUnavailability.employee_id == e2.id,
        )
        .order_by(CapacityUnavailability.start_date)
    ).all()
    assert [(r.start_date, r.end_date) for r in still] == [(tue, tue), (thu, thu)]

    # 4. Revoking all leave without leave_dates must fail (must be explicit)
    implicit_clear = client.put(
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
                }
            ],
        },
    )
    assert implicit_clear.status_code == 422

    # 5. Explicitly keeping Thu (removing Tue) removes only Tue and notifies Tue revoked
    explicit_reduce = client.put(
        f"{url}/capacity/weeks",
        headers=auth["manager"],
        json={
            "start_week": w0.isoformat(),
            "end_week": w0.isoformat(),
            "items": [
                {
                    "employee_id": str(e2.id),
                    "other_percent": 20,
                    "capacity_percent": 80,
                    "on_leave": True,
                    "leave_dates": [thu.isoformat()],
                }
            ],
        },
    )
    assert explicit_reduce.status_code == 200, explicit_reduce.text
    after_reduce = db.exec(
        select(CapacityUnavailability).where(
            CapacityUnavailability.org_id == e2.org_id,
            CapacityUnavailability.employee_id == e2.id,
        )
    ).all()
    assert [(r.start_date, r.end_date) for r in after_reduce] == [(thu, thu)]
    inbox = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == e2.org_id,
            InboxItem.recipient_employee_id == e2.id,
            InboxItem.kind == InboxKind.CAPACITY,
        )
    ).all()
    assert any(
        f"你的不可用时段已撤销（{tue.isoformat()} 至 {tue.isoformat()}）"
        in item.message
        for item in inbox
    )
    assert not any(fri.isoformat() in item.message for item in inbox)


def test_d067_carry_over_revert_preview_and_batch_guard(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = capacity
    enable(client, capacity)
    e1 = people["E01"]
    e4 = people["E04"]
    e5 = people["E05"]
    e6 = people["E06"]
    org_id = e1.org_id

    # Issue accounts so E04 has an active User + OrgMembership, then grant E01 & E04 dept_manager on E04's department (算法与模型部)
    issue_resp = client.post(f"{url}/accounts/issue", headers=auth["admin"], json={})
    assert issue_resp.status_code == 200, issue_resp.text
    for mgr_emp in (e1, e4):
        membership = db.exec(
            select(OrgMembership).where(
                OrgMembership.org_id == org_id,
                OrgMembership.employee_id == mgr_emp.id,
            )
        ).one()
        db.add(
            RoleGrant(
                org_id=org_id,
                membership_id=membership.id,
                role=Role.DEPT_MANAGER,
                department_id=e4.department_id,
            )
        )
    w0 = this_week(db, org_id)
    w1 = w0 + timedelta(weeks=1)
    w2 = w0 + timedelta(weeks=2)
    e4_uid = user_id(db, e4)
    e4_user = db.get(User, e4_uid)
    assert e4_user is not None
    e4_user.must_change_password = False
    db.add(e4_user)
    db.add_all(
        [
            CapacityWeek(
                org_id=org_id,
                employee_id=e5.id,
                week_start=w0,
                other_percent=35,
                confirmed_by_user_id=e4_uid,
            ),
            CapacityWeek(
                org_id=org_id,
                employee_id=e6.id,
                week_start=w0,
                other_percent=45,
                confirmed_by_user_id=e4_uid,
            ),
        ]
    )
    db.commit()

    e4_headers = {
        "Authorization": f"Bearer {create_access_token(e4_uid, expires_delta=timedelta(minutes=10), password_changed_at=e4_user.password_changed_at)}"
    }

    # Permissions on revert preview endpoint
    for role, expected in [("employee", 403), ("admin", 403), ("foreign", 404)]:
        assert (
            client.get(
                f"{url}/capacity/weeks/carry-over/revert/preview", headers=auth[role]
            ).status_code
            == expected
        )

    # E04 commits carry-over batch B1 for 算法与模型部 (W1)
    plan1_resp = client.get(
        f"{url}/capacity/weeks/carry-over/preview",
        headers=e4_headers,
        params={"department_id": str(e4.department_id)},
    )
    assert plan1_resp.status_code == 200, plan1_resp.text
    plan1 = plan1_resp.json()
    b1_resp = client.post(
        f"{url}/capacity/weeks/carry-over",
        headers=e4_headers,
        json={
            "items": [
                {
                    "employee_id": i["employee_id"],
                    "week_start": i["target_week_start"],
                    "baseline_week_start": i["baseline_week_start"],
                    "other_percent": i["other_percent"],
                }
                for i in plan1["items"]
            ]
        },
    )
    assert b1_resp.status_code == 200, b1_resp.text
    b1_id = b1_resp.json()["id"]

    # E01 previews revert across managed departments -> sees E04 as operator, 算法与模型部, E05/E06, W1
    rev_preview = client.get(
        f"{url}/capacity/weeks/carry-over/revert/preview", headers=auth["manager"]
    )
    assert rev_preview.status_code == 200, rev_preview.text
    payload = rev_preview.json()
    assert payload["reversible_count"] == 1
    batch = payload["latest_batch"]
    assert batch is not None
    assert batch["id"] == b1_id
    assert batch["created_by_name"] == e4.display_name
    assert batch["department_names"] == ["算法与模型部"]
    assert set(batch["employee_names"]) == {e5.display_name, e6.display_name}
    assert batch["week_starts"] == [w1.isoformat()]

    # Concurrency guard: E04 commits B2 while E01 still holds B1 id
    plan2 = client.get(
        f"{url}/capacity/weeks/carry-over/preview",
        headers=e4_headers,
        params={"department_id": str(e4.department_id)},
    ).json()
    b2_resp = client.post(
        f"{url}/capacity/weeks/carry-over",
        headers=e4_headers,
        json={
            "items": [
                {
                    "employee_id": i["employee_id"],
                    "week_start": i["target_week_start"],
                    "baseline_week_start": i["baseline_week_start"],
                    "other_percent": i["other_percent"],
                }
                for i in plan2["items"]
            ]
        },
    )
    assert b2_resp.status_code == 200, b2_resp.text
    b2_id = b2_resp.json()["id"]

    stale_revert = client.post(
        f"{url}/capacity/weeks/carry-over/revert",
        headers=auth["manager"],
        json={"batch_id": b1_id},
    )
    assert stale_revert.status_code == 409, stale_revert.text

    # Refresh preview -> gets B2 -> revert succeeds
    refreshed = client.get(
        f"{url}/capacity/weeks/carry-over/revert/preview", headers=auth["manager"]
    ).json()
    assert refreshed["latest_batch"]["id"] == b2_id
    assert refreshed["latest_batch"]["week_starts"] == [w2.isoformat()]
    ok_revert = client.post(
        f"{url}/capacity/weeks/carry-over/revert",
        headers=auth["manager"],
        json={"batch_id": b2_id},
    )
    assert ok_revert.status_code == 200, ok_revert.text
    assert ok_revert.json()["created_by_name"] == e4.display_name
