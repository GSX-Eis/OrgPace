import asyncio
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlmodel import Session, col, select

from app.domains.bot import schemas as bot
from app.domains.bot import store, tools
from app.domains.capability.service import get_schema, list_capabilities
from app.domains.change_request import employee
from app.domains.change_request.models import ProfileChangeRequest
from app.domains.change_request.schemas import ItemInput
from app.domains.evidence.models import Evidence, EvidenceKind
from app.domains.im import actions
from app.domains.im.models import ImAction
from app.domains.im.rendering import render
from app.domains.review.publish import current_claims
from tests.api.routes.test_approval_policy import save
from tests.api.routes.test_reviews import actor
from tests.domains.test_im_conversation import button
from tests.domains.test_im_gateway import event


@pytest.mark.parametrize("channel", ["form", "web", "telegram"])
@pytest.mark.parametrize("requires_manager", [False, True])
def test_policy_change_refreshes_preview_before_submission(
    demo: tuple, db: Session, client: TestClient, channel: str, requires_manager: bool
) -> None:
    url, people, auth = demo
    org_id = people["E02"].org_id
    owner = actor(db, org_id, "employee.platform@demo.example.com")
    definitions = list_capabilities(db, org_id, get_schema(db, org_id).id)
    backend = next(c for c in definitions if c.key == "backend_api")
    assert backend.category
    claims = current_claims(db, org_id, owner.employee_id)
    original = claims[backend.key]
    assert original.level is not None
    additional = next(
        c for c in definitions if c.category == backend.category and c.key not in claims
    )
    if requires_manager:
        save(client, demo, category_overrides={backend.category: False})
    draft = employee.save_draft(
        owner,
        db,
        None,
        [
            ItemInput(op="retract", capability_key=backend.key, statement="申请撤回"),
            ItemInput(
                op="add",
                capability_key=additional.key,
                statement="合成新增判断",
                owner_statement="合成员工依据",
            ),
        ],
        "web" if channel == "form" else "bot",
    )
    request_id = draft.id
    base = f"{url}/me/requests/{request_id}"
    headers = auth["employee"]
    card = tools.preview_card(db, owner, request_id)
    chat = store.create_session(
        db, owner, "telegram" if channel == "telegram" else "web", "100", "12345"
    )
    session_id = chat.id
    store.append_message(
        db, chat, "assistant", bot.TurnResponse(messages=[card]).model_dump(mode="json")
    )
    db.commit()
    before = client.get(f"{base}/preview", headers=headers).json()
    assert before["requires_manager"] is not requires_manager
    assert (
        card.policy_version
        == card.actions[0].policy_version
        == before["policy_version"]
    )
    updated = save(
        client, demo, category_overrides={backend.category: requires_manager}
    )

    message = "审批规则已更新，请核对最新预览后再确认提交"
    notices = (
        ["提交后需经理确认"] * 2
        if requires_manager
        else [
            "提交后立即撤回，能力状态变为未知",
            "本能力无需经理确认，提交后将直接发布为暂定",
        ]
    )
    status = "pending_review" if requires_manager else "approved"

    def submit_form(version: int) -> Response:
        return client.post(
            f"{base}/submit",
            headers=headers,
            json={"revision": before["revision"], "policy_version": version},
        )

    party = event(org_id, "确认提交")
    rendered: list[str] = []

    class FakeTelegram:
        async def render(self, chat: str, text: str, buttons: list) -> str:
            rendered.append(text)
            return str(len(rendered))

    def deliver(reply: actions.Reply) -> None:
        asyncio.run(actions.deliver(db, owner, party, "12345", reply, FakeTelegram()))

    def im_confirm() -> actions.Reply:
        row = db.exec(
            select(ImAction).where(
                ImAction.org_id == org_id,
                ImAction.session_id == session_id,
                ImAction.message_id == str(len(rendered)),
                ImAction.action["action"].astext == "confirm_submit",
            )
        ).one()
        reply = actions.callback(db, owner, button(party, row), "12345")
        assert isinstance(reply, actions.Reply) and reply.clear_buttons
        return reply

    def web_confirm(action: bot.RequestAction) -> bot.TurnResponse:
        response = client.post(
            f"/api/v1/bot/sessions/{session_id}/actions",
            params={"org_id": str(org_id)},
            headers=headers,
            json=action.model_dump(mode="json"),
        )
        assert response.status_code == 200, response.text
        return bot.TurnResponse.model_validate(response.json())

    if channel == "form":
        conflict = submit_form(before["policy_version"])
        assert conflict.status_code == 409, conflict.text
        detail = conflict.json()["detail"]
        assert detail["code"] == "approval_policy_changed"
        assert detail["message"] == message
        refreshed = detail["preview"]
    else:
        if channel == "telegram":
            deliver(actions.Reply(session_id, bot.TurnResponse(messages=[card])))
            reply = im_confirm()
            result = reply.response
            deliver(reply)
            assert rendered[-2] == message
            assert all(notice in rendered[-1] for notice in notices)
        else:
            result = web_confirm(card.actions[0])
        text, fresh_card = result.messages
        assert isinstance(text, bot.TextMessage) and text.text == message
        assert isinstance(fresh_card, bot.PreviewCard)
        assert fresh_card.actions[0].policy_version == fresh_card.policy_version
        refreshed = fresh_card.model_dump(mode="json")
    assert refreshed["policy_version"] == updated["current"]["version"]
    assert refreshed["revision"] == before["revision"]
    assert refreshed["requires_manager"] is requires_manager
    assert [i["submission_notice"] for i in refreshed["items"]] == notices
    if requires_manager:
        assert refreshed["reviewers"]
        latest = client.get(f"{base}/preview", headers=headers).json()
        assert refreshed["reviewers"] == latest["reviewers"]

    def self_reports() -> list[Evidence]:
        return list(
            db.exec(
                select(Evidence).where(
                    Evidence.org_id == org_id,
                    Evidence.kind == EvidenceKind.SELF_REPORT,
                    col(Evidence.provenance)["request_id"].astext == str(request_id),
                )
            ).all()
        )

    db.expire_all()
    pending = db.get(ProfileChangeRequest, request_id)
    assert pending and pending.status == "draft" and pending.submitted_at is None
    assert not self_reports()
    current = current_claims(db, org_id, owner.employee_id)
    assert current[backend.key].id == original.id
    assert current[backend.key].level == original.level
    assert additional.key not in current

    if channel == "form":
        confirmed = submit_form(refreshed["policy_version"])
        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json()["status"] == status
    else:
        confirmed_card = (
            im_confirm().response
            if channel == "telegram"
            else web_confirm(fresh_card.actions[0])
        ).messages[0]
        assert isinstance(confirmed_card, bot.StatusCard)
        assert confirmed_card.status == status
    db.expire_all()
    assert len(self_reports()) == 1
    current = current_claims(db, org_id, owner.employee_id)
    if requires_manager:
        assert current[backend.key].id == original.id
        assert additional.key not in current
    else:
        assert current[backend.key].assessment_status == "unknown"
        assert current[backend.key].level is None
        assert current[additional.key].assessment_status == "tentative"


