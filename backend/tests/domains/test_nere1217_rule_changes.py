"""Tests for NERE-1217 (E51): no-approval policy, approve/reject unification, and direct bot review."""

import json
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlmodel import Session, select

from app.domains.admin_assistant import change_set as admin_change_set
from app.domains.admin_assistant import registry as admin_registry
from app.domains.admin_assistant import store as admin_store
from app.domains.admin_assistant.schemas import ProposeChanges
from app.domains.audit.models import AuditEvent
from app.domains.bot import core as bot_core
from app.domains.bot import schemas as bot_schemas
from app.domains.bot import store as bot_store
from app.domains.bot import tools as bot_tools
from app.domains.capability.service import get_schema, list_capabilities
from app.domains.capacity.models import CapacitySetting, CapacityWeek
from app.domains.change_request import employee
from app.domains.change_request.claim import ClaimAfter
from app.domains.change_request.models import (
    ProfileChangeRequest,
    RequestOrigin,
    RequestStatus,
    ReviewDecision,
)
from app.domains.change_request.schemas import ItemInput
from app.domains.drafting import incremental
from app.domains.drafting import service as drafting_service
from app.domains.drafting.collect import task_groups
from app.domains.drafting.model import DraftItem
from app.domains.evidence.models import Evidence
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.org.models import Employee, ExternalIdentity, OrgMembership
from app.domains.profile.models import (
    AssessmentStatus,
    ClaimEvidence,
    Confidence,
    ProfileClaim,
    ProfileVersion,
)
from app.domains.profile.service import build_profile_snapshot
from app.domains.review import policy
from app.domains.review.models import ApprovalPolicy
from app.domains.review.publish import current_claims
from app.domains.review.schemas import DecisionInput
from app.models import User
from tests.api.routes.test_mcp import call as mcp_call
from tests.api.routes.test_mcp import initialize as mcp_init
from tests.api.routes.test_mcp import token_for
from tests.api.routes.test_reviews import actor, manager, pending
from tests.authz.test_tenant_access import tenant_data  # noqa: F401
from tests.domains.test_bot_core import enable as enable_model
from tests.domains.test_drafting_model import drafting  # noqa: F401
from tests.domains.test_ingest import ingest, person, record, rows
from tests.utils.pi import PiHarness


