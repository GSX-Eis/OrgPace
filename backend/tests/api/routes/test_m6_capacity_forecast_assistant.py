import asyncio
import json
from collections.abc import AsyncIterator, Generator
from dataclasses import replace
from datetime import timedelta
from typing import Any, ClassVar, Literal, cast
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlmodel import Session, col, select

from app.core.db import engine
from app.domains.audit.models import AuditEvent
from app.domains.bot import core, store, tools
from app.domains.bot import schemas as s
from app.domains.bot.models import BotMessage, BotSession
from app.domains.capacity import calendar
from app.domains.capacity.models import (
    CapacityForecastEvent,
    CapacityForecastPolicy,
    CapacityWeek,
    CapacityWeekForecast,
    ForecastSource,
)
from app.domains.im import binding, gateway, rendering
from app.domains.im.adapters.base import Event
from app.domains.im.models import ImAction, ImBindCode, ImBinding, ImSetting
from app.domains.im.schemas import Platform
from tests.api.routes.test_m6_capacity_workload import (
    capacity as base_capacity,
)
from tests.api.routes.test_m6_capacity_workload import (
    enable,
    user_id,
)
from tests.domains.test_bot_core import enable as enable_bot
from tests.domains.test_im_conversation import button
from tests.domains.test_im_gateway import enable as enable_im
from tests.domains.test_im_gateway import principal as make_principal
from tests.utils.pi import PiHarness

base_capacity_fixture = base_capacity
pytestmark = pytest.mark.usefixtures("reset_login_attempts")

DemoTuple = tuple[str, dict[str, Any], dict[str, dict[str, str]]]


class FakeFeishuAdapter:
    platform: ClassVar[Platform] = "feishu"

    def __init__(
        self, org_id: UUID | None = None, credentials: dict[str, str] | None = None
    ) -> None:
        self.org_id = org_id
        self.credentials = credentials or {}
        self.messages: list[dict[str, Any]] = []
        self.texts: list[str] = []
        self.callbacks: list[str] = []

    async def poll(self) -> AsyncIterator[Event]:
        if False:
            yield Event(uuid4(), "feishu", "")

    async def send_text(self, external_chat_id: str, text: str) -> None:
        _ = external_chat_id
        self.texts.append(text)

    async def render(
        self,
        external_chat_id: str,
        text: str,
        buttons: list[tuple[str, str]],
        *,
        links: list[tuple[str, str]] | None = None,
    ) -> str:
        _ = external_chat_id, links
        self.messages.append({"text": text, "buttons": buttons})
        return f"feishu-msg-{len(self.messages)}"

    async def answer_callback(self, callback_id: str) -> None:
        self.callbacks.append(callback_id)

    async def clear_buttons(self, external_chat_id: str, message_id: str) -> None:
        _ = external_chat_id, message_id

    async def test_connection(self) -> str:
        return "ok"

    async def close(self) -> None:
        pass


@pytest.fixture
def forecast_assistant(
    base_capacity_fixture: DemoTuple, db: Session
) -> Generator[DemoTuple]:
    yield base_capacity_fixture
    db.rollback()
    org_id = base_capacity_fixture[1]["E01"].org_id
    for model in (
        ImAction,
        ImBinding,
        ImBindCode,
        ImSetting,
        BotMessage,
        BotSession,
        CapacityForecastEvent,
        CapacityForecastPolicy,
    ):
        db.exec(delete(model).where(col(model.org_id) == org_id))
    db.commit()


def _assert_no_employee_leak(payload: object, people: dict[str, Any]) -> None:
    raw = json.dumps(payload, ensure_ascii=False, default=str)
    for person in people.values():
        if person.org_id != people["E01"].org_id:
            continue
        assert person.display_name not in raw
        assert str(person.id) not in raw
        assert person.employee_code not in raw
    for forbidden in ("个人负荷", "周负荷", "平台分配", "其他工作占比"):
        assert forbidden not in raw


