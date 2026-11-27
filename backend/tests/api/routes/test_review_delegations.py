import json
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import Engine, inspect
from sqlmodel import Session, select

from app.authz.deps import get_org_principal
from app.authz.principal import Principal
from app.core.security import create_access_token
from app.domains import manager_tools
from app.domains.audit.models import AuditEvent
from app.domains.base import utc_now
from app.domains.bot.presentation import manual_failure
from app.domains.capability.service import (
    get_schema,
    list_capabilities,
    read_editor,
    save_version,
)
from app.domains.change_request.models import (
    ChangeItem,
    ChangeItemEvidence,
    ChangeOp,
    ItemDecision,
    ProfileChangeRequest,
    RequestOrigin,
    RequestStatus,
    ReviewDecision,
)
from app.domains.evidence.models import Evidence, EvidenceKind, Visibility
from app.domains.evidence.service import append_evidence, read_evidence
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.org.models import (
    Department,
    Employee,
    EmploymentStatus,
    OrgMembership,
    ReportingLine,
    Role,
    RoleGrant,
)
from app.domains.profile.models import ClaimEvidence, EvidenceRelation, ProfileClaim
from app.domains.review import service
from app.domains.review.publish import current_claims
from app.domains.review.routing import can_review, can_review_any, reviewable_employees
from app.models import User
from tests.api.routes.test_mcp import call as mcp_call
from tests.api.routes.test_mcp import initialize, token_for
from tests.api.routes.test_reviews import actor, manager, pending, values
from tests.utils.migrations import migrate


def setup_delegation(
    db: Session, demo: tuple, *, delegate: Principal | None = None
) -> ReportingLine | RoleGrant:
    principal = manager(db, demo)
    delegate = delegate or actor(db, principal.org_id, "admin@demo.example.com")
    if delegate.employee_id is not None:
        assert principal.employee_id is not None
        line = ReportingLine(
            org_id=principal.org_id,
            employee_id=principal.employee_id,
            manager_employee_id=delegate.employee_id,
        )
        db.add(line)
        db.commit()
        return line
    dept = db.get(Employee, principal.employee_id).department_id
    root = Department(org_id=principal.org_id, name=f"合成总部-{uuid4().hex[:6]}")
    db.add(root)
    db.flush()
    current_dept = db.get(Department, dept)
    assert current_dept is not None
    current_dept.parent_department_id = root.id
    db.add(current_dept)
    member = db.exec(
        select(OrgMembership).where(
            OrgMembership.org_id == principal.org_id,
            OrgMembership.user_id == delegate.user_id,
        )
    ).one()
    grant = RoleGrant(
        org_id=principal.org_id,
        membership_id=member.id,
        role=Role.DEPT_MANAGER,
        department_id=root.id,
    )
    db.add(grant)
    db.commit()
    return grant


def _add_org_member(
    db: Session,
    org_id: UUID,
    name: str,
    department_id: UUID | None,
    *,
    title: str | None = None,
    with_user: bool = True,
    is_active: bool = True,
    employment_status: EmploymentStatus = EmploymentStatus.ACTIVE,
    role: Role | None = None,
    role_department_id: UUID | None = None,
) -> tuple[Employee, User | None]:
    emp = Employee(
        org_id=org_id,
        department_id=department_id,
        display_name=name,
        title=title,
        employee_code=f"CODE-{uuid4().hex[:8]}",
        employment_status=employment_status,
    )
    db.add(emp)
    db.flush()
    user: User | None = None
    if with_user:
        user = User(
            username=f"{uuid4().hex}@example.com",
            email=f"{uuid4().hex}@example.com",
            full_name=name,
            hashed_password="unused",
            is_active=is_active,
        )
        db.add(user)
        db.flush()
        member = OrgMembership(org_id=org_id, user_id=user.id, employee_id=emp.id)
        db.add(member)
        db.flush()
        if role is not None:
            db.add(
                RoleGrant(
                    org_id=org_id,
                    membership_id=member.id,
                    role=role,
                    department_id=role_department_id,
                )
            )
    db.flush()
    return emp, user