def _save_policy(client: TestClient, demo: tuple, **values: object) -> dict:
    response = client.put(
        f"{demo[0]}/approval-policy", headers=demo[2]["admin"], json=values
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_r1_no_approval_policy_toggle_and_versions(
    demo: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = demo
    org_id = employees["E02"].org_id
    initial = client.get(f"{url}/approval-policy", headers=auth["admin"]).json()
    assert "no_approval" not in initial["current"]
    assert initial["current"]["no_approval_category_overrides"] == {}
    category = initial["categories"][0]
    other_category = initial["categories"][1]
    assert category != other_category

    # Org-wide no_approval=True must be rejected via REST and Admin Assistant.
    rejected = client.put(
        f"{url}/approval-policy",
        headers=auth["admin"],
        json={"no_approval": True},
    )
    assert rejected.status_code == 422

    entry = admin_registry.FUNCTIONS["update_approval_policy"]
    assert "no_approval" not in entry.input_model.model_fields
    admin = actor(db, org_id, "admin@demo.example.com")
    session = admin_store.create_session(db, admin)
    db.commit()
    with pytest.raises(Exception) as exc_info:
        admin_change_set.propose(
            db,
            admin,
            session.id,
            ProposeChanges.model_validate(
                {
                    "items": [
                        {
                            "function": "update_approval_policy",
                            "args": {"no_approval": True},
                        }
                    ]
                }
            ),
        )
    assert getattr(exc_info.value, "status_code", None) == 422

    first = _save_policy(
        client,
        demo,
        no_approval_category_overrides={category: True},
    )
    assert first["current"]["version"] == 1
    assert "no_approval" not in first["current"]
    assert first["current"]["no_approval_category_overrides"] == {category: True}
    assert set(first["current"]["changed_fields"]) == {
        "no_approval_category_overrides",
    }
    saved_row = db.exec(
        select(ApprovalPolicy).where(
            ApprovalPolicy.org_id == org_id, ApprovalPolicy.version == 1
        )
    ).one()
    assert saved_row.no_approval is False

    # Even if a historical DB row or legacy JSON had no_approval=True,
    # allows_no_approval only permits explicitly enabled categories (never unchecked or new categories).
    legacy_row = ApprovalPolicy(
        org_id=org_id,
        version=2,
        require_manager=True,
        no_approval=True,
        no_approval_category_overrides={category: True},
        created_by_user_id=admin.user_id,
    )
    db.add(legacy_row)
    db.commit()
    read_back = policy.read_policy(db, org_id)
    assert policy.allows_no_approval(read_back, category) is True
    assert policy.allows_no_approval(read_back, other_category) is False
    assert policy.allows_no_approval(read_back, "新增能力类别") is False
    assert policy.allows_no_approval(read_back, None) is False
    assert policy.allows_no_approval(read_back, "") is False

    legacy_json = policy.PolicyPublic.model_validate(
        {
            "no_approval": True,
            "no_approval_category_overrides": {category: True},
        }
    )
    assert policy.allows_no_approval(legacy_json, category) is True
    assert policy.allows_no_approval(legacy_json, "新增能力类别") is False

    bad = client.put(
        f"{url}/approval-policy",
        headers=auth["admin"],
        json={"no_approval_category_overrides": {"不存在类别": True}},
    )
    assert bad.status_code == 422


def test_r1_initial_drafting_no_approval_publishes_confirmed_and_notifies(
    demo: tuple, db: Session, client: TestClient
) -> None:
    org_id = demo[1]["E02"].org_id
    # Create a fresh employee without an initial_sync request so we test initial drafting directly.
    emp = Employee(
        org_id=org_id,
        department_id=demo[1]["E02"].department_id,
        display_name="合成初稿员工",
    )
    db.add(emp)
    db.flush()
    db.add(
        ExternalIdentity(
            org_id=org_id, employee_id=emp.id, source="jira", external_id="draft-new"
        )
    )
    db.flush()
    ingest(
        db,
        org_id,
        record(person(account="draft-new"), key="JIRA-NEW-1"),
    )
    db.commit()

    schema = get_schema(db, org_id)
    caps = list_capabilities(db, org_id, schema.id)
    auto_cap = next(c for c in caps if c.category)
    other_cap = next(c for c in caps if c.category and c.category != auto_cap.category)
    _save_policy(
        client,
        demo,
        no_approval_category_overrides={auto_cap.category: True},
    )
    saved_policy = policy.read_policy(db, org_id)
    assert saved_policy.version == 1

    ev = next(e for e in rows(db, Evidence, org_id) if e.source_ref == "JIRA-NEW-1")
    draft_items = [
        DraftItem(
            op="add",
            capability_id=auto_cap.id,
            after=ClaimAfter(
                statement="Jira 独立完成自动发布能力",
                level="routine",
                assessment_status=AssessmentStatus.TENTATIVE,
                confidence=Confidence.MEDIUM,
            ),
            explanation="自动起草说明",
            uncertainty="待核实",
            evidence={ev.id: "supports"},
        ),
        DraftItem(
            op="add",
            capability_id=other_cap.id,
            after=ClaimAfter(
                statement="需本人确认的能力",
                level="routine",
                assessment_status=AssessmentStatus.TENTATIVE,
                confidence=Confidence.MEDIUM,
            ),
            explanation="普通起草说明",
            uncertainty="待核实",
            evidence={ev.id: "supports"},
        ),
    ]
    processed = drafting_service.postprocess(
        db, org_id, emp, draft_items, caps, task_groups(db, org_id)
    )
    written = drafting_service.write_initial_request(
        db, org_id, emp, processed, {"actor_type": "system_worker"}
    )
    db.commit()
    assert written is True

    # Auto-approved capability is immediately published as CONFIRMED even though Jira-only.
    claims = current_claims(db, org_id, emp.id)
    assert auto_cap.key in claims
    assert claims[auto_cap.key].assessment_status == AssessmentStatus.CONFIRMED
    assert other_cap.key not in claims

    # Non-auto capability remains in PENDING_OWNER initial request.
    initial_req = db.exec(
        select(ProfileChangeRequest).where(
            ProfileChangeRequest.org_id == org_id,
            ProfileChangeRequest.subject_employee_id == emp.id,
            ProfileChangeRequest.origin == RequestOrigin.INITIAL_SYNC,
        )
    ).one()
    assert initial_req.status == RequestStatus.PENDING_OWNER

    # Employee is notified and audit records the policy version and wording.
    inbox_notices = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == org_id,
            InboxItem.recipient_employee_id == emp.id,
            InboxItem.kind == InboxKind.DECIDED,
        )
    ).all()
    assert inbox_notices and "无需审批" in inbox_notices[0].message

    audit = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == org_id,
            AuditEvent.action == "change_request.no_approval_published",
        )
    ).one()
    assert audit.details["policy_version"] == 1
    assert "无需审批规则自动发布" in str(audit.details)


