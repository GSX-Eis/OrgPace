import asyncio
from datetime import date
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.authz.deps import get_org_principal
from app.core.db import engine
from app.domains import manager_tools
from app.domains.admin_assistant import change_set
from app.domains.admin_assistant import prompts as admin_prompts
from app.domains.admin_assistant.schemas import ProposeChanges
from app.domains.bot import core, presentation, reviews, store
from app.domains.bot import prompts as bot_prompts
from app.domains.bot import schemas as s
from app.domains.capacity.schemas import CapacitySettingsInput
from app.domains.change_request.models import ItemDecision
from app.domains.change_request.schemas import RequestReviewer
from app.domains.im import binding, gateway, rendering
from app.domains.im import settings as im_settings
from app.domains.im.adapters.base import Event
from app.domains.im.adapters.telegram import Telegram
from app.domains.im.models import ImBinding
from app.domains.model.client import ModelUnavailable
from app.domains.model.pi_client import TurnResult
from app.i18n import reply_language_instruction, tr, use_locale
from app.models import User
from tests.admin_assistant.test_registry import principal as admin_principal
from tests.domains.test_bot_core import enable as enable_bot
from tests.domains.test_bot_reviews import prepared
from tests.domains.test_im_gateway import TOKEN, principal
from tests.domains.test_im_gateway import enable as enable_im

pytestmark = pytest.mark.usefixtures("reset_login_attempts")


def test_assistant_prompts_append_language_instruction(
    demo: tuple, db: Session
) -> None:
    _, people, _ = demo
    org_id = people["E02"].org_id
    emp_p = principal(db, org_id, people["E02"].id)
    admin_p = admin_principal(db, demo)

    zh_bot = bot_prompts.system_prompt(db, emp_p, "web")
    zh_admin = admin_prompts.system_prompt(admin_p, "/admin/assistant")

    with use_locale("en"):
        instruction = reply_language_instruction()
        en_bot = bot_prompts.system_prompt(db, emp_p, "web")
        en_admin = admin_prompts.system_prompt(admin_p, "/admin/assistant")

    assert instruction
    assert instruction not in zh_bot
    assert instruction not in zh_admin
    assert en_bot == f"{zh_bot}\n{instruction}"
    assert en_admin == f"{zh_admin}\n{instruction}"