@pytest.mark.parametrize("channel", ["web", "feishu"])
def test_tool_definitions_limit_and_role_visibility(
    forecast_assistant: DemoTuple,
    db: Session,
    client: TestClient,
    channel: Literal["web", "feishu"],
) -> None:
    _, people, _ = forecast_assistant
    enable(client, forecast_assistant)
    org_id = people["E01"].org_id
    p_mgr = make_principal(db, org_id, people["E01"].id)
    p_admin = replace(p_mgr, is_org_admin=True)
    p_emp = make_principal(db, org_id, people["E02"].id)

    for privileged in (p_mgr, p_admin):
        defs = tools.definitions(privileged, db=db, channel=channel)
        names = {t.name for t in defs}
        assert len(defs) == len(names) <= 29
        assert {
            "get_forecast_config",
            "prepare_forecast_policy",
            "prepare_forecast_event",
        }.isdisjoint(names)
        coord = next(t for t in defs if t.name == "coordination")
        coord_params = cast("dict[str, Any]", coord.parameters)
        fn_enum = set(coord_params["properties"]["function"]["enum"])
        bot_fns = set(json.loads(coord.description.splitlines()[1]))
        expected = {
            "get_forecast_config",
            "prepare_forecast_policy",
            "prepare_forecast_event",
        }
        assert expected <= fn_enum
        assert expected <= bot_fns

    emp_defs = tools.definitions(p_emp, db=db, channel=channel)
    assert len(emp_defs) <= 29
    emp_coord = next(t for t in emp_defs if t.name == "coordination")
    emp_coord_params = cast("dict[str, Any]", emp_coord.parameters)
    emp_enum = set(emp_coord_params["properties"]["function"]["enum"])
    emp_bot_fns = set(json.loads(emp_coord.description.splitlines()[1]))
    for hidden in (
        "get_forecast_config",
        "prepare_forecast_policy",
        "prepare_forecast_event",
    ):
        assert hidden not in emp_enum
        assert hidden not in emp_bot_fns

        emp_session = store.create_session(db, p_emp, channel=channel)
        cards: list[s.Message] = []
        blocked = tools.call(
            db,
            p_emp,
            emp_session,
            cards,
            "coordination",
            {"function": hidden, "arguments": {}},
        )
        assert isinstance(blocked, dict) and "error" in blocked
        assert not cards

    for direct_name in ("prepare_forecast_policy", "prepare_forecast_event"):
        mgr_session = store.create_session(db, p_mgr, channel=channel)
        direct_err = tools.call(db, p_mgr, mgr_session, [], direct_name, {})
        assert isinstance(direct_err, dict) and "error" in direct_err