def test_r1_incremental_drafting_no_approval_and_employee_self_submit_excluded(
    drafting: tuple,  # noqa: F811
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    pi_service: PiHarness,
) -> None:
    org_id, schema, _, employees, users = drafting
    emp = employees[0]
    admin_principal = actor(db, org_id, users[0].email)
    caps = list_capabilities(db, org_id, schema.id)
    backend = next(c for c in caps if c.key == "backend_api")
    old_ev = next(e for e in rows(db, Evidence, org_id) if e.source_ref == "API-1")
    old_claim = ProfileClaim(
        org_id=org_id,
        subject_employee_id=emp.id,
        capability_definition_id=backend.id,
        statement="原后端陈述",
        level="routine",
        assessment_status=AssessmentStatus.TENTATIVE,
        confidence=Confidence.MEDIUM,
        explanation="原解释",
        generated_by={"actor_type": "system_worker"},
    )
    db.add(old_claim)
    db.flush()
    db.add(
        ClaimEvidence(
            org_id=org_id,
            claim_id=old_claim.id,
            evidence_id=old_ev.id,
            relation="supports",
        )
    )
    db.flush()
    prev_version = incremental.latest_version(db, org_id, emp.id)
    v1 = ProfileVersion(
        org_id=org_id,
        subject_employee_id=emp.id,
        revision=(prev_version.revision + 1) if prev_version else 1,
        schema_version_id=schema.id,
        published_at=emp.created_at,
        published_by={"actor_type": "system_worker"},
        snapshot=build_profile_snapshot(
            db, org_id=org_id, employee_id=emp.id, claim_ids=[old_claim.id]
        ),
    )
    db.add(v1)
    ingest(db, org_id, record(person(), key="API-INC-1", title="独立完成核心架构"))
    policy.save_policy(
        db,
        admin_principal,
        policy.PolicyInput(
            no_approval_category_overrides={backend.category: True},
            require_manager=True,
        ),
    )
    db.commit()

    monkeypatch.setattr(incremental, "model_config", lambda _: pi_service.config)
    pi_service.replies = [
        json.dumps(
            {
                "items": [
                    {
                        "op": "modify",
                        "capability_key": "backend_api",
                        "statement": "独立完成核心架构升级",
                        "level": "independent_complex",
                        "evidence": ["R1"],
                        "explanation": "增量工作记录",
                        "uncertainty": "无",
                    }
                ],
                "proposals": [],
            },
            ensure_ascii=False,
        )
    ]
    incremental.draft_employee(db, org_id, emp.id)

    db.expire_all()
    claims = current_claims(db, org_id, emp.id)
    assert claims["backend_api"].statement == "独立完成核心架构升级"
    assert claims["backend_api"].assessment_status == AssessmentStatus.CONFIRMED
    inc_notice = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == org_id,
            InboxItem.recipient_employee_id == emp.id,
            InboxItem.kind == InboxKind.DECIDED,
        )
    ).all()
    assert inc_notice and "无需审批" in inc_notice[0].message
    inc_audit = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == org_id,
            AuditEvent.action == "change_request.no_approval_published",
        )
    ).one()
    assert inc_audit.details["policy_version"] == 1

    # Employee's own submission MUST NOT trigger no_approval auto-confirm; still requires manager!
    member = db.exec(
        select(OrgMembership).where(
            OrgMembership.org_id == org_id,
            OrgMembership.employee_id.is_not(None),
        )
    ).first()
    assert member is not None
    owner_principal = actor(db, org_id, db.get(User, member.user_id).email)
    owner_claims = current_claims(db, org_id, owner_principal.employee_id)
    draft = employee.save_draft(
        owner_principal,
        db,
        None,
        [
            ItemInput(
                op="modify" if "backend_api" in owner_claims else "add",
                capability_key="backend_api",
                statement="员工本人主动修改",
                owner_statement="本人提交不走无需审批",
            )
        ],
        "web",
    )
    submitted = employee.submit(owner_principal, db, draft.id, draft.revision, "web")
    assert submitted.status == RequestStatus.PENDING_REVIEW

    # Even with require_manager=False + category no_approval, employee self-submission stays TENTATIVE (never CONFIRMED)
    policy.save_policy(
        db,
        admin_principal,
        policy.PolicyInput(
            no_approval_category_overrides={backend.category: True},
            require_manager=False,
        ),
    )
    draft2 = employee.save_draft(
        owner_principal,
        db,
        None,
        [
            ItemInput(
                op="add",
                capability_key="automated_testing",
                statement="员工自提免经理确认测试",
                owner_statement="本人自提",
            )
        ],
        "web",
    )
    # Withdraw first pending request? No, automated_testing doesn't overlap backend_api
    submitted2 = employee.submit(owner_principal, db, draft2.id, draft2.revision, "web")
    assert submitted2.status == RequestStatus.APPROVED
    assert (
        current_claims(db, org_id, owner_principal.employee_id)[
            "automated_testing"
        ].assessment_status
        == AssessmentStatus.TENTATIVE
    )