def test_delegate_reads_decides_and_notifies_without_employee(
    demo: tuple, db: Session
) -> None:
    setup_delegation(db, demo)
    mgr = manager(db, demo)
    owner, request = pending(db, demo)
    delegate = actor(db, owner.org_id, "admin@demo.example.com")
    assert delegate.employee_id is None
    assert can_review(db, mgr, owner.employee_id) == mgr.user_id
    assert can_review(db, delegate, owner.employee_id) == mgr.user_id
    assert request.id in {r.id for r in service.list_pending_reviews(delegate, db).data}
    detail = manager_tools.get_review(delegate, db, request.id)
    assert detail.acting_for_name
    evidence_id = detail.items[0].evidence[0].id
    assert read_evidence(db, delegate, evidence_id).content is not None
    # Submission notification only goes to the primary reviewer, not auto-delegates.
    recipients = set(
        db.exec(
            select(InboxItem.recipient_user_id).where(
                InboxItem.org_id == owner.org_id,
                InboxItem.request_id == request.id,
                InboxItem.kind == InboxKind.REVIEW_REQUESTED,
            )
        ).all()
    )
    assert recipients == {mgr.user_id}
    result = manager_tools.decide_review_items(
        delegate, db, request.id, request.revision, values(request)
    )
    db.commit()
    decision = db.get(ReviewDecision, result.decision_id)
    assert decision.acting_for_user_id == mgr.user_id
    assert decision.reviewer_user_id == delegate.user_id
    audit = db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == owner.org_id,
            AuditEvent.action == "change_request.decided",
        )
    ).one()
    assert audit.details["acting_for_user_id"] == str(mgr.user_id)
    assert audit.details["delegation_mode"] == "org_hierarchy"
    # Acting-for decision notifies the original primary reviewer.
    callback_notices = db.exec(
        select(InboxItem).where(
            InboxItem.org_id == owner.org_id,
            InboxItem.request_id == request.id,
            InboxItem.kind == InboxKind.DECIDED,
            InboxItem.recipient_user_id == mgr.user_id,
        )
    ).all()
    assert len(callback_notices) == 1
    assert "代为审批" in callback_notices[0].message
    assert demo[1]["E02"].display_name in callback_notices[0].message
    assert request.id not in {
        r.id for r in service.list_pending_reviews(delegate, db).data
    }


