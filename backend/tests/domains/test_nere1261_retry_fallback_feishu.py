import asyncio
import json
import logging
from uuid import uuid4

import httpx
import pytest
from sqlmodel import Session, select

from app.core.db import engine
from app.core.secrets import encrypt_secret
from app.domains.bot import core, store
from app.domains.bot import schemas as s
from app.domains.capacity.models import CapacitySetting, RequesterPolicy
from app.domains.change_request import employee
from app.domains.change_request.models import ProfileChangeRequest
from app.domains.change_request.schemas import ItemInput
from app.domains.im import actions, binding, gateway
from app.domains.im.adapters import feishu
from app.domains.im.adapters.feishu import Feishu
from app.domains.im.models import ImAction, ImSetting
from app.domains.model import pi_client
from app.domains.model.client import (
    ModelAuthenticationError,
    ModelRateLimited,
    ModelServiceError,
    ModelUnavailable,
)
from app.domains.model.pi_client import PiModelConfig, ToolDefinition, run_turn
from tests.api.routes.test_employee_requests import payload
from tests.api.routes.test_reviews import manager
from tests.domains.test_bot_core import enable as enable_model
from tests.domains.test_bot_reviews import prepared as prepared_review
from tests.domains.test_bot_team import prepared as prepared_edit
from tests.domains.test_im_gateway import principal
from tests.utils.pi import PiHarness

pytestmark = pytest.mark.usefixtures("reset_login_attempts")

CREDS = {"app_id": "synthetic-app", "app_secret": "synthetic-secret"}


def _config() -> PiModelConfig:
    return PiModelConfig(
        provider="openai",
        api="openai-completions",
        id="gpt-4o-mini",
        baseUrl="https://api.openai.com/v1",
    )