@pytest.mark.usefixtures("enable_external_mcp")
def test_r2_only_approve_and_reject_and_reject_allows_resubmit(
    demo: tuple, db: Session, client: TestClient
) -> None:
    owner, request = pending(db, demo)
    item_id = request.items[0].id

    # changes_requested is no longer accepted by DecisionInput / REST / MCP / Bot
    with pytest.raises(ValidationError):
        DecisionInput(item_id=item_id, decision="changes_requested", reason="旧退回")

    res = client.post(
        f"{demo[0]}/reviews/{request.id}/decisions",
        headers=demo[2]["manager"],
        json={
            "revision": request.revision,
            "decisions": [
                {
                    "item_id": str(item_id),
                    "decision": "changes_requested",
                    "reason": "r",
                }
            ],
        },
    )
    assert res.status_code == 422

    # Missing reason for reject fails validation
    no_reason = client.post(
        f"{demo[0]}/reviews/{request.id}/decisions",
        headers=demo[2]["manager"],
        json={
            "revision": request.revision,
            "decisions": [
                {"item_id": str(item_id), "decision": "rejected", "reason": "  "}
            ],
        },
    )
    assert no_reason.status_code == 422

    # Rejecting creates a correction draft for the employee to modify and resubmit
    ok = client.post(
        f"{demo[0]}/reviews/{request.id}/decisions",
        headers=demo[2]["manager"],
        json={
            "revision": request.revision,
            "decisions": [
                {
                    "item_id": str(item_id),
                    "decision": "rejected",
                    "reason": "请补充更详细的项目交付说明",
                }
            ],
        },
    )
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["status"] == "rejected"
    assert body["returned_request_id"] is not None

    # Employee can edit the returned correction draft and resubmit
    reqs = employee.my_requests(owner, db, "all")
    correction = next(r for r in reqs.data if str(r.id) == body["returned_request_id"])
    assert correction.status == RequestStatus.DRAFT
    edited = employee.save_draft(
        owner,
        db,
        correction.id,
        [
            ItemInput(
                op="modify",
                capability_key=correction.items[0].capability.key,
                statement="补充后的能力陈述",
                owner_statement="补充的依据",
            )
        ],
        "web",
    )
    resubmitted = employee.submit(owner, db, edited.id, edited.revision, "web")
    assert resubmitted.status == RequestStatus.PENDING_REVIEW

    # MCP decide_review_items schema only exposes approved and rejected
    headers, _ = token_for(db, demo[1]["E01"])
    active = mcp_init(client, headers)
    mcp_res = mcp_call(
        client,
        active,
        "decide_review_items",
        {
            "request_id": str(resubmitted.id),
            "revision": resubmitted.revision,
            "decisions": [
                {
                    "item_id": str(resubmitted.items[0].id),
                    "decision": "changes_requested",
                    "reason": "bad",
                }
            ],
        },
    )
    assert mcp_res["isError"]


