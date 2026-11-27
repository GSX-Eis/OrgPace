import asyncio
import string
from collections.abc import Generator
from datetime import date, timedelta
from typing import Any
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import delete
from sqlmodel import Session, col, select

import app.main
from app.core.db import engine
from app.domains.base import utc_now
from app.domains.capacity import assistant as capacity_assistant
from app.domains.capacity import calendar, forecast, forecast_policy
from app.domains.capacity.assignment_schemas import AssignmentUpdateInput
from app.domains.capacity.demand_schemas import DemandInput, DemandPublic
from app.domains.capacity.models import (
    CapacityAssignment,
    CapacityDemand,
    CapacityExtensionRequest,
    CapacitySetting,
    CapacityUnavailability,
    CapacityWeek,
    CapacityWeekForecast,
    CapacityWorkloadRequest,
    DemandStatus,
    TrackingState,
)
from app.domains.capacity.schemas import (
    UnavailabilityInput,
    WorkloadDecisionInput,
)
from app.domains.capacity.tracking import demand_tracking_risk
from app.domains.capacity.workload import (
    decide_workload_request,
    register_unavailability,
    request_workload_change,
)
from app.domains.change_request import employee as change_employee
from app.domains.change_request.models import ChangeOp, RequestStatus
from app.domains.change_request.schemas import ItemInput
from app.domains.im import binding, notifications
from app.domains.im.adapters.base import Adapter
from app.domains.im.adapters.telegram import Telegram
from app.domains.im.models import ImNotification
from app.domains.inbox.models import InboxItem
from app.domains.model.schemas import ConnectionTest
from app.domains.org.models import Organization, OrgMembership, Role, RoleGrant
from app.domains.org.roster.diff import compute_roster_diff
from app.domains.org.roster.schemas import ParsedRoster, RosterIssue
from app.domains.planning import validator as planning_validator
from app.domains.planning.models import OptionKind, PlanVerdict
from app.domains.planning.schemas import OptionPublic
from app.i18n import EN_CATALOG, tr, use_locale
from app.i18n.en_assistant import EN as EN_ASSISTANT
from app.i18n.en_capacity import EN as EN_CAPACITY
from app.i18n.en_core import EN as EN_CORE
from app.i18n.en_domains import EN as EN_DOMAINS
from app.models import User
from tests.api.routes.test_reviews import actor
from tests.domains.test_im_gateway import TOKEN, enable, principal


@pytest.fixture
def capacity_clean(demo: tuple[Any, ...], db: Session) -> Generator[tuple[Any, ...]]:
    yield demo
    db.rollback()
    org_id = demo[1]["E01"].org_id
    for model in (
        CapacityUnavailability,
        CapacityExtensionRequest,
        CapacityAssignment,
        CapacityDemand,
        CapacityWorkloadRequest,
        CapacityWeekForecast,
        CapacityWeek,
        CapacitySetting,
    ):
        db.exec(delete(model).where(col(model.org_id) == org_id))
    db.commit()


def test_en_catalog_split_and_placeholders() -> None:
    assert not (EN_CORE.keys() & EN_DOMAINS.keys())
    assert not (EN_CORE.keys() & EN_CAPACITY.keys())
    assert not (EN_DOMAINS.keys() & EN_CAPACITY.keys())
    assert not (
        EN_ASSISTANT.keys() & (EN_CORE.keys() | EN_DOMAINS.keys() | EN_CAPACITY.keys())
    )
    assert len(EN_CATALOG) == (
        len(EN_CORE) + len(EN_DOMAINS) + len(EN_CAPACITY) + len(EN_ASSISTANT)
    )

    fmt = string.Formatter()
    for key, val in EN_CATALOG.items():
        k_fields = {f for _, f, _, _ in fmt.parse(key) if f is not None}
        v_fields = {f for _, f, _, _ in fmt.parse(val) if f is not None}
        assert k_fields == v_fields, f"Placeholder mismatch for {key!r}"

    with use_locale("en"):
        assert (
            tr("规划与负荷功能未开启")
            == "Capacity and planning features are not enabled"
        )
        assert (
            tr(
                "恢复在职的 {count} 名员工账号仍然停用，需要企业管理员在员工详情里启用并重置密码",
                count=2,
            )
            == "2 reactivated employees still have disabled accounts; an admin must enable them and reset passwords in employee details."
        )
        assert (
            tr("方案已过期，请对方重新安排")
            == "Plan expired. Ask the other party to re-plan."
        )