def test_get_forecast_config_scope_and_on_read(
    forecast_assistant: DemoTuple,
    db: Session,
    client: TestClient,
    pi_service: PiHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url, people, auth = forecast_assistant
    enable(client, forecast_assistant)
    org_id = people["E01"].org_id
    e02 = people["E02"]
    e02.job_family = "仓储运营"
    db.add(e02)
    db.commit()

    w0 = calendar.this_week(db, org_id)
    assert (
        client.put(
            f"{url}/capacity/forecast-policies",
            headers=auth["admin"],
            json={"retention_rate": 0.5},
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"{url}/capacity/forecast-events",
            headers=auth["admin"],
            json={
                "title": "全企业盘点周",
                "start_week": w0.isoformat(),
                "end_week": w0.isoformat(),
                "modifier_kind": "delta",
                "modifier_value": 10,
                "reason": "年度盘点",
            },
        ).status_code
        == 200
    )

    p_mgr = make_principal(db, org_id, people["E01"].id)
    p_admin = replace(p_mgr, is_org_admin=True)
    mgr_session = store.create_session(db, p_mgr, channel="web")
    admin_session = store.create_session(db, p_admin, channel="web")

    read_ids: set[str] = {"sentinel"}

    def record_read(ids: set[str]) -> None:
        read_ids.clear()
        read_ids.update(ids)

    mgr_cfg_raw = tools.call(
        db,
        p_mgr,
        mgr_session,
        [],
        "coordination",
        {"function": "get_forecast_config", "arguments": {}},
        on_read=record_read,
    )
    assert read_ids == set()
    assert isinstance(mgr_cfg_raw, dict) and "error" not in mgr_cfg_raw
    mgr_cfg = cast("dict[str, Any]", mgr_cfg_raw)
    assert mgr_cfg["default_retention_rate"] == 0.65
    assert "presets" not in mgr_cfg
    assert len(mgr_cfg["recommended_retention_rates"]) == 3
    assert "仓储运营" in mgr_cfg["job_families"]
    assert all(
        d["id"] in {str(i) for i in p_mgr.managed_department_ids}
        for d in mgr_cfg["departments"]
    )
    assert all(d["can_edit"] is True for d in mgr_cfg["departments"])
    assert any(
        pol["department_id"] is None and pol["can_edit"] is False
        for pol in mgr_cfg["policies"]
    )
    assert any(
        ev["department_id"] is None and ev["can_edit"] is False
        for ev in mgr_cfg["events"]
    )
    _assert_no_employee_leak(mgr_cfg, people)

    admin_cfg_raw = tools.call(
        db,
        p_admin,
        admin_session,
        [],
        "coordination",
        {"function": "get_forecast_config", "arguments": {}},
    )
    assert isinstance(admin_cfg_raw, dict)
    admin_cfg = cast("dict[str, Any]", admin_cfg_raw)
    assert len(admin_cfg["departments"]) > len(mgr_cfg["departments"])
    assert any(
        pol["department_id"] is None and pol["can_edit"] is True
        for pol in admin_cfg["policies"]
    )

    enable_bot(db, org_id)
    monkeypatch.setattr(core, "model_config", lambda _: pi_service.config)
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "coordination",
                    "arguments": {"function": "get_forecast_config", "arguments": {}},
                }
            ]
        },
        "已查到当前预测配置",
    ]
    turn_resp = core.turn(db, p_mgr, mgr_session.id, "查看预测配置")
    assert len(turn_resp.steps) == 1 and turn_resp.steps[0].ok
    req_prompt = pi_service.requests[0]["body"]["messages"][0]["content"]
    assert "prepare_forecast_policy" in req_prompt
    assert "prepare_forecast_event" in req_prompt

    p_emp = make_principal(db, org_id, e02.id)
    emp_session = store.create_session(db, p_emp, channel="web")
    pi_service.replies = ["你好"]
    core.turn(db, p_emp, emp_session.id, "你好")
    emp_prompt = pi_service.requests[-1]["body"]["messages"][0]["content"]
    assert "prepare_forecast_policy" not in emp_prompt
    assert "prepare_forecast_event" not in emp_prompt


