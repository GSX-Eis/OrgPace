"""Regression tests for NERE-1222: server-side verification of direct bot review decisions."""

from dataclasses import replace
from datetime import date, timedelta
from uuid import uuid4

import pytest
from sqlmodel import Session, select

from app.domains.audit.models import AuditEvent
from app.domains.bot import core as bot_core
from app.domains.bot import reviews as bot_reviews
from app.domains.bot import schemas as bot_schemas
from app.domains.bot import store as bot_store
from app.domains.bot import tools as bot_tools
from app.domains.capacity.models import CapacitySetting, CapacityWeek
from app.domains.change_request import employee
from app.domains.change_request.models import (
    ChangeItem,
    ProfileChangeRequest,
    RequestStatus,
    ReviewDecision,
)
from app.domains.drafting import incremental
from app.domains.evidence.models import Evidence, EvidenceKind
from app.domains.im import actions as im_actions
from app.domains.im import rendering as im_rendering
from app.domains.im.adapters.base import Event
from app.domains.review.publish import current_claims
from tests.api.routes.test_reviews import actor, manager, pending
from tests.domains.test_bot_core import enable as enable_model
from tests.utils.pi import PiHarness


def _direct_args(
    request: ProfileChangeRequest,
    *,
    decision: str = "approved",
    reason: str | None = None,
) -> dict:
    item_payload: dict[str, object] = {
        "item_id": str(request.items[0].id),
        "decision": decision,
    }
    if reason is not None:
        item_payload["reason"] = reason
    return {
        "request_id": str(request.id),
        "revision": request.revision,
        "direct": True,
        "decisions": [item_payload],
    }


@pytest.mark.parametrize(
    "turn_text",
    [
        None,
        "",
        "   ",
        # Read-only questions & inquiries
        "有什么要我批的？",
        "帮我看看待审批列表",
        "张伟的请求是什么内容？",
        "张伟的请求我该批准吗？",
        "这条请求可以批准吗？",
        "如果批准张伟的请求会怎样？",
        "这条请求已经批准了吗？",
        "帮我看看这条请求能不能直接批准",
        "先出确认卡让我看看",
        "把这条批准前的改动列出来给我看",
        # Negations
        "不批准",
        "先不批准张伟的请求",
        "不要批准",
        "不同意张伟的请求",
        "不能批准这条",
        "暂不拒绝",
        "不要直接批准，先出确认卡",
        # Quotes / third-party attribution / conditionals
        '张伟在说明里写了"批准"',
        "材料里说「批准张伟的请求」",
        "张伟说希望能批准这个修改",
        "员工说可以批准了",
        "引用：批准张伟的请求",
        "如果证据够了再批准",
        # Batch wording even when only 1 pending request
        "全部批准",
        "批量批准",
        # Mismatched target when only 1 pending request
        "批准李四的请求",
        "批准自动化测试那条请求",
    ],
)
def test_single_pending_direct_blocked_on_inquiry_negation_quote_or_mismatch(
    demo: tuple, db: Session, turn_text: str | None
) -> None:
    _, req = pending(db, demo)
    mgr = manager(db, demo)
    session = bot_store.create_session(db, mgr, "web")
    db.commit()

    result = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        _direct_args(req),
        turn_text=turn_text,
    )
    assert isinstance(result, dict) and "error" in result
    assert not db.exec(
        select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
    ).all()
    row = db.get(ProfileChangeRequest, req.id, populate_existing=True)
    assert row is not None and row.status == RequestStatus.PENDING_REVIEW


def test_direct_blocks_decision_mismatch_missing_or_fabricated_reason_and_mixed_items(
    demo: tuple, db: Session
) -> None:
    _, req = pending(
        db,
        demo,
        items=[
            {"op": "add", "capability_key": "automated_testing", "statement": "s1"},
            {"op": "add", "capability_key": "observability", "statement": "s2"},
        ],
    )
    mgr = manager(db, demo)
    session = bot_store.create_session(db, mgr, "feishu", "chat-1", "bot-1")
    db.commit()

    # 1. Manager says approve, model attempts direct reject with fabricated reason
    err_flip_reject = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        {
            "request_id": str(req.id),
            "revision": req.revision,
            "direct": True,
            "decisions": [
                {
                    "item_id": str(i.id),
                    "decision": "rejected",
                    "reason": "模型编造的理由",
                }
                for i in req.items
            ],
        },
        turn_text="批准张伟的请求",
    )
    assert isinstance(err_flip_reject, dict) and "error" in err_flip_reject

    # 2. Manager says reject with reason, model attempts direct approve
    err_flip_approve = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        {
            "request_id": str(req.id),
            "revision": req.revision,
            "direct": True,
            "decisions": [
                {"item_id": str(i.id), "decision": "approved"} for i in req.items
            ],
        },
        turn_text="拒绝张伟的请求，原因：缺少测试报告",
    )
    assert isinstance(err_flip_approve, dict) and "error" in err_flip_approve

    # 3. Manager says reject without reason, model fabricates a reason
    err_no_reason = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        {
            "request_id": str(req.id),
            "revision": req.revision,
            "direct": True,
            "decisions": [
                {
                    "item_id": str(i.id),
                    "decision": "rejected",
                    "reason": "证据不充分",
                }
                for i in req.items
            ],
        },
        turn_text="拒绝张伟的请求",
    )
    assert isinstance(err_no_reason, dict) and "error" in err_no_reason

    # 4. Manager gives reason A, model substitutes unrelated reason B
    err_wrong_reason = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        {
            "request_id": str(req.id),
            "revision": req.revision,
            "direct": True,
            "decisions": [
                {
                    "item_id": str(i.id),
                    "decision": "rejected",
                    "reason": "完全不相干的模型改写理由",
                }
                for i in req.items
            ],
        },
        turn_text="拒绝张伟的请求，原因：请补充自动化测试覆盖率数据",
    )
    assert isinstance(err_wrong_reason, dict) and "error" in err_wrong_reason

    # 5. Mixed per-item decisions must go through confirmation card, not direct=True
    err_mixed = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        {
            "request_id": str(req.id),
            "revision": req.revision,
            "direct": True,
            "decisions": [
                {"item_id": str(req.items[0].id), "decision": "approved"},
                {
                    "item_id": str(req.items[1].id),
                    "decision": "rejected",
                    "reason": "请补充可观测性证据",
                },
            ],
        },
        turn_text="第 1 项批准，第 2 项拒绝，原因：请补充可观测性证据",
    )
    assert isinstance(err_mixed, dict) and "error" in err_mixed

    assert not db.exec(
        select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
    ).all()


def test_direct_turn_prompt_injection_falls_back_to_card_or_no_write(
    demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch, pi_service: PiHarness
) -> None:
    _, req = pending(db, demo)
    mgr = manager(db, demo)
    enable_model(db, mgr.org_id)
    session = bot_store.create_session(db, mgr, "web")
    db.commit()

    monkeypatch.setattr(bot_core, "model_config", lambda _: pi_service.config)
    pi_service.replies = [
        {"calls": [{"name": "get_review", "arguments": {"request_id": str(req.id)}}]},
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(req),
                }
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": {
                        "request_id": str(req.id),
                        "revision": req.revision,
                        "direct": False,
                        "decisions": [
                            {"item_id": str(req.items[0].id), "decision": "approved"}
                        ],
                    },
                }
            ]
        },
        "已为你生成审批确认卡，请核对后点击确认。",
    ]

    response = bot_core.turn(db, mgr, session.id, "帮我看看张伟的待审批请求内容")
    db.commit()

    # No decision written during read-only inquiry even though model first tried direct=True
    assert not db.exec(
        select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
    ).all()
    assert any(m.type == "review_card" for m in response.messages)
    row = db.get(ProfileChangeRequest, req.id, populate_existing=True)
    assert row is not None and row.status == RequestStatus.PENDING_REVIEW


