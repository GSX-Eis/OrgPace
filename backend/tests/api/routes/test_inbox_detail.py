import json
from collections.abc import Generator
from datetime import date, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, delete, inspect, text
from sqlmodel import Session, select

from app.authz.deps import get_org_principal
from app.core.security import create_access_token, get_password_hash
from app.domains.audit.models import AuditEvent
from app.domains.base import utc_now
from app.domains.capability.schemas import DictionaryDefinition
from app.domains.capability.service import save_version
from app.domains.capacity.calendar import this_week, week_start
from app.domains.capacity.inbox_detail import (
    CapacityInboxProvider,
    record_capacity_inbox_link,
)
from app.domains.capacity.models import (
    AssignmentStatus,
    CapacityAssignment,
    CapacityDemand,
    CapacityExtensionRequest,
    CapacityRequestStatus,
    CapacitySetting,
    CapacityWeek,
    CapacityWeekForecast,
    CapacityWorkloadRequest,
)
from app.domains.change_request import employee
from app.domains.change_request.models import ItemDecision
from app.domains.change_request.schemas import ItemInput
from app.domains.evidence.models import EvidenceKind, Visibility
from app.domains.evidence.service import append_evidence
from app.domains.inbox.models import InboxItem, InboxKind, InboxTargetType
from app.domains.inbox.service import (
    REDACTED_EXTENSION_RECEIPT_MESSAGE,
    _resolve_target,
    add_item,
)
from app.domains.org.models import (
    Department,
    Employee,
    Organization,
    OrgMembership,
    ReportingLine,
    Role,
    RoleGrant,
)
from app.domains.review import service as review_service
from app.domains.review.schemas import DecisionInput
from app.models import User
from tests.api.routes.test_reviews import actor, manager
from tests.utils.migrations import migrate
from tests.utils.org import delete_test_organization


def test_inbox_capacity_links_migration_roundtrip(migration_engine: Engine) -> None:
    previous = "d1215001bc01"
    target = "c910001bc001"
    for action, revision in [
        ("downgrade", previous),
        ("upgrade", target),
        ("downgrade", previous),
        ("upgrade", target),
    ]:
        migrate(migration_engine, action, revision)
        assert inspect(migration_engine).has_table("capacity_inbox_link") == (
            action == "upgrade"
        )