@pytest.mark.parametrize(
    "change", ["same", "days", "other", "omitted", "missing", "invalid"]
)
def test_policy_version_validation_and_compatible_submissions(
    demo: tuple, client: TestClient, change: str
) -> None:
    url, _, auth = demo
    headers = auth["employee"]
    draft = client.post(
        f"{url}/me/requests",
        headers=headers,
        json={
            "items": [
                {
                    "op": "retract",
                    "capability_key": "backend_api",
                    "statement": "申请撤回",
                }
            ]
        },
    )
    assert draft.status_code == 201, draft.text
    base = f"{url}/me/requests/{draft.json()['id']}"
    preview = client.get(f"{base}/preview", headers=headers).json()
    body = {
        "revision": preview["revision"],
        "policy_version": preview["policy_version"],
    }
    if change == "days":
        save(client, demo, owner_review_days=7)
    elif change == "other":
        category = preview["items"][0]["after"]["capability"]["category"]
        policy = client.get(f"{url}/approval-policy", headers=auth["admin"]).json()
        other = next(c for c in policy["categories"] if c != category)
        save(client, demo, category_overrides={other: False})
    elif change == "omitted":
        save(client, demo, require_manager=False)
        body.pop("policy_version")
    elif change == "missing":
        body["policy_version"] += 100
    elif change == "invalid":
        body["policy_version"] = -1
    response = client.post(f"{base}/submit", headers=headers, json=body)
    if change == "missing":
        assert response.status_code == 409, response.text
        detail = response.json()["detail"]
        assert detail["code"] == "approval_policy_changed"
        assert detail["preview"] == preview
    elif change == "invalid":
        assert response.status_code == 422, response.text
        assert response.json()["detail"][0]["loc"] == ["body", "policy_version"]
    else:
        assert response.status_code == 200, response.text
        assert response.json()["status"] == (
            "approved" if change == "omitted" else "pending_review"
        )