def test_direct_approve_reject_with_reason_negation_in_reason_and_audit_via(
    demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch, pi_service: PiHarness
) -> None:
    owner, req1 = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "automated_testing", "statement": "s1"}],
    )
    mgr = manager(db, demo)
    enable_model(db, mgr.org_id)
    web_session = bot_store.create_session(db, mgr, "web")
    db.commit()

    # 1. Explicit single-pending approval on web -> direct write, audit via=bot, client_name=网页
    monkeypatch.setattr(bot_core, "model_config", lambda _: pi_service.config)
    pi_service.replies = [
        {"calls": [{"name": "get_review", "arguments": {"request_id": str(req1.id)}}]},
        {
            "calls": [
                {"name": "prepare_review_decision", "arguments": _direct_args(req1)}
            ]
        },
        "已批准。",
    ]
    res1 = bot_core.turn(
        db, mgr, web_session.id, f"批准{demo[1]['E02'].display_name}的自动化测试请求"
    )
    db.commit()
    assert not any(m.type == "review_card" for m in res1.messages)
    d1 = db.exec(
        select(ReviewDecision).where(
            ReviewDecision.org_id == mgr.org_id, ReviewDecision.request_id == req1.id
        )
    ).one()
    assert (d1.via, d1.client_name) == ("bot", "网页")
    audit1 = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == mgr.org_id,
            AuditEvent.action == "change_request.decided",
            AuditEvent.target_id == str(req1.id),
        )
    ).one()
    assert (audit1.details["via"], audit1.details["client_name"]) == ("bot", "网页")

    # 2. Explicit rejection whose reason contains negation ("暂时不能批准") -> allowed on feishu
    _, req2 = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "observability", "statement": "s2"}],
    )
    feishu_session = bot_store.create_session(db, mgr, "feishu", "chat-2", "bot-1")
    db.commit()
    reason = "目前缺少监控告警演练数据，暂时不能批准"
    pi_service.replies = [
        {"calls": [{"name": "get_review", "arguments": {"request_id": str(req2.id)}}]},
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(req2, decision="rejected", reason=reason),
                }
            ]
        },
        "已拒绝。",
    ]
    res2 = bot_core.turn(
        db, mgr, feishu_session.id, f"拒绝可观测性那条请求，原因：{reason}"
    )
    db.commit()
    assert not any(m.type == "review_card" for m in res2.messages)
    d2 = db.exec(
        select(ReviewDecision).where(
            ReviewDecision.org_id == mgr.org_id, ReviewDecision.request_id == req2.id
        )
    ).one()
    assert (d2.via, d2.client_name) == ("bot", "飞书")
    audit2 = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == mgr.org_id,
            AuditEvent.action == "change_request.decided",
            AuditEvent.target_id == str(req2.id),
        )
    ).one()
    assert (audit2.details["via"], audit2.details["client_name"]) == ("bot", "飞书")

    # 3. Self-approval, unauthorized actor, and cross-tenant actor still blocked
    owner_session = bot_store.create_session(db, owner, "web")
    other = actor(db, mgr.org_id, "employee.algorithm@demo.example.com")
    other_session = bot_store.create_session(db, other, "web")
    _, req3 = pending(
        db,
        demo,
        items=[{"op": "modify", "capability_key": "backend_api", "statement": "s3"}],
    )
    for bad_actor, bad_session in (
        (owner, owner_session),
        (other, other_session),
        (replace(mgr, org_id=uuid4()), web_session),
    ):
        err = bot_tools.call(
            db,
            bad_actor,
            bad_session,
            [],
            "prepare_review_decision",
            _direct_args(req3),
            turn_text=f"批准{demo[1]['E02'].display_name}的请求",
        )
        assert isinstance(err, dict) and "error" in err


def test_trusted_session_context_disambiguation_and_direct_edit_cards_unchanged(
    demo: tuple, db: Session
) -> None:
    _, req_auto = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "automated_testing", "statement": "s1"}],
    )
    _, req_obs = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "observability", "statement": "s2"}],
    )
    mgr = manager(db, demo)
    session = bot_store.create_session(db, mgr, "web")

    # Ambiguous demonstrative without trusted single-request context -> blocked
    bot_store.append_message(db, session, "user", {"text": "有哪些待审批请求？"})
    bot_core._save(db, session, [bot_schemas.TextMessage(text="有两条待审批")])
    db.commit()
    ambig = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        _direct_args(req_auto),
        turn_text="批准这条",
    )
    assert isinstance(ambig, dict) and "error" in ambig

    # Prior user turn naming two different pending capabilities + "批准这条" -> still blocked
    bot_store.append_message(
        db, session, "user", {"text": "看看张伟的自动化测试与可观测性请求"}
    )
    bot_core._save(db, session, [bot_schemas.TextMessage(text="已展示两条详情")])
    db.commit()
    ambig_multi_caps = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        _direct_args(req_auto),
        turn_text="批准这条",
    )
    assert isinstance(ambig_multi_caps, dict) and "error" in ambig_multi_caps

    # Trusted single-request ReviewCard context + explicit "批准这条" -> allowed
    cards: list[bot_schemas.Message] = []
    bot_tools.call(
        db,
        mgr,
        session,
        cards,
        "prepare_review_decision",
        {
            "request_id": str(req_auto.id),
            "revision": req_auto.revision,
            "decisions": [
                {"item_id": str(req_auto.items[0].id), "decision": "approved"}
            ],
        },
    )
    bot_store.append_message(
        db, session, "user", {"text": "先出自动化测试那条的确认卡"}
    )
    bot_core._save(db, session, cards)
    db.commit()

    approved = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        _direct_args(req_auto),
        turn_text="批准这条",
    )
    assert isinstance(approved, dict) and approved.get("status") == "approved"
    obs_row = db.get(ProfileChangeRequest, req_obs.id, populate_existing=True)
    assert obs_row is not None and obs_row.status == RequestStatus.PENDING_REVIEW

    # Trusted prior user turn uniquely naming remaining request + "拒绝这条，原因：..." -> allowed
    _, req_third = pending(
        db,
        demo,
        items=[{"op": "modify", "capability_key": "backend_api", "statement": "s3"}],
    )
    bot_store.append_message(db, session, "user", {"text": "看看可观测性那条请求"})
    bot_core._save(db, session, [bot_schemas.TextMessage(text="这是可观测性请求详情")])
    db.commit()
    rejected = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        _direct_args(req_obs, decision="rejected", reason="请补充监控指标截图"),
        turn_text="拒绝这条，原因：请补充监控指标截图",
    )
    assert isinstance(rejected, dict) and rejected.get("status") == "rejected"
    third_row = db.get(ProfileChangeRequest, req_third.id, populate_existing=True)
    assert third_row is not None and third_row.status == RequestStatus.PENDING_REVIEW

    # Employee profile direct edit and team workload adjustment still require confirmation cards
    latest_v = incremental.latest_version(db, mgr.org_id, demo[1]["E02"].id)
    edit_cards: list[bot_schemas.Message] = []
    bot_tools.call(
        db,
        mgr,
        session,
        edit_cards,
        "prepare_profile_edit",
        {
            "employee_id": str(demo[1]["E02"].id),
            "base_revision": latest_v.revision if latest_v else None,
            "items": [
                {
                    "op": "add",
                    "capability_key": "observability",
                    "statement": "直接修改仍需确认卡",
                    "level": "routine",
                }
            ],
        },
    )
    assert len(edit_cards) == 1 and edit_cards[0].type == "profile_edit_card"
    assert "observability" not in current_claims(db, mgr.org_id, demo[1]["E02"].id)

    cap_setting = CapacitySetting(
        org_id=mgr.org_id, enabled=True, updated_by_user_id=mgr.user_id
    )
    db.add(cap_setting)
    db.commit()
    try:
        today = date.today()
        monday = today - timedelta(days=today.weekday()) + timedelta(days=7)
        workload_cards: list[bot_schemas.Message] = []
        bot_tools.call(
            db,
            mgr,
            session,
            workload_cards,
            "coordination",
            {
                "function": "prepare_team_workload",
                "arguments": {
                    "employee_id": str(demo[1]["E02"].id),
                    "other_percent": 15,
                    "start_week": monday.isoformat(),
                    "end_week": monday.isoformat(),
                },
            },
        )
        assert len(workload_cards) == 1 and workload_cards[0].type == "capacity_card"
        assert not db.exec(
            select(CapacityWeek).where(
                CapacityWeek.org_id == mgr.org_id,
                CapacityWeek.employee_id == demo[1]["E02"].id,
            )
        ).all()
    finally:
        db.delete(cap_setting)
        db.commit()