def test_presentation_english_routing_parity(
    demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, people, _ = demo
    org_id = people["E02"].org_id
    emp_p = principal(db, org_id, people["E02"].id)
    mgr_user = db.exec(
        select(User).where(User.email == "manager.platform@demo.example.com")
    ).one()
    mgr_p = get_org_principal(org_id, mgr_user, db)
    monkeypatch.setattr(
        presentation,
        "read_capacity_settings",
        lambda _p, _db: CapacitySettingsInput(enabled=True),
    )
    monkeypatch.setattr(presentation.demand, "require_requester", lambda _p, _db: None)

    # Pending reviews parity
    zh_review = presentation.manual_failure(db, mgr_p, "m", intent_text="查一下待审批")
    en_review = presentation.manual_failure(
        db, mgr_p, "m", intent_text="Show pending reviews"
    )
    assert zh_review.review_link == "/reviews" and en_review.review_link == "/reviews"

    # Profile link parity
    zh_profile = presentation.manual_failure(db, emp_p, "m", intent_text="更新我的画像")
    en_profile = presentation.manual_failure(
        db, emp_p, "m", intent_text="Update my profile capability"
    )
    expected_path = f"/employees/{emp_p.employee_id}"
    assert expected_path in zh_profile.text and expected_path in en_profile.text

    # My workload parity
    zh_wl = presentation.manual_failure(db, emp_p, "m", intent_text="调整我的负荷")
    en_wl = presentation.manual_failure(
        db, emp_p, "m", intent_text="Adjust my workload allocation"
    )
    assert [link.href for link in zh_wl.capacity_links] == ["/capacity?tab=mine"]
    assert [link.href for link in en_wl.capacity_links] == ["/capacity?tab=mine"]

    # Team workload parity
    zh_team = presentation.manual_failure(db, mgr_p, "m", intent_text="查看团队负荷")
    en_team = presentation.manual_failure(
        db, mgr_p, "m", intent_text="Check team workload"
    )
    assert [link.href for link in zh_team.capacity_links] == ["/capacity?tab=team"]
    assert [link.href for link in en_team.capacity_links] == ["/capacity?tab=team"]

    # Capacity demand parity + English link label under en locale
    with use_locale("en"):
        zh_cap = presentation.manual_failure(
            db, emp_p, "Model disabled", intent_text="发起跨部门需求"
        )
        en_cap = presentation.manual_failure(
            db,
            emp_p,
            "Model disabled",
            intent_text="Submit cross-department capacity demand",
        )
    assert [link.href for link in zh_cap.capacity_links] == ["/capacity?tab=outgoing"]
    assert [link.href for link in en_cap.capacity_links] == ["/capacity?tab=outgoing"]
    assert en_cap.capacity_links[0].label == "My Demands"
    assert "Plan -> My Demands" in en_cap.text


def test_reviews_english_direct_guard_and_summary(demo: tuple, db: Session) -> None:
    owner, request, mgr_p, session, _, _ = prepared(db, demo)
    employee_name = demo[1]["E02"].display_name
    assert owner.employee_id is not None

    with use_locale("en"):
        # Invalid schema returns English error
        invalid = reviews.call(db, mgr_p, session, [], "prepare_review_decision", {})
        assert isinstance(invalid, dict)
        assert "Please provide a decision" in str(invalid["error"])

        # English direct parser extracts approve, reject reason, and guards negation/inquiry/batch
        assert reviews._parse_turn_decision("Approve Alice's request", set()) == (
            ItemDecision.APPROVED,
            None,
            "Approve Alice's request",
        )
        rejected = reviews._parse_turn_decision(
            "Reject: missing verifiable project metrics", set()
        )
        assert isinstance(rejected, tuple)
        assert rejected[0] == ItemDecision.REJECTED
        assert rejected[1] == "missing verifiable project metrics"
        assert "negation or deferral" in str(
            reviews._parse_turn_decision("Do not approve yet", set())
        )
        assert "inquiry or preview" in str(
            reviews._parse_turn_decision("Why did Alice submit this?", set())
        )
        assert "multiple requests or batch" in str(
            reviews._parse_turn_decision("Approve all pending requests", set())
        )

        # Translated step names in session context remain recognized
        store.append_message(
            db,
            session,
            "user",
            {"text": f"Check {employee_name} request"},
        )
        store.append_message(
            db,
            session,
            "assistant",
            s.TurnResponse(
                messages=[s.TextMessage(text="Details")],
                steps=[
                    s.ToolStep(
                        name=tr("查看审批详情"),
                        ok=True,
                    )
                ],
            ).model_dump(mode="json"),
        )
        db.commit()
        pending_list = manager_tools.list_pending_reviews(mgr_p, db).data
        target = next(r for r in pending_list if r.id == request.id)
        _, conflict = reviews._assess_session_context(
            db,
            session,
            pending_list,
            target,
            request.revision,
            f"Approve {employee_name}",
            {request.id: {"Backend"}},
            set(),
            set(),
        )
        assert conflict is False
        assert store.SENSITIVE_TOOLS  # sanity non-empty under locale context


def test_bot_web_english_responses_and_streaming(
    demo: tuple, db: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, people, auth = demo
    org_id = people["E02"].org_id
    query = {"org_id": str(org_id)}
    session_id = client.post(
        "/api/v1/bot/sessions",
        params=query,
        headers={**auth["employee"], "Accept-Language": "en"},
    ).json()["session_id"]

    # Model disabled error under Accept-Language: en
    res_disabled = client.post(
        f"/api/v1/bot/sessions/{session_id}/turns",
        params=query,
        headers={**auth["employee"], "Accept-Language": "en"},
        json={"text": "hello"},
    )
    assert res_disabled.status_code in (200, 422, 503)
    assert "Work Assistant requires a model" in res_disabled.text

    # Streaming ModelUnavailable propagates locale into worker thread
    enable_bot(db, org_id)
    seen_prompts: list[str] = []

    def fake_run_turn(_cfg: object, **kwargs: object) -> TurnResult:
        seen_prompts.append(str(kwargs["system_prompt"]))
        return TurnResult(
            text="English ok", stop_reason="stop", model_calls=1, tool_calls=0
        )

    monkeypatch.setattr(core.pi_client, "run_turn", fake_run_turn)
    ok_res = client.post(
        f"/api/v1/bot/sessions/{session_id}/turns",
        params=query,
        headers={**auth["employee"], "Accept-Language": "en"},
        json={"text": "hello"},
    )
    assert ok_res.status_code == 200
    with use_locale("en"):
        expected_instruction = reply_language_instruction()
    assert seen_prompts and expected_instruction in seen_prompts[0]

    def fail_unavailable(*_args: object, **_kwargs: object) -> TurnResult:
        raise ModelUnavailable("down")

    monkeypatch.setattr(core.pi_client, "run_turn", fail_unavailable)
    with client.stream(
        "POST",
        f"/api/v1/bot/sessions/{session_id}/turns",
        params=query,
        headers={
            **auth["employee"],
            "Accept-Language": "en",
            "Accept": "application/x-ndjson",
        },
        json={"text": "hello"},
    ) as stream_res:
        raw = "".join(stream_res.iter_text())
    assert "Model service is temporarily unavailable" in raw


def test_admin_assistant_english_errors_and_change_set(
    demo: tuple, db: Session, client: TestClient
) -> None:
    _, people, auth = demo
    org_id = people["E02"].org_id
    admin_p = admin_principal(db, demo)

    avail = client.get(
        "/api/v1/admin-assistant/availability",
        params={"org_id": str(org_id)},
        headers={**auth["admin"], "Accept-Language": "en"},
    )
    assert avail.status_code == 200
    assert avail.json()["available"] is False
    assert "Model Settings" in avail.json()["reason"]

    # Direct domain validation & IM connection test under EN locale
    with use_locale("en"):
        im_res = asyncio.run(im_settings.test_connection(db, org_id, "feishu"))
        assert im_res.ok is False
        assert im_res.message == "Please save app credentials first"

        session_id = client.post(
            "/api/v1/admin-assistant/sessions",
            params={"org_id": str(org_id)},
            headers={**auth["admin"], "Accept-Language": "en"},
        ).json()["session_id"]
        with pytest.raises(
            change_set.ChangeSetError, match="Invalid change function or arguments"
        ):
            change_set.propose(
                db,
                admin_p,
                UUID(session_id),
                ProposeChanges.model_validate(
                    {"items": [{"function": "nonexistent", "args": {}}]}
                ),
            )


def test_im_gateway_and_rendering_follow_preferred_locale(
    demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, people, _ = demo
    org_id = people["E02"].org_id
    enable_bot(db, org_id)
    p = principal(db, org_id, people["E02"].id)
    assert p.user_id is not None and p.employee_id is not None
    setting = enable_im(db, p)

    # Create explicit binding for E02
    db.add(
        ImBinding(
            org_id=org_id,
            employee_id=p.employee_id,
            platform="telegram",
            external_user_id="en-tg-user",
            external_chat_id="en-tg-chat",
            bot_identity="12345",
        )
    )
    user = db.get(User, p.user_id)
    assert user is not None
    prev_locale = user.preferred_locale
    user.preferred_locale = "en"
    db.add(user)
    db.commit()
    try:
        # Check rendering across card types under EN locale
        with use_locale("en"):
            feasibility = s.FeasibilityCard(
                capability_key="frontend",
                capability_name="Frontend",
                allocation_cap_percent=70,
                window_start=date(2026, 12, 1),
                window_end=date(2026, 12, 7),
                departments=[
                    s.FeasibilityDepartmentItem(
                        department_name="Platform UI",
                        conclusion="can_do",
                        load_level="low",
                        department_load_percent=40,
                        earliest_start_date=date(2026, 12, 1),
                        data_source="confirmed",
                    )
                ],
            )
            f_text, _ = rendering.render(feasibility)
            assert "Available" in f_text
            assert "Earliest start: 2026-12-01" in f_text

            question = s.QuestionCard(
                id=uuid4(),
                status="open",
                question="Which API did you own?",
                reason="Confirm scope",
                actions=["answer_question"],
            )
            q_text, _ = rendering.render(question)
            assert q_text.startswith("Pending Question: Which API did you own?")

            req_id = uuid4()
            preview = s.PreviewCard(
                request_id=req_id,
                revision=1,
                requires_manager=True,
                partial_auto_publish=False,
                reviewers=[RequestReviewer(name="Manager", role="直属上级")],
                items=[],
                actions=[
                    s.RequestAction(
                        action="confirm_submit", request_id=req_id, revision=1
                    ),
                    s.RequestAction(
                        action="continue_editing", request_id=req_id, revision=1
                    ),
                ],
            )
            p_text, _ = rendering.render(preview)
            assert "Change Preview" in p_text
            assert "Direct Manager" in p_text
            assert (
                rendering.tr(rendering.LABELS["confirm_submit"]) == "Confirm & Submit"
            )

        # Gateway dispatch & handle with EN bound user
        seen_prompts: list[str] = []
        sent_texts: list[tuple[str, str]] = []
        rendered_cards: list[tuple[str, list[tuple[str, str]]]] = []

        def fake_run_turn(_cfg: object, **kwargs: object) -> TurnResult:
            seen_prompts.append(str(kwargs["system_prompt"]))
            return TurnResult(
                text="Hello from assistant",
                stop_reason="stop",
                model_calls=1,
                tool_calls=0,
            )

        monkeypatch.setattr(core.pi_client, "run_turn", fake_run_turn)

        async def fake_send_text(_self: Telegram, chat_id: str, text: str) -> None:
            sent_texts.append((chat_id, text))

        async def fake_render(
            _self: Telegram,
            _chat_id: str,
            body: str,
            buttons: list[tuple[str, str]],
            **_kwargs: object,
        ) -> str:
            rendered_cards.append((body, buttons))
            return "msg-1"

        monkeypatch.setattr(Telegram, "send_text", fake_send_text)
        monkeypatch.setattr(Telegram, "render", fake_render)

        async def run_bound_turn(ev: Event) -> None:
            adapter = Telegram(org_id, {"bot_token": TOKEN})
            try:
                await gateway.Gateway(engine).handle(
                    ev, "12345", setting.credentials, adapter
                )
            finally:
                await adapter.close()

        asyncio.run(
            run_bound_turn(
                Event(
                    org_id,
                    "telegram",
                    uuid4().hex,
                    "en-tg-user",
                    "en-tg-chat",
                    True,
                    "Hi",
                )
            )
        )
        with use_locale("en"):
            expected_instruction = reply_language_instruction()
        assert seen_prompts and expected_instruction in seen_prompts[0]
        assert any("Got it, processing..." in text for _, text in sent_texts)
        assert any("Hello from assistant" in body for body, _ in rendered_cards)

        # Unbound external user still gets Chinese GUIDE
        gw = gateway.Gateway(engine)
        unbound_reply = gw.dispatch(
            Event(
                org_id,
                "telegram",
                uuid4().hex,
                "unbound-user",
                "unbound-chat",
                True,
                "Hi",
            ),
            "12345",
            setting.credentials,
        )
        assert unbound_reply == binding.GUIDE
    finally:
        user.preferred_locale = prev_locale
        db.add(user)
        db.commit()