@pytest.mark.usefixtures("enable_external_mcp")
@pytest.mark.parametrize("channel", ["web", "mcp"])
@pytest.mark.parametrize("ending", ["approved", "revoked", "disabled"])
def test_cross_department_employee_delegate_evidence_is_request_scoped(
    demo: tuple, db: Session, client: TestClient, channel: str, ending: str
) -> None:
    base, employees, _ = demo
    mgr = manager(db, demo)
    delegate = actor(db, employees["E02"].org_id, "employee.algorithm@demo.example.com")
    assert not delegate.is_org_admin and not delegate.managed_department_ids
    subject = employees["E02"]
    assert db.get(Employee, delegate.employee_id).department_id != subject.department_id
    row = setup_delegation(db, demo, delegate=delegate)
    assert isinstance(row, ReportingLine)
    _, request = pending(db, demo)
    unrelated, _ = append_evidence(
        db,
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        kind=EvidenceKind.SELF_REPORT,
        source="synthetic",
        source_ref="unrelated",
        title="合成的未引用证据",
        content={"text": "未引用的受限正文"},
        visibility=Visibility.RESTRICTED,
        provenance={},
    )
    db.commit()
    originals = {
        e.id: e.model_dump()
        for e in db.exec(select(Evidence).where(Evidence.org_id == subject.org_id))
    }
    web_headers = {
        "Authorization": f"Bearer {create_access_token(delegate.user_id, expires_delta=timedelta(minutes=5))}"
    }
    headers = web_headers
    if channel == "mcp":
        headers, _ = token_for(db, db.get(Employee, delegate.employee_id))
        headers = initialize(client, headers)

    def invoke(tool: str) -> tuple[int, dict]:
        args = {"request_id": str(request.id)}
        if tool == "decide_review_items":
            args.update(
                revision=request.revision,
                decisions=[d.model_dump(mode="json") for d in values(request)],
            )
        if channel == "mcp":
            result = mcp_call(client, headers, tool, args)
            if result.get("isError"):
                return json.loads(result["content"][0]["text"])["status"], result
            return 200, result["structuredContent"]
        path = f"{base}/reviews/{request.id}"
        response = (
            client.get(path, headers=headers)
            if tool == "get_review"
            else client.post(
                path + "/decisions",
                headers=headers,
                json={k: v for k, v in args.items() if k != "request_id"},
            )
        )
        return response.status_code, response.json()

    status, detail = invoke("get_review")
    assert status == 200, detail
    evidence = [e for item in detail["items"] for e in item["evidence"]]
    assert evidence and all(e["content"] and not e["redacted"] for e in evidence)
    assert any(e["visibility"] == "restricted" for e in evidence)
    assert str(unrelated.id) not in {e["id"] for e in evidence}
    for e in evidence:
        response = client.get(f"{base}/evidence/{e['id']}", headers=web_headers)
        assert response.status_code == 200, response.text
        assert response.json() == e
        assert (
            client.get(
                f"{base}/evidence/{e['id']}", headers=demo[2]["foreign"]
            ).status_code
            == 404
        )
    for path in (
        f"/evidence/{unrelated.id}",
        f"/employees/{subject.id}/profile",
        f"/employees/{subject.id}/evidence",
    ):
        assert client.get(base + path, headers=web_headers).status_code == 404
    if ending == "approved":
        status, result = invoke("decide_review_items")
        assert status == 200 and result["status"] == "approved", result
        db.expire_all()
        decision = db.get(ReviewDecision, UUID(result["decision_id"]))
        assert decision.acting_for_user_id == mgr.user_id
        assert decision.reviewer_user_id == delegate.user_id
        assert decision.via == channel
    else:
        if ending == "revoked":
            row.valid_to = utc_now()
            db.add(row)
        else:
            delegate_emp = db.get(Employee, delegate.employee_id)
            assert delegate_emp is not None
            delegate_emp.employment_status = EmploymentStatus.INACTIVE
            db.add(delegate_emp)
        db.commit()
    try:
        for tool in ("get_review", "decide_review_items"):
            expected = 404 if channel == "mcp" and ending != "approved" else 403
            if ending == "approved" and tool == "decide_review_items":
                expected = 409
            if channel == "mcp" and ending == "disabled":
                res = client.post(
                    "/mcp",
                    headers=headers,
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/call",
                        "params": {
                            "name": tool,
                            "arguments": {"request_id": str(request.id)},
                        },
                    },
                )
                assert res.status_code == 404
            else:
                assert invoke(tool)[0] == expected
        for e in evidence:
            assert (
                client.get(
                    f"{base}/evidence/{e['id']}", headers=web_headers
                ).status_code
                == 404
            )
    finally:
        if ending == "disabled":
            delegate_emp = db.get(Employee, delegate.employee_id)
            assert delegate_emp is not None
            delegate_emp.employment_status = EmploymentStatus.ACTIVE
            db.add(delegate_emp)
            db.commit()
    for id_, original in originals.items():
        assert db.get(Evidence, id_).model_dump() == original


def test_multilevel_reporting_line_skips_unlinked_and_guards_cycles_and_self(
    demo: tuple, db: Session
) -> None:
    _, employees, _ = demo
    org_id = employees["E02"].org_id
    e01 = employees["E01"]
    e02 = employees["E02"]
    mgr = manager(db, demo)
    # E01 -> intermediate (no User) -> director (active) -> ceo (active)
    mid_emp, _ = _add_org_member(
        db, org_id, "合成中层无账号", e01.department_id, with_user=False
    )
    dir_emp, dir_user = _add_org_member(
        db, org_id, "合成总监", e01.department_id, title="研发总监"
    )
    ceo_emp, ceo_user = _add_org_member(db, org_id, "合成CEO", None, title="CEO")
    assert dir_user is not None and ceo_user is not None
    db.add_all(
        [
            ReportingLine(
                org_id=org_id, employee_id=e01.id, manager_employee_id=mid_emp.id
            ),
            ReportingLine(
                org_id=org_id, employee_id=mid_emp.id, manager_employee_id=dir_emp.id
            ),
            ReportingLine(
                org_id=org_id, employee_id=dir_emp.id, manager_employee_id=ceo_emp.id
            ),
        ]
    )
    db.commit()
    dir_principal = get_org_principal(org_id, dir_user, db)
    ceo_principal = get_org_principal(org_id, ceo_user, db)
    assert can_review(db, dir_principal, e02.id) == mgr.user_id
    assert can_review(db, ceo_principal, e02.id) == mgr.user_id
    assert can_review_any(db, dir_principal) is True
    assert can_review_any(db, ceo_principal) is True
    assert (
        manual_failure(db, dir_principal, "失败", intent_text="我要审批").review_link
        == "/reviews"
    )

    # Reporting cycle (ceo -> e02 -> ... -> ceo): self-review remains forbidden and no infinite loop.
    db.add(
        ReportingLine(org_id=org_id, employee_id=ceo_emp.id, manager_employee_id=e02.id)
    )
    db.commit()
    e02_principal = actor(db, org_id, "employee.platform@demo.example.com")
    assert can_review(db, e02_principal, e02.id) is None
    assert can_review(db, ceo_principal, e02.id) == mgr.user_id

    # Deactivating CEO account or marking INACTIVE revokes access immediately.
    ceo_user.is_active = False
    db.add(ceo_user)
    db.commit()
    assert can_review(db, ceo_principal, e02.id) is None
    assert can_review(db, dir_principal, e02.id) == mgr.user_id