def _feishu_service(monkeypatch: pytest.MonkeyPatch) -> dict:
    state: dict = {"mode": "p2p", "requests": [], "status": 200, "code": 0}

    def respond(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        state["requests"].append((request.method, request.url.path, body))
        if "/auth/" in request.url.path:
            data: dict = {"tenant_access_token": "private-token", "expire": 7200}
        elif "/chats/" in request.url.path:
            data = {"data": {"chat_mode": state["mode"]}}
        elif request.method == "PATCH":
            data = {"data": {}}
        else:
            data = {"data": {"message_id": f"om_{len(state['requests'])}"}}
        return httpx.Response(
            state["status"],
            json={"code": state["code"], "msg": "ok", **data},
        )

    original = httpx.AsyncClient.__init__

    def client(instance: httpx.AsyncClient, **kwargs: object) -> None:
        original(instance, **kwargs, transport=httpx.MockTransport(respond))

    monkeypatch.setattr(feishu.httpx.AsyncClient, "__init__", client)
    return state


def _setup_feishu(db: Session, demo: tuple, emp_key: str = "E02") -> tuple:
    person = demo[1][emp_key]
    p = principal(db, person.org_id, person.id)
    setting = ImSetting(
        org_id=p.org_id,
        platform="feishu",
        enabled=True,
        credentials=encrypt_secret(json.dumps(CREDS)),
        bot_identity=CREDS["app_id"],
        updated_by_user_id=p.user_id,
    )
    db.add(setting)
    db.commit()
    assert binding.bind(
        db,
        p.org_id,
        "feishu",
        "ou_test",
        "oc_test",
        CREDS["app_id"],
        binding.create_code(db, p).code,
    )
    enable_model(db, p.org_id)
    return p, setting


def _enable_capacity(db: Session, p) -> None:
    row = db.exec(
        select(CapacitySetting).where(CapacitySetting.org_id == p.org_id)
    ).one_or_none()
    if row is None:
        row = CapacitySetting(
            org_id=p.org_id,
            enabled=True,
            requester_policy=RequesterPolicy.EVERYONE,
            updated_by_user_id=p.user_id,
        )
    else:
        row.enabled = True
        row.requester_policy = RequesterPolicy.EVERYONE
    db.add(row)
    db.commit()


# --- B item: Retry tests ---


@pytest.mark.parametrize(
    "failure_mode",
    ["upstream_unavailable", "busy", "model_error", "connect_error", "timeout"],
)
def test_run_turn_retries_transient_failures_up_to_three_attempts(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    failure_mode: str,
) -> None:
    monkeypatch.setattr(pi_client, "RETRY_DELAYS", (0.0, 0.0), raising=False)
    calls = 0
    real = httpx.Client

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls < 3:
            if failure_mode == "connect_error":
                raise httpx.ConnectError("transient connect drop")
            if failure_mode == "timeout":
                raise httpx.ReadTimeout("transient timeout")
            if failure_mode == "busy":
                return httpx.Response(503, json={"type": "error", "code": "busy"})
            return httpx.Response(
                200,
                text=json.dumps({"type": "error", "code": failure_mode}) + "\n",
            )
        return httpx.Response(
            200,
            text=json.dumps(
                {
                    "type": "done",
                    "stopReason": "stop",
                    "model_calls": 1,
                    "tool_calls": 0,
                    "session_state": {"version": 1, "messages": []},
                }
            )
            + "\n",
        )

    monkeypatch.setattr(
        pi_client.httpx,
        "Client",
        lambda **kwargs: real(**kwargs, transport=httpx.MockTransport(handler)),
    )
    caplog.set_level(logging.WARNING)
    result = run_turn(
        _config(),
        mode="chat",
        system_prompt="secret-system",
        input="secret-user-input",
        tools=[],
        on_tool_call=lambda *_: None,
    )
    assert result.stop_reason == "stop"
    assert calls == 3
    assert "secret-system" not in caplog.text
    assert "secret-user-input" not in caplog.text


def test_run_turn_fails_after_three_attempts_and_logs_sanitized_metadata(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(pi_client, "RETRY_DELAYS", (0.0, 0.0), raising=False)
    calls = 0
    real = httpx.Client

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            text=json.dumps({"type": "error", "code": "upstream_unavailable"}) + "\n",
        )

    monkeypatch.setattr(
        pi_client.httpx,
        "Client",
        lambda **kwargs: real(**kwargs, transport=httpx.MockTransport(handler)),
    )
    caplog.set_level(logging.WARNING)
    with pytest.raises(ModelServiceError) as exc:
        run_turn(
            _config(),
            mode="chat",
            system_prompt="secret-prompt",
            input="secret-chat",
            tools=[],
            on_tool_call=lambda *_: None,
        )
    assert exc.value.code == "upstream_unavailable"
    assert calls == 3
    assert getattr(exc.value, "attempts", None) == 3
    assert "attempts=3" in caplog.text
    assert "upstream_unavailable" in caplog.text
    assert "secret-prompt" not in caplog.text
    assert "secret-chat" not in caplog.text


@pytest.mark.parametrize(
    "code,exc_type",
    [
        ("model_unauthorized", ModelAuthenticationError),
        ("model_forbidden", ModelUnavailable),
        ("model_not_found", ModelServiceError),
        ("upstream_rejected", ModelServiceError),
        ("rate_limited", ModelRateLimited),
        ("local_auth_unavailable", ModelUnavailable),
        ("bad_request", pi_client.PiSessionInvalid),
    ],
)
def test_run_turn_does_not_retry_non_retryable_errors(
    monkeypatch: pytest.MonkeyPatch,
    code: str,
    exc_type: type[Exception],
) -> None:
    monkeypatch.setattr(pi_client, "RETRY_DELAYS", (0.0, 0.0), raising=False)
    calls = 0
    real = httpx.Client

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if code == "bad_request":
            return httpx.Response(400, json={"type": "error", "code": "bad_request"})
        payload_err: dict[str, object] = {"type": "error", "code": code}
        if code == "rate_limited":
            payload_err["retry_at"] = "2026-11-23T12:00:00+00:00"
        return httpx.Response(200, text=json.dumps(payload_err) + "\n")

    monkeypatch.setattr(
        pi_client.httpx,
        "Client",
        lambda **kwargs: real(**kwargs, transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(exc_type):
        run_turn(
            _config(),
            mode="chat",
            system_prompt="",
            input="",
            tools=[],
            on_tool_call=lambda *_: None,
        )
    assert calls == 1


def test_run_turn_does_not_retry_after_streamed_text_or_tool_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(pi_client, "RETRY_DELAYS", (0.0, 0.0), raising=False)
    real = httpx.Client

    # 1. Partial text streamed -> must NOT retry
    text_calls = 0
    emitted: list[str] = []

    def text_handler(_request: httpx.Request) -> httpx.Response:
        nonlocal text_calls
        text_calls += 1
        return httpx.Response(
            200,
            text=(
                json.dumps({"type": "text", "text": "半句输出"})
                + "\n"
                + json.dumps({"type": "error", "code": "model_error"})
                + "\n"
            ),
        )

    monkeypatch.setattr(
        pi_client.httpx,
        "Client",
        lambda **kwargs: real(**kwargs, transport=httpx.MockTransport(text_handler)),
    )
    stream = pi_client.TurnStream(
        run_id=str(uuid4()),
        on_text=emitted.append,
        on_tool=lambda *_: None,
        cancelled=__import__("threading").Event(),
    )
    with pytest.raises(ModelUnavailable):
        run_turn(
            _config(),
            mode="chat",
            system_prompt="",
            input="",
            tools=[],
            on_tool_call=lambda *_: None,
            stream=stream,
        )
    assert text_calls == 1
    assert emitted == ["半句输出"]

    # 2. Tool call already invoked -> must NOT retry
    tool_calls = 0
    invoked: list[str] = []

    def tool_handler(request: httpx.Request) -> httpx.Response:
        nonlocal tool_calls
        if request.url.path == "/v1/turns":
            tool_calls += 1
            return httpx.Response(
                200,
                text=(
                    json.dumps(
                        {
                            "type": "tool_call",
                            "call_id": "c1",
                            "name": "draft_update_request",
                            "arguments": {},
                        }
                    )
                    + "\n"
                    + json.dumps({"type": "error", "code": "upstream_unavailable"})
                    + "\n"
                ),
            )
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(
        pi_client.httpx,
        "Client",
        lambda **kwargs: real(**kwargs, transport=httpx.MockTransport(tool_handler)),
    )
    with pytest.raises(ModelServiceError):
        run_turn(
            _config(),
            mode="chat",
            system_prompt="",
            input="",
            tools=[
                ToolDefinition(
                    name="draft_update_request",
                    description="d",
                    parameters={"type": "object", "properties": {}},
                )
            ],
            on_tool_call=lambda name, _args: invoked.append(name) or {"ok": True},
        )
    assert tool_calls == 1
    assert invoked == ["draft_update_request"]


# --- B item: Intent-matched fallback tests ---


def test_intent_matched_fallback_across_web_and_feishu(
    demo: tuple,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    p, setting = _setup_feishu(db, demo, "E02")
    _enable_capacity(db, p)
    try:
        mgr = manager(db, demo)
        _feishu_service(monkeypatch)

        def fail(*_args: object, **_kwargs: object) -> None:
            raise ModelUnavailable(code="model_error")

        monkeypatch.setattr(pi_client, "run_turn", fail)

        # 1. Employee asks to add backend capability -> profile link ONLY, never /capacity?tab=outgoing
        session = store.create_session(db, p, "web")
        profile_resp = core.turn(
            db, p, session.id, "我希望给自己添加后端能力，能完成常规任务"
        )
        profile_msg = profile_resp.messages[0]
        assert f"/employees/{p.employee_id}" in profile_msg.text
        assert "我的画像" in profile_msg.text
        assert "/capacity" not in profile_msg.text
        assert profile_msg.capacity_links == []

        # Verify same on Feishu IM
        g = gateway.Gateway(engine)
        feishu_event = feishu.Event(
            p.org_id,
            "feishu",
            uuid4().hex,
            "ou_test",
            "oc_test",
            True,
            "我希望给自己添加后端能力，能完成常规任务",
        )
        im_reply = g.dispatch(feishu_event, CREDS["app_id"], setting.credentials)
        assert isinstance(im_reply, actions.Reply)
        im_text = im_reply.response.messages[0].text
        assert f"/employees/{p.employee_id}" in im_text
        assert "/capacity" not in im_text

        # 2. Manager asks about pending reviews -> /reviews
        mgr_session = store.create_session(db, mgr, "web")
        review_resp = core.turn(db, mgr, mgr_session.id, "帮我看看待审批请求")
        assert "/reviews" in review_resp.messages[0].text
        assert "/capacity" not in review_resp.messages[0].text

        # 3. Employee asks about workload / leave -> /capacity?tab=mine
        load_resp = core.turn(db, p, session.id, "我要请假两天，顺便看下我的负荷")
        assert "/capacity?tab=mine" in load_resp.messages[0].text
        assert "/capacity?tab=outgoing" not in load_resp.messages[0].text

        # 4. Manager asks about team workload -> /capacity?tab=team
        team_load_resp = core.turn(db, mgr, mgr_session.id, "查看团队负荷")
        assert "/capacity?tab=team" in team_load_resp.messages[0].text

        # 5. Demand / collaboration intent -> capacity links
        demand_resp = core.turn(db, p, session.id, "帮我发起一个跨部门协作需求")
        assert "/capacity?tab=outgoing" in demand_resp.messages[0].text

        plan_resp = core.turn(db, mgr, mgr_session.id, "再帮我模拟方案")
        assert [link.href for link in plan_resp.messages[0].capacity_links] == [
            "/reviews?type=demand"
        ]
        employee_plan_resp = core.turn(db, p, session.id, "再帮我模拟方案")
        assert employee_plan_resp.messages[0].capacity_links == []

        # 6. Unclassified chitchat -> NO links at all
        chat_resp = core.turn(db, p, session.id, "你好，今天天气不错")
        assert chat_resp.messages[0].text == "模型服务暂时不可用，请稍后再试"
        assert chat_resp.messages[0].capacity_links == []
        assert chat_resp.messages[0].review_link is None
    finally:
        db.rollback()
        row = db.exec(
            select(CapacitySetting).where(CapacitySetting.org_id == p.org_id)
        ).one_or_none()
        if row is not None:
            db.delete(row)
            db.commit()


# --- D item: Feishu continue_editing / continue_profile_edit / continue_review ---


def test_feishu_continue_editing_consumed_and_optional_fields(
    demo: tuple,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    p, setting = _setup_feishu(db, demo, "E02")
    state = _feishu_service(monkeypatch)

    draft = employee.save_draft(
        p,
        db,
        None,
        [ItemInput(**payload("automated_testing", statement="熟悉自动化测试"))],
        "bot",
    )
    db.commit()

    def respond(*_args: object, **_kwargs: object) -> pi_client.TurnResult:
        kwargs = _kwargs
        kwargs["on_tool_call"]("preview_request", {"request_id": str(draft.id)})
        return pi_client.TurnResult(
            text="请核对后确认", stop_reason="stop", model_calls=1, tool_calls=1
        )

    monkeypatch.setattr(pi_client, "run_turn", respond)

    async def run() -> None:
        adapter = Feishu(p.org_id, CREDS)
        g = gateway.Gateway(engine)
        try:
            incoming_msg = await adapter._event(
                json.dumps(
                    {
                        "header": {
                            "event_id": uuid4().hex,
                            "event_type": "im.message.receive_v1",
                        },
                        "event": {
                            "sender": {
                                "sender_type": "user",
                                "sender_id": {"open_id": "ou_test"},
                            },
                            "message": {
                                "chat_id": "oc_test",
                                "chat_type": "p2p",
                                "message_type": "text",
                                "content": json.dumps({"text": "预览我的草稿"}),
                            },
                        },
                    }
                )
            )
            assert incoming_msg
            await g.handle(incoming_msg, CREDS["app_id"], setting.credentials, adapter)

            cont_row = db.exec(
                select(ImAction).where(
                    ImAction.org_id == p.org_id,
                    ImAction.action["action"].astext == "continue_editing",
                )
            ).one()
            confirm_row = db.exec(
                select(ImAction).where(
                    ImAction.org_id == p.org_id,
                    ImAction.action["action"].astext == "confirm_submit",
                )
            ).one()

            # Simulate legacy/serialized action missing optional base_revision/policy_version
            stripped = dict(cont_row.action)
            stripped.pop("base_revision", None)
            stripped.pop("policy_version", None)
            cont_row.action = stripped
            db.add(cont_row)
            db.commit()

            # Also simulate Feishu delivering action.value as JSON string in card.action.trigger
            trigger = {
                "schema": "2.0",
                "header": {
                    "event_id": uuid4().hex,
                    "event_type": "card.action.trigger",
                },
                "event": {
                    "operator": {"open_id": "ou_test"},
                    "action": {"value": json.dumps({"token": cont_row.token})},
                    "context": {
                        "open_message_id": cont_row.message_id,
                        "open_chat_id": cont_row.external_chat_id,
                    },
                },
            }
            cb = await adapter._event(json.dumps(trigger))
            assert cb is not None and cb.token == cont_row.token
            await g.handle(cb, CREDS["app_id"], setting.credentials, adapter)

            db.refresh(cont_row)
            db.refresh(confirm_row)
            assert cont_row.consumed_at is not None
            assert any(
                method == "PATCH" and cont_row.message_id in path
                for method, path, _ in state["requests"]
            )
            last_post = [
                body
                for method, path, body in state["requests"]
                if method == "POST" and "/messages" in path
            ][-1]
            assert "请告诉我需要修改的内容" in last_post["content"]

            # Clicking sibling confirm_submit on the already-handled card must NOT submit
            sibling_cb = await adapter._event(
                json.dumps(
                    {
                        "header": {
                            "event_id": uuid4().hex,
                            "event_type": "card.action.trigger",
                        },
                        "event": {
                            "operator": {"open_id": "ou_test"},
                            "action": {"value": {"token": confirm_row.token}},
                            "context": {
                                "open_message_id": confirm_row.message_id,
                                "open_chat_id": confirm_row.external_chat_id,
                            },
                        },
                    }
                )
            )
            assert sibling_cb
            await g.handle(sibling_cb, CREDS["app_id"], setting.credentials, adapter)
            req = db.get(ProfileChangeRequest, draft.id)
            assert req is not None and req.status == "draft"
        finally:
            await adapter.close()

    asyncio.run(run())


def test_feishu_continue_after_confirm_submit_does_not_fail_with_conflict(
    demo: tuple,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    p, setting = _setup_feishu(db, demo, "E02")
    state = _feishu_service(monkeypatch)
    draft = employee.save_draft(
        p,
        db,
        None,
        [ItemInput(**payload("automated_testing", statement="熟悉自动化测试"))],
        "bot",
    )
    session = store.create_session(db, p, "feishu", "oc_test", CREDS["app_id"])
    card = s.PreviewCard(
        **employee.preview(p, db, draft.id).model_dump(),
        actions=[
            s.RequestAction(
                action=a,
                request_id=draft.id,
                revision=draft.revision,
                base_revision=None,
                policy_version=0 if a == "confirm_submit" else None,
            )
            for a in ("confirm_submit", "continue_editing")
        ],
    )
    core._save(db, session, [card])
    db.commit()

    async def run() -> None:
        adapter = Feishu(p.org_id, CREDS)
        g = gateway.Gateway(engine)
        try:
            incoming = actions.Event(
                p.org_id, "feishu", uuid4().hex, "ou_test", "oc_test", True, "预览"
            )
            await actions.deliver(
                db,
                p,
                incoming,
                CREDS["app_id"],
                actions.Reply(session.id, s.TurnResponse(messages=[card])),
                adapter,
            )
            confirm_row = db.exec(
                select(ImAction).where(
                    ImAction.org_id == p.org_id,
                    ImAction.action["action"].astext == "confirm_submit",
                )
            ).one()
            cont_row = db.exec(
                select(ImAction).where(
                    ImAction.org_id == p.org_id,
                    ImAction.action["action"].astext == "continue_editing",
                )
            ).one()
            cb1 = await adapter._event(
                json.dumps(
                    {
                        "header": {
                            "event_id": uuid4().hex,
                            "event_type": "card.action.trigger",
                        },
                        "event": {
                            "operator": {"open_id": "ou_test"},
                            "action": {"value": {"token": confirm_row.token}},
                            "context": {
                                "open_message_id": confirm_row.message_id,
                                "open_chat_id": "oc_test",
                            },
                        },
                    }
                )
            )
            assert cb1
            await g.handle(cb1, CREDS["app_id"], setting.credentials, adapter)
            cb2 = await adapter._event(
                json.dumps(
                    {
                        "header": {
                            "event_id": uuid4().hex,
                            "event_type": "card.action.trigger",
                        },
                        "event": {
                            "operator": {"open_id": "ou_test"},
                            "action": {"value": {"token": cont_row.token}},
                            "context": {
                                "open_message_id": cont_row.message_id,
                                "open_chat_id": "oc_test",
                            },
                        },
                    }
                )
            )
            assert cb2
            await g.handle(cb2, CREDS["app_id"], setting.credentials, adapter)
            sent_bodies = [
                body.get("content", "")
                for method, path, body in state["requests"]
                if method == "POST" and "/messages" in path and body
            ]
            assert not any("操作未完成，请重新查看后再试。" in c for c in sent_bodies)
            assert any("已处理" in c for c in sent_bodies)
        finally:
            await adapter.close()

    asyncio.run(run())


def test_feishu_continue_profile_edit_and_continue_review(
    demo: tuple,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _feishu_service(monkeypatch)
    _, mgr_p, edit_session, edit_card, _ = prepared_edit(db, demo, "feishu")
    setting = ImSetting(
        org_id=mgr_p.org_id,
        platform="feishu",
        enabled=True,
        credentials=encrypt_secret(json.dumps(CREDS)),
        bot_identity=CREDS["app_id"],
        updated_by_user_id=mgr_p.user_id,
    )
    db.add(setting)
    edit_session.external_chat_id = "oc_mgr"
    edit_session.bot_identity = CREDS["app_id"]
    db.add(edit_session)
    core._save(db, edit_session, [edit_card])
    db.commit()
    assert binding.bind(
        db,
        mgr_p.org_id,
        "feishu",
        "ou_mgr",
        "oc_mgr",
        CREDS["app_id"],
        binding.create_code(db, mgr_p).code,
    )

    _, _, rev_p, rev_session, rev_card, _ = prepared_review(db, demo)
    rev_session.channel = "feishu"
    rev_session.external_chat_id = "oc_mgr"
    rev_session.bot_identity = CREDS["app_id"]
    db.add(rev_session)
    core._save(db, rev_session, [rev_card])
    db.commit()

    async def run() -> None:
        adapter = Feishu(mgr_p.org_id, CREDS)
        g = gateway.Gateway(engine)
        try:
            incoming = actions.Event(
                mgr_p.org_id, "feishu", uuid4().hex, "ou_mgr", "oc_mgr", True, "修改"
            )
            await actions.deliver(
                db,
                mgr_p,
                incoming,
                CREDS["app_id"],
                actions.Reply(edit_session.id, s.TurnResponse(messages=[edit_card])),
                adapter,
            )
            cont_edit = db.exec(
                select(ImAction).where(
                    ImAction.org_id == mgr_p.org_id,
                    ImAction.action["action"].astext == "continue_profile_edit",
                )
            ).one()
            cb_edit = await adapter._event(
                json.dumps(
                    {
                        "header": {
                            "event_id": uuid4().hex,
                            "event_type": "card.action.trigger",
                        },
                        "event": {
                            "operator": {"open_id": "ou_mgr"},
                            "action": {"value": {"token": cont_edit.token}},
                            "context": {
                                "open_message_id": cont_edit.message_id,
                                "open_chat_id": "oc_mgr",
                            },
                        },
                    }
                )
            )
            assert cb_edit
            await g.handle(cb_edit, CREDS["app_id"], setting.credentials, adapter)
            db.refresh(cont_edit)
            assert cont_edit.consumed_at is not None

            await actions.deliver(
                db,
                rev_p,
                incoming,
                CREDS["app_id"],
                actions.Reply(rev_session.id, s.TurnResponse(messages=[rev_card])),
                adapter,
            )
            cont_rev = db.exec(
                select(ImAction).where(
                    ImAction.org_id == rev_p.org_id,
                    ImAction.action["action"].astext == "continue_review",
                )
            ).one()
            cb_rev = await adapter._event(
                json.dumps(
                    {
                        "header": {
                            "event_id": uuid4().hex,
                            "event_type": "card.action.trigger",
                        },
                        "event": {
                            "operator": {"open_id": "ou_mgr"},
                            "action": {"value": {"token": cont_rev.token}},
                            "context": {
                                "open_message_id": cont_rev.message_id,
                                "open_chat_id": "oc_mgr",
                            },
                        },
                    }
                )
            )
            assert cb_rev
            await g.handle(cb_rev, CREDS["app_id"], setting.credentials, adapter)
            db.refresh(cont_rev)
            assert cont_rev.consumed_at is not None
        finally:
            await adapter.close()

    asyncio.run(run())


def test_pi_harness_retries_three_attempts_without_multiplying(
    pi_service: PiHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(pi_client, "RETRY_DELAYS", (0.0, 0.0))
    pi_service.replies = [{"status": 500}, {"status": 503}, "终于成功"]
    result = run_turn(
        pi_service.config,
        mode="chat",
        system_prompt="secret-system",
        input="secret-input",
        tools=[],
        on_tool_call=lambda *_: None,
    )
    assert result.text == "终于成功"
    assert len(pi_service.requests) == 3
    logs = pi_service.logs.read_text()
    assert '"upstream_status":500' in logs
    assert '"upstream_status":503' in logs
    assert "secret-system" not in logs and "secret-input" not in logs


def test_feishu_event_logs_sanitized_drop_reason_and_followup_turn(
    demo: tuple,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    p, setting = _setup_feishu(db, demo, "E02")
    _feishu_service(monkeypatch)
    draft = employee.save_draft(
        p,
        db,
        None,
        [ItemInput(**payload("automated_testing", statement="熟悉自动化测试"))],
        "bot",
    )
    session = store.create_session(db, p, "feishu", "oc_test", CREDS["app_id"])
    card = s.PreviewCard(
        **employee.preview(p, db, draft.id).model_dump(),
        actions=[
            s.RequestAction(
                action=a,
                request_id=draft.id,
                revision=draft.revision,
                base_revision=None,
                policy_version=0 if a == "confirm_submit" else None,
            )
            for a in ("confirm_submit", "continue_editing")
        ],
    )
    core._save(db, session, [card])
    db.commit()
    caplog.set_level(logging.WARNING)

    async def run() -> None:
        adapter = Feishu(p.org_id, CREDS)
        g = gateway.Gateway(engine)
        try:
            # Malformed trigger logs sanitized metadata instead of silently dropping
            dropped = await adapter._event(
                json.dumps(
                    {
                        "header": {
                            "event_id": uuid4().hex,
                            "event_type": "card.action.trigger",
                        },
                        "event": {"action": {"value": "secret-token-value"}},
                    }
                )
            )
            assert dropped is None
            assert "card.action.trigger" in caplog.text
            assert "secret-token-value" not in caplog.text

            incoming = actions.Event(
                p.org_id, "feishu", uuid4().hex, "ou_test", "oc_test", True, "预览"
            )
            await actions.deliver(
                db,
                p,
                incoming,
                CREDS["app_id"],
                actions.Reply(session.id, s.TurnResponse(messages=[card])),
                adapter,
            )
            cont_row = db.exec(
                select(ImAction).where(
                    ImAction.org_id == p.org_id,
                    ImAction.action["action"].astext == "continue_editing",
                )
            ).one()
            cb = await adapter._event(
                json.dumps(
                    {
                        "header": {
                            "event_id": uuid4().hex,
                            "event_type": "card.action.trigger",
                        },
                        "event": {
                            "operator": {"open_id": "ou_test"},
                            "action": {"value": {"token": cont_row.token}},
                            "context": {
                                "open_message_id": cont_row.message_id,
                                "open_chat_id": "oc_test",
                            },
                        },
                    }
                )
            )
            assert cb
            await g.handle(cb, CREDS["app_id"], setting.credentials, adapter)
            db.refresh(cont_row)
            assert cont_row.consumed_at is not None

            # User can continue the conversation in the same session
            monkeypatch.setattr(
                pi_client,
                "run_turn",
                lambda *_a, **_k: pi_client.TurnResult(
                    text="已按新要求修改",
                    stop_reason="stop",
                    model_calls=1,
                    tool_calls=0,
                ),
            )
            followup = await adapter._event(
                json.dumps(
                    {
                        "header": {
                            "event_id": uuid4().hex,
                            "event_type": "im.message.receive_v1",
                        },
                        "event": {
                            "sender": {
                                "sender_type": "user",
                                "sender_id": {"open_id": "ou_test"},
                            },
                            "message": {
                                "chat_id": "oc_test",
                                "chat_type": "p2p",
                                "message_type": "text",
                                "content": json.dumps({"text": "改成精通级别"}),
                            },
                        },
                    }
                )
            )
            assert followup
            reply = g.dispatch(followup, CREDS["app_id"], setting.credentials)
            assert isinstance(reply, actions.Reply)
            assert reply.response.messages[0].text == "已按新要求修改"
        finally:
            await adapter.close()

    asyncio.run(run())