def test_openapi_preserves_chinese_literal_enums() -> None:
    schema = app.main.app.openapi()
    schemas = schema["components"]["schemas"]
    assert schemas["RequestReviewer"]["properties"]["role"]["enum"] == [
        "直属上级",
        "部门经理",
        "代理审批",
        "企业管理员",
    ]
    assert (
        schemas["DepartedDemandAssignment"]["properties"]["employee_name"]["const"]
        == "已离职员工"
    )


def test_domain_errors_and_dict_code_follow_accept_language(
    capacity_clean: tuple[Any, ...], client: TestClient, db: Session
) -> None:
    url, employees, auth = capacity_clean
    en_headers = {**auth["manager"], "Accept-Language": "en"}
    zh_headers = {**auth["manager"], "Accept-Language": "zh-CN"}

    # Capacity disabled (404)
    res_zh = client.get(f"{url}/capacity/workloads", headers=zh_headers)
    assert res_zh.status_code == 404
    assert res_zh.json()["detail"] == "规划与负荷功能未开启"

    res_en = client.get(f"{url}/capacity/workloads", headers=en_headers)
    assert res_en.status_code == 404
    assert res_en.json()["detail"] == "Capacity and planning features are not enabled"

    # Org admin required (403)
    res_perm = client.put(
        f"{url}/capacity-settings",
        headers=en_headers,
        json={"enabled": True},
    )
    assert res_perm.status_code == 403
    assert res_perm.json()["detail"] == "Organization administrator permission required"

    # Setup step blocked (422 dict detail preserves code & translates message and blockers)
    empty_org = Organization(slug=f"setup-{uuid4().hex[:8]}", name="Setup Org")
    db.add(empty_org)
    db.flush()
    admin_user = db.exec(
        select(User).where(User.email == "admin@demo.example.com")
    ).one()
    membership = OrgMembership(
        org_id=empty_org.id,
        user_id=admin_user.id,
    )
    db.add(membership)
    db.flush()
    db.add(
        RoleGrant(
            org_id=empty_org.id,
            membership_id=membership.id,
            role=Role.ORG_ADMIN,
        )
    )
    db.commit()

    try:
        blocked = client.post(
            f"/api/v1/orgs/{empty_org.id}/setup/steps/roster/complete",
            headers={**auth["admin"], "Accept-Language": "en"},
        )
        assert blocked.status_code == 422
        detail = blocked.json()["detail"]
        assert detail["code"] == "setup_step_blocked"
        assert detail["message"] == "This step cannot be completed yet"
        assert "No active employees yet" in detail["blockers"]
    finally:
        db.exec(delete(RoleGrant).where(col(RoleGrant.org_id) == empty_org.id))
        db.exec(delete(OrgMembership).where(col(OrgMembership.org_id) == empty_org.id))
        db.exec(delete(Organization).where(col(Organization.id) == empty_org.id))
        db.commit()

    # Validation error via Pydantic model_validator under use_locale("en")
    with use_locale("en"):
        with pytest.raises(
            ValidationError, match="A note for the requesting department is required"
        ):
            AssignmentUpdateInput(
                due_date=date(2026, 6, 10),
                new_committed_end_date=date(2026, 6, 12),
            )
        same_id = employees["E01"].department_id
        assert same_id is not None
        with pytest.raises(
            ValidationError,
            match="Target department cannot be the requesting department itself",
        ):
            DemandInput(
                requesting_department_id=same_id,
                target_department_id=same_id,
                capability_key="backend_api",
                window_start=date(2026, 6, 1),
                window_end=date(2026, 6, 7),
                description="Need backend support",
            )