def test_profile_approval_inbox_detail_and_no_restricted_leak(
    demo: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = demo
    subject = employees["E02"]
    emp = actor(db, subject.org_id, "employee.platform@demo.example.com")
    mgr = manager(db, demo)

    secret_evidence_text = "绝密受限证据原文_SENTINEL_1213"
    evidence, _ = append_evidence(
        db,
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        kind=EvidenceKind.SELF_REPORT,
        source="self_report:web",
        source_ref="inbox-detail-test",
        title="员工受限自述",
        content={"text": secret_evidence_text},
        visibility=Visibility.RESTRICTED,
        provenance={"test": True},
    )
    db.flush()

    existing_keys = {
        item.capability.key for item in employee.my_profile(emp, db).items if item.claim
    }
    add_cap = next(
        c
        for c in employee.capability_dictionary(emp, db).data
        if c.key not in existing_keys
    )
    add_level = (add_cap.level_rubric or {}).get("levels", [{"key": "routine"}])[0][
        "key"
    ]

    draft = employee.save_draft(
        emp,
        db,
        None,
        [
            ItemInput(
                op="modify",
                capability_key="backend_api",
                statement="独立设计高可用网关与熔断机制",
                level="routine",
                owner_statement="仅本人与经理可见的自述",
                evidence_ids=[evidence.id],
            ),
            ItemInput(
                op="add",
                capability_key=add_cap.key,
                statement="带教两名初级工程师完成核心模块交付",
                level=add_level,
                objection="异议说明文本",
                evidence_ids=[evidence.id],
            ),
        ],
        "web",
    )
    submitted = employee.submit(emp, db, draft.id, draft.revision, "web")
    db.commit()

    by_key = {item.capability.key: item for item in submitted.items}
    review_service.decide(
        mgr,
        db,
        submitted.id,
        submitted.revision,
        [
            DecisionInput(
                item_id=by_key["backend_api"].id,
                decision=ItemDecision.APPROVED,
                reason="网关设计方案扎实，同意升级",
            ),
            DecisionInput(
                item_id=by_key[add_cap.key].id,
                decision=ItemDecision.REJECTED,
                reason="请补充具体的带教评审记录",
            ),
        ],
        comment="整体表现良好，请补充带教材料后重提",
    )
    db.commit()

    inbox_res = client.get(f"{url}/me/inbox", headers=auth["employee"])
    assert inbox_res.status_code == 200
    assert secret_evidence_text not in inbox_res.text

    decided_item = next(
        row
        for row in inbox_res.json()["data"]
        if row["kind"] == "decided" and row["request_id"] == str(submitted.id)
    )
    detail_res = client.get(
        f"{url}/me/inbox/{decided_item['id']}", headers=auth["employee"]
    )
    assert detail_res.status_code == 200
    body_text = detail_res.text
    assert secret_evidence_text not in body_text
    assert "仅本人与经理可见的自述" not in body_text
    assert "异议说明文本" not in body_text

    detail = detail_res.json()["profile_request"]
    assert detail is not None
    assert detail["decision_comment"] == "整体表现良好，请补充带教材料后重提"
    assert detail["decided_at"] is not None
    assert detail["reviewer_name"] is not None

    items_by_name = {i["capability_name"]: i for i in detail["items"]}
    backend_item = items_by_name[by_key["backend_api"].capability.name]
    assert backend_item["decision"] == "approved"
    assert backend_item["decision_reason"] == "网关设计方案扎实，同意升级"
    assert backend_item["before"] is not None
    assert backend_item["before"]["statement"]
    assert backend_item["after"]["statement"] == "独立设计高可用网关与熔断机制"
    assert backend_item["after"]["assessment_status"] == "confirmed"

    mentoring_item = items_by_name[by_key[add_cap.key].capability.name]
    assert mentoring_item["decision"] == "rejected"
    assert mentoring_item["decision_reason"] == "请补充具体的带教评审记录"
    assert mentoring_item["before"] is None
    assert mentoring_item["after"]["statement"] == "带教两名初级工程师完成核心模块交付"

    returned_notice = next(
        row
        for row in inbox_res.json()["data"]
        if row["kind"] == "status_changed" and "被拒绝" in row["message"]
    )
    returned_detail = client.get(
        f"{url}/me/inbox/{returned_notice['id']}", headers=auth["employee"]
    )
    assert returned_detail.status_code == 200
    returned_profile = returned_detail.json()["profile_request"]
    assert returned_profile["decided_at"] is not None
    assert returned_profile["items"][0]["decision"] == "rejected"
    assert returned_profile["items"][0]["decision_reason"] == "请补充具体的带教评审记录"

    # Cross-user inbox detail access is rejected.
    assert (
        client.get(
            f"{url}/me/inbox/{decided_item['id']}", headers=auth["admin"]
        ).status_code
        == 404
    )

    # Admin without restricted access to E02 cannot read restricted fields even if holding a request link.
    admin = actor(db, subject.org_id, "admin@demo.example.com")
    admin_notice = InboxItem(
        org_id=subject.org_id,
        recipient_user_id=admin.user_id,
        kind=InboxKind.STATUS_CHANGED,
        request_id=submitted.id,
        message="合成关联通知",
    )
    add_item(db, admin_notice)
    db.commit()
    admin_detail = client.get(
        f"{url}/me/inbox/{admin_notice.id}", headers=auth["admin"]
    )
    assert admin_detail.status_code == 200
    redacted = admin_detail.json()["profile_request"]
    assert redacted["decision_comment"] is None
    assert redacted["reviewer_name"] is None
    redacted_by_name = {i["capability_name"]: i for i in redacted["items"]}
    assert list(redacted_by_name) == [by_key["backend_api"].capability.name]
    assert (
        redacted_by_name[by_key["backend_api"].capability.name]["decision_reason"]
        is None
    )
    assert by_key[add_cap.key].capability.name not in admin_detail.text
    assert "请补充具体的带教评审记录" not in admin_detail.text
    assert "带教两名初级工程师完成核心模块交付" not in admin_detail.text


@pytest.fixture
def capacity_demo(demo: tuple, db: Session) -> Generator[tuple]:
    yield demo
    db.rollback()
    org_id = demo[1]["E01"].org_id
    for model in (
        InboxItem,
        CapacityExtensionRequest,
        CapacityAssignment,
        CapacityDemand,
        CapacityWorkloadRequest,
        CapacityWeekForecast,
        CapacityWeek,
        CapacitySetting,
    ):
        db.execute(delete(model).where(model.org_id == org_id))
    db.commit()


def test_capacity_workload_and_extension_inbox_details(
    capacity_demo: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = capacity_demo
    e02 = employees["E02"]
    mgr_emp = employees["E01"]
    mgr_user_id = db.exec(
        select(OrgMembership.user_id).where(
            OrgMembership.org_id == e02.org_id, OrgMembership.employee_id == mgr_emp.id
        )
    ).one()

    db.add(
        CapacitySetting(org_id=e02.org_id, enabled=True, updated_by_user_id=mgr_user_id)
    )
    monday = this_week(db, e02.org_id)
    db.add(
        CapacityWeek(
            org_id=e02.org_id,
            employee_id=e02.id,
            week_start=monday,
            other_percent=30,
            confirmed_by_user_id=mgr_user_id,
        )
    )
    demand = CapacityDemand(
        org_id=e02.org_id,
        requesting_department_id=e02.department_id,
        requester_user_id=mgr_user_id,
        target_department_id=e02.department_id,
        capability_key="backend_api",
        capability_name="后端与接口",
        headcount=1,
        allocation_percent=40,
        window_start=monday,
        window_end=monday + timedelta(days=14),
        description="核心服务扩容",
    )
    db.add(demand)
    db.flush()
    due_before = monday + timedelta(days=10)
    assignment = CapacityAssignment(
        org_id=e02.org_id,
        demand_id=demand.id,
        employee_id=e02.id,
        allocation_percent=40,
        start_date=monday,
        due_date=due_before,
        status=AssignmentStatus.ACTIVE,
        assigned_by_user_id=mgr_user_id,
    )
    db.add(assignment)
    db.commit()

    wl_req = client.post(
        f"{url}/capacity/workloads/me/requests",
        headers=auth["employee"],
        json={
            "requested_percent": 65,
            "reason": "支撑临时专项评审",
            "start_week": monday.isoformat(),
            "end_week": monday.isoformat(),
        },
    )
    assert wl_req.status_code == 200, wl_req.text
    wl_id = wl_req.json()["id"]

    wl_decide = client.post(
        f"{url}/capacity/workload-requests/{wl_id}/decision",
        headers=auth["manager"],
        json={"approve": True, "note": "专项期同意调整至 65%"},
    )
    assert wl_decide.status_code == 200, wl_decide.text

    ext_target = due_before + timedelta(days=7)
    ext_req = client.post(
        f"{url}/capacity/assignments/{assignment.id}/extension-requests",
        headers=auth["employee"],
        json={
            "requested_due_date": ext_target.isoformat(),
            "reason": "需配合上游联调",
        },
    )
    assert ext_req.status_code == 200, ext_req.text
    ext_id = ext_req.json()["id"]

    ext_decide = client.post(
        f"{url}/capacity/extension-requests/{ext_id}/decision",
        headers=auth["manager"],
        json={"approve": False, "note": "请先拆分本周可交付范围"},
    )
    assert ext_decide.status_code == 200, ext_decide.text

    inbox = client.get(f"{url}/me/inbox", headers=auth["employee"]).json()["data"]
    wl_notice = next(row for row in inbox if row["workload_request_id"] == wl_id)
    ext_notice = next(row for row in inbox if row["extension_request_id"] == ext_id)

    wl_detail = client.get(
        f"{url}/me/inbox/{wl_notice['id']}", headers=auth["employee"]
    ).json()["workload_request"]
    assert wl_detail["status"] == CapacityRequestStatus.APPROVED
    assert wl_detail["before_percent"] == 30
    assert wl_detail["requested_percent"] == 65
    assert wl_detail["reason"] == "支撑临时专项评审"
    assert wl_detail["decision_note"] == "专项期同意调整至 65%"
    assert wl_detail["decided_at"] is not None
    assert wl_detail["reviewer_name"] is not None

    ext_detail = client.get(
        f"{url}/me/inbox/{ext_notice['id']}", headers=auth["employee"]
    ).json()["extension_request"]
    assert ext_detail["status"] == CapacityRequestStatus.RETURNED
    assert ext_detail["capability_name"] == "后端与接口"
    assert ext_detail["before_due_date"] == due_before.isoformat()
    assert ext_detail["requested_due_date"] == ext_target.isoformat()
    assert ext_detail["new_due_date"] is None
    assert ext_detail["reason"] == "需配合上游联调"
    assert ext_detail["decision_note"] == "请先拆分本周可交付范围"
    assert ext_detail["decided_at"] is not None
    assert ext_detail["reviewer_name"] is not None

    # Another user cannot read E02's capacity inbox detail.
    assert (
        client.get(
            f"{url}/me/inbox/{UUID(wl_notice['id'])}", headers=auth["manager"]
        ).status_code
        == 404
    )


def test_d060_inbox_detail_revoked_permissions_and_isolation(
    db: Session, client: TestClient
) -> None:
    org = Organization(slug=str(uuid4()), name="合成收件箱权限收回企业")
    foreign = Organization(slug=str(uuid4()), name="合成收件箱外部企业")
    db.add_all([org, foreign])
    db.flush()

    dept_open = Department(org_id=org.id, name="待管辖部门")
    dept_managed = Department(org_id=org.id, name="已管辖部门")
    db.add_all([dept_open, dept_managed])
    db.flush()

    users: dict[str, User] = {}
    members: dict[str, OrgMembership] = {}
    people: dict[str, Employee] = {}
    auth: dict[str, dict[str, str]] = {}

    try:
        for role_name in ("admin", "emp", "mgr", "delegate", "foreign_admin"):
            user = User(
                username=f"{uuid4()}@example.com",
                hashed_password=get_password_hash("synthetic-password-2026"),
                full_name=f"合成_{role_name}",
            )
            db.add(user)
            db.flush()
            users[role_name] = user
            target_org = foreign if role_name == "foreign_admin" else org
            emp_row = None
            if role_name not in ("admin", "foreign_admin"):
                emp_row = Employee(
                    org_id=target_org.id,
                    employee_code=role_name.upper(),
                    display_name=f"合成员工_{role_name}",
                    work_email=user.username,
                    department_id=(
                        dept_open.id if role_name == "emp" else dept_managed.id
                    ),
                )
                db.add(emp_row)
                db.flush()
                people[role_name] = emp_row
            member = OrgMembership(
                org_id=target_org.id,
                user_id=user.id,
                employee_id=emp_row.id if emp_row else None,
            )
            db.add(member)
            db.flush()
            members[role_name] = member
            if role_name in ("admin", "foreign_admin"):
                db.add(
                    RoleGrant(
                        org_id=target_org.id,
                        membership_id=member.id,
                        role=Role.ORG_ADMIN,
                    )
                )
            elif role_name == "mgr":
                db.add(
                    RoleGrant(
                        org_id=org.id,
                        membership_id=member.id,
                        role=Role.DEPT_MANAGER,
                        department_id=dept_managed.id,
                    )
                )
            db.flush()
            auth[role_name] = {
                "Authorization": f"Bearer {create_access_token(user.id, expires_delta=timedelta(minutes=30))}"
            }

        admin_principal = get_org_principal(org.id, users["admin"], db)
        save_version(
            db,
            admin_principal,
            expected_version=0,
            definitions=[
                DictionaryDefinition(
                    key="d060_skill",
                    name="合成未发布专项能力",
                    category="测试",
                    description="权限收回验证",
                    level_rubric={
                        "levels": [
                            {"key": "l1", "label": "L1 基础", "description": "基础"},
                            {"key": "l2", "label": "L2 熟练", "description": "熟练"},
                        ]
                    },
                )
            ],
        )
        emp_principal = get_org_principal(org.id, users["emp"], db)
        draft = employee.save_draft(
            emp_principal,
            db,
            None,
            [
                ItemInput(
                    op="add",
                    capability_key="d060_skill",
                    statement="合成未发布陈述_D060",
                    level="l2",
                )
            ],
            "web",
        )
        submitted = employee.submit(emp_principal, db, draft.id, draft.revision, "web")
        db.commit()

        org_url = f"/api/v1/orgs/{org.id}"
        # Admin initially receives REVIEW_REQUESTED as fallback reviewer when dept_open has no manager.
        admin_inbox = client.get(f"{org_url}/me/inbox", headers=auth["admin"]).json()[
            "data"
        ]
        admin_notice = next(
            row
            for row in admin_inbox
            if row["kind"] == "review_requested"
            and row["request_id"] == str(submitted.id)
        )
        while_eligible = client.get(
            f"{org_url}/me/inbox/{admin_notice['id']}", headers=auth["admin"]
        )
        assert while_eligible.status_code == 200
        assert while_eligible.json()["profile_request"] is not None
        assert (
            while_eligible.json()["profile_request"]["items"][0]["after"]["level"]
            == "l2"
        )

        # Employee transfers to dept_managed; admin loses review eligibility and has no dept management.
        people["emp"].department_id = dept_managed.id
        db.add(people["emp"])
        db.flush()
        # Activate an auto-delegate for mgr via ReportingLine so we can verify access and revocation.
        mgr_principal = get_org_principal(org.id, users["mgr"], db)
        line = ReportingLine(
            org_id=org.id,
            employee_id=people["mgr"].id,
            manager_employee_id=people["delegate"].id,
        )
        db.add(line)
        db.flush()
        delegate_notice = InboxItem(
            org_id=org.id,
            recipient_user_id=users["delegate"].id,
            kind=InboxKind.REVIEW_REQUESTED,
            request_id=submitted.id,
            message="有新的画像请求待审批",
        )
        add_item(db, delegate_notice)
        mgr_notice = InboxItem(
            org_id=org.id,
            recipient_user_id=users["mgr"].id,
            kind=InboxKind.REVIEW_REQUESTED,
            request_id=submitted.id,
            message="有新的画像请求待审批",
        )
        add_item(db, mgr_notice)
        db.commit()

        # 1) Admin without approval eligibility or dept management only gets summary.
        revoked_admin = client.get(
            f"{org_url}/me/inbox/{admin_notice['id']}", headers=auth["admin"]
        )
        assert revoked_admin.status_code == 200
        assert revoked_admin.json()["item"]["id"] == admin_notice["id"]
        assert revoked_admin.json()["item"]["message"] == "有新的画像请求待审批"
        assert revoked_admin.json()["profile_request"] is None
        assert "合成未发布专项能力" not in revoked_admin.text
        assert "合成未发布陈述_D060" not in revoked_admin.text
        assert '"l2"' not in revoked_admin.text

        # Admin can still mark the summary notice as read.
        marked = client.post(
            f"{org_url}/me/inbox/{admin_notice['id']}/read", headers=auth["admin"]
        )
        assert marked.status_code == 200
        assert marked.json()["read_at"] is not None

        # 2) Active delegate and current dept manager and owner can still see full details.
        for role_key, notice_id in (
            ("delegate", delegate_notice.id),
            ("mgr", mgr_notice.id),
        ):
            allowed_res = client.get(
                f"{org_url}/me/inbox/{notice_id}", headers=auth[role_key]
            )
            assert allowed_res.status_code == 200
            detail = allowed_res.json()["profile_request"]
            assert detail is not None
            assert detail["items"][0]["capability_name"] == "合成未发布专项能力"
            assert detail["items"][0]["after"]["level"] == "l2"
            assert detail["items"][0]["after"]["statement"] == "合成未发布陈述_D060"

        # 3) End reporting line -> delegate loses detail access and only gets summary.
        line.valid_to = utc_now()
        db.add(line)
        db.commit()
        revoked_delegate = client.get(
            f"{org_url}/me/inbox/{delegate_notice.id}", headers=auth["delegate"]
        )
        assert revoked_delegate.status_code == 200
        assert revoked_delegate.json()["item"]["message"] == "有新的画像请求待审批"
        assert revoked_delegate.json()["profile_request"] is None

        # 4) Manager rejects request -> owner and manager still see full detail, admin still only gets summary.
        review_service.decide(
            mgr_principal,
            db,
            submitted.id,
            submitted.revision,
            [
                DecisionInput(
                    item_id=submitted.items[0].id,
                    decision=ItemDecision.REJECTED,
                    reason="合成退回理由_D060",
                )
            ],
            comment="合成审批总评_D060",
        )
        db.commit()

        emp_inbox = client.get(f"{org_url}/me/inbox", headers=auth["emp"]).json()[
            "data"
        ]
        emp_decided = next(
            row
            for row in emp_inbox
            if row["kind"] == "decided" and row["request_id"] == str(submitted.id)
        )
        for role_key, notice_id in (
            ("emp", emp_decided["id"]),
            ("mgr", mgr_notice.id),
        ):
            res = client.get(f"{org_url}/me/inbox/{notice_id}", headers=auth[role_key])
            assert res.status_code == 200
            assert res.json()["profile_request"] is not None
            assert (
                res.json()["profile_request"]["items"][0]["decision_reason"]
                == "合成退回理由_D060"
            )

        admin_after_reject = client.get(
            f"{org_url}/me/inbox/{admin_notice['id']}", headers=auth["admin"]
        )
        assert admin_after_reject.status_code == 200
        assert admin_after_reject.json()["profile_request"] is None
        assert "合成退回理由_D060" not in admin_after_reject.text
        assert "合成审批总评_D060" not in admin_after_reject.text

        # 5) Former dept manager (not org_admin) loses DEPT_MANAGER grant -> gets summary only even for published items.
        approved_draft = employee.save_draft(
            emp_principal,
            db,
            None,
            [
                ItemInput(
                    op="add",
                    capability_key="d060_skill",
                    statement="合成已批准陈述_D060",
                    level="l1",
                )
            ],
            "web",
        )
        approved_req = employee.submit(
            emp_principal, db, approved_draft.id, approved_draft.revision, "web"
        )
        db.flush()
        mgr_approved_notice = InboxItem(
            org_id=org.id,
            recipient_user_id=users["mgr"].id,
            kind=InboxKind.REVIEW_REQUESTED,
            request_id=approved_req.id,
            message="有新的画像请求待审批",
        )
        add_item(db, mgr_approved_notice)
        review_service.decide(
            mgr_principal,
            db,
            approved_req.id,
            approved_req.revision,
            [
                DecisionInput(
                    item_id=approved_req.items[0].id,
                    decision=ItemDecision.APPROVED,
                    reason="同意发布",
                )
            ],
        )
        mgr_grant = db.exec(
            select(RoleGrant).where(
                RoleGrant.org_id == org.id,
                RoleGrant.membership_id == members["mgr"].id,
                RoleGrant.role == Role.DEPT_MANAGER,
            )
        ).one()
        db.delete(mgr_grant)
        db.commit()

        revoked_mgr = client.get(
            f"{org_url}/me/inbox/{mgr_approved_notice.id}", headers=auth["mgr"]
        )
        assert revoked_mgr.status_code == 200
        assert revoked_mgr.json()["item"]["message"] == "有新的画像请求待审批"
        assert revoked_mgr.json()["profile_request"] is None
        emp_approved_inbox = client.get(
            f"{org_url}/me/inbox", headers=auth["emp"]
        ).json()["data"]
        emp_approved_notice = next(
            row
            for row in emp_approved_inbox
            if row["kind"] == "decided" and row["request_id"] == str(approved_req.id)
        )
        emp_approved_detail = client.get(
            f"{org_url}/me/inbox/{emp_approved_notice['id']}", headers=auth["emp"]
        )
        assert emp_approved_detail.status_code == 200
        assert (
            emp_approved_detail.json()["profile_request"]["items"][0]["after"][
                "statement"
            ]
            == "合成已批准陈述_D060"
        )

        # 6) Cross-org isolation: foreign admin cannot access org's inbox detail.
        assert (
            client.get(
                f"{org_url}/me/inbox/{admin_notice['id']}",
                headers=auth["foreign_admin"],
            ).status_code
            == 404
        )
        assert (
            client.get(
                f"/api/v1/orgs/{foreign.id}/me/inbox/{admin_notice['id']}",
                headers=auth["foreign_admin"],
            ).status_code
            == 404
        )
    finally:
        db.rollback()
        delete_test_organization(db, org.id)
        delete_test_organization(db, foreign.id)
        for user in users.values():
            db.delete(user)
        db.commit()


def test_d086_extension_callback_and_inbox_detail_scope(
    db: Session, client: TestClient
) -> None:
    org = Organization(slug=str(uuid4()), name="合成D086企业")
    foreign = Organization(slug=str(uuid4()), name="合成D086外部企业")
    db.add_all([org, foreign])
    db.flush()

    dept_a = Department(org_id=org.id, name="合成需求部门A")
    dept_b = Department(org_id=org.id, name="合成承接部门B")
    db.add_all([dept_a, dept_b])
    db.flush()
    dept_child = Department(
        org_id=org.id, name="合成承接子部门C", parent_department_id=dept_b.id
    )
    db.add(dept_child)
    db.flush()

    users: dict[str, User] = {}
    members: dict[str, OrgMembership] = {}
    people: dict[str, Employee] = {}
    auth: dict[str, dict[str, str]] = {}

    try:
        specs = {
            "a": (org.id, dept_a.id, None, None),
            "bm": (org.id, dept_b.id, Role.DEPT_MANAGER, dept_b.id),
            "cm": (org.id, dept_child.id, Role.DEPT_MANAGER, dept_child.id),
            "w": (org.id, dept_child.id, None, None),
            "foreign": (foreign.id, None, Role.ORG_ADMIN, None),
        }
        for key, (tenant_id, emp_dept_id, role, grant_dept_id) in specs.items():
            user = User(
                username=f"{uuid4()}@example.com",
                hashed_password=get_password_hash("synthetic-password-2026"),
                full_name=f"合成_{key}",
            )
            db.add(user)
            db.flush()
            users[key] = user
            emp_row = None
            if emp_dept_id is not None:
                emp_row = Employee(
                    org_id=tenant_id,
                    employee_code=f"D086_{key.upper()}",
                    display_name=f"合成员工_{key}",
                    work_email=user.username,
                    department_id=emp_dept_id,
                )
                db.add(emp_row)
                db.flush()
                people[key] = emp_row
            member = OrgMembership(
                org_id=tenant_id,
                user_id=user.id,
                employee_id=emp_row.id if emp_row else None,
            )
            db.add(member)
            db.flush()
            members[key] = member
            if role is not None:
                db.add(
                    RoleGrant(
                        org_id=tenant_id,
                        membership_id=member.id,
                        role=role,
                        department_id=grant_dept_id,
                    )
                )
            db.flush()
            auth[key] = {
                "Authorization": f"Bearer {create_access_token(user.id, expires_delta=timedelta(minutes=30))}"
            }

        for tenant_id, user_key in ((org.id, "bm"), (foreign.id, "foreign")):
            db.add(
                CapacitySetting(
                    org_id=tenant_id,
                    enabled=True,
                    updated_by_user_id=users[user_key].id,
                )
            )
        monday = week_start(date(2026, 12, 1))
        for offset in range(8):
            db.add(
                CapacityWeek(
                    org_id=org.id,
                    employee_id=people["w"].id,
                    week_start=monday + timedelta(weeks=offset),
                    other_percent=0,
                    confirmed_by_user_id=users["bm"].id,
                )
            )
        demand = CapacityDemand(
            org_id=org.id,
            requesting_department_id=dept_a.id,
            target_department_id=dept_b.id,
            requester_user_id=users["a"].id,
            capability_key="d086_cap",
            capability_name="D086保密专项工作",
            headcount=1,
            allocation_percent=30,
            window_start=date(2026, 12, 1),
            window_end=date(2026, 12, 31),
            committed_start_date=date(2026, 12, 1),
            committed_end_date=date(2026, 12, 31),
            status="accepted",
            description="合成D086需求",
        )
        db.add(demand)
        db.flush()
        assignment = CapacityAssignment(
            org_id=org.id,
            demand_id=demand.id,
            employee_id=people["w"].id,
            allocation_percent=30,
            start_date=date(2026, 12, 1),
            due_date=date(2026, 12, 20),
            status=AssignmentStatus.ACTIVE,
            assigned_by_user_id=users["bm"].id,
        )
        db.add(assignment)
        db.commit()

        org_url = f"/api/v1/orgs/{org.id}"

        def submit_and_decide(
            target_due: str, reason: str, approve: bool, note: str
        ) -> tuple[str, dict]:
            req_res = client.post(
                f"{org_url}/capacity/assignments/{assignment.id}/extension-requests",
                headers=auth["w"],
                json={"requested_due_date": target_due, "reason": reason},
            )
            assert req_res.status_code == 200, req_res.text
            req_id = req_res.json()["id"]
            # Self-approval remains forbidden even when the subject gains a manager grant.
            self_grant = RoleGrant(
                org_id=org.id,
                membership_id=members["w"].id,
                role=Role.DEPT_MANAGER,
                department_id=dept_b.id,
            )
            db.add(self_grant)
            db.commit()
            try:
                assert (
                    client.post(
                        f"{org_url}/capacity/extension-requests/{req_id}/decision",
                        headers=auth["w"],
                        json={"approve": approve, "note": note},
                    ).status_code
                    == 404
                )
            finally:
                db.delete(self_grant)
                db.commit()

            dec_res = client.post(
                f"{org_url}/capacity/extension-requests/{req_id}/decision",
                headers=auth["bm"],
                json={"approve": approve, "note": note},
            )
            assert dec_res.status_code == 200, dec_res.text
            return req_id, dec_res.json()

        def assert_redacted_receipt(
            inbox_id: str,
            req_id: str,
            reason: str,
            note: str,
        ) -> None:
            forbidden_tokens = (
                req_id,
                str(assignment.id),
                str(demand.id),
                people["w"].display_name,
                people["bm"].display_name,
                "D086保密专项工作",
                reason,
                note,
                "已同意",
                "已退回",
                "/capacity",
                "/reviews",
            )
            listed = client.get(f"{org_url}/me/inbox", headers=auth["cm"]).json()[
                "data"
            ]
            row = next(entry for entry in listed if entry["id"] == inbox_id)
            assert row["extension_request_id"] is None
            assert row["workload_request_id"] is None
            assert row["request_id"] is None
            assert row["question_id"] is None
            assert row["message"] == REDACTED_EXTENSION_RECEIPT_MESSAGE
            row_json = json.dumps(row, ensure_ascii=False)

            detail_res = client.get(
                f"{org_url}/me/inbox/{inbox_id}", headers=auth["cm"]
            )
            assert detail_res.status_code == 200
            detail_json = detail_res.json()
            assert detail_json["extension_request"] is None
            assert detail_json["item"]["extension_request_id"] is None
            assert detail_json["item"]["message"] == REDACTED_EXTENSION_RECEIPT_MESSAGE

            read_res = client.post(
                f"{org_url}/me/inbox/{inbox_id}/read", headers=auth["cm"]
            )
            assert read_res.status_code == 200
            read_json = read_res.json()
            assert read_json["extension_request_id"] is None
            assert read_json["message"] == REDACTED_EXTENSION_RECEIPT_MESSAGE

            for forbidden in forbidden_tokens:
                assert forbidden not in row_json
                assert forbidden not in detail_res.text
                assert forbidden not in read_res.text

        # 1) Authorized original reviewer (cm in child under B) receives openable receipt.
        allowed_req_id, allowed_dec = submit_and_decide(
            "2026-12-22", "D086_ALLOWED_REASON", True, "D086_ALLOWED_NOTE"
        )
        assert allowed_dec["decided_for_user_id"] == str(users["cm"].id)

        cm_inbox_1 = client.get(f"{org_url}/me/inbox", headers=auth["cm"]).json()[
            "data"
        ]
        allowed_notice = next(
            row for row in cm_inbox_1 if row["extension_request_id"] == allowed_req_id
        )
        assert people["w"].display_name in allowed_notice["message"]
        assert "D086保密专项工作" in allowed_notice["message"]
        allowed_detail = client.get(
            f"{org_url}/me/inbox/{allowed_notice['id']}", headers=auth["cm"]
        )
        assert allowed_detail.status_code == 200
        ext_detail = allowed_detail.json()["extension_request"]
        assert ext_detail is not None
        assert ext_detail["reason"] == "D086_ALLOWED_REASON"
        assert ext_detail["decision_note"] == "D086_ALLOWED_NOTE"
        allowed_read = client.post(
            f"{org_url}/me/inbox/{allowed_notice['id']}/read", headers=auth["cm"]
        )
        assert allowed_read.status_code == 200
        assert allowed_read.json()["extension_request_id"] == allowed_req_id
        assert people["w"].display_name in allowed_read.json()["message"]

        # Applicant w retains normal access to their own extension receipt.
        w_inbox = client.get(f"{org_url}/me/inbox", headers=auth["w"]).json()["data"]
        w_notice = next(
            row for row in w_inbox if row["extension_request_id"] == allowed_req_id
        )
        assert "D086保密专项工作" in w_notice["message"]
        w_detail = client.get(f"{org_url}/me/inbox/{w_notice['id']}", headers=auth["w"])
        assert w_detail.status_code == 200
        assert w_detail.json()["extension_request"]["reason"] == "D086_ALLOWED_REASON"
        w_read = client.post(
            f"{org_url}/me/inbox/{w_notice['id']}/read", headers=auth["w"]
        )
        assert w_read.status_code == 200
        assert w_read.json()["extension_request_id"] == allowed_req_id

        # 2) Move cm's own employee record outside B (to A), keeping DEPT_MANAGER grant on child.
        #    Existing receipt (list, detail, mark_read) must now redact summary, link, and detail.
        people["cm"].department_id = dept_a.id
        db.add(people["cm"])
        db.commit()

        assert_redacted_receipt(
            allowed_notice["id"],
            allowed_req_id,
            "D086_ALLOWED_REASON",
            "D086_ALLOWED_NOTE",
        )

        # Historical pre-PR#529 unauthorized receipt (linked and unlinked) must also be redacted.
        legacy_linked = InboxItem(
            org_id=org.id,
            recipient_user_id=users["cm"].id,
            kind=InboxKind.CAPACITY,
            message=(
                f"员工 {people['w'].display_name} 的延期申请（D086保密专项工作，已同意）"
                f"已由上级 {people['bm'].display_name} 代为审批"
            ),
        )
        add_item(db, legacy_linked)
        record_capacity_inbox_link(
            db, legacy_linked, extension_request_id=UUID(allowed_req_id)
        )
        legacy_unlinked = InboxItem(
            org_id=org.id,
            recipient_user_id=users["cm"].id,
            kind=InboxKind.CAPACITY,
            message=(
                f"员工 {people['w'].display_name} 的延期申请（D086保密专项工作，已退回）"
                f"已由上级 {people['bm'].display_name} 代为审批"
            ),
        )
        add_item(db, legacy_unlinked)
        db.commit()

        assert_redacted_receipt(
            str(legacy_linked.id),
            allowed_req_id,
            "D086_ALLOWED_REASON",
            "D086_ALLOWED_NOTE",
        )
        assert_redacted_receipt(
            str(legacy_unlinked.id),
            allowed_req_id,
            "D086_ALLOWED_REASON",
            "D086_ALLOWED_NOTE",
        )

        # Direct provider call also enforces current scope (ignoring decided_for_user_id).
        cm_principal_outside = get_org_principal(org.id, users["cm"], db)
        assert (
            CapacityInboxProvider().extension_detail(
                cm_principal_outside, db, UUID(allowed_req_id)
            )
            is None
        )
        assert (
            CapacityInboxProvider().accessible_extension_ids(
                cm_principal_outside, db, {UUID(allowed_req_id)}
            )
            == set()
        )

        # 3) While cm lacks extension_department_allowed, both approve and return send only generic reminders.
        for target_due, approve, reason, note in (
            (
                "2026-12-24",
                False,
                "D086_SECRET_RETURN_REASON",
                "D086_SECRET_RETURN_NOTE",
            ),
            (
                "2026-12-25",
                True,
                "D086_SECRET_APPROVE_REASON",
                "D086_SECRET_APPROVE_NOTE",
            ),
        ):
            before_ids = {
                row["id"]
                for row in client.get(f"{org_url}/me/inbox", headers=auth["cm"]).json()[
                    "data"
                ]
            }
            req_id, dec_json = submit_and_decide(target_due, reason, approve, note)
            assert dec_json["decided_for_user_id"] == str(users["cm"].id)

            cm_inbox_after = client.get(
                f"{org_url}/me/inbox", headers=auth["cm"]
            ).json()["data"]
            new_notices = [row for row in cm_inbox_after if row["id"] not in before_ids]
            assert len(new_notices) == 1
            generic = new_notices[0]
            assert generic["extension_request_id"] is None
            assert generic["workload_request_id"] is None
            assert generic["request_id"] is None
            assert generic["question_id"] is None
            assert (
                generic["message"]
                == "一条延期申请已由上级代为审批，受承接部门可见范围限制，暂不展示详情"
            )

            generic_detail = client.get(
                f"{org_url}/me/inbox/{generic['id']}", headers=auth["cm"]
            )
            assert generic_detail.status_code == 200
            assert generic_detail.json()["extension_request"] is None
            generic_json = json.dumps(generic, ensure_ascii=False)
            for forbidden in (
                req_id,
                str(assignment.id),
                str(demand.id),
                people["w"].display_name,
                people["bm"].display_name,
                "D086保密专项工作",
                reason,
                note,
                "已同意",
                "已退回",
                "/capacity",
                "/reviews",
            ):
                assert forbidden not in generic_detail.text
                assert forbidden not in generic_json

        # Verify delegated audit records acting_for_user_id & delegation_mode="org_hierarchy".
        ext_audits = db.exec(
            select(AuditEvent)
            .where(
                AuditEvent.org_id == org.id,
                AuditEvent.action.in_(
                    ["capacity.extension_approved", "capacity.extension_returned"]
                ),
            )
            .order_by(AuditEvent.created_at)
        ).all()
        assert len(ext_audits) == 3
        for evt in ext_audits:
            assert evt.details["acting_for_user_id"] == str(users["cm"].id)
            assert evt.details["delegation_mode"] == "org_hierarchy"

        # 4) Restoring cm to child restores access to the previously created receipt;
        #    revoking cm's DEPT_MANAGER grant revokes it again across list, detail, and mark_read.
        people["cm"].department_id = dept_child.id
        db.add(people["cm"])
        db.commit()
        restored_list = client.get(f"{org_url}/me/inbox", headers=auth["cm"]).json()[
            "data"
        ]
        restored_row = next(
            row for row in restored_list if row["id"] == allowed_notice["id"]
        )
        assert restored_row["extension_request_id"] == allowed_req_id
        assert people["w"].display_name in restored_row["message"]
        assert "D086保密专项工作" in restored_row["message"]
        restored = client.get(
            f"{org_url}/me/inbox/{allowed_notice['id']}", headers=auth["cm"]
        )
        assert restored.status_code == 200
        assert restored.json()["item"]["extension_request_id"] == allowed_req_id
        assert restored.json()["extension_request"]["reason"] == "D086_ALLOWED_REASON"
        restored_read = client.post(
            f"{org_url}/me/inbox/{allowed_notice['id']}/read", headers=auth["cm"]
        )
        assert restored_read.status_code == 200
        assert restored_read.json()["extension_request_id"] == allowed_req_id

        cm_grant = db.exec(
            select(RoleGrant).where(
                RoleGrant.org_id == org.id,
                RoleGrant.membership_id == members["cm"].id,
                RoleGrant.role == Role.DEPT_MANAGER,
            )
        ).one()
        db.delete(cm_grant)
        db.commit()
        assert_redacted_receipt(
            allowed_notice["id"],
            allowed_req_id,
            "D086_ALLOWED_REASON",
            "D086_ALLOWED_NOTE",
        )

        # 5) Cross-tenant & cross-user isolation.
        assert (
            client.get(
                f"{org_url}/me/inbox/{allowed_notice['id']}", headers=auth["foreign"]
            ).status_code
            == 404
        )
        assert (
            client.get(
                f"/api/v1/orgs/{foreign.id}/me/inbox/{allowed_notice['id']}",
                headers=auth["foreign"],
            ).status_code
            == 404
        )
        assert (
            client.post(
                f"{org_url}/me/inbox/{allowed_notice['id']}/read",
                headers=auth["foreign"],
            ).status_code
            == 404
        )
        assert (
            client.post(
                f"/api/v1/orgs/{foreign.id}/me/inbox/{allowed_notice['id']}/read",
                headers=auth["foreign"],
            ).status_code
            == 404
        )
        assert (
            client.get(
                f"{org_url}/me/inbox/{allowed_notice['id']}", headers=auth["a"]
            ).status_code
            == 404
        )
        foreign_principal = get_org_principal(foreign.id, users["foreign"], db)
        assert (
            CapacityInboxProvider().extension_detail(
                foreign_principal, db, UUID(allowed_req_id)
            )
            is None
        )
        assert (
            CapacityInboxProvider().accessible_extension_ids(
                foreign_principal, db, {UUID(allowed_req_id)}
            )
            == set()
        )
    finally:
        db.rollback()
        for model in (
            InboxItem,
            CapacityExtensionRequest,
            CapacityAssignment,
            CapacityDemand,
            CapacityWeek,
            CapacitySetting,
        ):
            db.execute(delete(model).where(model.org_id == org.id))
        db.execute(delete(CapacitySetting).where(CapacitySetting.org_id == foreign.id))
        db.commit()
        delete_test_organization(db, org.id)
        delete_test_organization(db, foreign.id)
        for user in users.values():
            db.delete(user)
        db.commit()


def test_d086_historical_handler_respects_current_department_visibility(
    db: Session, client: TestClient
) -> None:
    org = Organization(slug=str(uuid4()), name="合成D086历史处理人企业")
    foreign = Organization(slug=str(uuid4()), name="合成D086历史处理人外部企业")
    db.add_all([org, foreign])
    db.flush()

    dept_a = Department(org_id=org.id, name="合成部门A")
    dept_b = Department(org_id=org.id, name="合成承接部门B")
    db.add_all([dept_a, dept_b])
    db.flush()
    dept_child = Department(
        org_id=org.id, name="合成承接子部门C", parent_department_id=dept_b.id
    )
    db.add(dept_child)
    db.flush()

    users: dict[str, User] = {}
    members: dict[str, OrgMembership] = {}
    people: dict[str, Employee] = {}
    auth: dict[str, dict[str, str]] = {}

    try:
        for key, tenant_id, dept_id in (
            ("a", org.id, dept_a.id),
            ("cm", org.id, dept_child.id),
            ("w", org.id, dept_child.id),
            ("foreign", foreign.id, None),
        ):
            user = User(
                username=f"{uuid4()}@example.com",
                hashed_password=get_password_hash("synthetic-password-2026"),
                full_name=f"合成_{key}",
            )
            db.add(user)
            db.flush()
            users[key] = user
            emp_row = None
            if dept_id is not None:
                emp_row = Employee(
                    org_id=tenant_id,
                    employee_code=f"D086H_{key.upper()}",
                    display_name=f"合成员工_{key}",
                    work_email=user.username,
                    department_id=dept_id,
                )
                db.add(emp_row)
                db.flush()
                people[key] = emp_row
            member = OrgMembership(
                org_id=tenant_id,
                user_id=user.id,
                employee_id=emp_row.id if emp_row else None,
            )
            db.add(member)
            db.flush()
            members[key] = member
            auth[key] = {
                "Authorization": f"Bearer {create_access_token(user.id, expires_delta=timedelta(minutes=30))}"
            }

        cm_child_grant = RoleGrant(
            org_id=org.id,
            membership_id=members["cm"].id,
            role=Role.DEPT_MANAGER,
            department_id=dept_child.id,
        )
        cm_a_grant = RoleGrant(
            org_id=org.id,
            membership_id=members["cm"].id,
            role=Role.DEPT_MANAGER,
            department_id=dept_a.id,
        )
        foreign_grant = RoleGrant(
            org_id=foreign.id,
            membership_id=members["foreign"].id,
            role=Role.ORG_ADMIN,
        )
        db.add_all([cm_child_grant, cm_a_grant, foreign_grant])
        db.add(
            CapacitySetting(
                org_id=org.id, enabled=True, updated_by_user_id=users["cm"].id
            )
        )
        db.add(
            CapacitySetting(
                org_id=foreign.id, enabled=True, updated_by_user_id=users["foreign"].id
            )
        )
        monday = week_start(date(2026, 12, 1))
        for offset in range(8):
            db.add(
                CapacityWeek(
                    org_id=org.id,
                    employee_id=people["w"].id,
                    week_start=monday + timedelta(weeks=offset),
                    other_percent=0,
                    confirmed_by_user_id=users["cm"].id,
                )
            )
        demand = CapacityDemand(
            org_id=org.id,
            requesting_department_id=dept_a.id,
            target_department_id=dept_b.id,
            requester_user_id=users["a"].id,
            capability_key="d086_hist_cap",
            capability_name="D086历史处理人专项",
            headcount=1,
            allocation_percent=30,
            window_start=date(2026, 12, 1),
            window_end=date(2026, 12, 31),
            committed_start_date=date(2026, 12, 1),
            committed_end_date=date(2026, 12, 31),
            status="accepted",
            description="合成D086历史处理人需求",
        )
        db.add(demand)
        db.flush()
        assignment = CapacityAssignment(
            org_id=org.id,
            demand_id=demand.id,
            employee_id=people["w"].id,
            allocation_percent=30,
            start_date=date(2026, 12, 1),
            due_date=date(2026, 12, 20),
            status=AssignmentStatus.ACTIVE,
            assigned_by_user_id=users["cm"].id,
        )
        db.add(assignment)
        db.commit()

        org_url = f"/api/v1/orgs/{org.id}"
        req_res = client.post(
            f"{org_url}/capacity/assignments/{assignment.id}/extension-requests",
            headers=auth["w"],
            json={
                "requested_due_date": "2026-12-23",
                "reason": "D086_HIST_REASON",
            },
        )
        assert req_res.status_code == 200, req_res.text
        req_id = req_res.json()["id"]

        dec_res = client.post(
            f"{org_url}/capacity/extension-requests/{req_id}/decision",
            headers=auth["cm"],
            json={"approve": True, "note": "D086_HIST_NOTE"},
        )
        assert dec_res.status_code == 200, dec_res.text
        assert dec_res.json()["decided_by_user_id"] == str(users["cm"].id)

        handler_notice = InboxItem(
            org_id=org.id,
            recipient_user_id=users["cm"].id,
            kind=InboxKind.CAPACITY,
            message=(
                f"员工 {people['w'].display_name} 的延期申请（D086历史处理人专项，已同意）"
                f"已由上级 {people['cm'].display_name} 代为审批"
            ),
        )
        add_item(db, handler_notice)
        record_capacity_inbox_link(
            db, handler_notice, extension_request_id=UUID(req_id)
        )
        db.commit()

        # While cm is in child under B, historical handler can open detail and see receipt.
        cm_principal_before = get_org_principal(org.id, users["cm"], db)
        before_detail = CapacityInboxProvider().extension_detail(
            cm_principal_before, db, UUID(req_id)
        )
        assert before_detail is not None
        assert before_detail.reason == "D086_HIST_REASON"

        # cm and w both move to dept_a, and cm loses DEPT_MANAGER on dept_child while keeping dept_a.
        # cm still satisfies can_view_employee(cm, w) and decided_by_user_id == cm,
        # but extension_department_allowed(cm, dept_b) is now False.
        people["cm"].department_id = dept_a.id
        people["w"].department_id = dept_a.id
        db.add_all([people["cm"], people["w"]])
        db.delete(cm_child_grant)
        db.commit()

        cm_principal_after = get_org_principal(org.id, users["cm"], db)
        assert (
            CapacityInboxProvider().extension_detail(
                cm_principal_after, db, UUID(req_id)
            )
            is None
        )
        assert (
            CapacityInboxProvider().accessible_extension_ids(
                cm_principal_after, db, {UUID(req_id)}
            )
            == set()
        )
        handler_list = client.get(f"{org_url}/me/inbox", headers=auth["cm"]).json()[
            "data"
        ]
        handler_row = next(
            row for row in handler_list if row["id"] == str(handler_notice.id)
        )
        assert handler_row["extension_request_id"] is None
        assert handler_row["message"] == REDACTED_EXTENSION_RECEIPT_MESSAGE
        assert "D086历史处理人专项" not in json.dumps(handler_row, ensure_ascii=False)

        handler_detail = client.get(
            f"{org_url}/me/inbox/{handler_notice.id}", headers=auth["cm"]
        )
        assert handler_detail.status_code == 200
        assert handler_detail.json()["extension_request"] is None
        assert handler_detail.json()["item"]["extension_request_id"] is None
        assert (
            handler_detail.json()["item"]["message"]
            == REDACTED_EXTENSION_RECEIPT_MESSAGE
        )
        assert "D086_HIST_REASON" not in handler_detail.text

        handler_read = client.post(
            f"{org_url}/me/inbox/{handler_notice.id}/read", headers=auth["cm"]
        )
        assert handler_read.status_code == 200
        assert handler_read.json()["extension_request_id"] is None
        assert handler_read.json()["message"] == REDACTED_EXTENSION_RECEIPT_MESSAGE

        # Applicant w retains normal access to their own extension receipt even after moving to dept_a.
        w_inbox = client.get(f"{org_url}/me/inbox", headers=auth["w"]).json()["data"]
        w_row = next(row for row in w_inbox if row["extension_request_id"] == req_id)
        assert "D086历史处理人专项" in w_row["message"]
        w_detail = client.get(f"{org_url}/me/inbox/{w_row['id']}", headers=auth["w"])
        assert w_detail.status_code == 200
        assert w_detail.json()["extension_request"]["reason"] == "D086_HIST_REASON"
        w_read = client.post(
            f"{org_url}/me/inbox/{w_row['id']}/read", headers=auth["w"]
        )
        assert w_read.status_code == 200
        assert w_read.json()["extension_request_id"] == req_id

        # Cross-tenant isolation.
        foreign_principal = get_org_principal(foreign.id, users["foreign"], db)
        assert (
            CapacityInboxProvider().extension_detail(
                foreign_principal, db, UUID(req_id)
            )
            is None
        )
        assert (
            CapacityInboxProvider().accessible_extension_ids(
                foreign_principal, db, {UUID(req_id)}
            )
            == set()
        )
        assert (
            client.get(
                f"{org_url}/me/inbox/{handler_notice.id}", headers=auth["foreign"]
            ).status_code
            == 404
        )
    finally:
        db.rollback()
        for model in (
            InboxItem,
            CapacityExtensionRequest,
            CapacityAssignment,
            CapacityDemand,
            CapacityWeek,
            CapacitySetting,
        ):
            db.execute(delete(model).where(model.org_id == org.id))
        db.execute(delete(CapacitySetting).where(CapacitySetting.org_id == foreign.id))
        db.commit()
        delete_test_organization(db, org.id)
        delete_test_organization(db, foreign.id)
        for user in users.values():
            db.delete(user)
        db.commit()


def test_inbox_target_migration_roundtrip(migration_engine: Engine) -> None:
    previous = "e57a1b2c3d4f"
    target = "e58a1b2c3d4f"
    for action, revision in [
        ("downgrade", previous),
        ("upgrade", target),
        ("downgrade", previous),
        ("upgrade", target),
    ]:
        migrate(migration_engine, action, revision)
        cols = {c["name"] for c in inspect(migration_engine).get_columns("inbox_item")}
        assert ({"target_type", "target_id"} <= cols) == (action == "upgrade")
    backend_dir = Path(__file__).resolve().parents[3]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "app/alembic"))
    config.attributes["configure_logger"] = False
    with migration_engine.connect() as connection:
        config.attributes["connection"] = connection
        command.check(config)
        assert (
            connection.execute(
                text("SELECT count(*) FROM alembic_version")
            ).scalar_one()
            == 1
        )


