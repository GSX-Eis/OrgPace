import asyncio
from dataclasses import replace
from datetime import timedelta
from typing import Literal

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.domains.audit.models import AuditEvent
from app.domains.bot import core, store, tools
from app.domains.bot import schemas as s
from app.domains.capacity.calendar import this_week
from app.domains.capacity.models import (
    CapacityUnavailability,
    CapacityWeek,
    CapacityWorkloadRequest,
)
from app.domains.im import actions, rendering
from app.domains.im.models import ImAction, ImSetting
from app.domains.inbox.models import InboxItem, InboxKind
from tests.api.routes.test_m6_capacity_workload import enable, user_id
from tests.api.routes.test_m7_unavailability import capacity as capacity
from tests.api.routes.test_m7_unavailability import (
    workload_capacity as workload_capacity,
)
from tests.domains.test_im_conversation import button
from tests.domains.test_im_gateway import event
from tests.domains.test_im_gateway import principal as make_principal


def test_next_week_workload_request_web_and_assistant(
    capacity: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = capacity
    enable(client, capacity)
    emp = people["E02"]
    mgr = people["E01"]
    mgr_user_id = user_id(db, mgr)
    next_week = (this_week(db, emp.org_id) + timedelta(weeks=1)).isoformat()

    # 1. Web path for next week
    created = client.post(
        f"{url}/capacity/workloads/me/requests",
        headers=auth["employee"],
        json={
            "requested_percent": 45,
            "reason": "合成下周网页负荷调整",
            "start_week": next_week,
            "end_week": next_week,
        },
    )
    assert created.status_code == 200, created.text
    req_id = created.json()["id"]
    assert mgr.display_name in created.json()["reviewer_names"]

    mgr_inbox = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == emp.org_id,
            InboxItem.recipient_user_id == mgr_user_id,
            InboxItem.kind == InboxKind.CAPACITY,
        )
    ).all()
    assert any(next_week in item.message for item in mgr_inbox)

    pending_list = client.get(
        f"{url}/capacity/workload-requests", headers=auth["manager"]
    ).json()["data"]
    assert any(r["id"] == req_id and r["status"] == "pending" for r in pending_list)

    approved = client.post(
        f"{url}/capacity/workload-requests/{req_id}/decision",
        headers=auth["manager"],
        json={"approve": True},
    )
    assert approved.status_code == 200, approved.text
    mine = client.get(f"{url}/capacity/workloads/me", headers=auth["employee"]).json()
    assert mine["weeks"][1]["other_percent"] == 45

    # 2. Assistant path (web + feishu) for next week
    for channel in ("web", "feishu"):
        p = make_principal(db, emp.org_id, emp.id)
        session = store.create_session(db, p, channel=channel)
        cards: list[s.Message] = []
        result = tools.call(
            db,
            p,
            session,
            cards,
            "prepare_workload_request",
            {
                "requested_percent": 30 if channel == "web" else 25,
                "reason": f"合成助手下周调整-{channel}",
                "start_week": next_week,
                "end_week": next_week,
            },
        )
        assert isinstance(result, dict) and result["status"] == "pending"
        assert mgr.display_name in result["preview"]
        card = cards[0]
        assert isinstance(card, s.CapacityCard)
        core._save(db, session, [card])
        db.commit()

        confirmed = core.act(db, p, session.id, card.actions[0]).messages[0]
        assert isinstance(confirmed, s.CapacityCard)
        assert confirmed.status == "confirmed"
        assert confirmed.result and mgr.display_name in confirmed.result

        bot_req = db.exec(
            select(CapacityWorkloadRequest)
            .where(
                CapacityWorkloadRequest.org_id == emp.org_id,
                CapacityWorkloadRequest.employee_id == emp.id,
                CapacityWorkloadRequest.status == "pending",
            )
            .order_by(CapacityWorkloadRequest.created_at.desc())
        ).one()
        assert (
            client.post(
                f"{url}/capacity/workload-requests/{bot_req.id}/decision",
                headers=auth["manager"],
                json={"approve": True},
            ).status_code
            == 200
        )
        mine = client.get(
            f"{url}/capacity/workloads/me", headers=auth["employee"]
        ).json()
        assert mine["weeks"][1]["other_percent"] == (30 if channel == "web" else 25)