def test_roster_diff_validation_error_in_en(demo: tuple[Any, ...], db: Session) -> None:
    _, employees, _ = demo
    org_id = employees["E01"].org_id
    parsed = ParsedRoster(
        rows=[],
        column_mapping={},
        issues=[
            RosterIssue(
                severity="error",
                row_number=1,
                column="工号",
                message="Invalid row",
            )
        ],
    )
    with use_locale("en"):
        with pytest.raises(
            ValueError, match="Roster has parsing errors and cannot be compared"
        ):
            compute_roster_diff(db, org_id, parsed)


def test_non_error_api_returns_follow_accept_language(
    capacity_clean: tuple[Any, ...], client: TestClient
) -> None:
    url, _, auth = capacity_clean
    admin_en = {**auth["admin"], "Accept-Language": "en"}
    admin_zh = {**auth["admin"], "Accept-Language": "zh-CN"}

    # Admin overview
    ov_zh = client.get(f"{url}/admin/overview", headers=admin_zh)
    assert ov_zh.status_code == 200
    ov_en = client.get(f"{url}/admin/overview", headers=admin_en)
    assert ov_en.status_code == 200
    assert [c["title"] for c in ov_zh.json()["status_cards"]] != [
        c["title"] for c in ov_en.json()["status_cards"]
    ]
    assert ov_en.json()["status_cards"][0]["title"] == "Feishu"

    # Profile export CSV headers
    csv_zh = client.get(f"{url}/profile-export?format=csv", headers=admin_zh)
    csv_en = client.get(f"{url}/profile-export?format=csv", headers=admin_en)
    assert csv_zh.status_code == 200 and csv_en.status_code == 200
    assert "工号,能力,等级" in csv_zh.text
    assert "Employee ID,Capability,Level" in csv_en.text

    # Connection tests (model unconfigured & jira unconfigured)
    model_res = client.post(f"{url}/model-setting/test", headers=admin_en)
    assert model_res.status_code == 200
    assert model_res.json()["ok"] is False
    assert model_res.json()["message"] == "Model is disabled. Please enable it first."

    jira_res = client.post(f"{url}/sources/jira/test", headers=admin_en)
    assert jira_res.status_code == 200
    assert jira_res.json()["ok"] is False
    assert jira_res.json()["message"] == "Please save Jira settings first"

    with patch(
        "app.domains.model.service.test_connection",
        return_value=ConnectionTest(ok=True, message=tr("模型连接成功")),
    ):
        with use_locale("en"):
            assert tr("模型连接成功") == "Model connection succeeded"