@pytest.mark.parametrize("channel", ["web", "feishu"])
def test_prepare_and_confirm_forecast_policy_closed_loop(
    forecast_assistant: DemoTuple,
    db: Session,
    client: TestClient,
    channel: Literal["web", "feishu"],
) -> None:
    _, people, _ = forecast_assistant
    enable(client, forecast_assistant)
    e01 = people["E01"]
    e02 = people["E02"]
    e04 = people["E04"]
    org_id = e01.org_id
    w0 = calendar.this_week(db, org_id)
    far_week = w0 + timedelta(weeks=6)
    override_week = w0 + timedelta(weeks=8)
    dept_id = e02.department_id
    assert dept_id is not None

    mgr_uid = user_id(db, e01)
    for emp_id in (e01.id, e02.id):
        db.add(
            CapacityWeek(
                org_id=org_id,
                employee_id=emp_id,
                week_start=w0,
                other_percent=90,
                confirmed_by_user_id=mgr_uid,
            )
        )
    db.add(
        CapacityWeek(
            org_id=org_id,
            employee_id=e02.id,
            week_start=override_week,
            other_percent=85,
            confirmed_by_user_id=mgr_uid,
        )
    )
    db.add(
        CapacityWeekForecast(
            org_id=org_id,
            employee_id=e02.id,
            week_start=far_week + timedelta(weeks=1),
            forecast_other_percent=55,
            source=ForecastSource.MANAGER_OVERRIDE,
            basis_summary="经理单周修正",
            updated_by_user_id=mgr_uid,
        )
    )
    db.commit()

    p_mgr = make_principal(db, org_id, e01.id)
    p_admin = replace(p_mgr, is_org_admin=True)
    mgr_session = store.create_session(db, p_mgr, channel=channel)
    admin_session = store.create_session(db, p_admin, channel=channel)

    forbidden_payloads: tuple[dict[str, Any], ...] = (
        {"action": "upsert", "department_id": None, "retention_rate": 0.0},
        {
            "action": "upsert",
            "department_id": str(e04.department_id),
            "retention_rate": 0.0,
        },
    )
    for forbidden_args in forbidden_payloads:
        err_cards: list[s.Message] = []
        err = tools.call(
            db,
            p_mgr,
            mgr_session,
            err_cards,
            "coordination",
            {"function": "prepare_forecast_policy", "arguments": forbidden_args},
        )
        assert isinstance(err, dict) and "error" in err
        assert not err_cards

    cards: list[s.Message] = []
    res = tools.call(
        db,
        p_mgr,
        mgr_session,
        cards,
        "coordination",
        {
            "function": "prepare_forecast_policy",
            "arguments": {
                "action": "upsert",
                "department_id": str(dept_id),
                "retention_rate": 0.0,
                "note": "仓储脉冲调整",
            },
        },
    )
    assert isinstance(res, dict) and res["status"] == "pending"
    assert len(cards) == 1
    card = cards[0]
    assert isinstance(card, s.CapacityCard)
    assert card.kind == "forecast_policy"
    assert card.title == "配置负荷预测策略"
    assert "适用范围" in card.content and "周延续系数" in card.content
    assert "脉冲波次型" in card.content
    assert "修改前" in card.content and "修改后" in card.content
    assert "名在职员工" in card.content
    assert "不覆盖已确认排期与经理单周修正" in card.content
    _assert_no_employee_leak(card.model_dump(mode="json"), people)
    assert (
        db.exec(
            select(CapacityForecastPolicy).where(
                CapacityForecastPolicy.org_id == org_id
            )
        ).all()
        == []
    )

    core._save(db, mgr_session, [card])
    db.commit()

    cancelled = core.act(db, p_mgr, mgr_session.id, card.actions[1]).messages[0]
    assert isinstance(cancelled, s.CapacityCard) and cancelled.status == "cancelled"
    assert (
        db.exec(
            select(CapacityForecastPolicy).where(
                CapacityForecastPolicy.org_id == org_id
            )
        ).all()
        == []
    )

    cards2: list[s.Message] = []
    tools.call(
        db,
        p_mgr,
        mgr_session,
        cards2,
        "coordination",
        {
            "function": "prepare_forecast_policy",
            "arguments": {
                "action": "upsert",
                "department_id": str(dept_id),
                "retention_rate": 0.0,
            },
        },
    )
    card2 = cards2[0]
    assert isinstance(card2, s.CapacityCard)
    core._save(db, mgr_session, [card2])
    db.commit()

    confirmed = core.act(db, p_mgr, mgr_session.id, card2.actions[0]).messages[0]
    assert isinstance(confirmed, s.CapacityCard) and confirmed.status == "confirmed"
    assert confirmed.result and "重算" in confirmed.result
    _assert_no_employee_leak(confirmed.result, people)

    saved_policy = db.exec(
        select(CapacityForecastPolicy).where(CapacityForecastPolicy.org_id == org_id)
    ).one()
    assert saved_policy.decay_rate == 1.0
    assert saved_policy.baseline_percent == 0
    assert saved_policy.near_weeks == 0
    assert saved_policy.preset is None

    audit_ev = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == org_id,
            AuditEvent.action == "capacity.forecast_policy_saved",
            AuditEvent.target_id == str(saved_policy.id),
        )
    ).one()
    assert audit_ev.details["via"] == ("feishu" if channel == "feishu" else "bot")
    assert audit_ev.details["client_name"] == channel

    far_fc = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == e02.id,
            CapacityWeekForecast.week_start == far_week,
        )
    ).one()
    assert far_fc.source == ForecastSource.AGENT_AUTO
    assert far_fc.forecast_other_percent == 0

    override_fc = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == e02.id,
            CapacityWeekForecast.week_start == far_week + timedelta(weeks=1),
        )
    ).one()
    assert override_fc.source == ForecastSource.MANAGER_OVERRIDE
    assert override_fc.forecast_other_percent == 55

    confirmed_wk = db.exec(
        select(CapacityWeek).where(
            CapacityWeek.org_id == org_id,
            CapacityWeek.employee_id == e02.id,
            CapacityWeek.week_start == override_week,
        )
    ).one()
    assert confirmed_wk.other_percent == 85

    admin_cards: list[s.Message] = []
    tools.call(
        db,
        p_admin,
        admin_session,
        admin_cards,
        "coordination",
        {
            "function": "prepare_forecast_policy",
            "arguments": {
                "action": "upsert",
                "department_id": None,
                "retention_rate": 0.8,
            },
        },
    )
    admin_card = admin_cards[0]
    assert isinstance(admin_card, s.CapacityCard)
    core._save(db, mgr_session, [admin_card])
    db.commit()
    failed = core.act(db, p_mgr, mgr_session.id, admin_card.actions[0]).messages[0]
    assert isinstance(failed, s.CapacityCard) and failed.status == "failed"

    del_cards: list[s.Message] = []
    tools.call(
        db,
        p_mgr,
        mgr_session,
        del_cards,
        "coordination",
        {
            "function": "prepare_forecast_policy",
            "arguments": {"action": "delete", "policy_id": str(saved_policy.id)},
        },
    )
    del_card = del_cards[0]
    assert isinstance(del_card, s.CapacityCard)
    assert del_card.title == "删除负荷预测策略"
    core._save(db, mgr_session, [del_card])
    db.commit()
    del_confirmed = core.act(db, p_mgr, mgr_session.id, del_card.actions[0]).messages[0]
    assert (
        isinstance(del_confirmed, s.CapacityCard)
        and del_confirmed.status == "confirmed"
    )
    assert (
        db.exec(
            select(CapacityForecastPolicy).where(
                CapacityForecastPolicy.org_id == org_id
            )
        ).all()
        == []
    )