def test_single_pending_blocks_stale_or_mismatched_anaphora_context(
    demo: tuple, db: Session
) -> None:
    owner, req_processed = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "automated_testing", "statement": "s1"}],
    )
    _, req_remaining = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "observability", "statement": "s2"}],
    )
    mgr = manager(db, demo)

    # 1. Fresh session with 1 pending request: bare demonstrative ("批准这条") has no context -> blocked
    employee.withdraw(owner, db, req_processed.id)
    db.commit()
    fresh_session = bot_store.create_session(db, mgr, "web")
    db.commit()
    for phrase in ("批准这条", "批准那条"):
        err = bot_tools.call(
            db,
            mgr,
            fresh_session,
            [],
            "prepare_review_decision",
            _direct_args(req_remaining),
            turn_text=phrase,
        )
        assert isinstance(err, dict) and "error" in err

    # 2. Prior ReviewCard pointed to another (now processed) request -> cannot fall onto remaining item
    other_card_session = bot_store.create_session(db, mgr, "web")
    stale_card = bot_schemas.ReviewCard(
        id=req_processed.id,
        revision=req_processed.revision,
        items=[],
        decisions=[],
        actions=[
            bot_schemas.ReviewAction(
                action="confirm_review",
                request_id=req_processed.id,
                revision=req_processed.revision,
                card_id=uuid4(),
            )
        ],
    )
    bot_store.append_message(
        db, other_card_session, "user", {"text": "看看张伟的自动化测试请求"}
    )
    bot_core._save(db, other_card_session, [stale_card])
    db.commit()
    for phrase in ("批准这条", "批准", f"批准{demo[1]['E02'].display_name}这条请求"):
        err = bot_tools.call(
            db,
            mgr,
            other_card_session,
            [],
            "prepare_review_decision",
            _direct_args(req_remaining),
            turn_text=phrase,
        )
        assert isinstance(err, dict) and "error" in err

    # 3. Prior ReviewCard for remaining request had an older revision -> stale card blocked
    old_rev_session = bot_store.create_session(db, mgr, "web")
    old_cards: list[bot_schemas.Message] = []
    bot_tools.call(
        db,
        mgr,
        old_rev_session,
        old_cards,
        "prepare_review_decision",
        {
            "request_id": str(req_remaining.id),
            "revision": req_remaining.revision,
            "decisions": [
                {"item_id": str(req_remaining.items[0].id), "decision": "approved"}
            ],
        },
    )
    bot_store.append_message(
        db, old_rev_session, "user", {"text": "先出可观测性那条确认卡"}
    )
    bot_core._save(db, old_rev_session, old_cards)
    row = db.get(ProfileChangeRequest, req_remaining.id)
    assert row is not None
    row.revision += 1
    db.add(row)
    db.commit()
    db.refresh(row)
    for submitted_rev in (row.revision - 1, row.revision):
        err = bot_tools.call(
            db,
            mgr,
            old_rev_session,
            [],
            "prepare_review_decision",
            {
                "request_id": str(req_remaining.id),
                "revision": submitted_rev,
                "direct": True,
                "decisions": [
                    {
                        "item_id": str(req_remaining.items[0].id),
                        "decision": "approved",
                    }
                ],
            },
            turn_text="批准这条",
        )
        assert isinstance(err, dict) and "error" in err

    # 4. Prior text turn named processed capability -> cannot match remaining item via employee name
    text_only_session = bot_store.create_session(db, mgr, "web")
    bot_store.append_message(
        db, text_only_session, "user", {"text": "看看张伟的自动化测试请求"}
    )
    bot_core._save(
        db, text_only_session, [bot_schemas.TextMessage(text="这是自动化测试详情")]
    )
    db.commit()
    err_text = bot_tools.call(
        db,
        mgr,
        text_only_session,
        [],
        "prepare_review_decision",
        {
            "request_id": str(req_remaining.id),
            "revision": row.revision,
            "direct": True,
            "decisions": [
                {"item_id": str(req_remaining.items[0].id), "decision": "approved"}
            ],
        },
        turn_text="批准这条",
    )
    assert isinstance(err_text, dict) and "error" in err_text

    # 5. Valid ReviewCard for current request & revision + "批准这条" -> succeeds; explicit request also succeeds
    valid_session = bot_store.create_session(db, mgr, "web")
    valid_cards: list[bot_schemas.Message] = []
    bot_tools.call(
        db,
        mgr,
        valid_session,
        valid_cards,
        "prepare_review_decision",
        {
            "request_id": str(req_remaining.id),
            "revision": row.revision,
            "decisions": [
                {"item_id": str(req_remaining.items[0].id), "decision": "approved"}
            ],
        },
    )
    bot_store.append_message(db, valid_session, "user", {"text": "先看可观测性那条"})
    bot_core._save(db, valid_session, valid_cards)
    db.commit()
    ok = bot_tools.call(
        db,
        mgr,
        valid_session,
        [],
        "prepare_review_decision",
        {
            "request_id": str(req_remaining.id),
            "revision": row.revision,
            "direct": True,
            "decisions": [
                {"item_id": str(req_remaining.items[0].id), "decision": "approved"}
            ],
        },
        turn_text="批准这条",
    )
    assert isinstance(ok, dict) and ok.get("status") == "approved"