def test_capacity_and_planning_helpers_bilingual(
    capacity_clean: tuple[Any, ...], client: TestClient, db: Session
) -> None:
    url, employees, auth = capacity_clean
    assert (
        client.put(
            f"{url}/capacity-settings",
            headers=auth["admin"],
            json={"enabled": True, "requester_policy": "everyone"},
        ).status_code
        == 200
    )

    with use_locale("en"):
        assert forecast_policy.retention_mode_label(0.0) == "Burst"
        assert (
            forecast_policy.build_policy_label(0.5, None, None)
            == "Retention rate 0.5 (Org default)"
        )
        assert (
            forecast._basis_summary(  # noqa: SLF001
                policy=forecast._ResolvedPolicy(  # noqa: SLF001
                    policy_id=None,
                    policy_scope="implicit_default",
                    policy_label=None,
                    scope_label=tr("系统默认"),
                    retention_rate=0.65,
                    is_implicit_default=True,
                ),
                hist_scope="employee",
                hist_weeks=4,
                hist_mean=40.0,
                applied_events=[],
            )
            == "Retention 0.65 (System default): based on 4-week confirmed avg 40% decays weekly"
        )
        pub = DemandPublic(
            id=uuid4(),
            capability_key="backend_api",
            capability_name="Backend",
            requesting_department_id=uuid4(),
            target_department_id=uuid4(),
            window_start=date(2026, 6, 1),
            window_end=date(2026, 6, 7),
            description="desc",
            status=DemandStatus.SUBMITTED,
            revision=1,
            created_at=utc_now(),
        )
        assert pub.status_label == "Awaiting Reply"

        opt = OptionPublic(
            id=uuid4(),
            snapshot_id=uuid4(),
            kind=OptionKind.DELAY,
            params={},
            verdict=PlanVerdict.CONDITIONAL,
            findings=[],
            summary={},
            created_at=utc_now(),
        )
        assert opt.kind_label == "Delay"
        assert opt.verdict_label == "Conditional"

        val = planning_validator.validate(
            {
                "demand": {
                    "window_start": "2026-06-01",
                    "window_end": "2026-06-07",
                    "committed_end_date": None,
                    "headcount": 1,
                    "allocation_percent": 50,
                    "minimum_level": None,
                },
                "candidates": [],
                "rules": {
                    "levels": [],
                    "current_week": "2026-06-01",
                    "default_allocation_cap_percent": 70,
                    "allow_elastic": False,
                },
            },
            {"assignees": []},
        )
        assert val.verdict == "infeasible"
        assert val.findings[0]["message"] == "Please select at least one employee"
        assert val.summary["approvers"] == ["Target department manager confirms reply"]
        assert (
            capacity_assistant._scope_label(  # noqa: SLF001
                None, None, default_label=tr("企业默认")
            )
            == "Org default"
        )

    with use_locale("zh-CN"):
        assert forecast_policy.retention_mode_label(0.0) == "脉冲波次型"

    # Tracking risk in en vs zh-CN
    org_id = employees["E01"].org_id
    admin_principal = actor(db, org_id, "admin@demo.example.com")
    assert admin_principal.user_id is not None
    req_dept_id = employees["E01"].department_id
    tgt_dept_id = employees["E04"].department_id
    assert req_dept_id is not None and tgt_dept_id is not None
    risk_demand = CapacityDemand(
        org_id=org_id,
        requester_user_id=admin_principal.user_id,
        requesting_department_id=req_dept_id,
        target_department_id=tgt_dept_id,
        capability_key="backend_api",
        capability_name="Backend",
        window_start=date(2026, 6, 1),
        window_end=date(2026, 6, 7),
        description="risk check",
    )
    db.add(risk_demand)
    db.flush()
    assign = CapacityAssignment(
        org_id=org_id,
        demand_id=risk_demand.id,
        employee_id=employees["E04"].id,
        assigned_by_user_id=admin_principal.user_id,
        allocation_percent=50,
        start_date=date(2026, 6, 1),
        due_date=date(2026, 6, 7),
        tracking_state=TrackingState.OVERDUE,
    )
    db.add(assign)
    db.flush()
    assert (
        demand_tracking_risk(admin_principal, db, risk_demand.id).message
        == "该角色有延期风险"
    )
    with use_locale("en"):
        assert (
            demand_tracking_risk(admin_principal, db, risk_demand.id).message
            == "This role is at risk of delay"
        )
    db.rollback()