def test_pure_dept_tree_multi_managers_branch_isolation_and_cycle_guard(
    demo: tuple, db: Session
) -> None:
    _, employees, _ = demo
    org_id = employees["E02"].org_id
    e02 = employees["E02"]
    mgr = manager(db, demo)
    root_dept = Department(org_id=org_id, name="总公司")
    other_branch = Department(org_id=org_id, name="其他分支")
    db.add_all([root_dept, other_branch])
    db.flush()
    other_branch.parent_department_id = root_dept.id
    plat_dept = db.get(Department, e02.department_id)
    assert plat_dept is not None
    plat_dept.parent_department_id = root_dept.id
    db.add_all([other_branch, plat_dept])
    _, root_mgr_a = _add_org_member(
        db,
        org_id,
        "总公司经理甲",
        root_dept.id,
        role=Role.DEPT_MANAGER,
        role_department_id=root_dept.id,
    )
    _, root_mgr_b = _add_org_member(
        db,
        org_id,
        "总公司经理乙",
        root_dept.id,
        role=Role.DEPT_MANAGER,
        role_department_id=root_dept.id,
    )
    _, sibling_mgr = _add_org_member(
        db,
        org_id,
        "跨分支经理",
        other_branch.id,
        role=Role.DEPT_MANAGER,
        role_department_id=other_branch.id,
    )
    assert root_mgr_a and root_mgr_b and sibling_mgr
    db.commit()

    p_a = get_org_principal(org_id, root_mgr_a, db)
    p_b = get_org_principal(org_id, root_mgr_b, db)
    p_sib = get_org_principal(org_id, sibling_mgr, db)
    assert can_review(db, p_a, e02.id) == mgr.user_id
    assert can_review(db, p_b, e02.id) == mgr.user_id
    assert can_review(db, p_sib, e02.id) is None

    # Moving employee out of branch revokes old ancestor manager immediately.
    e02.department_id = other_branch.id
    db.add(e02)
    db.commit()
    assert can_review(db, p_sib, e02.id) == sibling_mgr.id
    assert can_review(db, p_a, e02.id) == sibling_mgr.id
    assert can_review(db, mgr, e02.id) is None

    # Department parent cycle does not loop infinitely.
    root_dept.parent_department_id = other_branch.id
    db.add(root_dept)
    db.commit()
    assert reviewable_employees(db, p_a, {e02.id}) == {e02.id: sibling_mgr.id}


def test_self_approval_red_line_even_if_subject_is_parent_manager(
    demo: tuple, db: Session
) -> None:
    _, employees, _ = demo
    org_id = employees["E02"].org_id
    e02 = employees["E02"]
    root_dept = Department(org_id=org_id, name="合成集团")
    db.add(root_dept)
    db.flush()
    plat_dept = db.get(Department, e02.department_id)
    assert plat_dept is not None
    plat_dept.parent_department_id = root_dept.id
    db.add(plat_dept)
    e02_member = db.exec(
        select(OrgMembership).where(
            OrgMembership.org_id == org_id,
            OrgMembership.employee_id == e02.id,
        )
    ).one()
    db.add(
        RoleGrant(
            org_id=org_id,
            membership_id=e02_member.id,
            role=Role.DEPT_MANAGER,
            department_id=root_dept.id,
        )
    )
    db.commit()
    owner, request = pending(db, demo)
    assert can_review(db, owner, e02.id) is None
    with pytest.raises(HTTPException) as err:
        service.decide(owner, db, request.id, request.revision, values(request))
    assert err.value.status_code == 403