@pytest.mark.parametrize(
    "scenario,requires_manager,partial_auto_publish",
    [
        ("default", True, False),
        ("exempt", False, False),
        ("retract", False, False),
        ("mixed", True, True),
        ("empty", True, False),
    ],
)
def test_preview_policy_matches_bot_and_im(
    demo: tuple,
    db: Session,
    client: TestClient,
    scenario: str,
    requires_manager: bool,
    partial_auto_publish: bool,
) -> None:
    url, employees, auth = demo
    org_id = employees["E02"].org_id
    definitions = list_capabilities(db, org_id, get_schema(db, org_id).id)
    backend = next(c for c in definitions if c.key == "backend_api")
    assert backend.category
    owner = actor(db, org_id, "employee.platform@demo.example.com")
    pending_notice = "提交后需经理确认"
    tentative_notice = "本能力无需经理确认，提交后将直接发布为暂定"
    retract_notice = "提交后立即撤回，能力状态变为未知"
    changes = []
    if scenario in ("retract", "mixed"):
        changes.append((backend.key, "retract", retract_notice))
    elif scenario != "empty":
        changes.append(
            (
                backend.key,
                "modify",
                pending_notice if requires_manager else tentative_notice,
            )
        )
    if scenario == "mixed":
        other = next(c for c in definitions if c.category != backend.category)
        save(client, demo, require_manager=False)
        seed = employee.save_draft(
            owner,
            db,
            None,
            [ItemInput(op="add", capability_key=other.key, statement="合成判断")],
            "web",
        )
        employee.submit(owner, db, seed.id, seed.revision, "web")
        db.commit()
        additional = next(
            c
            for c in definitions
            if c.key != backend.key and c.category == backend.category
        )
        changes.extend(
            [
                (other.key, "retract", pending_notice),
                (additional.key, "add", tentative_notice),
            ]
        )
    if scenario != "default":
        save(
            client,
            demo,
            require_manager=True,
            category_overrides={backend.category: False},
        )
    draft = client.post(
        f"{url}/me/requests",
        headers=auth["employee"],
        json={
            "items": [
                {
                    "op": op,
                    "capability_key": key,
                    "statement": "合成审批预览",
                }
                for key, op, _ in changes
            ]
        },
    )
    assert draft.status_code == 201, draft.text
    request_id = draft.json()["id"]
    response = client.get(
        f"{url}/me/requests/{request_id}/preview", headers=auth["employee"]
    )
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["requires_manager"] is requires_manager
    assert preview["partial_auto_publish"] is partial_auto_publish
    assert [
        (
            item["after"]["capability"]["key"],
            item["after"]["op"],
            item["submission_notice"],
        )
        for item in preview["items"]
    ] == changes

    card = tools.preview_card(db, owner, UUID(request_id))
    assert card.requires_manager is requires_manager
    assert card.partial_auto_publish is partial_auto_publish
    reviewers = "、".join(f"{r['name']}（{r['role']}）" for r in preview["reviewers"])
    assert reviewers
    prefix = "需经理确认的改动：" if partial_auto_publish else ""
    text, actions = render(card)
    assert actions[0]["action"] == "confirm_submit"
    blocks = text.split("\n\n") if changes else []
    for item, (_, _, notice), block in zip(card.items, changes, blocks, strict=True):
        assert item.submission_notice == notice
        assert item.after.capability.name in block
        assert set(block.splitlines()) & {
            pending_notice,
            tentative_notice,
            retract_notice,
        } == {notice}
    if requires_manager:
        assert text.splitlines()[-1] == f"{prefix}提交后由 {reviewers}审批"
    else:
        assert f"提交后由 {reviewers}审批" not in text
        assert "暂未配置部门审批人，将由企业管理员处理" not in text
    if scenario == "mixed":
        assert (
            render(card.model_copy(update={"reviewers": []}))[0].splitlines()[-1]
            == f"{prefix}暂未配置部门审批人，将由企业管理员处理"
        )
        db.commit()
        submitted = client.post(
            f"{url}/me/requests/{request_id}/submit",
            headers=auth["employee"],
            json={"revision": preview["revision"]},
        )
        assert submitted.status_code == 200, submitted.text
        assert [item["decision"] for item in submitted.json()["items"]] == [
            "approved",
            None,
            "approved",
        ]
        db.expire_all()
        published = current_claims(db, org_id, owner.employee_id)
        assert published[backend.key].assessment_status == "unknown"
        assert published[backend.key].level is None
        assert published[other.key].assessment_status == "tentative"
        assert published[additional.key].assessment_status == "tentative"