def test_bilingual_notifications_and_im_locale(
    capacity_clean: tuple[Any, ...],
    client: TestClient,
    db: Session,
    telegram_server: dict[str, Any],
) -> None:
    url, employees, auth = capacity_clean
    org_id = employees["E01"].org_id

    assert (
        client.put(
            f"{url}/capacity-settings",
            headers=auth["admin"],
            json={"enabled": True, "requester_policy": "everyone"},
        ).status_code
        == 200
    )

    before_inbox_ids = set(
        db.exec(select(InboxItem.id).where(InboxItem.org_id == org_id)).all()
    )

    # 1. Change request submission notification
    e02 = employees["E02"]
    e02_principal = actor(db, org_id, "employee.platform@demo.example.com")
    draft = change_employee.save_draft(
        e02_principal,
        db,
        None,
        [
            ItemInput(
                op=ChangeOp.MODIFY,
                capability_key="backend_api",
                statement="Updated statement",
                owner_statement="Evidence confirmed",
                level="routine",
            )
        ],
        "web",
    )
    submitted = change_employee.submit(
        e02_principal, db, draft.id, draft.revision, "web"
    )
    assert submitted.status == RequestStatus.PENDING_REVIEW

    # 2. Workload request & decision notifications
    monday = calendar.this_week(db, org_id)
    mgr_p = actor(db, org_id, "manager.platform@demo.example.com")
    req_public = request_workload_change(
        e02_principal,
        db,
        requested_percent=40,
        reason="Off-platform project",
        start_week=monday,
        end_week=monday,
    )
    decide_workload_request(
        mgr_p,
        db,
        req_public.id,
        WorkloadDecisionInput(approve=True, note=None),
    )

    # 3. Unavailability notification
    leave_day = monday + timedelta(days=7)
    unavail = register_unavailability(
        e02_principal,
        db,
        UnavailabilityInput(
            employee_id=e02.id,
            start_date=leave_day,
            end_date=leave_day + timedelta(days=1),
        ),
    )
    assert unavail.employee_id == e02.id
    db.commit()

    # Check all newly created InboxItems have non-empty distinct English message_en
    items = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == org_id,
            *([col(InboxItem.id).not_in(before_inbox_ids)] if before_inbox_ids else []),
        )
    ).all()
    assert len(items) >= 4
    for item in items:
        assert item.message
        assert item.message_en, f"Missing message_en for inbox item: {item.message}"
        assert item.message_en != item.message

    # Reading /me/inbox with Accept-Language: en returns English, zh-CN returns Chinese
    en_inbox = client.get(
        f"{url}/me/inbox",
        headers={**auth["employee"], "Accept-Language": "en"},
    )
    assert en_inbox.status_code == 200
    assert any(
        "workload adjustment request was approved" in row["message"]
        for row in en_inbox.json()["data"]
    )
    zh_inbox = client.get(
        f"{url}/me/inbox",
        headers={**auth["employee"], "Accept-Language": "zh-CN"},
    )
    assert zh_inbox.status_code == 200
    assert any(
        "负荷调整申请已同意" in row["message"] for row in zh_inbox.json()["data"]
    )

    # 4. IM push obeys recipient's preferred_locale
    target_p = principal(db, org_id, e02.id)
    im_setting = enable(db, target_p)
    assert im_setting.credentials is not None
    code = binding.create_code(db, target_p).code
    assert binding.bind(db, org_id, "telegram", "300", "300", "12345", code)
    db.exec(delete(ImNotification).where(col(ImNotification.org_id) == org_id))
    user = db.exec(select(User).where(User.id == target_p.user_id)).one()
    old_locale = user.preferred_locale
    try:
        user.preferred_locale = "en"
        db.add(user)
        next_leave = monday + timedelta(days=14)
        register_unavailability(
            mgr_p,
            db,
            UnavailabilityInput(
                employee_id=e02.id,
                start_date=next_leave,
                end_date=next_leave + timedelta(days=1),
            ),
        )
        db.commit()

        async def push() -> None:
            adapter: Adapter = Telegram(org_id, {"bot_token": TOKEN})
            try:
                assert im_setting.credentials is not None
                await notifications.send_pending(
                    engine, {(org_id, "telegram"): (im_setting.credentials, adapter)}
                )
            finally:
                await adapter.close()

        asyncio.run(push())
        sent = [b["text"] for m, b in telegram_server["requests"] if m == "sendMessage"]
        assert any(
            "workload" in msg.lower() or "collaboration" in msg.lower() for msg in sent
        )
    finally:
        user.preferred_locale = old_locale
        db.add(user)
        db.commit()