def test_delegation_http_readonly_and_410_gone(
    demo: tuple, db: Session, client: TestClient
) -> None:
    url, employees, auth = demo
    org_id = employees["E01"].org_id
    root_dept = Department(org_id=org_id, name="总部")
    db.add(root_dept)
    db.flush()
    plat_dept = db.get(Department, employees["E01"].department_id)
    assert plat_dept is not None
    plat_dept.parent_department_id = root_dept.id
    db.add(plat_dept)
    boss_emp, boss_user = _add_org_member(
        db,
        org_id,
        "林总",
        root_dept.id,
        title="技术总监",
        role=Role.DEPT_MANAGER,
        role_department_id=root_dept.id,
    )
    assert boss_user is not None
    db.add(
        ReportingLine(
            org_id=org_id,
            employee_id=employees["E01"].id,
            manager_employee_id=boss_emp.id,
        )
    )
    db.commit()

    path = f"{url}/me/review-delegations"
    mgr_view = client.get(path, headers=auth["manager"])
    assert mgr_view.status_code == 200, mgr_view.text
    assert mgr_view.json() == {
        "is_reviewer_role": True,
        "auto_delegates": [
            {
                "user_id": str(boss_user.id),
                "name": "林总",
                "department_name": "总部",
                "title": "技术总监",
                "relations": ["直属上级", "上级部门经理（总部）"],
            }
        ],
    }
    emp_view = client.get(path, headers=auth["employee"])
    assert emp_view.status_code == 200
    assert emp_view.json() == {"is_reviewer_role": False, "auto_delegates": []}
    admin_view = client.get(path, headers=auth["admin"])
    assert admin_view.status_code == 200
    assert admin_view.json() == {"is_reviewer_role": True, "auto_delegates": []}
    assert client.get(path, headers=auth["foreign"]).status_code == 404

    for method, target in (
        ("POST", path),
        ("DELETE", f"{path}/{uuid4()}"),
    ):
        for role_key in ("manager", "employee", "admin"):
            res = client.request(method, target, headers=auth[role_key], json={})
            assert res.status_code == 410
            assert (
                res.json()["detail"]
                == "代理审批已改为按组织架构自动设置，无需手动添加或撤销"
            )
        assert (
            client.request(method, target, headers=auth["foreign"], json={}).status_code
            == 404
        )


def test_cross_tenant_delegate_has_no_review_access(
    demo: tuple, db: Session, client: TestClient
) -> None:
    setup_delegation(db, demo)
    owner, request = pending(db, demo)
    foreign_user_id = client.get("/api/v1/users/me", headers=demo[2]["foreign"]).json()[
        "id"
    ]
    foreign_org_id = db.exec(
        select(OrgMembership.org_id).where(
            OrgMembership.user_id == UUID(foreign_user_id)
        )
    ).one()
    assert (
        client.get(
            f"/api/v1/orgs/{foreign_org_id}/reviews/{request.id}",
            headers=demo[2]["foreign"],
        ).status_code
        == 404
    )
    principal = actor(db, owner.org_id, "admin@demo.example.com")
    principal = type(principal)(
        principal.actor_type,
        foreign_org_id,
        principal.user_id,
        None,
        False,
        frozenset(),
    )
    assert can_review(db, principal, owner.employee_id) is None


@pytest.mark.slow
def test_delegation_migration_roundtrip(migration_engine: Engine) -> None:
    migrate(migration_engine, "downgrade", "b127001bc001")
    assert "review_delegation" not in inspect(migration_engine).get_table_names()
    migrate(migration_engine, "upgrade", "head")
    fks = inspect(migration_engine).get_foreign_keys("review_delegation")
    assert (
        sum(
            fk["referred_table"] == "org_membership"
            and fk["referred_columns"] == ["org_id", "user_id"]
            for fk in fks
        )
        == 3
    )
    migrate(migration_engine, "downgrade", "b127001bc001")
    migrate(migration_engine, "upgrade", "head")