@pytest.mark.unit
@pytest.mark.parametrize(
    (
        "kind",
        "message",
        "stored_type",
        "stored_id",
        "wl_id",
        "ext_id",
        "redacted",
        "expected_type",
        "has_target_id",
    ),
    [
        (
            InboxKind.CAPACITY,
            "Arbitrary changed copy",
            InboxTargetType.REVIEWS_BORROW.value,
            UUID("00000000-0000-0000-0000-000000000011"),
            None,
            None,
            False,
            InboxTargetType.REVIEWS_BORROW,
            True,
        ),
        (
            InboxKind.CAPACITY,
            "New collaboration demand received\n/capacity?tab=incoming&demand=00000000-0000-0000-0000-000000000022",
            None,
            None,
            None,
            None,
            False,
            InboxTargetType.CAPACITY_INCOMING,
            True,
        ),
        (
            InboxKind.CAPACITY,
            "Plan status\n/capacity?tab=incoming&demand=00000000-0000-0000-0000-000000000022&plans=1",
            None,
            None,
            None,
            None,
            False,
            InboxTargetType.CAPACITY_PLANS,
            True,
        ),
        (
            InboxKind.CAPACITY,
            "Tracking\n/capacity?tab=borrows",
            None,
            None,
            None,
            None,
            False,
            InboxTargetType.CAPACITY_BORROWS,
            False,
        ),
        (
            InboxKind.CAPACITY,
            "You have a workload adjustment request awaiting approval",
            None,
            None,
            None,
            None,
            False,
            InboxTargetType.REVIEWS_WORKLOAD,
            False,
        ),
        (
            InboxKind.CAPACITY,
            "Borrow request (Delivery, 2026-12-01 to 2026-12-10)",
            None,
            None,
            None,
            None,
            False,
            InboxTargetType.REVIEWS_BORROW,
            False,
        ),
        (
            InboxKind.CAPACITY,
            "收到新的协作需求",
            None,
            None,
            None,
            None,
            False,
            InboxTargetType.REVIEWS_DEMAND,
            False,
        ),
        (
            InboxKind.CAPACITY,
            "协作需求已收到答复",
            None,
            None,
            None,
            None,
            False,
            InboxTargetType.CAPACITY_OUTGOING,
            False,
        ),
        (
            InboxKind.CAPACITY,
            "Alice recorded leave (2026-12-01 to 2026-12-03).",
            None,
            None,
            None,
            None,
            False,
            InboxTargetType.CAPACITY_TEAM,
            False,
        ),
        (
            InboxKind.ADMIN_TODOS,
            "You have 3 admin to-dos",
            None,
            None,
            None,
            None,
            False,
            InboxTargetType.ASSISTANT_ADMIN,
            False,
        ),
        (
            InboxKind.CAPACITY,
            "Secret extension receipt",
            InboxTargetType.CAPACITY_OUTGOING.value,
            UUID("00000000-0000-0000-0000-000000000033"),
            None,
            UUID("00000000-0000-0000-0000-000000000044"),
            True,
            InboxTargetType.CAPACITY,
            False,
        ),
        (
            InboxKind.PROFILE_EDITED,
            "Profile updated",
            None,
            None,
            None,
            None,
            False,
            None,
            False,
        ),
    ],
)
def test_resolve_target_structured_and_legacy(
    kind: InboxKind,
    message: str,
    stored_type: str | None,
    stored_id: UUID | None,
    wl_id: UUID | None,
    ext_id: UUID | None,
    redacted: bool,
    expected_type: InboxTargetType | None,
    has_target_id: bool,
) -> None:
    item = InboxItem(
        org_id=uuid4(),
        recipient_user_id=uuid4(),
        kind=kind,
        target_type=stored_type,
        target_id=stored_id,
        message=message,
    )
    resolved_type, resolved_id = _resolve_target(item, wl_id, ext_id, redacted=redacted)
    assert resolved_type == expected_type
    assert (resolved_id is not None) == has_target_id