def test_direct_reject_blocks_truncation_expansion_and_persists_verbatim_reason(
    demo: tuple, db: Session
) -> None:
    _, req = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "automated_testing", "statement": "s1"}],
    )
    mgr = manager(db, demo)
    session = bot_store.create_session(db, mgr, "web")
    db.commit()

    manager_reason = "缺少自动化测试报告，且没有上线回滚方案"
    turn_text = f"拒绝自动化测试那条请求，原因：{manager_reason}"
    for bad_reason in (
        "缺少自动化测试报告",  # truncated
        "且没有上线回滚方案",  # truncated
        f"{manager_reason}，建议下周再提交",  # expanded
        f"{manager_reason}，绩效不达标",  # added
    ):
        err = bot_tools.call(
            db,
            mgr,
            session,
            [],
            "prepare_review_decision",
            _direct_args(req, decision="rejected", reason=bad_reason),
            turn_text=turn_text,
        )
        assert isinstance(err, dict) and "error" in err

    # Reason with leading "说明" word cannot be truncated by dropping "说明"
    _, req_doc = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "observability", "statement": "s2"}],
    )
    err_doc = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        _direct_args(req_doc, decision="rejected", reason="文档不完整"),
        turn_text="拒绝可观测性那条请求，原因：说明文档不完整",
    )
    assert isinstance(err_doc, dict) and "error" in err_doc
    assert not db.exec(
        select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
    ).all()

    # Format-only differences pass, and server persists manager's verbatim original text
    verbatim = "缺少自动化测试报告（V2），请补充"
    ok = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        _direct_args(
            req, decision="rejected", reason="原因：缺少自动化测试报告V2请补充。"
        ),
        turn_text=f"拒绝自动化测试那条请求，原因：{verbatim}。",
    )
    assert isinstance(ok, dict) and ok.get("status") == "rejected"
    item = db.get(ChangeItem, req.items[0].id, populate_existing=True)
    assert item is not None and item.decision_reason == verbatim
    ev = db.exec(
        select(Evidence).where(
            Evidence.org_id == mgr.org_id,
            Evidence.kind == EvidenceKind.MANAGER_REVIEW,
            Evidence.source_ref == str(ok["decision_id"]),
        )
    ).one()
    assert ev.content["reasons"] == [{"item_id": str(item.id), "reason": verbatim}]


def test_web_and_im_fall_back_to_confirmation_card_on_stale_anaphora_or_altered_reason(
    demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch, pi_service: PiHarness
) -> None:
    owner, req_old = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "automated_testing", "statement": "s1"}],
    )
    _, req_only = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "observability", "statement": "s2"}],
    )
    employee.withdraw(owner, db, req_old.id)
    mgr = manager(db, demo)
    enable_model(db, mgr.org_id)
    db.commit()
    monkeypatch.setattr(bot_core, "model_config", lambda _: pi_service.config)

    # 1. Web: stale card for req_old + "批准这条" -> direct=True blocked -> falls back to ReviewCard
    web_session = bot_store.create_session(db, mgr, "web")
    stale_card = bot_schemas.ReviewCard(
        id=req_old.id,
        revision=req_old.revision,
        items=[],
        decisions=[],
        actions=[
            bot_schemas.ReviewAction(
                action="confirm_review",
                request_id=req_old.id,
                revision=req_old.revision,
                card_id=uuid4(),
            )
        ],
    )
    bot_store.append_message(db, web_session, "user", {"text": "看看自动化测试请求"})
    bot_core._save(db, web_session, [stale_card])
    db.commit()
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(req_only),
                }
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": {
                        "request_id": str(req_only.id),
                        "revision": req_only.revision,
                        "direct": False,
                        "decisions": [
                            {
                                "item_id": str(req_only.items[0].id),
                                "decision": "approved",
                            }
                        ],
                    },
                }
            ]
        },
        "上一张卡已失效，请确认是否批准可观测性请求。",
    ]
    web_resp = bot_core.turn(db, mgr, web_session.id, "批准这条")
    db.commit()
    assert any(
        isinstance(m, bot_schemas.ReviewCard) and m.id == req_only.id
        for m in web_resp.messages
    )
    assert not db.exec(
        select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
    ).all()

    # 2. IM (Feishu): truncated reason -> direct=True blocked -> falls back to ReviewCard
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(
                        req_only, decision="rejected", reason="缺少指标"
                    ),
                }
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": {
                        "request_id": str(req_only.id),
                        "revision": req_only.revision,
                        "direct": False,
                        "decisions": [
                            {
                                "item_id": str(req_only.items[0].id),
                                "decision": "rejected",
                                "reason": "缺少指标与告警演练数据",
                            }
                        ],
                    },
                }
            ]
        },
        "请确认审批决定卡片。",
    ]
    incoming = Event(
        platform="feishu",
        org_id=mgr.org_id,
        event_id="nere1230-feishu-fallback",
        external_user_id="synthetic-user",
        external_chat_id="synthetic-chat",
        text="拒绝可观测性那条请求，原因：缺少指标与告警演练数据",
    )
    im_reply = im_actions.text(db, mgr, incoming, "synthetic-app")
    im_cards = [
        m
        for m in im_reply.response.messages
        if isinstance(m, bot_schemas.ReviewCard) and m.id == req_only.id
    ]
    assert len(im_cards) == 1
    rendered_text, offered_buttons = im_rendering.render(im_cards[0])
    assert "缺少指标与告警演练数据" in rendered_text
    assert [b["action"] for b in offered_buttons] == [
        "confirm_review",
        "continue_review",
    ]
    assert not db.exec(
        select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
    ).all()
    row = db.get(ProfileChangeRequest, req_only.id, populate_existing=True)
    assert row is not None and row.status == RequestStatus.PENDING_REVIEW