@pytest.mark.parametrize("channel", ["web", "feishu"])
def test_employee_leave_web_and_assistant_notifies_manager(
    capacity: tuple,
    db: Session,
    client: TestClient,
    channel: Literal["web", "feishu"],
) -> None:
    url, people, auth = capacity
    enable(client, capacity)
    emp = people["E02"]
    mgr = people["E01"]
    mgr_user_id = user_id(db, mgr)
    next_week = this_week(db, emp.org_id) + timedelta(weeks=1)
    leave_end = next_week + timedelta(days=1)

    if channel == "web":
        res = client.post(
            f"{url}/capacity/unavailability",
            headers=auth["employee"],
            json={
                "employee_id": str(emp.id),
                "start_date": next_week.isoformat(),
                "end_date": leave_end.isoformat(),
            },
        )
        assert res.status_code == 200, res.text
        row = res.json()
        assert "reason" not in row and "note" not in row
    else:
        p = make_principal(db, emp.org_id, emp.id)
        incoming = replace(event(p.org_id, "请假"), platform="feishu")
        session = store.create_session(
            db,
            p,
            channel="feishu",
            external_chat_id=incoming.external_chat_id,
            bot_identity="12345",
        )
        cards: list[s.Message] = []
        res_tool = tools.call(
            db,
            p,
            session,
            cards,
            "coordination",
            {
                "function": "prepare_leave",
                "arguments": {
                    "start_date": next_week.isoformat(),
                    "end_date": leave_end.isoformat(),
                },
            },
        )
        assert isinstance(res_tool, dict) and res_tool["status"] == "pending"
        assert not db.exec(
            select(CapacityUnavailability).where(
                CapacityUnavailability.org_id == emp.org_id
            )
        ).all()
        card = cards[0]
        assert isinstance(card, s.CapacityCard) and card.kind == "leave"
        rendered, buttons = rendering.render(card)
        assert (
            "请假" in rendered
            and next_week.isoformat() in rendered
            and "说明：" not in rendered
            and len(buttons) == 2
        )
        core._save(db, session, [card])
        db.add(
            ImSetting(
                org_id=p.org_id,
                platform="feishu",
                enabled=True,
                bot_identity="12345",
                credentials="synthetic",
                updated_by_user_id=p.user_id,
            )
        )
        db.commit()

        class FakeFeishu:
            async def render(self, chat: str, text: str, btns: list) -> str:
                return "leave-msg"

        asyncio.run(
            actions.deliver(
                db,
                p,
                incoming,
                "12345",
                actions.Reply(session.id, s.TurnResponse(messages=[card])),
                FakeFeishu(),
            )
        )
        action_row = db.exec(
            select(ImAction).where(
                ImAction.org_id == p.org_id,
                ImAction.action["action"].astext == "confirm_capacity",
            )
        ).one()
        reply = actions.callback(db, p, button(incoming, action_row), "12345")
        assert isinstance(reply, actions.Reply)
        confirmed = reply.response.messages[0]
        assert isinstance(confirmed, s.CapacityCard) and confirmed.status == "confirmed"

    # Takes effect immediately
    mine = client.get(f"{url}/capacity/workloads/me", headers=auth["employee"]).json()
    assert mine["weeks"][1]["capacity_percent"] == 60

    # Manager notified with dates only (no free-text note retained; D-061)
    mgr_notices = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == emp.org_id,
            InboxItem.recipient_user_id == mgr_user_id,
            InboxItem.kind == InboxKind.CAPACITY,
        )
    ).all()
    assert any(
        emp.display_name in item.message
        and next_week.isoformat() in item.message
        and leave_end.isoformat() in item.message
        and "说明：" not in item.message
        for item in mgr_notices
    )

    # Audit excludes private note / reason and records origin
    audit = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == emp.org_id,
            AuditEvent.action == "capacity.unavailability_registered",
        )
    ).one()
    assert "reason" not in audit.details and "合成外出培训" not in str(audit.details)
    assert audit.details["via"] == ("web" if channel == "web" else "feishu")

    # Org admin is forbidden from preparing leave
    admin_p = make_principal(db, emp.org_id, emp.id)
    admin_only = replace(admin_p, is_org_admin=True)
    assert "prepare_leave" not in {
        t.name for t in tools.definitions(admin_only, db=db, channel=channel)
    }
    admin_session = store.create_session(db, admin_only, channel=channel)
    blocked = tools.call(
        db,
        admin_only,
        admin_session,
        [],
        "coordination",
        {
            "function": "prepare_leave",
            "arguments": {
                "start_date": next_week.isoformat(),
                "end_date": leave_end.isoformat(),
            },
        },
    )
    assert isinstance(blocked, dict) and "error" in blocked