def test_temporary_delegate_evidence_claims_are_request_capability_scoped(
    demo: tuple, db: Session, client: TestClient
) -> None:
    base, employees, auth = demo
    subject = employees["E02"]
    delegate = actor(db, subject.org_id, "employee.algorithm@demo.example.com")
    assert not delegate.is_org_admin and not delegate.managed_department_ids
    line = setup_delegation(db, demo, delegate=delegate)
    assert isinstance(line, ReportingLine)

    cap_rows = list_capabilities(db, subject.org_id, get_schema(db, subject.org_id).id)
    cap_by_key = {c.key: c for c in cap_rows}
    claims = current_claims(db, subject.org_id, subject.id)
    claim_a = claims["backend_api"]
    other_cap = next(c for c in cap_rows if c.key not in claims)
    claim_b = ProfileClaim(
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        capability_definition_id=other_cap.id,
        statement="非本单送审的既有能力判断",
        level="routine",
        assessment_status="confirmed",
        confidence="medium",
        generated_by={"actor_type": "human"},
    )
    db.add(claim_b)
    db.flush()

    shared_ev, _ = append_evidence(
        db,
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        kind=EvidenceKind.SELF_REPORT,
        source="synthetic",
        source_ref="shared-d087",
        title="跨能力共享受限证据",
        content={"text": "共享证据受限正文"},
        visibility=Visibility.RESTRICTED,
        provenance={},
    )
    approved_only_ev, _ = append_evidence(
        db,
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        kind=EvidenceKind.SELF_REPORT,
        source="synthetic",
        source_ref="approved-only-d087",
        title="已自动批准项专用证据",
        content={"text": "已自动批准项受限正文"},
        visibility=Visibility.RESTRICTED,
        provenance={},
    )
    db.add_all(
        [
            ClaimEvidence(
                org_id=subject.org_id,
                claim_id=claim_a.id,
                evidence_id=shared_ev.id,
                relation=EvidenceRelation.SUPPORTS,
            ),
            ClaimEvidence(
                org_id=subject.org_id,
                claim_id=claim_b.id,
                evidence_id=shared_ev.id,
                relation=EvidenceRelation.CONTRADICTS,
            ),
        ]
    )

    # Request has an already-approved item (claim_b) and a pending item (claim_a).
    req = ProfileChangeRequest(
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        origin=RequestOrigin.MANUAL,
        status=RequestStatus.PENDING_REVIEW,
        author={},
    )
    db.add(req)
    db.flush()
    approved_item = ChangeItem(
        org_id=subject.org_id,
        request_id=req.id,
        position=0,
        op=ChangeOp.MODIFY,
        capability_definition_id=other_cap.id,
        target_claim_id=claim_b.id,
        after={
            "statement": "已免审生效的改动",
            "level": "routine",
            "assessment_status": "tentative",
        },
        decision=ItemDecision.APPROVED,
    )
    pending_item = ChangeItem(
        org_id=subject.org_id,
        request_id=req.id,
        position=1,
        op=ChangeOp.MODIFY,
        capability_definition_id=cap_by_key["backend_api"].id,
        target_claim_id=claim_a.id,
        after={
            "statement": "待代审的能力改动",
            "level": "routine",
            "assessment_status": "tentative",
        },
    )
    db.add_all([approved_item, pending_item])
    db.flush()
    db.add_all(
        [
            ChangeItemEvidence(
                org_id=subject.org_id,
                item_id=approved_item.id,
                evidence_id=approved_only_ev.id,
                relation=EvidenceRelation.SUPPORTS,
            ),
            ChangeItemEvidence(
                org_id=subject.org_id,
                item_id=approved_item.id,
                evidence_id=shared_ev.id,
                relation=EvidenceRelation.SUPPORTS,
            ),
            ChangeItemEvidence(
                org_id=subject.org_id,
                item_id=pending_item.id,
                evidence_id=shared_ev.id,
                relation=EvidenceRelation.SUPPORTS,
            ),
        ]
    )
    db.commit()

    delegate_headers = {
        "Authorization": f"Bearer {create_access_token(delegate.user_id, expires_delta=timedelta(minutes=5))}"
    }
    review_res = client.get(f"{base}/reviews/{req.id}", headers=delegate_headers)
    assert review_res.status_code == 200, review_res.text
    review_ev = review_res.json()["items"][0]["evidence"][0]
    assert review_ev["id"] == str(shared_ev.id)
    assert review_ev["content"] == {"text": "共享证据受限正文"}
    assert review_ev["redacted"] is False
    assert [c["claim_id"] for c in review_ev["claims"]] == [str(claim_a.id)]

    detail_res = client.get(f"{base}/evidence/{shared_ev.id}", headers=delegate_headers)
    assert detail_res.status_code == 200, detail_res.text
    assert detail_res.json() == review_ev
    assert (
        client.get(
            f"{base}/evidence/{approved_only_ev.id}", headers=delegate_headers
        ).status_code
        == 404
    )

    # Routine jurisdiction (manager, owner, org_admin) still sees all linked claims.
    for role_key in ("manager", "employee", "admin"):
        routine = client.get(f"{base}/evidence/{shared_ev.id}", headers=auth[role_key])
        assert routine.status_code == 200
        assert {c["claim_id"] for c in routine.json()["claims"]} == {
            str(claim_a.id),
            str(claim_b.id),
        }

    # New capability ADD sharing the same evidence reveals zero unrelated claims.
    add_cap = next(c for c in cap_rows if c.key not in claims and c.id != other_cap.id)
    _, add_req = pending(
        db,
        demo,
        items=[
            {
                "op": "add",
                "capability_key": add_cap.key,
                "statement": "新增能力陈述",
                "evidence_ids": [str(shared_ev.id)],
            }
        ],
    )
    # Remove the earlier request from pending state to test pure ADD isolation.
    db.get(ProfileChangeRequest, req.id).status = RequestStatus.APPROVED
    db.commit()

    add_review = client.get(f"{base}/reviews/{add_req.id}", headers=delegate_headers)
    assert add_review.status_code == 200, add_review.text
    add_ev = next(
        e
        for e in add_review.json()["items"][0]["evidence"]
        if e["id"] == str(shared_ev.id)
    )
    assert add_ev["content"] == {"text": "共享证据受限正文"}
    assert add_ev["claims"] == []
    add_detail = client.get(f"{base}/evidence/{shared_ev.id}", headers=delegate_headers)
    assert add_detail.status_code == 200
    assert add_detail.json()["claims"] == []

    # Revoking reporting line immediately revokes evidence and review access.
    line.valid_to = utc_now()
    db.add(line)
    db.commit()
    assert (
        client.get(f"{base}/reviews/{add_req.id}", headers=delegate_headers).status_code
        == 403
    )
    assert (
        client.get(
            f"{base}/evidence/{shared_ev.id}", headers=delegate_headers
        ).status_code
        == 404
    )