@pytest.mark.parametrize(
    "channel,version",
    [
        ("web", "legacy"),
        ("telegram", "legacy"),
        ("web", "ambiguous"),
        ("web", "already_notified"),
        ("web", "current"),
    ],
)
def test_assistant_confirms_immediate_retraction_after_notice(
    demo: tuple, db: Session, client: TestClient, channel: str, version: str
) -> None:
    _, people, auth = demo
    org_id = people["E02"].org_id
    owner = actor(db, org_id, "employee.platform@demo.example.com")
    definitions = list_capabilities(db, org_id, get_schema(db, org_id).id)
    backend = next(c for c in definitions if c.key == "backend_api")
    assert backend.category
    items = [ItemInput(op="retract", capability_key=backend.key, statement="申请撤回")]
    mixed = channel == "telegram"
    if mixed:
        other = next(c for c in definitions if c.category != backend.category)
        save(client, demo, require_manager=False)
        seed = employee.save_draft(
            owner,
            db,
            None,
            [ItemInput(op="add", capability_key=other.key, statement="合成判断")],
            "web",
        )
        employee.submit(owner, db, seed.id, seed.revision, "web")
        db.commit()
        items.append(
            ItemInput(op="retract", capability_key=other.key, statement="申请撤回")
        )
    save(client, demo, category_overrides={backend.category: False})
    original = current_claims(db, org_id, owner.employee_id)[backend.key]
    assert original.level is not None
    draft = employee.save_draft(owner, db, None, items, "bot")
    incoming = event(org_id, "预览撤回")
    session = store.create_session(db, owner, channel, "100", "12345")
    session_id = session.id
    request_id = draft.id
    url = f"/api/v1/bot/sessions/{session_id}"
    query = {"org_id": str(org_id)}
    card = tools.preview_card(db, owner, request_id)
    payload = card.model_dump(mode="json")
    for action in payload["actions"]:
        action.pop("preview_id")
        if version == "legacy":
            action.pop("policy_version")
    if version == "legacy":
        payload.pop("policy_version")
    legacy = {**payload, "items": [dict(item) for item in payload["items"]]}
    for item in legacy["items"]:
        item.pop("submission_notice")
    if version != "already_notified":
        store.append_message(
            db, session, "assistant", {"messages": [legacy], "steps": []}
        )
    if version in ("ambiguous", "already_notified"):
        # PR #405 displayed the notice with the same action payload as a legacy card.
        store.append_message(
            db, session, "assistant", {"messages": [payload], "steps": []}
        )
        if version == "ambiguous":
            card = bot.PreviewCard.model_validate(legacy)
            assert card.actions == bot.PreviewCard.model_validate(payload).actions
        else:
            card = bot.PreviewCard.model_validate(payload)
    elif version == "current":
        store.append_message(
            db,
            session,
            "assistant",
            bot.TurnResponse(messages=[card]).model_dump(mode="json"),
        )
    else:
        card = bot.PreviewCard.model_validate(legacy)
    db.commit()

    rendered: list[str] = []

    class FakeTelegram:
        async def render(self, chat: str, text: str, buttons: list) -> str:
            rendered.append(text)
            return str(len(rendered))

    def confirm(preview: bot.PreviewCard) -> bot.TurnResponse:
        if channel == "web":
            response = client.post(
                url + "/actions",
                params=query,
                headers=auth["employee"],
                json=preview.actions[0].model_dump(mode="json"),
            )
            assert response.status_code == 200, response.text
            return bot.TurnResponse.model_validate(response.json())
        asyncio.run(
            actions.deliver(
                db,
                owner,
                incoming,
                "12345",
                actions.Reply(session_id, bot.TurnResponse(messages=[preview])),
                FakeTelegram(),
            )
        )
        row = db.exec(
            select(ImAction).where(
                ImAction.org_id == org_id,
                ImAction.session_id == session_id,
                ImAction.message_id == str(len(rendered)),
                ImAction.action["action"].astext == "confirm_submit",
            )
        ).one()
        reply = actions.callback(db, owner, button(incoming, row), "12345")
        assert isinstance(reply, actions.Reply)
        return reply.response

    notice = "提交后立即撤回，能力状态变为未知"

    def assert_draft_unchanged() -> None:
        db.expire_all()
        unchanged = db.get(ProfileChangeRequest, request_id)
        assert unchanged and unchanged.status == "draft"
        assert unchanged.submitted_at is None
        current = current_claims(db, org_id, owner.employee_id)[backend.key]
        assert current.id == original.id
        assert current.level is not None

    response = confirm(card)
    if version in ("legacy", "ambiguous"):
        (fresh,) = response.messages
        assert isinstance(fresh, bot.PreviewCard)
        assert fresh.request_id == card.request_id
        assert fresh.revision == card.revision
        assert fresh.base_revision == card.base_revision
        assert fresh.actions[0].preview_id is not None
        assert [item.submission_notice for item in fresh.items] == (
            [notice, "提交后需经理确认"] if mixed else [notice]
        )
        assert_draft_unchanged()
        if channel == "web":
            (retry,) = confirm(card).messages
            assert isinstance(retry, bot.PreviewCard)
            assert retry.actions[0].preview_id is not None
            assert retry.actions[0].preview_id != fresh.actions[0].preview_id
            assert [item.submission_notice for item in retry.items] == [notice]
            assert_draft_unchanged()
            history = client.get(
                url + "/messages", params=query, headers=auth["employee"]
            )
            assert history.status_code == 200, history.text
            assert history.json()[0]["payload"]["messages"][0] == legacy
        response = confirm(fresh)
        if version == "ambiguous":
            replay = client.post(
                url + "/actions",
                params=query,
                headers=auth["employee"],
                json=fresh.actions[0].model_dump(mode="json"),
            )
            assert replay.status_code == 409, replay.text
        if mixed:
            first, second = rendered[-1].split("\n\n")
            assert (
                notice in first
                and "提交后需经理确认" in second
                and notice not in second
            )
    (status,) = response.messages
    assert isinstance(status, bot.StatusCard)
    assert status.status == ("pending_review" if mixed else "approved")
    db.expire_all()
    published = current_claims(db, org_id, owner.employee_id)
    assert published[backend.key].assessment_status == "unknown"
    assert published[backend.key].level is None
    if mixed:
        assert published[other.key].assessment_status == "tentative"