@pytest.mark.slow
def test_single_pending_fresh_session_ambiguous_blocked_on_web_and_im(
    demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch, pi_service: PiHarness
) -> None:
    _, req_only = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "observability", "statement": "s1"}],
    )
    mgr = manager(db, demo)
    enable_model(db, mgr.org_id)
    db.commit()
    monkeypatch.setattr(bot_core, "model_config", lambda _: pi_service.config)

    # 1. Direct tool call in fresh session with 1 pending request and no target -> blocked
    for channel, phrase, decision, reason in (
        ("web", "批准", "approved", None),
        ("web", "拒绝，原因：缺少监控指标截图", "rejected", "缺少监控指标截图"),
        ("feishu", "批准", "approved", None),
        ("feishu", "拒绝，原因：缺少监控指标截图", "rejected", "缺少监控指标截图"),
    ):
        fresh = bot_store.create_session(
            db,
            mgr,
            channel,
            "chat-fresh" if channel == "feishu" else None,
            "bot-1" if channel == "feishu" else None,
        )
        db.commit()
        err = bot_tools.call(
            db,
            mgr,
            fresh,
            [],
            "prepare_review_decision",
            _direct_args(req_only, decision=decision, reason=reason),
            turn_text=phrase,
        )
        assert isinstance(err, dict) and "error" in err
        assert not db.exec(
            select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
        ).all()

    # 2. Web turn: fresh session + 1 pending + "批准" -> direct=True blocked, falls back to ReviewCard;
    #    fresh session + 1 pending + "拒绝，原因：..." -> direct=True blocked, falls back to clarification text
    web_card_session = bot_store.create_session(db, mgr, "web")
    web_ask_session = bot_store.create_session(db, mgr, "web")
    db.commit()
    pi_service.replies = [
        {
            "calls": [
                {"name": "get_review", "arguments": {"request_id": str(req_only.id)}}
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(req_only),
                }
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": {
                        "request_id": str(req_only.id),
                        "revision": req_only.revision,
                        "direct": False,
                        "decisions": [
                            {
                                "item_id": str(req_only.items[0].id),
                                "decision": "approved",
                            }
                        ],
                    },
                }
            ]
        },
        "请确认要批准的具体审批请求。",
    ]
    web_resp = bot_core.turn(db, mgr, web_card_session.id, "批准")
    db.commit()
    assert any(
        isinstance(m, bot_schemas.ReviewCard) and m.id == req_only.id
        for m in web_resp.messages
    )

    reason = "缺少监控指标与告警演练数据"
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(
                        req_only, decision="rejected", reason=reason
                    ),
                }
            ]
        },
        "请说明要拒绝哪位员工或哪项能力的审批请求。",
    ]
    web_ask_resp = bot_core.turn(db, mgr, web_ask_session.id, f"拒绝，原因：{reason}")
    db.commit()
    assert not any(isinstance(m, bot_schemas.ReviewCard) for m in web_ask_resp.messages)
    assert "哪位员工" in web_ask_resp.messages[0].text

    # 3. IM (Feishu) turns: fresh session + 1 pending + "批准" -> clarification or ReviewCard;
    #    fresh session + 1 pending + "拒绝，原因：..." -> ReviewCard
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(req_only),
                }
            ]
        },
        "请先明确要批准的具体审批请求。",
    ]
    im_ask = im_actions.text(
        db,
        mgr,
        Event(
            platform="feishu",
            org_id=mgr.org_id,
            event_id="nere1231-feishu-fresh-approve",
            external_user_id="synthetic-user",
            external_chat_id="synthetic-chat-fresh-approve",
            text="批准",
        ),
        "synthetic-app",
    )
    assert not any(
        isinstance(m, bot_schemas.ReviewCard) for m in im_ask.response.messages
    )
    assert "明确" in im_ask.response.messages[0].text

    pi_service.replies = [
        {
            "calls": [
                {"name": "get_review", "arguments": {"request_id": str(req_only.id)}}
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(
                        req_only, decision="rejected", reason=reason
                    ),
                }
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": {
                        "request_id": str(req_only.id),
                        "revision": req_only.revision,
                        "direct": False,
                        "decisions": [
                            {
                                "item_id": str(req_only.items[0].id),
                                "decision": "rejected",
                                "reason": reason,
                            }
                        ],
                    },
                }
            ]
        },
        "请核对后点击确认拒绝。",
    ]
    incoming = Event(
        platform="feishu",
        org_id=mgr.org_id,
        event_id="nere1231-feishu-fresh-ambiguous",
        external_user_id="synthetic-user",
        external_chat_id="synthetic-chat-fresh",
        text=f"拒绝，原因：{reason}",
    )
    im_reply = im_actions.text(db, mgr, incoming, "synthetic-app")
    im_cards = [
        m
        for m in im_reply.response.messages
        if isinstance(m, bot_schemas.ReviewCard) and m.id == req_only.id
    ]
    assert len(im_cards) == 1
    rendered_text, offered_buttons = im_rendering.render(im_cards[0])
    assert reason in rendered_text
    assert [b["action"] for b in offered_buttons] == [
        "confirm_review",
        "continue_review",
    ]

    # 4. Unrelated prior turn (get_member_profile, no review inspection) does not authorize bare "批准"
    unrelated_session = bot_store.create_session(db, mgr, "web")
    db.commit()
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "get_member_profile",
                    "arguments": {"employee_id": str(demo[1]["E02"].id)},
                }
            ]
        },
        "已为你查看张伟的当前画像。",
    ]
    bot_core.turn(
        db, mgr, unrelated_session.id, f"看看{demo[1]['E02'].display_name}的画像"
    )
    db.commit()
    for phrase in ("批准", "批准这条"):
        err = bot_tools.call(
            db,
            mgr,
            unrelated_session,
            [],
            "prepare_review_decision",
            _direct_args(req_only),
            turn_text=phrase,
        )
        assert isinstance(err, dict) and "error" in err

    assert not db.exec(
        select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
    ).all()
    row = db.get(ProfileChangeRequest, req_only.id, populate_existing=True)
    assert row is not None and row.status == RequestStatus.PENDING_REVIEW


@pytest.mark.slow
def test_single_pending_explicit_or_bound_context_direct_decision_web_and_im(
    demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch, pi_service: PiHarness
) -> None:
    _, req_web_ctx = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "automated_testing", "statement": "s1"}],
    )
    mgr = manager(db, demo)
    enable_model(db, mgr.org_id)
    db.commit()
    monkeypatch.setattr(bot_core, "model_config", lambda _: pi_service.config)

    # 1. Web: prior turn inspects the single pending request via get_review, next turn says "批准" -> succeeds
    web_session = bot_store.create_session(db, mgr, "web")
    db.commit()
    pi_service.replies = [
        {
            "calls": [
                {"name": "get_review", "arguments": {"request_id": str(req_web_ctx.id)}}
            ]
        },
        "张伟提交了自动化测试能力修改请求。",
    ]
    bot_core.turn(db, mgr, web_session.id, "看看自动化测试那条请求")
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(req_web_ctx),
                }
            ]
        },
        "已批准自动化测试修改请求。",
    ]
    web_ok = bot_core.turn(db, mgr, web_session.id, "批准")
    db.commit()
    assert not any(isinstance(m, bot_schemas.ReviewCard) for m in web_ok.messages)
    d_web = db.exec(
        select(ReviewDecision).where(
            ReviewDecision.org_id == mgr.org_id,
            ReviewDecision.request_id == req_web_ctx.id,
        )
    ).one()
    assert (d_web.via, d_web.client_name) == ("bot", "网页")

    # 2. Web: explicit single-request verbatim rejection in fresh session -> succeeds
    _, req_web_reject = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "observability", "statement": "s2"}],
    )
    web_reject_session = bot_store.create_session(db, mgr, "web")
    db.commit()
    web_reason = "请补充生产环境监控覆盖证明"
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(
                        req_web_reject, decision="rejected", reason=web_reason
                    ),
                }
            ]
        },
        "已拒绝可观测性修改请求。",
    ]
    web_reject_resp = bot_core.turn(
        db,
        mgr,
        web_reject_session.id,
        f"拒绝可观测性那条请求，原因：{web_reason}",
    )
    db.commit()
    assert not any(
        isinstance(m, bot_schemas.ReviewCard) for m in web_reject_resp.messages
    )
    item_web = db.get(ChangeItem, req_web_reject.items[0].id, populate_existing=True)
    assert item_web is not None and item_web.decision_reason == web_reason

    # 3. IM (Feishu): explicit single-request direct approval in fresh session -> succeeds
    _, req_im_explicit = pending(
        db,
        demo,
        items=[{"op": "modify", "capability_key": "backend_api", "statement": "s3"}],
    )
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "get_review",
                    "arguments": {"request_id": str(req_im_explicit.id)},
                }
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(req_im_explicit),
                }
            ]
        },
        "已批准后端 API 开发修改请求。",
    ]
    im_ok = im_actions.text(
        db,
        mgr,
        Event(
            platform="feishu",
            org_id=mgr.org_id,
            event_id="nere1231-feishu-explicit-approve",
            external_user_id="synthetic-user",
            external_chat_id="synthetic-chat-explicit",
            text=f"批准{demo[1]['E02'].display_name}的后端 API 开发请求",
        ),
        "synthetic-app",
    )
    assert not any(
        isinstance(m, bot_schemas.ReviewCard) for m in im_ok.response.messages
    )
    d_im = db.exec(
        select(ReviewDecision).where(
            ReviewDecision.org_id == mgr.org_id,
            ReviewDecision.request_id == req_im_explicit.id,
        )
    ).one()
    assert (d_im.via, d_im.client_name) == ("bot", "飞书")
    audit_im = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == mgr.org_id,
            AuditEvent.action == "change_request.decided",
            AuditEvent.target_id == str(req_im_explicit.id),
        )
    ).one()
    assert (audit_im.details["via"], audit_im.details["client_name"]) == ("bot", "飞书")

    # 4. IM (Feishu): valid ReviewCard context + bare verbatim rejection -> succeeds
    _, req_im_card = pending(
        db,
        demo,
        items=[
            {"op": "modify", "capability_key": "automated_testing", "statement": "s4"}
        ],
    )
    im_reason = "请补充压测与回滚验证记录"
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": {
                        "request_id": str(req_im_card.id),
                        "revision": req_im_card.revision,
                        "direct": False,
                        "decisions": [
                            {
                                "item_id": str(req_im_card.items[0].id),
                                "decision": "approved",
                            }
                        ],
                    },
                }
            ]
        },
        "已为你生成确认卡。",
    ]
    im_actions.text(
        db,
        mgr,
        Event(
            platform="feishu",
            org_id=mgr.org_id,
            event_id="nere1231-feishu-card-setup",
            external_user_id="synthetic-user",
            external_chat_id="synthetic-chat-ctx",
            text="先出自动化测试确认卡",
        ),
        "synthetic-app",
    )
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(
                        req_im_card, decision="rejected", reason=im_reason
                    ),
                }
            ]
        },
        "已拒绝该修改请求。",
    ]
    im_ctx_reject = im_actions.text(
        db,
        mgr,
        Event(
            platform="feishu",
            org_id=mgr.org_id,
            event_id="nere1231-feishu-ctx-reject",
            external_user_id="synthetic-user",
            external_chat_id="synthetic-chat-ctx",
            text=f"拒绝，原因：{im_reason}",
        ),
        "synthetic-app",
    )
    assert not any(
        isinstance(m, bot_schemas.ReviewCard) for m in im_ctx_reject.response.messages
    )
    item_im = db.get(ChangeItem, req_im_card.items[0].id, populate_existing=True)
    assert item_im is not None and item_im.decision_reason == im_reason