def test_temporary_delegate_evidence_claims_survive_schema_bump_and_scope_to_request(
    demo: tuple, db: Session, client: TestClient
) -> None:
    base, employees, auth = demo
    subject = employees["E02"]
    other_employee = employees["E01"]
    delegate = actor(db, subject.org_id, "employee.algorithm@demo.example.com")
    assert not delegate.is_org_admin and not delegate.managed_department_ids
    line = setup_delegation(db, demo, delegate=delegate)
    assert isinstance(line, ReportingLine)

    cap_rows = list_capabilities(db, subject.org_id, get_schema(db, subject.org_id).id)
    claims = current_claims(db, subject.org_id, subject.id)
    claim_a = claims["backend_api"]
    other_cap = next(c for c in cap_rows if c.key not in claims)
    claim_b = ProfileClaim(
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        capability_definition_id=other_cap.id,
        statement="换版前非本单的既有能力判断",
        level="routine",
        assessment_status="confirmed",
        confidence="medium",
        generated_by={"actor_type": "human"},
    )
    db.add(claim_b)
    db.flush()

    shared_ev, _ = append_evidence(
        db,
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        kind=EvidenceKind.SELF_REPORT,
        source="synthetic",
        source_ref="shared-d087-v2",
        title="换版前后多请求共享受限证据",
        content={"text": "换版前共享受限正文"},
        visibility=Visibility.RESTRICTED,
        provenance={},
    )
    db.add_all(
        [
            ClaimEvidence(
                org_id=subject.org_id,
                claim_id=claim_a.id,
                evidence_id=shared_ev.id,
                relation=EvidenceRelation.SUPPORTS,
            ),
            ClaimEvidence(
                org_id=subject.org_id,
                claim_id=claim_b.id,
                evidence_id=shared_ev.id,
                relation=EvidenceRelation.CONTRADICTS,
            ),
        ]
    )
    db.flush()

    # Bump schema version so new change items get new capability_definition_ids
    # while published claims keep the retired schema version's definition IDs.
    admin_principal = actor(db, subject.org_id, "admin@demo.example.com")
    new_schema = save_version(
        db, admin_principal, read_editor(db, admin_principal).definitions
    )
    new_cap_by_key = {
        c.key: c for c in list_capabilities(db, subject.org_id, new_schema.id)
    }
    assert new_cap_by_key["backend_api"].id != claim_a.capability_definition_id
    assert new_cap_by_key[other_cap.key].id != claim_b.capability_definition_id

    def _create_request(
        target_employee: Employee,
        cap_id: UUID,
        target_claim_id: UUID | None,
        status: RequestStatus,
        *,
        attach_shared_ev: bool = True,
    ) -> ProfileChangeRequest:
        req = ProfileChangeRequest(
            org_id=subject.org_id,
            subject_employee_id=target_employee.id,
            origin=RequestOrigin.MANUAL,
            status=status,
            author={},
        )
        db.add(req)
        db.flush()
        item = ChangeItem(
            org_id=subject.org_id,
            request_id=req.id,
            position=0,
            op=ChangeOp.MODIFY if target_claim_id else ChangeOp.ADD,
            capability_definition_id=cap_id,
            target_claim_id=target_claim_id,
            after={
                "statement": "换版后的能力改动",
                "level": "routine",
                "assessment_status": "tentative",
            },
        )
        db.add(item)
        db.flush()
        if attach_shared_ev:
            db.add(
                ChangeItemEvidence(
                    org_id=subject.org_id,
                    item_id=item.id,
                    evidence_id=shared_ev.id,
                    relation=EvidenceRelation.SUPPORTS,
                )
            )
        return req

    req_a = _create_request(
        subject,
        new_cap_by_key["backend_api"].id,
        claim_a.id,
        RequestStatus.PENDING_REVIEW,
    )
    req_b = _create_request(
        subject,
        new_cap_by_key[other_cap.key].id,
        claim_b.id,
        RequestStatus.PENDING_REVIEW,
    )
    req_approved = _create_request(
        subject,
        new_cap_by_key["backend_api"].id,
        claim_a.id,
        RequestStatus.APPROVED,
    )
    req_other_employee = _create_request(
        other_employee,
        new_cap_by_key["backend_api"].id,
        None,
        RequestStatus.PENDING_REVIEW,
        attach_shared_ev=False,
    )
    db.commit()

    delegate_headers = {
        "Authorization": f"Bearer {create_access_token(delegate.user_id, expires_delta=timedelta(minutes=5))}"
    }

    # Both review detail and request-scoped evidence detail match cross-version claim_a only.
    review_a = client.get(f"{base}/reviews/{req_a.id}", headers=delegate_headers)
    assert review_a.status_code == 200, review_a.text
    ev_a = review_a.json()["items"][0]["evidence"][0]
    assert [c["claim_id"] for c in ev_a["claims"]] == [str(claim_a.id)]
    detail_a = client.get(
        f"{base}/evidence/{shared_ev.id}",
        params={"request_id": str(req_a.id)},
        headers=delegate_headers,
    )
    assert detail_a.status_code == 200, detail_a.text
    assert detail_a.json() == ev_a

    # Request B only exposes claim_b, not claim_a from request A.
    review_b = client.get(f"{base}/reviews/{req_b.id}", headers=delegate_headers)
    assert review_b.status_code == 200, review_b.text
    ev_b = review_b.json()["items"][0]["evidence"][0]
    assert [c["claim_id"] for c in ev_b["claims"]] == [str(claim_b.id)]
    detail_b = client.get(
        f"{base}/evidence/{shared_ev.id}",
        params={"request_id": str(req_b.id)},
        headers=delegate_headers,
    )
    assert detail_b.status_code == 200, detail_b.text
    assert detail_b.json() == ev_b

    # Non-pending, unknown, or other-employee request_id denies temporary delegate access.
    for bad_req_id in (req_approved.id, req_other_employee.id, uuid4()):
        assert (
            client.get(
                f"{base}/evidence/{shared_ev.id}",
                params={"request_id": str(bad_req_id)},
                headers=delegate_headers,
            ).status_code
            == 404
        )

    # Routine full-access roles preserve all linked claims even with request_id.
    for role_key in ("manager", "employee", "admin"):
        routine = client.get(
            f"{base}/evidence/{shared_ev.id}",
            params={"request_id": str(req_a.id)},
            headers=auth[role_key],
        )
        assert routine.status_code == 200
        assert {c["claim_id"] for c in routine.json()["claims"]} == {
            str(claim_a.id),
            str(claim_b.id),
        }
    # Admin without routine restricted-content jurisdiction stays redacted when request_id is non-pending.
    admin_non_pending = client.get(
        f"{base}/evidence/{shared_ev.id}",
        params={"request_id": str(req_approved.id)},
        headers=auth["admin"],
    )
    assert admin_non_pending.status_code == 200
    assert admin_non_pending.json()["redacted"] is True
    assert admin_non_pending.json()["content"] is None