def test_r3_bot_direct_approval_and_guards(
    demo: tuple, db: Session, monkeypatch: pytest.MonkeyPatch, pi_service: PiHarness
) -> None:
    owner, req1 = pending(db, demo)
    mgr = manager(db, demo)
    enable_model(db, mgr.org_id)
    session = bot_store.create_session(db, mgr, "feishu", "chat-1", "bot-1")
    db.commit()

    # 1. Single clear request -> prepare_review_decision(direct=True) executes directly and logs audit (via=bot, client_name=飞书)
    monkeypatch.setattr(bot_core, "model_config", lambda _: pi_service.config)
    pi_service.replies = [
        {"calls": [{"name": "get_review", "arguments": {"request_id": str(req1.id)}}]},
        {
            "calls": [
                {
                    "name": "prepare_review_decision",
                    "arguments": {
                        "request_id": str(req1.id),
                        "revision": req1.revision,
                        "direct": True,
                        "decisions": [
                            {"item_id": str(req1.items[0].id), "decision": "approved"}
                        ],
                    },
                }
            ]
        },
        "已批准张伟的后端 API 开发修改请求。",
    ]
    response = bot_core.turn(
        db, mgr, session.id, f"批准{demo[1]['E02'].display_name}的请求"
    )
    db.commit()
    assert not any(m.type == "review_card" for m in response.messages)
    assert "已批准" in response.messages[0].text
    decision = db.exec(
        select(ReviewDecision).where(
            ReviewDecision.org_id == mgr.org_id, ReviewDecision.request_id == req1.id
        )
    ).one()
    assert decision.via == "bot"
    assert decision.client_name == "飞书"
    audit = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == mgr.org_id,
            AuditEvent.action == "change_request.decided",
            AuditEvent.target_id == str(req1.id),
        )
    ).one()
    assert audit.details["via"] == "bot"
    assert audit.details["client_name"] == "飞书"

    # 2. Multiple pending requests + ambiguous/batch prompt -> blocked on direct execution, forces confirmation card
    _, req2 = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "automated_testing", "statement": "s2"}],
    )
    _, req3 = pending(
        db,
        demo,
        items=[{"op": "add", "capability_key": "observability", "statement": "s3"}],
    )
    for bad_text in (
        "全部批准",
        "批准",
        f"批准{demo[1]['E02'].display_name}的请求",
    ):
        ambiguous = bot_tools.call(
            db,
            mgr,
            session,
            [],
            "prepare_review_decision",
            {
                "request_id": str(req2.id),
                "revision": req2.revision,
                "direct": True,
                "decisions": [
                    {"item_id": str(req2.items[0].id), "decision": "approved"}
                ],
            },
            turn_text=bad_text,
        )
        assert isinstance(ambiguous, dict) and "error" in ambiguous

    # Single clear rejection with reason -> executes directly, creates correction draft, leaves audit
    decided_ids: list = []
    rejected = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        {
            "request_id": str(req2.id),
            "revision": req2.revision,
            "direct": True,
            "decisions": [
                {
                    "item_id": str(req2.items[0].id),
                    "decision": "rejected",
                    "reason": "请补充自动化测试覆盖率数据",
                }
            ],
        },
        decided_review_ids=decided_ids,
        turn_text="拒绝自动化测试那条请求，原因：请补充自动化测试覆盖率数据",
    )
    assert isinstance(rejected, dict) and rejected.get("status") == "rejected"
    assert rejected.get("returned_request_id") is not None

    # Second direct prepare_review_decision in the same turn -> blocked
    second_call = bot_tools.call(
        db,
        mgr,
        session,
        [],
        "prepare_review_decision",
        {
            "request_id": str(req3.id),
            "revision": req3.revision,
            "direct": True,
            "decisions": [{"item_id": str(req3.items[0].id), "decision": "approved"}],
        },
        decided_review_ids=decided_ids,
        turn_text="批准可观测性那条请求",
    )
    assert isinstance(second_call, dict) and "error" in second_call

    # 3. Self-approval is rejected by server
    owner_session = bot_store.create_session(db, owner, "web")
    self_err = bot_tools.call(
        db,
        owner,
        owner_session,
        [],
        "prepare_review_decision",
        {
            "request_id": str(req3.id),
            "revision": req3.revision,
            "direct": True,
            "decisions": [{"item_id": str(req3.items[0].id), "decision": "approved"}],
        },
        turn_text=f"批准{demo[1]['E02'].display_name}的请求",
    )
    assert isinstance(self_err, dict) and "error" in self_err

    # 4. Direct profile edit & team workload still produce confirmation cards and do not write until confirmed
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
                    "other_percent": 10,
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