@pytest.mark.parametrize(
    "template",
    [
        # Tentative / modal / hedging (including first-person `might`)
        "I might approve {emp}'s request",
        "I might approve {emp}'s {cap} request",
        "I may approve {emp}'s request",
        "Maybe approve {emp}'s request",
        "Perhaps I should approve {emp}'s request",
        "I could approve {emp}'s request",
        "I would approve {emp}'s request",
        "I'm thinking about approving {emp}'s request",
        "Not sure if I should approve {emp}'s request",
        "I might reject {emp}'s request: missing metrics",
        # Future plans / intentions / deferrals / desires
        "I will approve {emp}'s request tomorrow",
        "I'll approve {emp}'s request later",
        "I'm going to approve {emp}'s request next week",
        "I plan to approve {emp}'s request",
        "I want to approve {emp}'s request",
        "I'd like to approve {emp}'s request",
        "Approve {emp}'s request tomorrow",
        "Approve {emp}'s request once she updates the evidence",
        "Hold off on approving {emp}'s request",
        # Attribution / reported speech / quotes / conditionals / past narration
        "{emp} asked me to approve her request",
        "Bob told me to approve {emp}'s request",
        "The document says approve {emp}'s request",
        'She wrote "approve" in the note for {emp}',
        "If evidence is sufficient, approve {emp}'s request",
        "{emp}'s request was approved",
        "Let's approve {emp}'s request",
        "To approve {emp}'s request, click confirm",
        "Please remind me to approve {emp}'s request",
        # Negations (including intervening adverbs/clauses)
        "Do not approve {emp}'s request",
        "Don't just approve {emp}'s request",
        "I don't want to approve {emp}'s request",
        "I'm not approving {emp}'s request",
        "Refuse to approve {emp}'s request",
        "Never approve {emp}'s request",
        # Inquiries / previews / card requests (with and without '?')
        "Should I approve {emp}'s request",
        "Can I approve {emp}'s request?",
        "Give me a card to approve {emp}'s request",
        "Let me check {emp}'s request before approving",
        "Approve {emp}'s request, right",
        # Batch / unclear or mismatched target
        "Approve all pending requests",
        "Approve UnknownEmployee's request",
        "Approve",
        "Approve this",
    ],
)
def test_english_non_explicit_direct_review_blocked_across_web_and_im(
    demo: tuple, db: Session, template: str
) -> None:
    _, req = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "automated_testing", "statement": "s1"}],
    )
    mgr = manager(db, demo)
    emp_name = demo[1]["E02"].display_name
    turn_text = template.format(emp=emp_name, cap="自动化测试")

    for channel in ("web", "feishu"):
        session = bot_store.create_session(
            db,
            mgr,
            channel,
            "chat-en-guard" if channel == "feishu" else None,
            "bot-1" if channel == "feishu" else None,
        )
        db.commit()
        decision = "rejected" if "reject" in turn_text.lower() else "approved"
        reason = "missing metrics" if decision == "rejected" else None
        result = bot_tools.call(
            db,
            mgr,
            session,
            [],
            "prepare_review_decision",
            _direct_args(req, decision=decision, reason=reason),
            turn_text=turn_text,
        )
        assert isinstance(result, dict) and "error" in result
        assert not db.exec(
            select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
        ).all()
        row = db.get(ProfileChangeRequest, req.id, populate_existing=True)
        assert row is not None and row.status == RequestStatus.PENDING_REVIEW


def test_english_tentative_falls_back_to_card_and_mismatched_subject_blocked_with_context(
    demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch, pi_service: PiHarness
) -> None:
    _, req = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "automated_testing", "statement": "s1"}],
    )
    mgr = manager(db, demo)
    enable_model(db, mgr.org_id)
    emp_name = demo[1]["E02"].display_name
    monkeypatch.setattr(bot_core, "model_config", lambda _: pi_service.config)

    # 1. Web: "I might approve ..." -> direct=True blocked -> falls back to confirmation card
    web_session = bot_store.create_session(db, mgr, "web")
    db.commit()
    pi_service.replies = [
        {"calls": [{"name": "get_review", "arguments": {"request_id": str(req.id)}}]},
        {
            "calls": [
                {"name": "prepare_review_decision", "arguments": _direct_args(req)}
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": {
                        "request_id": str(req.id),
                        "revision": req.revision,
                        "direct": False,
                        "decisions": [
                            {"item_id": str(req.items[0].id), "decision": "approved"}
                        ],
                    },
                }
            ]
        },
        "Generated a confirmation card for you to review.",
    ]
    web_resp = bot_core.turn(
        db, mgr, web_session.id, f"I might approve {emp_name}'s request"
    )
    db.commit()
    assert any(
        isinstance(m, bot_schemas.ReviewCard) and m.id == req.id
        for m in web_resp.messages
    )
    assert not db.exec(
        select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
    ).all()

    # 2. IM (Feishu): "I might approve ..." -> direct=True blocked -> falls back to ReviewCard
    pi_service.replies = [
        {
            "calls": [
                {"name": "prepare_review_decision", "arguments": _direct_args(req)}
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": {
                        "request_id": str(req.id),
                        "revision": req.revision,
                        "direct": False,
                        "decisions": [
                            {"item_id": str(req.items[0].id), "decision": "approved"}
                        ],
                    },
                }
            ]
        },
        "Please confirm on the review card.",
    ]
    im_reply = im_actions.text(
        db,
        mgr,
        Event(
            platform="feishu",
            org_id=mgr.org_id,
            event_id="nere1468-feishu-might",
            external_user_id="synthetic-user",
            external_chat_id="synthetic-chat-might",
            text=f"I might approve {emp_name}'s request",
        ),
        "synthetic-app",
    )
    assert any(
        isinstance(m, bot_schemas.ReviewCard) and m.id == req.id
        for m in im_reply.response.messages
    )
    assert not db.exec(
        select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
    ).all()

    # 3. Trusted session context for `req` + mismatched English subject -> still blocked
    ctx_session = bot_store.create_session(db, mgr, "web")
    ctx_cards: list[bot_schemas.Message] = []
    bot_tools.call(
        db,
        mgr,
        ctx_session,
        ctx_cards,
        "prepare_review_decision",
        {
            "request_id": str(req.id),
            "revision": req.revision,
            "decisions": [{"item_id": str(req.items[0].id), "decision": "approved"}],
        },
    )
    bot_store.append_message(
        db, ctx_session, "user", {"text": f"Check {emp_name}'s request"}
    )
    bot_core._save(db, ctx_session, ctx_cards)
    db.commit()
    mismatch = bot_tools.call(
        db,
        mgr,
        ctx_session,
        [],
        "prepare_review_decision",
        _direct_args(req),
        turn_text="Approve Bob's request",
    )
    assert isinstance(mismatch, dict) and "error" in mismatch
    assert not db.exec(
        select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
    ).all()