@pytest.mark.parametrize("channel", ["web", "feishu"])
def test_prepare_and_confirm_forecast_event_crud_and_feishu_callback(
    forecast_assistant: DemoTuple,
    db: Session,
    client: TestClient,
    pi_service: PiHarness,
    monkeypatch: pytest.MonkeyPatch,
    channel: Literal["web", "feishu"],
) -> None:
    _, people, _ = forecast_assistant
    enable(client, forecast_assistant)
    e01 = people["E01"]
    e02 = people["E02"]
    e04 = people["E04"]
    org_id = e01.org_id
    w0 = calendar.this_week(db, org_id)
    target_week = w0 + timedelta(weeks=2)
    dept_id = e02.department_id
    assert dept_id is not None

    mgr_uid = user_id(db, e01)
    for emp_id in (e01.id, e02.id):
        db.add(
            CapacityWeek(
                org_id=org_id,
                employee_id=emp_id,
                week_start=w0,
                other_percent=80,
                confirmed_by_user_id=mgr_uid,
            )
        )
    db.commit()

    p_mgr = make_principal(db, org_id, e01.id)
    mgr_session = store.create_session(db, p_mgr, channel=channel)

    for bad_dept in (None, str(e04.department_id)):
        err_cards: list[s.Message] = []
        err = tools.call(
            db,
            p_mgr,
            mgr_session,
            err_cards,
            "coordination",
            {
                "function": "prepare_forecast_event",
                "arguments": {
                    "action": "create",
                    "department_id": bad_dept,
                    "title": "越权事件",
                    "start_week": target_week.isoformat(),
                    "end_week": target_week.isoformat(),
                    "modifier_kind": "multiplier",
                    "modifier_value": 0.4,
                    "reason": "越权测试",
                },
            },
        )
        assert isinstance(err, dict) and "error" in err
        assert not err_cards

    if channel == "feishu":
        enable_bot(db, org_id)
        im_setting = enable_im(db, p_mgr)
        im_setting.platform = "feishu"
        db.add(im_setting)
        db.commit()
        assert im_setting.credentials is not None
        assert binding.bind(
            db,
            org_id,
            "feishu",
            "mgr1",
            "mgr1",
            "12345",
            binding.create_code(db, p_mgr).code,
        )
        monkeypatch.setattr(core, "model_config", lambda _: pi_service.config)
        pi_service.replies = [
            {
                "calls": [
                    {
                        "name": "coordination",
                        "arguments": {
                            "function": "get_forecast_config",
                            "arguments": {},
                        },
                    }
                ]
            },
            {
                "calls": [
                    {
                        "name": "coordination",
                        "arguments": {
                            "function": "prepare_forecast_event",
                            "arguments": {
                                "action": "create",
                                "department_id": str(dept_id),
                                "title": "下周无进货",
                                "start_week": target_week.isoformat(),
                                "end_week": target_week.isoformat(),
                                "modifier_kind": "multiplier",
                                "modifier_value": 0.4,
                                "reason": "供应商停供一周",
                            },
                        },
                    }
                ]
            },
            "已生成业务波动事件确认卡，请确认。",
        ]
        adapter = FakeFeishuAdapter()
        incoming = Event(
            org_id,
            "feishu",
            uuid4().hex,
            "mgr1",
            "mgr1",
            True,
            "下周供应商无进货，按0.4系数下调",
        )
        asyncio.run(
            gateway.Gateway(engine).handle(
                incoming, "12345", im_setting.credentials, adapter
            )
        )
        card_msg = adapter.messages[-1]
        assert "注入业务波动事件" in card_msg["text"]
        assert "×0.4" in card_msg["text"]
        assert "名在职员工" in card_msg["text"]
        _assert_no_employee_leak(card_msg["text"], people)
        assert [label for label, _ in card_msg["buttons"]] == ["确认", "取消"]
        assert (
            db.exec(
                select(CapacityForecastEvent).where(
                    CapacityForecastEvent.org_id == org_id
                )
            ).all()
            == []
        )

        action_rows = db.exec(select(ImAction).where(ImAction.org_id == org_id)).all()
        confirm_row = next(
            r for r in action_rows if r.action["action"] == "confirm_capacity"
        )
        asyncio.run(
            gateway.Gateway(engine).handle(
                button(incoming, confirm_row),
                "12345",
                im_setting.credentials,
                adapter,
            )
        )
        event_row = db.exec(
            select(CapacityForecastEvent).where(CapacityForecastEvent.org_id == org_id)
        ).one()
        assert event_row.title == "下周无进货"
        fc = db.exec(
            select(CapacityWeekForecast).where(
                CapacityWeekForecast.org_id == org_id,
                CapacityWeekForecast.employee_id == e02.id,
                CapacityWeekForecast.week_start == target_week,
            )
        ).one()
        assert fc.forecast_other_percent == 15
        audit_ev = db.exec(
            select(AuditEvent).where(
                AuditEvent.org_id == org_id,
                AuditEvent.action == "capacity.forecast_event_saved",
                AuditEvent.target_id == str(event_row.id),
            )
        ).one()
        assert audit_ev.details["via"] == "feishu"
        assert audit_ev.details["client_name"] == "feishu"
    else:
        cards: list[s.Message] = []
        tools.call(
            db,
            p_mgr,
            mgr_session,
            cards,
            "coordination",
            {
                "function": "prepare_forecast_event",
                "arguments": {
                    "action": "create",
                    "department_id": str(dept_id),
                    "title": "大促备货",
                    "start_week": target_week.isoformat(),
                    "end_week": target_week.isoformat(),
                    "modifier_kind": "delta",
                    "modifier_value": 20,
                    "reason": "大促加量",
                },
            },
        )
        create_card = cards[0]
        assert isinstance(create_card, s.CapacityCard)
        assert create_card.kind == "forecast_event"
        assert create_card.title == "注入业务波动事件"
        assert "+20%" in create_card.content
        _assert_no_employee_leak(create_card.model_dump(mode="json"), people)
        rendered_text, rendered_buttons = rendering.render(create_card)
        assert "+20%" in rendered_text and len(rendered_buttons) == 2

        core._save(db, mgr_session, [create_card])
        db.commit()
        confirmed = core.act(
            db, p_mgr, mgr_session.id, create_card.actions[0]
        ).messages[0]
        assert isinstance(confirmed, s.CapacityCard) and confirmed.status == "confirmed"
        event_row = db.exec(
            select(CapacityForecastEvent).where(CapacityForecastEvent.org_id == org_id)
        ).one()
        fc = db.exec(
            select(CapacityWeekForecast).where(
                CapacityWeekForecast.org_id == org_id,
                CapacityWeekForecast.employee_id == e02.id,
                CapacityWeekForecast.week_start == target_week,
            )
        ).one()
        assert fc.forecast_other_percent == 55

        upd_cards: list[s.Message] = []
        tools.call(
            db,
            p_mgr,
            mgr_session,
            upd_cards,
            "coordination",
            {
                "function": "prepare_forecast_event",
                "arguments": {
                    "action": "update",
                    "event_id": str(event_row.id),
                    "modifier_kind": "multiplier",
                    "modifier_value": 0.5,
                },
            },
        )
        upd_card = upd_cards[0]
        assert (
            isinstance(upd_card, s.CapacityCard)
            and upd_card.title == "修改业务波动事件"
        )
        assert "×0.5" in upd_card.content
        core._save(db, mgr_session, [upd_card])
        db.commit()
        upd_res = core.act(db, p_mgr, mgr_session.id, upd_card.actions[0]).messages[0]
        assert isinstance(upd_res, s.CapacityCard) and upd_res.status == "confirmed"
        fc_upd = db.exec(
            select(CapacityWeekForecast).where(
                CapacityWeekForecast.org_id == org_id,
                CapacityWeekForecast.employee_id == e02.id,
                CapacityWeekForecast.week_start == target_week,
            )
        ).one()
        assert fc_upd.forecast_other_percent == 15

        del_cards: list[s.Message] = []
        tools.call(
            db,
            p_mgr,
            mgr_session,
            del_cards,
            "coordination",
            {
                "function": "prepare_forecast_event",
                "arguments": {
                    "action": "delete",
                    "event_id": str(event_row.id),
                },
            },
        )
        del_card = del_cards[0]
        assert (
            isinstance(del_card, s.CapacityCard)
            and del_card.title == "删除业务波动事件"
        )
        core._save(db, mgr_session, [del_card])
        db.commit()
        del_res = core.act(db, p_mgr, mgr_session.id, del_card.actions[0]).messages[0]
        assert isinstance(del_res, s.CapacityCard) and del_res.status == "confirmed"
        assert (
            db.exec(
                select(CapacityForecastEvent).where(
                    CapacityForecastEvent.org_id == org_id
                )
            ).all()
            == []
        )
        audit_del = db.exec(
            select(AuditEvent).where(
                AuditEvent.org_id == org_id,
                AuditEvent.action == "capacity.forecast_event_deleted",
                AuditEvent.target_id == str(event_row.id),
            )
        ).one()
        assert audit_del.details["via"] == "bot"
        assert audit_del.details["client_name"] == "web"
