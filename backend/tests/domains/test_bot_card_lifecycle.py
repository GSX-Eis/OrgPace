import json
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.domains.bot import core, store, tools
from app.domains.bot import schemas as s
from app.domains.change_request import employee
from app.domains.change_request.schemas import ItemInput
from app.domains.im import actions, rendering
from app.domains.im.adapters.base import Event
from app.domains.model.pi_client import TurnResult
from tests.api.routes.test_employee_requests import payload, principal_for
from tests.domains.test_bot_core import enable as enable_model
from tests.domains.test_bot_reviews import prepared


def test_unchanged_modify_item_blocked_on_api_and_bot(
    demo: tuple, db: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    url, people, auth = demo
    p = principal_for(db, people["E02"].org_id)
    enable_model(db, p.org_id)
    current_item = next(i for i in employee.my_profile(p, db).items if i.claim)
    assert current_item.claim is not None
    unchanged = {
        "op": "modify",
        "capability_key": current_item.capability.key,
        "statement": current_item.claim.statement,
        "level": current_item.claim.level,
    }
    api_resp = client.post(
        f"{url}/me/requests",
        headers=auth["employee"],
        json={"items": [unchanged]},
    )
    assert api_resp.status_code == 422

    session = store.create_session(db, p, "web")
    tool_results: list[dict] = []

    def respond_all_unchanged(*_args: object, **kwargs: object) -> TurnResult:
        tool_results.append(
            kwargs["on_tool_call"]("draft_update_request", {"items": [unchanged]})
        )
        return TurnResult(
            text="无改动", stop_reason="stop", model_calls=1, tool_calls=1
        )

    monkeypatch.setattr(core.pi_client, "run_turn", respond_all_unchanged)
    resp_empty = core.turn(db, p, session.id, "帮我看看")
    assert not any(isinstance(m, s.PreviewCard) for m in resp_empty.messages)
    assert "error" in tool_results[0]

    changed = payload(
        "automated_testing"
        if current_item.capability.key != "automated_testing"
        else "frontend_ui",
        statement="本次真正修改后的陈述",
    )

    def respond_mixed(*_args: object, **kwargs: object) -> TurnResult:
        kwargs["on_tool_call"]("draft_update_request", {"items": [changed, unchanged]})
        return TurnResult(
            text="请核对", stop_reason="stop", model_calls=1, tool_calls=1
        )

    monkeypatch.setattr(core.pi_client, "run_turn", respond_mixed)
    resp_mixed = core.turn(db, p, session.id, "只改这一项")
    previews = [m for m in resp_mixed.messages if isinstance(m, s.PreviewCard)]
    assert len(previews) == 1
    assert [i.after.capability.key for i in previews[0].items] == [
        changed["capability_key"]
    ]


@pytest.mark.parametrize("channel", ["web", "feishu"])
def test_single_preview_card_per_turn_even_with_existing_draft_or_two_calls(
    demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch, channel: str
) -> None:
    p = principal_for(db, demo[1]["E02"].org_id)
    enable_model(db, p.org_id)
    old_draft = employee.save_draft(
        p,
        db,
        None,
        [ItemInput(**payload("frontend_ui", statement="旧草稿内容"))],
        "bot",
    )
    db.commit()

    def respond(*_args: object, **kwargs: object) -> TurnResult:
        call = kwargs["on_tool_call"]
        call("get_my_requests", {})
        call(
            "draft_update_request",
            {"items": [payload("automated_testing", statement="第一次修改")]},
        )
        call(
            "draft_update_request",
            {"items": [payload("incident_support", statement="第二次补充")]},
        )
        return TurnResult(
            text="请确认预览", stop_reason="stop", model_calls=1, tool_calls=3
        )

    monkeypatch.setattr(core.pi_client, "run_turn", respond)
    if channel == "web":
        session = store.create_session(db, p, "web")
        response = core.turn(db, p, session.id, "更新两项能力")
    else:
        incoming = Event(
            platform="feishu",
            org_id=p.org_id,
            event_id="single-preview-feishu",
            external_user_id="synthetic-user",
            external_chat_id="synthetic-chat",
            text="更新两项能力",
        )
        response = actions.text(db, p, incoming, "synthetic-app").response
    previews = [m for m in response.messages if isinstance(m, s.PreviewCard)]
    assert len(previews) == 1
    assert previews[0].request_id != old_draft.id
    assert {i.after.capability.key for i in previews[0].items} == {
        "automated_testing",
        "incident_support",
    }
    if channel == "feishu":
        rendered = [rendering.render(m)[0] for m in response.messages]
        assert sum(text.startswith("改动预览") for text in rendered) == 1


def test_review_card_persists_confirmed_state_across_reload(
    demo: tuple, db: Session, client: TestClient
) -> None:
    _, request, p, session, card, _ = prepared(db, demo)
    session.channel = "web"
    db.add(session)
    core._save(db, session, [card])
    db.commit()
    url = f"/api/v1/bot/sessions/{session.id}"
    query = {"org_id": str(p.org_id)}
    confirm = client.post(
        f"{url}/actions",
        params=query,
        headers=demo[2]["manager"],
        json=card.actions[0].model_dump(mode="json"),
    )
    assert confirm.status_code == 200, confirm.text
    history = client.get(
        f"{url}/messages", params=query, headers=demo[2]["manager"]
    ).json()
    reloaded_card = next(
        m
        for entry in history
        if "messages" in entry["payload"]
        for m in entry["payload"]["messages"]
        if m["type"] == "review_card" and UUID(m["id"]) == request.id
    )
    assert reloaded_card["actions"] == []
    assert reloaded_card["status"] == "confirmed"
    assert "审批决定已保存" in (reloaded_card.get("result") or "")
    assert "confirm_review" not in json.dumps(reloaded_card)


def test_review_card_becomes_stale_if_request_updated_and_profile_edit_persists(
    demo: tuple, db: Session, client: TestClient
) -> None:
    owner, request, p, session, card, _ = prepared(db, demo)
    session.channel = "web"
    db.add(session)
    core._save(db, session, [card])
    db.commit()
    employee.withdraw(owner, db, request.id)
    db.commit()
    url = f"/api/v1/bot/sessions/{session.id}"
    query = {"org_id": str(p.org_id)}
    history = client.get(
        f"{url}/messages", params=query, headers=demo[2]["manager"]
    ).json()
    stale_card = next(
        m
        for entry in history
        if "messages" in entry["payload"]
        for m in entry["payload"]["messages"]
        if m["type"] == "review_card" and UUID(m["id"]) == request.id
    )
    assert stale_card["actions"] == []
    assert stale_card["status"] == "stale"

    edit_session = store.create_session(db, p, "web")
    member_profile = tools.call(
        db,
        p,
        edit_session,
        [],
        "get_member_profile",
        {"employee_id": str(demo[1]["E02"].id)},
    )
    edit_cards: list[s.Message] = []
    tools.call(
        db,
        p,
        edit_session,
        edit_cards,
        "prepare_profile_edit",
        {
            "employee_id": str(demo[1]["E02"].id),
            "base_revision": member_profile["revision"],
            "items": [
                {
                    "op": "modify",
                    "capability_key": "backend_api",
                    "statement": "经理直接修改后的陈述",
                    "level": "routine",
                }
            ],
        },
    )
    core._save(db, edit_session, edit_cards)
    db.commit()
    edit_card = edit_cards[0]
    assert isinstance(edit_card, s.ProfileEditCard)
    edit_url = f"/api/v1/bot/sessions/{edit_session.id}"
    confirm = client.post(
        f"{edit_url}/actions",
        params=query,
        headers=demo[2]["manager"],
        json=edit_card.actions[0].model_dump(mode="json"),
    )
    assert confirm.status_code == 200, confirm.text
    edit_history = client.get(
        f"{edit_url}/messages", params=query, headers=demo[2]["manager"]
    ).json()
    reloaded_edit = next(
        m
        for entry in edit_history
        if "messages" in entry["payload"]
        for m in entry["payload"]["messages"]
        if m["type"] == "profile_edit_card"
    )
    assert reloaded_edit["actions"] == []
    assert reloaded_edit["status"] == "confirmed"
    assert "画像已发布" in (reloaded_edit.get("result") or "")