def test_english_explicit_direct_approve_reject_and_authz_web_and_im(
    demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch, pi_service: PiHarness
) -> None:
    owner, req_approve = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "automated_testing", "statement": "s1"}],
    )
    _, req_reject = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "observability", "statement": "s2"}],
    )
    mgr = manager(db, demo)
    enable_model(db, mgr.org_id)
    emp_name = demo[1]["E02"].display_name
    monkeypatch.setattr(bot_core, "model_config", lambda _: pi_service.config)

    # 1. Explicit English single-request approval on web
    web_session = bot_store.create_session(db, mgr, "web")
    db.commit()
    pi_service.replies = [
        {
            "calls": [
                {"name": "get_review", "arguments": {"request_id": str(req_approve.id)}}
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(req_approve),
                }
            ]
        },
        "Approved.",
    ]
    web_res = bot_core.turn(
        db, mgr, web_session.id, f"Please approve {emp_name}'s 自动化测试 request"
    )
    db.commit()
    assert not any(isinstance(m, bot_schemas.ReviewCard) for m in web_res.messages)
    d_approve = db.exec(
        select(ReviewDecision).where(
            ReviewDecision.org_id == mgr.org_id,
            ReviewDecision.request_id == req_approve.id,
        )
    ).one()
    assert (d_approve.via, d_approve.client_name) == ("bot", "网页")
    audit_approve = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == mgr.org_id,
            AuditEvent.action == "change_request.decided",
            AuditEvent.target_id == str(req_approve.id),
        )
    ).one()
    assert (audit_approve.details["via"], audit_approve.details["client_name"]) == (
        "bot",
        "网页",
    )

    # 2. Explicit English rejection with verbatim reason on IM (Feishu)
    verbatim_reason = "missing verifiable production monitoring metrics"
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(
                        req_reject, decision="rejected", reason=verbatim_reason
                    ),
                }
            ]
        },
        "Rejected.",
    ]
    im_res = im_actions.text(
        db,
        mgr,
        Event(
            platform="feishu",
            org_id=mgr.org_id,
            event_id="nere1468-feishu-explicit-reject",
            external_user_id="synthetic-user",
            external_chat_id="synthetic-chat-explicit-en",
            text=f"Reject 可观测性 request, reason: {verbatim_reason}.",
        ),
        "synthetic-app",
    )
    assert not any(
        isinstance(m, bot_schemas.ReviewCard) for m in im_res.response.messages
    )
    item_reject = db.get(ChangeItem, req_reject.items[0].id, populate_existing=True)
    assert item_reject is not None and item_reject.decision_reason == verbatim_reason
    d_reject = db.exec(
        select(ReviewDecision).where(
            ReviewDecision.org_id == mgr.org_id,
            ReviewDecision.request_id == req_reject.id,
        )
    ).one()
    assert (d_reject.via, d_reject.client_name) == ("bot", "飞书")
    ev = db.exec(
        select(Evidence).where(
            Evidence.org_id == mgr.org_id,
            Evidence.kind == EvidenceKind.MANAGER_REVIEW,
            Evidence.source_ref == str(d_reject.id),
        )
    ).one()
    assert ev.content["reasons"] == [
        {"item_id": str(item_reject.id), "reason": verbatim_reason}
    ]

    # 3. Principal / scope / self-approval / cross-tenant still enforced for explicit English command
    owner_session = bot_store.create_session(db, owner, "web")
    other = actor(db, mgr.org_id, "employee.algorithm@demo.example.com")
    other_session = bot_store.create_session(db, other, "web")
    _, req_authz = pending(
        db,
        demo,
        items=[{"op": "modify", "capability_key": "backend_api", "statement": "s3"}],
    )
    for bad_actor, bad_session in (
        (owner, owner_session),
        (other, other_session),
        (replace(mgr, org_id=uuid4()), web_session),
    ):
        err = bot_tools.call(
            db,
            bad_actor,
            bad_session,
            [],
            "prepare_review_decision",
            _direct_args(req_authz),
            turn_text=f"Approve {emp_name}'s request",
        )
        assert isinstance(err, dict) and "error" in err
    row_authz = db.get(ProfileChangeRequest, req_authz.id, populate_existing=True)
    assert row_authz is not None and row_authz.status == RequestStatus.PENDING_REVIEW
    employee.withdraw(owner, db, req_authz.id)
    db.commit()

    # 4. Normal factual rejection reason containing benign words ("after the refactor") succeeds on Web
    _, req_factual = pending(
        db,
        demo,
        items=[{"op": "modify", "capability_key": "backend_api", "statement": "s4"}],
    )
    factual_reason = "documentation was not updated after the refactor"
    factual_session = bot_store.create_session(db, mgr, "web")
    db.commit()
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(
                        req_factual, decision="rejected", reason=factual_reason
                    ),
                }
            ]
        },
        "Rejected.",
    ]
    factual_res = bot_core.turn(
        db,
        mgr,
        factual_session.id,
        f"Reject {emp_name}'s request, reason: {factual_reason}.",
    )
    db.commit()
    assert not any(isinstance(m, bot_schemas.ReviewCard) for m in factual_res.messages)
    item_factual = db.get(ChangeItem, req_factual.items[0].id, populate_existing=True)
    assert item_factual is not None and item_factual.decision_reason == factual_reason