@pytest.mark.parametrize("channel", ["web", "feishu"])
def test_manager_adjusts_subordinate_workload_via_assistant(
    capacity: tuple,
    db: Session,
    channel: Literal["web", "feishu"],
) -> None:
    url_unused, people, _ = capacity
    _ = url_unused
    emp = people["E02"]
    mgr = people["E01"]
    outside = people["E04"]
    org_id = emp.org_id
    p_mgr = make_principal(db, org_id, mgr.id)
    p_emp = make_principal(db, org_id, emp.id)
    next_week = (this_week(db, org_id) + timedelta(weeks=1)).isoformat()

    from app.domains.capacity.models import CapacitySetting

    db.add(
        CapacitySetting(org_id=org_id, enabled=True, updated_by_user_id=p_mgr.user_id)
    )
    db.commit()

    session = store.create_session(db, p_mgr, channel=channel)
    emp_session = store.create_session(db, p_emp, channel=channel)

    # Scope / validation rejections
    for actor_p, actor_session, target_id, week_str in (
        (p_mgr, session, outside.id, next_week),  # outside managed departments
        (p_mgr, session, mgr.id, next_week),  # self adjustment forbidden
        (p_emp, emp_session, emp.id, next_week),  # regular employee forbidden
        (
            replace(p_mgr, is_org_admin=True),
            session,
            outside.id,
            next_week,
        ),  # dual role still scoped to managed_department_ids
    ):
        err = tools.call(
            db,
            actor_p,
            actor_session,
            cards := [],
            "coordination",
            {
                "function": "prepare_team_workload",
                "arguments": {
                    "employee_id": str(target_id),
                    "other_percent": 0,
                    "start_week": week_str,
                    "end_week": week_str,
                },
            },
        )
        assert isinstance(err, dict) and "error" in err
        assert not cards

    # Valid prepare -> confirmation card only, DB untouched before click
    cards = []
    scope: set[str] = set()
    res = tools.call(
        db,
        p_mgr,
        session,
        cards,
        "coordination",
        {
            "function": "prepare_team_workload",
            "arguments": {
                "employee_id": str(emp.id),
                "other_percent": 0,
                "start_week": next_week,
                "end_week": next_week,
            },
        },
        on_read=scope.update,
    )
    assert isinstance(res, dict) and res["status"] == "pending"
    assert scope == {str(emp.id)}
    assert len(cards) == 1
    card = cards[0]
    assert isinstance(card, s.CapacityCard) and card.kind == "team_workload"
    assert emp.display_name in card.content and "0%" in card.content
    assert not db.exec(select(CapacityWeek).where(CapacityWeek.org_id == org_id)).all()

    core._save(db, session, [card])
    db.commit()

    # Click confirm -> writes CapacityWeek, notifies employee, records assistant audit
    confirmed = core.act(db, p_mgr, session.id, card.actions[0]).messages[0]
    assert isinstance(confirmed, s.CapacityCard) and confirmed.status == "confirmed"

    week_row = db.exec(
        select(CapacityWeek).where(
            CapacityWeek.org_id == org_id,
            CapacityWeek.employee_id == emp.id,
        )
    ).one()
    assert week_row.other_percent == 0

    emp_notice = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == org_id,
            InboxItem.recipient_employee_id == emp.id,
            InboxItem.kind == InboxKind.CAPACITY,
        )
    ).one()
    assert next_week in emp_notice.message

    audit = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == org_id,
            AuditEvent.action == "capacity.workload_adjusted",
            AuditEvent.target_id == str(emp.id),
        )
    ).one()
    assert audit.details["via"] == ("feishu" if channel == "feishu" else "bot")
    assert audit.details["client_name"] == channel
    assert audit.details["after_percent"] == 0