def test_structured_inbox_targets_bilingual_and_legacy_fallback(
    capacity_demo: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = capacity_demo
    e02 = employees["E02"]
    mgr_emp = employees["E01"]
    mgr_user_id = db.exec(
        select(OrgMembership.user_id).where(
            OrgMembership.org_id == e02.org_id, OrgMembership.employee_id == mgr_emp.id
        )
    ).one()
    db.add(
        CapacitySetting(org_id=e02.org_id, enabled=True, updated_by_user_id=mgr_user_id)
    )
    monday = this_week(db, e02.org_id)
    db.add(
        CapacityWeek(
            org_id=e02.org_id,
            employee_id=e02.id,
            week_start=monday,
            other_percent=20,
            confirmed_by_user_id=mgr_user_id,
        )
    )
    demand = CapacityDemand(
        org_id=e02.org_id,
        requesting_department_id=e02.department_id,
        requester_user_id=mgr_user_id,
        target_department_id=e02.department_id,
        capability_key="backend_api",
        capability_name="后端与接口",
        headcount=1,
        allocation_percent=30,
        window_start=monday,
        window_end=monday + timedelta(days=14),
        description="结构化跳转测试需求",
    )
    db.add(demand)
    db.flush()
    assignment = CapacityAssignment(
        org_id=e02.org_id,
        demand_id=demand.id,
        employee_id=e02.id,
        allocation_percent=30,
        start_date=monday,
        due_date=monday + timedelta(days=7),
        status=AssignmentStatus.ACTIVE,
        assigned_by_user_id=mgr_user_id,
    )
    db.add(assignment)
    db.flush()
    # Historical DB row with no target_type/target_id stored.
    legacy_item = InboxItem(
        org_id=e02.org_id,
        recipient_user_id=mgr_user_id,
        kind=InboxKind.CAPACITY,
        message="收到新的协作需求",
    )
    add_item(db, legacy_item)
    db.commit()

    wl_res = client.post(
        f"{url}/capacity/workloads/me/requests",
        headers=auth["employee"],
        json={
            "requested_percent": 55,
            "reason": "专项支持",
            "start_week": monday.isoformat(),
            "end_week": monday.isoformat(),
        },
    )
    assert wl_res.status_code == 200
    ext_res = client.post(
        f"{url}/capacity/assignments/{assignment.id}/extension-requests",
        headers=auth["employee"],
        json={
            "requested_due_date": (monday + timedelta(days=12)).isoformat(),
            "reason": "联调延期",
        },
    )
    assert ext_res.status_code == 200

    # Verify exclude_own filters applicant's own extension requests while preserving reviewer view.
    emp_exts = client.get(
        f"{url}/capacity/extension-requests", headers=auth["employee"]
    ).json()["data"]
    assert len(emp_exts) == 1
    assert (
        client.get(
            f"{url}/capacity/extension-requests?exclude_own=true",
            headers=auth["employee"],
        ).json()["data"]
        == []
    )
    mgr_exts = client.get(
        f"{url}/capacity/extension-requests?exclude_own=true", headers=auth["manager"]
    ).json()["data"]
    assert len(mgr_exts) == 1

    # Verify MembershipPublic.can_review for plain employee vs manager.
    emp_memberships = client.get(
        "/api/v1/me/memberships", headers=auth["employee"]
    ).json()
    mgr_memberships = client.get(
        "/api/v1/me/memberships", headers=auth["manager"]
    ).json()
    assert emp_memberships[0]["can_review"] is False
    assert mgr_memberships[0]["can_review"] is True

    # Verify structured targets stay identical across zh-CN and en locales.
    zh_rows = client.get(
        f"{url}/me/inbox",
        headers={**auth["manager"], "Accept-Language": "zh-CN"},
    ).json()["data"]
    en_rows = client.get(
        f"{url}/me/inbox",
        headers={**auth["manager"], "Accept-Language": "en"},
    ).json()["data"]
    assert [r["target_type"] for r in zh_rows] == [r["target_type"] for r in en_rows]
    assert [r["target_id"] for r in zh_rows] == [r["target_id"] for r in en_rows]
    assert any(
        r["id"] == str(legacy_item.id) and r["target_type"] == "reviews_demand"
        for r in en_rows
    )
    assert sum(1 for r in en_rows if r["target_type"] == "reviews_workload") >= 2