def test_english_parse_turn_decision_variants() -> None:
    from app.domains.change_request.models import ItemDecision

    for approve_text in (
        "Approve Alice's request",
        "Approve May's request",
        "Approve Will's request",
        "Please approve Alice's request",
        "Go ahead and approve Alice's request",
        "Yes, approve Alice's request",
        "I approve Alice's request",
        "I hereby approve Alice's request",
        "I'm approving Alice's request",
    ):
        parsed = bot_reviews._parse_turn_decision(approve_text, set())
        assert isinstance(parsed, tuple) and parsed[0] == ItemDecision.APPROVED, (
            approve_text
        )

    for reject_text, expected_reason in (
        (
            "Decline Alice's request: missing metrics",
            "missing metrics",
        ),
        (
            "Deny Alice's request due to insufficient evidence",
            "insufficient evidence",
        ),
        (
            "Reject Alice's request. Missing verifiable project metrics.",
            "Missing verifiable project metrics",
        ),
        (
            "Reject Alice's request: missing project details",
            "missing project details",
        ),
        (
            "Reject Alice's request: failed security check",
            "failed security check",
        ),
        (
            "Reject Alice's request because documentation was not updated after the refactor",
            "documentation was not updated after the refactor",
        ),
        (
            "Reject Alice's request: missing metrics from when she led the migration",
            "missing metrics from when she led the migration",
        ),
        (
            "Reject Alice's request: test coverage should be above 80%",
            "test coverage should be above 80%",
        ),
        (
            "Reject Alice's request: missing load test report. Please attach CI logs.",
            "missing load test report. Please attach CI logs",
        ),
    ):
        parsed = bot_reviews._parse_turn_decision(reject_text, set())
        assert isinstance(parsed, tuple)
        assert parsed[0] == ItemDecision.REJECTED
        assert parsed[1] == expected_reason

    for non_explicit in (
        "I might approve Alice's request",
        "I may approve Alice's request",
        "I'll approve Alice's request later",
        "Approve button is broken",
        "Alice's request: maybe approve",
        "Alice's note says I'm supposed to approve",
        "She wrote 'approve Alice's request' in the doc",
        "Approve Alice's request after I review",
        "Approve Alice's request after my review",
        "Approve Alice's request pending final review",
        "Approve Alice's request, pending final review",
        "Approve Alice's request (pending final review)",
        "Approve Alice's request subject to final sign-off",
        "Approve Alice's request until I verify the metrics",
        "Approve Alice's request once verified",
        "Approve Alice's request awaiting confirmation",
        "Approve Alice's request for now",
        "Approve Alice's request following code review",
        "Approve Alice pending final review",
        "Approve this request pending final review",
        "Approve this after I review",
        "Reject Alice's request, pending final review",
        "Reject Alice's request after I review, reason: missing metrics",
        "Reject Alice's request, reason: missing metrics. Hold off until I review.",
        "Reject Alice's request: missing metrics. Do not submit yet.",
        "Reject Alice's request: missing metrics. Wait for my confirmation.",
        "Reject Alice's request: missing metrics. I will confirm after final review.",
        "Reject Alice's request: missing metrics. Send me a confirmation card first.",
        "Reject Alice's request: missing metrics; please check and approve if updated.",
        "Reject Alice's request because metrics are missing, pending final review",
        "Reject Alice's request: missing metrics, pending final review",
        "Reject Alice's request, reason: missing metrics after I review",
        "Reject Alice's request: missing metrics until I verify",
        "Reject Alice's request: missing metrics, subject to final sign-off",
        "Reject Alice's request: missing metrics, for now",
        "Reject Alice's request: missing metrics unless she attaches CI logs",
        "Reject Alice's request: missing metrics, pending.",
        "Reject Alice's request: missing metrics, send confirmation card",
        'Approve Alice\'s request "pending review"',
    ):
        assert isinstance(bot_reviews._parse_turn_decision(non_explicit, set()), str), (
            non_explicit
        )
        assert isinstance(
            bot_reviews._parse_turn_decision(non_explicit, {"Alice", "Backend API"}),
            str,
        ), non_explicit


@pytest.mark.parametrize(
    "template",
    [
        "Approve {emp}'s request after I review",
        "Approve {emp}'s request pending final review",
        "Approve {emp}'s request, pending final review",
        "Approve {emp}'s request subject to final sign-off",
        "Approve {emp}'s request until I verify the metrics",
        "Approve {emp}'s request for now",
        "Approve {emp} pending final review",
        "Reject {emp}'s request, pending final review",
        "Reject {emp}'s request after I review, reason: missing metrics",
        "Reject {emp}'s request, reason: missing metrics. Hold off until I review.",
        "Reject {emp}'s request: missing metrics. Do not submit yet.",
        "Reject {emp}'s request because metrics are missing, pending final review",
        "Reject {emp}'s request, reason: missing metrics after I review",
        "Reject {emp}'s request: missing metrics, subject to final sign-off",
    ],
)
def test_english_trailing_condition_or_pending_review_blocked_on_web_and_im(
    demo: tuple,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    pi_service: PiHarness,
    template: str,
) -> None:
    _, req = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "automated_testing", "statement": "s1"}],
    )
    mgr = manager(db, demo)
    enable_model(db, mgr.org_id)
    emp_name = demo[1]["E02"].display_name
    turn_text = template.format(emp=emp_name)
    decision = "rejected" if "Reject" in turn_text else "approved"
    reason = "missing metrics" if decision == "rejected" else None
    monkeypatch.setattr(bot_core, "model_config", lambda _: pi_service.config)

    # 1. Direct tool call gate blocks on both web & IM
    for channel in ("web", "feishu"):
        session = bot_store.create_session(
            db,
            mgr,
            channel,
            "chat-cond" if channel == "feishu" else None,
            "bot-1" if channel == "feishu" else None,
        )
        db.commit()
        err = bot_tools.call(
            db,
            mgr,
            session,
            [],
            "prepare_review_decision",
            _direct_args(req, decision=decision, reason=reason),
            turn_text=turn_text,
        )
        assert isinstance(err, dict) and "error" in err

    # 2. End-to-end Web & IM turns keep the request pending and fall back to ReviewCard
    card_decisions = [
        {"item_id": str(req.items[0].id), "decision": decision}
        if reason is None
        else {"item_id": str(req.items[0].id), "decision": decision, "reason": reason}
    ]
    web_session = bot_store.create_session(db, mgr, "web")
    db.commit()
    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(req, decision=decision, reason=reason),
                }
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": {
                        "request_id": str(req.id),
                        "revision": req.revision,
                        "direct": False,
                        "decisions": card_decisions,
                    },
                }
            ]
        },
        "Please confirm on the review card.",
    ]
    web_resp = bot_core.turn(db, mgr, web_session.id, turn_text)
    db.commit()
    assert any(
        isinstance(m, bot_schemas.ReviewCard) and m.id == req.id
        for m in web_resp.messages
    )

    pi_service.replies = [
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": _direct_args(req, decision=decision, reason=reason),
                }
            ]
        },
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": {
                        "request_id": str(req.id),
                        "revision": req.revision,
                        "direct": False,
                        "decisions": card_decisions,
                    },
                }
            ]
        },
        "Please confirm on the review card.",
    ]
    suffix = uuid4().hex
    im_resp = im_actions.text(
        db,
        mgr,
        Event(
            platform="feishu",
            org_id=mgr.org_id,
            event_id=f"nere1468-cond-{suffix}",
            external_user_id="synthetic-user",
            external_chat_id=f"chat-cond-{suffix}",
            text=turn_text,
        ),
        "synthetic-app",
    )
    assert any(
        isinstance(m, bot_schemas.ReviewCard) and m.id == req.id
        for m in im_resp.response.messages
    )
    assert not db.exec(
        select(ReviewDecision).where(ReviewDecision.org_id == mgr.org_id)
    ).all()
    row = db.get(ProfileChangeRequest, req.id, populate_existing=True)
    assert row is not None and row.status == RequestStatus.PENDING_REVIEW
