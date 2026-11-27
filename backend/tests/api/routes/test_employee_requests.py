from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlmodel import Session, select

from app.authz.deps import get_org_principal
from app.core.db import engine
from app.domains.audit.models import AuditEvent
from app.domains.base import utc_now
from app.domains.capability.service import get_schema, list_capabilities
from app.domains.change_request import employee
from app.domains.change_request.models import (
    ChangeItem,
    ChangeItemEvidence,
    ChangeOp,
    ItemDecision,
    ProfileChangeRequest,
    RequestOrigin,
    RequestStatus,
)
from app.domains.change_request.schemas import ItemInput
from app.domains.employee_tools import EMPLOYEE_TOOLS
from app.domains.evidence.models import (
    Evidence,
    EvidenceKind,
    EvidenceStatus,
    Visibility,
)
from app.domains.evidence.service import append_evidence
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.org.models import Employee, OrgMembership
from app.domains.profile.models import EvidenceRelation, ProfileVersion
from app.models import User


def payload(key: str = "automated_testing", **changes: object) -> dict:
    return {"op": "add", "capability_key": key, "statement": "合成测试判断", **changes}


def principal_for(db: Session, org_id: UUID) -> employee.Principal:
    user = db.exec(
        select(User).where(User.email == "employee.platform@demo.example.com")
    ).one()
    return get_org_principal(org_id, user, db)


def test_my_reads(shared_demo: tuple, client: TestClient) -> None:
    url, employees, auth = shared_demo
    for path in (
        "profile",
        "evidence",
        "requests",
        "capabilities",
        "inbox",
        "questions",
    ):
        response = client.get(f"{url}/me/{path}", headers=auth["employee"])
        assert response.status_code == 200
        if path == "profile":
            assert response.json()["employee"]["id"] == str(employees["E02"].id)
        assert (
            client.get(f"{url}/me/{path}", headers=auth["foreign"]).status_code == 404
        )
        admin_response = client.get(f"{url}/me/{path}", headers=auth["admin"])
        assert admin_response.status_code == (200 if path == "inbox" else 404)
        if path == "inbox":
            assert admin_response.json()["data"] == []
    for query in ("limit=0", "limit=101", "skip=-1"):
        assert (
            client.get(
                f"{url}/me/evidence?{query}", headers=auth["employee"]
            ).status_code
            == 422
        )
        assert (
            client.get(f"{url}/me/inbox?{query}", headers=auth["employee"]).status_code
            == 422
        )
        assert (
            client.get(
                f"{url}/me/questions?{query}", headers=auth["employee"]
            ).status_code
            == 422
        )


def test_inbox_filters_before_paging_and_marks_only_matching_unread(
    minimal_demo: tuple, client: TestClient, db: Session
) -> None:
    url, employees, auth = minimal_demo
    path = f"{url}/me/inbox"
    headers = auth["employee"]
    owner = employees["E02"]
    user_id = principal_for(db, owner.org_id).user_id
    foreign_org = UUID(
        client.get("/api/v1/me/memberships", headers=auth["foreign"]).json()[0]["org"][
            "id"
        ]
    )
    db.add(OrgMembership(org_id=foreign_org, user_id=user_id))
    db.flush()
    now = utc_now()
    pending = [
        InboxItem(
            org_id=owner.org_id,
            recipient_employee_id=owner.id if index % 2 else None,
            recipient_user_id=None if index % 2 else user_id,
            kind=InboxKind.REVIEW_REQUESTED,
            message=f"待审批 {index}",
            created_at=now - timedelta(days=1),
        )
        for index in range(22)
    ]
    notices = [
        InboxItem(
            org_id=owner.org_id,
            recipient_employee_id=owner.id,
            kind=InboxKind.PROFILE_EDITED,
            message=f"画像已更新 {index}",
            created_at=now,
            read_at=now if index else None,
        )
        for index in range(25)
    ]
    completed = InboxItem(
        org_id=owner.org_id,
        recipient_employee_id=owner.id,
        kind=InboxKind.REVIEW_REQUESTED,
        message="已处理的待审批",
        done_at=now,
    )
    excluded = [
        InboxItem(
            org_id=org_id,
            recipient_employee_id=employee_id,
            recipient_user_id=recipient_user_id,
            kind=InboxKind.REVIEW_REQUESTED,
            message="其他收件箱的待审批",
        )
        for org_id, employee_id, recipient_user_id in (
            (owner.org_id, employees["E03"].id, None),
            (foreign_org, None, user_id),
        )
    ]
    db.add_all([*pending, *notices, completed, *excluded])
    db.commit()
    got = client.get(path, headers=headers, params={"limit": 20}).json()
    assert got["count"] == got["total_count"] == 48
    assert got["unread_count"] == got["filtered_unread_count"] == 24
    assert not {row["id"] for row in got["data"]} & {str(row.id) for row in pending}
    assert (
        client.get(path, headers=headers, params={"kind": "invalid"}).status_code == 422
    )
    assert (
        client.post(
            f"{path}/read-all", headers=headers, json={"kind": "invalid"}
        ).status_code
        == 422
    )
    assert (
        client.post(f"{path}/read-all", headers=auth["foreign"], json={}).status_code
        == 404
    )

    filters = {"pending_only": True, "unread_only": True, "kind": "review_requested"}
    first = client.get(path, headers=headers, params={**filters, "limit": 20}).json()
    second = client.get(
        path, headers=headers, params={**filters, "limit": 20, "skip": 20}
    ).json()
    assert first["total_count"] == 48 and first["unread_count"] == 24
    assert (
        first["count"] == first["pending_count"] == first["filtered_unread_count"] == 22
    )
    assert second["count"] == 22 and len(second["data"]) == 2
    assert [row["id"] for row in first["data"] + second["data"]] == sorted(
        str(row.id) for row in pending
    )

    assert client.post(f"{path}/read-all", headers=headers, json=filters).json() == {
        "updated_count": 22
    }
    assert client.post(f"{path}/read-all", headers=headers, json=filters).json() == {
        "updated_count": 0
    }
    after = client.get(path, headers=headers, params=filters).json()
    assert after["data"] == [] and after["count"] == after["filtered_unread_count"] == 0
    assert after["pending_count"] == 22 and after["unread_count"] == 2
    unread = client.get(path, headers=headers, params={"unread_only": True}).json()
    assert {row["id"] for row in unread["data"]} == {
        str(notices[0].id),
        str(completed.id),
    }
    assert client.post(f"{path}/read-all", headers=headers, json={}).json() == {
        "updated_count": 2
    }
    db.expire_all()
    assert all(row.read_at is None for row in excluded)
    assert all(row.done_at is None for row in pending)
    assert completed.done_at == now and notices[1].read_at == now


def test_draft_preview_submit_and_withdraw(
    demo: tuple, client: TestClient, db: Session
) -> None:
    url, employees, auth = demo
    headers = auth["employee"]
    original_profile = client.get(f"{url}/me/profile", headers=headers).json()
    own = client.get(f"{url}/me/evidence", headers=headers).json()["data"][0]["id"]
    body = {
        "items": [
            payload(
                owner_statement="本人确认的依据",
                objection="本人对初始推断的异议",
                evidence_ids=[own],
            )
        ]
    }
    response = client.post(f"{url}/me/requests", headers=headers, json=body)
    assert response.status_code == 201, response.text
    draft = response.json()
    base = f"{url}/me/requests/{draft['id']}"
    assert draft["status"] == "draft" and draft["revision"] == 1
    for role in ("admin", "manager"):
        rows = client.get(
            f"{url}/employees/{employees['E02'].id}/change-requests", headers=auth[role]
        ).json()["data"]
        assert draft["id"] not in {r["id"] for r in rows}
    before = client.get(f"{base}/preview", headers=headers).json()
    assert before["items"][0]["before"] is None
    assert before["items"][0]["after"]["after"]["assessment_status"] == "tentative"
    body["items"][0]["statement"] = "预览后修改的合成判断"
    edited = client.put(f"{base}/items", headers=headers, json=body).json()
    assert edited["revision"] == 2
    stale = client.post(
        f"{base}/submit", headers=headers, json={"revision": before["revision"]}
    )
    assert (
        stale.status_code == 409 and stale.json()["detail"] == "内容已更新，请重新预览"
    )
    preview = client.get(f"{base}/preview", headers=headers).json()
    submitted = client.post(
        f"{base}/submit", headers=headers, json={"revision": preview["revision"]}
    )
    assert submitted.status_code == 200, submitted.text
    result = submitted.json()
    assert (
        result["status"] == "pending_review"
        and result["submitted_via"] == "web"
        and result["submitted_at"]
    )
    assert result["items"][0]["after"] == preview["items"][0]["after"]["after"]
    item = result["items"][0]
    links = db.exec(
        select(ChangeItemEvidence).where(
            ChangeItemEvidence.org_id == employees["E02"].org_id,
            ChangeItemEvidence.item_id == UUID(item["id"]),
        )
    ).all()
    reports = db.exec(
        select(Evidence).where(
            Evidence.org_id == employees["E02"].org_id,
            Evidence.source == "self_report:web",
        )
    ).all()
    assert len(reports) == 2
    assert {link.relation for link in links} == {"supports", "contradicts"}
    contents = {r.id: r.content.copy() for r in reports}
    for report in reports:
        assert report.visibility == "restricted" and report.kind == "self_report"
        assert report.source_ref == item["id"]
        assert report.provenance == {
            "via": "web",
            "client_name": None,
            "request_id": draft["id"],
        }
        for role in ("admin", "manager", "employee"):
            detail = client.get(
                f"{url}/evidence/{report.id}", headers=auth[role]
            ).json()
            assert (detail["content"] is None) == (role == "admin")
            rows = client.get(
                f"{url}/employees/{employees['E02'].id}/change-requests",
                headers=auth[role],
            ).json()["data"]
            visible = next(r for r in rows if r["id"] == draft["id"])["items"][0]
            assert visible["owner_statement"] == (
                None if role == "admin" else "本人确认的依据"
            )
            assert visible["objection"] == (
                None if role == "admin" else "本人对初始推断的异议"
            )
    assert client.put(f"{base}/items", headers=headers, json=body).status_code == 409
    assert (
        client.post(
            f"{base}/submit", headers=headers, json={"revision": result["revision"]}
        ).status_code
        == 409
    )
    withdrawn = client.post(f"{base}/withdraw", headers=headers)
    assert withdrawn.status_code == 200 and withdrawn.json()["status"] == "withdrawn"
    assert client.post(f"{base}/withdraw", headers=headers).status_code == 409
    db.expire_all()
    for report in reports:
        assert (
            report.content == contents[report.id]
            and report.status == EvidenceStatus.RETRACTED
        )
    refs = withdrawn.json()["items"][0]["evidence"]
    assert {ref["evidence_id"]: ref["status"] for ref in refs} == {
        own: "active",
        **{str(report.id): "retracted" for report in reports},
    }
    requests_path = f"{url}/me/requests"
    new_draft = client.post(requests_path, headers=headers, json=body)
    assert new_draft.status_code == 201, new_draft.text
    invalid_body = {"items": [payload(evidence_ids=[own, str(reports[0].id)])]}
    for response in (
        client.post(
            requests_path,
            headers=headers,
            json={**invalid_body, "withdrawn_request_id": draft["id"]},
        ),
        client.put(
            f"{requests_path}/{new_draft.json()['id']}/items",
            headers=headers,
            json=invalid_body,
        ),
    ):
        assert response.status_code == 422
        assert response.json()["detail"] == [
            {"index": 0, "message": "不能引用已撤销或已更正的证据"}
        ]
    actions = [
        e.action
        for e in db.exec(
            select(AuditEvent).where(AuditEvent.org_id == employees["E02"].org_id)
        ).all()
    ]
    assert actions.count("evidence.retracted") == 2
    assert (
        "change_request.submitted" in actions and "change_request.withdrawn" in actions
    )
    assert client.get(f"{url}/me/profile", headers=headers).json() == original_profile
    inbox = client.get(f"{url}/me/inbox", headers=headers).json()
    assert {i["kind"] for i in inbox["data"]} == {
        "submitted",
        "status_changed",
        "question",
        "initial_review",
    }
    inbox_id = inbox["data"][0]["id"]
    first = client.post(f"{url}/me/inbox/{inbox_id}/read", headers=headers).json()
    second = client.post(f"{url}/me/inbox/{inbox_id}/read", headers=headers).json()
    assert first["read_at"] and first["read_at"] == second["read_at"]
    assert (
        client.post(
            f"{url}/me/inbox/{inbox_id}/read", headers=auth["manager"]
        ).status_code
        == 404
    )


@pytest.mark.parametrize("edit", [False, True])
def test_initial_request_confirmation(
    demo: tuple, client: TestClient, edit: bool
) -> None:
    url, _, auth = demo
    headers = auth["employee"]
    initial = next(
        r
        for r in client.get(f"{url}/me/requests", headers=headers).json()["data"]
        if r["origin"] == "initial_sync"
    )
    base = f"{url}/me/requests/{initial['id']}"
    if edit:
        uncertainty = initial["items"][0]["uncertainty"]
        body = {
            "items": [
                payload(objection="不认可系统起草的范围", uncertainty=uncertainty)
            ]
        }
        updated = client.put(f"{base}/items", headers=headers, json=body)
        assert updated.status_code == 200
        initial = updated.json()
        assert initial["status"] == "draft"
        assert initial["items"][0]["uncertainty"] == uncertainty
        assert (
            client.get(f"{url}/me/profile", headers=headers).json()["employee"][
                "progress"
            ]["review_status"]
            == "pending_employee"
        )
    else:
        assert client.post(f"{base}/withdraw", headers=headers).status_code == 409
    preview = client.get(f"{base}/preview", headers=headers).json()
    result = client.post(
        f"{base}/submit", headers=headers, json={"revision": preview["revision"]}
    )
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "pending_review"
    inbox = client.get(f"{url}/me/inbox", headers=headers).json()
    initial_notification = next(
        row
        for row in inbox["data"]
        if row["kind"] == "initial_review" and row["request_id"] == initial["id"]
    )
    assert initial_notification["done_at"] and initial_notification["read_at"]
    if edit:
        assert any(
            e["relation"] == "contradicts"
            for e in result.json()["items"][0]["evidence"]
        )


@pytest.mark.parametrize("role", ["employee", "manager", "admin", "foreign"])
def test_other_employee_and_tenant_requests(
    demo: tuple, client: TestClient, db: Session, role: str
) -> None:
    url, employees, auth = demo
    other = employees["E03"]
    row = ProfileChangeRequest(
        org_id=other.org_id,
        subject_employee_id=other.id,
        origin=RequestOrigin.MANUAL,
        status=RequestStatus.WITHDRAWN,
        author={},
    )
    db.add(row)
    db.commit()
    base = f"{url}/me/requests/{row.id}"
    headers = auth[role]
    copy_body = {"items": [payload()], "withdrawn_request_id": str(row.id)}
    assert (
        client.post(f"{url}/me/requests", headers=headers, json=copy_body).status_code
        == 404
    )
    assert client.get(f"{base}/preview", headers=headers).status_code == 404
    assert (
        client.put(
            f"{base}/items", headers=headers, json={"items": [payload()]}
        ).status_code
        == 404
    )
    assert (
        client.post(f"{base}/submit", headers=headers, json={"revision": 1}).status_code
        == 404
    )
    assert client.post(f"{base}/withdraw", headers=headers).status_code == 404
    # A principal in another tenant cannot use a request belonging to this tenant.
    if role == "foreign":
        user_id = UUID(
            jwt.decode(
                headers["Authorization"].removeprefix("Bearer "),
                options={"verify_signature": False},
            )["sub"]
        )
        membership = db.exec(
            select(OrgMembership).where(OrgMembership.user_id == user_id)
        ).one()
        foreign_employee = Employee(
            org_id=membership.org_id, display_name="Synthetic foreign employee"
        )
        db.add(foreign_employee)
        db.flush()
        membership.employee_id = foreign_employee.id
        db.commit()
        foreign = base.replace(str(other.org_id), str(membership.org_id))
        assert (
            client.post(
                foreign.rsplit("/", 1)[0], headers=headers, json=copy_body
            ).status_code
            == 404
        )
        assert client.get(f"{foreign}/preview", headers=headers).status_code == 404
        assert (
            client.put(
                f"{foreign}/items", headers=headers, json={"items": [payload()]}
            ).status_code
            == 404
        )
        assert (
            client.post(
                f"{foreign}/submit", headers=headers, json={"revision": 1}
            ).status_code
            == 404
        )
        assert client.post(f"{foreign}/withdraw", headers=headers).status_code == 404


def test_resubmitted_initial_request_preserves_evidence_relations(
    demo: tuple, client: TestClient, db: Session
) -> None:
    url, employees, auth = demo
    subject = employees["E02"]
    headers = auth["employee"]
    requests = f"{url}/me/requests"
    initial = next(
        request
        for request in client.get(requests, headers=headers).json()["data"]
        if request["origin"] == "initial_sync"
    )
    item = initial["items"][0]
    context = item["evidence"][0]
    assert context["relation"] == "context"
    expected = {context["evidence_id"]: "context"}
    for relation in (EvidenceRelation.SUPPORTS, EvidenceRelation.CONTRADICTS):
        record, _ = append_evidence(
            db,
            org_id=subject.org_id,
            subject_employee_id=subject.id,
            kind=EvidenceKind.WORK_RECORD,
            source="jira",
            source_ref=f"SYNTHETIC-{relation}",
            title="合成 Jira 工作记录",
            content={"summary": "用于验证证据关系的合成记录"},
            visibility=Visibility.STANDARD,
            provenance={},
        )
        db.add(
            ChangeItemEvidence(
                org_id=subject.org_id,
                item_id=UUID(item["id"]),
                evidence_id=record.id,
                relation=relation,
            )
        )
        expected[str(record.id)] = relation.value
    db.commit()

    new_to_second = next(
        id_ for id_, relation in expected.items() if relation == "contradicts"
    )
    second = payload("incident_support", evidence_ids=[new_to_second])
    body = {
        "withdrawn_request_id": initial["id"],
        "items": [payload(evidence_ids=list(expected)), second],
    }
    assert client.post(requests, headers=headers, json=body).status_code == 409
    base = f"{requests}/{initial['id']}"
    submitted = client.post(
        f"{base}/submit", headers=headers, json={"revision": initial["revision"]}
    )
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["status"] == "pending_review"
    withdrawn = client.post(f"{base}/withdraw", headers=headers)
    assert withdrawn.status_code == 200, withdrawn.text
    original = withdrawn.json()
    assert original["status"] == "withdrawn"

    def relations(item: dict) -> dict[str, str]:
        return {ref["evidence_id"]: ref["relation"] for ref in item["evidence"]}

    assert relations(original["items"][0]) == expected
    created = client.post(requests, headers=headers, json=body)
    assert created.status_code == 201, created.text
    draft = created.json()
    assert draft["id"] != original["id"] and draft["parent_request_id"] is None
    assert relations(draft["items"][0]) == expected
    assert relations(draft["items"][1]) == {new_to_second: "supports"}
    base = f"{requests}/{draft['id']}"
    assert (
        relations(
            client.get(f"{base}/preview", headers=headers).json()["items"][0]["after"]
        )
        == expected
    )

    updated = client.put(
        f"{base}/items",
        headers=headers,
        json={
            "items": [
                payload(statement="修改后的合成判断", evidence_ids=list(expected)),
                second,
            ]
        },
    )
    assert updated.status_code == 200, updated.text
    preview = client.get(f"{base}/preview", headers=headers).json()
    assert relations(preview["items"][0]["after"]) == expected
    assert relations(preview["items"][1]["after"]) == {new_to_second: "supports"}
    submitted = client.post(
        f"{base}/submit",
        headers=headers,
        json={
            "revision": preview["revision"],
            "policy_version": preview["policy_version"],
        },
    )
    assert submitted.status_code == 200, submitted.text
    pending = submitted.json()
    assert pending["status"] == "pending_review"
    assert relations(pending["items"][0]) == expected
    decisions = client.post(
        f"{url}/reviews/{draft['id']}/decisions",
        headers=auth["manager"],
        json={
            "revision": pending["revision"],
            "decisions": [
                {"item_id": change["id"], "decision": "approved"}
                for change in pending["items"]
            ],
        },
    )
    assert decisions.status_code == 200, decisions.text
    assert decisions.json()["status"] == "approved"
    version = db.get(ProfileVersion, UUID(decisions.json()["published_version_id"]))
    assert version is not None
    published_claim = next(
        claim
        for claim in version.snapshot["claims"]
        if claim["statement"] == "修改后的合成判断"
    )
    assert {
        ref["id"]: ref["relation"] for ref in published_claim["evidence"]
    } == expected
    history = client.get(f"{requests}?status=all", headers=headers).json()["data"]
    assert (
        next(request for request in history if request["id"] == initial["id"])
        == original
    )


def test_validation_and_current_targets(
    demo: tuple, client: TestClient, db: Session
) -> None:
    url, employees, auth = demo
    headers = auth["employee"]
    evidence = db.exec(
        select(Evidence).where(
            Evidence.org_id == employees["E03"].org_id,
            Evidence.subject_employee_id == employees["E03"].id,
        )
    ).first()
    response = client.post(
        f"{url}/me/requests",
        headers=headers,
        json={
            "items": [
                payload("missing"),
                payload(level="missing"),
                payload("incident_support", evidence_ids=[str(evidence.id)]),
                payload("rknn_deployment", op="modify"),
                payload("rknn_deployment", op="retract"),
            ]
        },
    )
    assert response.status_code == 422
    errors = response.json()["detail"]
    assert {e["index"] for e in errors} == {0, 1, 2, 3, 4}
    assert all(any("\u4e00" <= ch <= "\u9fff" for ch in e["message"]) for e in errors)
    for extra in (
        {"via": "mcp"},
        {"employee_id": str(employees["E03"].id)},
        {"assessment_status": "confirmed"},
    ):
        body = {"items": [payload(**extra)]}
        assert (
            client.post(f"{url}/me/requests", headers=headers, json=body).status_code
            == 422
        )
    assert (
        client.post(
            f"{url}/me/requests",
            headers=headers,
            json={"items": [payload()], "via": "mcp"},
        ).status_code
        == 422
    )
    profile = client.get(f"{url}/me/profile", headers=headers).json()
    current = next(i for i in profile["items"] if i["claim"])
    key, claim = current["capability"]["key"], current["claim"]
    assert (
        client.post(
            f"{url}/me/requests", headers=headers, json={"items": [payload(key)]}
        ).status_code
        == 422
    )
    for op in ("modify", "retract", "attach_evidence"):
        response = client.post(
            f"{url}/me/requests",
            headers=headers,
            json={"items": [payload(key, op=op, level=claim["level"])]},
        )
        assert response.status_code == 201, response.text
        draft = response.json()
        assert draft["items"][0]["target_claim_id"] == claim["id"]
        preview = client.get(
            f"{url}/me/requests/{draft['id']}/preview", headers=headers
        ).json()
        assert preview["items"][0]["before"]["id"] == claim["id"]
        assert (
            client.post(
                f"{url}/me/requests/{draft['id']}/withdraw", headers=headers
            ).json()["status"]
            == "withdrawn"
        )
    empty = client.post(
        f"{url}/me/requests", headers=headers, json={"items": []}
    ).json()
    assert (
        client.post(
            f"{url}/me/requests/{empty['id']}/submit",
            headers=headers,
            json={"revision": empty["revision"]},
        ).status_code
        == 422
    )


@pytest.mark.parametrize(
    "via,origin",
    [("mcp", "conversation"), ("import", "import"), ("bot", "conversation")],
)
def test_other_channels_use_shared_service(
    demo: tuple, db: Session, via: employee.EmployeeVia, origin: str
) -> None:
    _, employees, _ = demo
    principal = principal_for(db, employees["E02"].org_id)
    draft = employee.save_draft(
        principal,
        db,
        None,
        [ItemInput(**payload(owner_statement="合成经历"))],
        via,
        "测试客户端",
    )
    assert draft.origin == origin
    submitted = employee.submit(
        principal, db, draft.id, draft.revision, via, "测试客户端"
    )
    db.commit()
    from app.domains.inbox.service import my_inbox

    notification = my_inbox(principal, db).data[0]
    assert notification.request_id == submitted.id
    assert ("测试客户端" in notification.message) == (via != "bot")
    employee.withdraw(principal, db, draft.id)
    db.commit()


def test_submit_rolls_back_with_notifications(
    demo: tuple, client: TestClient, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    url, employees, auth = demo
    draft = client.post(
        f"{url}/me/requests",
        headers=auth["employee"],
        json={"items": [payload(owner_statement="必须原子写入")]},
    ).json()

    def fail(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("Synthetic notification failure")

    monkeypatch.setattr(employee, "notify", fail)
    with pytest.raises(RuntimeError, match="Synthetic"):
        client.post(
            f"{url}/me/requests/{draft['id']}/submit",
            headers=auth["employee"],
            json={"revision": draft["revision"]},
        )
    db.expire_all()
    assert db.get(ProfileChangeRequest, UUID(draft["id"])).status == "draft"
    assert not db.exec(
        select(Evidence).where(
            Evidence.org_id == employees["E02"].org_id,
            Evidence.source == "self_report:web",
        )
    ).all()
    assert not db.exec(
        select(AuditEvent).where(
            AuditEvent.org_id == employees["E02"].org_id,
            AuditEvent.action == "change_request.submitted",
        )
    ).all()


def test_tools_exclude_identity_and_bot_submission() -> None:
    assert len(EMPLOYEE_TOOLS) == 10
    assert all(tool.name != "appeal_decision" for tool in EMPLOYEE_TOOLS)
    for tool in EMPLOYEE_TOOLS:
        properties = tool.input_model.model_json_schema()["properties"]
        assert not {"employee_id", "org_id", "via", "client_name"} & properties.keys()
        assert tool.input_model.model_json_schema()["additionalProperties"] is False
        assert tool.bot_allowed == (
            tool.name not in ("submit_request", "withdraw_request")
        )
        assert tool.writes == (
            tool.name
            in (
                "draft_update_request",
                "submit_request",
                "withdraw_request",
                "answer_question",
            )
        )


def test_resubmit_clone_accepts_rejected_and_partial_requests(
    demo: tuple, client: TestClient, db: Session
) -> None:
    url, employees, auth = demo
    subject = employees["E02"]
    headers = auth["employee"]
    principal = principal_for(db, subject.org_id)
    requests_path = f"{url}/me/requests"
    ev_support, _ = append_evidence(
        db,
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        kind=EvidenceKind.WORK_RECORD,
        source="jira",
        source_ref="SYNTHETIC-RESUBMIT-SUPPORTS",
        title="合成支持证据",
        content={"summary": "支持证据"},
        visibility=Visibility.STANDARD,
        provenance={},
    )
    ev_ctx, _ = append_evidence(
        db,
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        kind=EvidenceKind.WORK_RECORD,
        source="jira",
        source_ref="SYNTHETIC-RESUBMIT-CTX",
        title="合成背景证据",
        content={"summary": "背景证据"},
        visibility=Visibility.STANDARD,
        provenance={},
    )
    cap_rows = list_capabilities(db, subject.org_id, get_schema(db, subject.org_id).id)
    cap_by_key = {c.key: c for c in cap_rows}

    def seed_source(
        status: RequestStatus,
        item_specs: list[tuple[str, ItemDecision, UUID, EvidenceRelation]],
    ) -> ProfileChangeRequest:
        row = ProfileChangeRequest(
            org_id=subject.org_id,
            subject_employee_id=subject.id,
            origin=RequestOrigin.MANUAL,
            status=status,
            author={},
        )
        db.add(row)
        db.flush()
        for position, (key, decision, ev_id, relation) in enumerate(item_specs):
            ci = ChangeItem(
                org_id=subject.org_id,
                request_id=row.id,
                position=position,
                op=ChangeOp.ADD,
                capability_definition_id=cap_by_key[key].id,
                after={
                    "statement": "合成能力陈述",
                    "level": "routine",
                    "assessment_status": "tentative",
                },
                decision=decision,
            )
            db.add(ci)
            db.flush()
            db.add(
                ChangeItemEvidence(
                    org_id=subject.org_id,
                    item_id=ci.id,
                    evidence_id=ev_id,
                    relation=relation,
                )
            )
        db.commit()
        return row

    rejected_req = seed_source(
        RequestStatus.REJECTED,
        [
            (
                "incident_support",
                ItemDecision.REJECTED,
                ev_ctx.id,
                EvidenceRelation.CONTEXT,
            )
        ],
    )
    changes_req = seed_source(
        RequestStatus.CHANGES_REQUESTED,
        [
            (
                "incident_support",
                ItemDecision.CHANGES_REQUESTED,
                ev_ctx.id,
                EvidenceRelation.CONTEXT,
            )
        ],
    )
    mixed_req = seed_source(
        RequestStatus.APPROVED,
        [
            (
                "automated_testing",
                ItemDecision.APPROVED,
                ev_support.id,
                EvidenceRelation.CONTRADICTS,
            ),
            (
                "incident_support",
                ItemDecision.REJECTED,
                ev_ctx.id,
                EvidenceRelation.CONTEXT,
            ),
        ],
    )
    approved_only_req = seed_source(
        RequestStatus.APPROVED,
        [
            (
                "automated_testing",
                ItemDecision.APPROVED,
                ev_support.id,
                EvidenceRelation.SUPPORTS,
            )
        ],
    )
    foreign_rejected = ProfileChangeRequest(
        org_id=employees["E03"].org_id,
        subject_employee_id=employees["E03"].id,
        origin=RequestOrigin.MANUAL,
        status=RequestStatus.REJECTED,
        author={},
    )
    db.add(foreign_rejected)
    db.commit()

    for source_req in (rejected_req, changes_req, mixed_req):
        res = client.post(
            requests_path,
            headers=headers,
            json={
                "withdrawn_request_id": str(source_req.id),
                "items": [payload("incident_support", evidence_ids=[str(ev_ctx.id)])],
            },
        )
        assert res.status_code == 201, res.text
        created = res.json()
        assert created["items"][0]["evidence"][0]["relation"] == "context"

    # Mixed approved source ignores relations from approved items.
    mixed_res = client.post(
        requests_path,
        headers=headers,
        json={
            "withdrawn_request_id": str(mixed_req.id),
            "items": [payload("automated_testing", evidence_ids=[str(ev_support.id)])],
        },
    )
    assert mixed_res.status_code == 201, mixed_res.text
    assert mixed_res.json()["items"][0]["evidence"][0]["relation"] == "supports"

    assert (
        client.post(
            requests_path,
            headers=headers,
            json={
                "withdrawn_request_id": str(approved_only_req.id),
                "items": [payload("incident_support")],
            },
        ).status_code
        == 409
    )
    assert (
        client.post(
            requests_path,
            headers=headers,
            json={
                "withdrawn_request_id": str(foreign_rejected.id),
                "items": [payload("incident_support")],
            },
        ).status_code
        == 404
    )
    assert principal.employee_id == subject.id


def test_concurrent_submission_is_once(demo: tuple, client: TestClient) -> None:
    url, _, auth = demo
    headers = auth["employee"]
    draft = client.post(
        f"{url}/me/requests",
        headers=headers,
        json={"items": [payload(owner_statement="并发提交的确认依据")]},
    ).json()

    def send() -> int:
        return client.post(
            f"{url}/me/requests/{draft['id']}/submit",
            headers=headers,
            json={"revision": draft["revision"]},
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: send(), range(2)))
    assert sorted(results) == [200, 409]
    notifications = client.get(f"{url}/me/inbox", headers=headers).json()["data"]
    assert (
        sum(
            n["request_id"] == draft["id"] and n["kind"] == "submitted"
            for n in notifications
        )
        == 1
    )


def test_validation_queries_are_batched(demo: tuple, db: Session) -> None:
    _, employees, _ = demo
    principal = principal_for(db, employees["E02"].org_id)
    dictionary = employee.capability_dictionary(principal, db)
    claims = {
        i.capability.key for i in employee.my_profile(principal, db).items if i.claim
    }
    keys = [c.key for c in dictionary.data if c.key not in claims]
    assert len(keys) >= 3
    queries: list[str] = []

    def count(_conn: object, _cursor: object, statement: str, *_: object) -> None:
        if statement.lstrip().upper().startswith("SELECT"):
            queries.append(statement)

    counts = []
    for size in (1, 3):
        queries.clear()
        event.listen(engine, "before_cursor_execute", count)
        try:
            draft = employee.save_draft(
                principal,
                db,
                None,
                [ItemInput(**payload(key)) for key in keys[:size]],
                "web",
            )
            assert len(employee.preview(principal, db, draft.id).items) == size
        finally:
            event.remove(engine, "before_cursor_execute", count)
        counts.append(len(queries))
    assert counts[0] == counts[1]
    db.rollback()


def test_resubmit_reuses_single_draft_and_blocks_duplicate_after_submit(
    demo: tuple, client: TestClient, db: Session
) -> None:
    url, employees, auth = demo
    subject = employees["E02"]
    headers = auth["employee"]
    requests_path = f"{url}/me/requests"
    ev_ctx, _ = append_evidence(
        db,
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        kind=EvidenceKind.WORK_RECORD,
        source="jira",
        source_ref="SYNTHETIC-D088-CTX",
        title="合成背景证据",
        content={"summary": "背景证据"},
        visibility=Visibility.STANDARD,
        provenance={},
    )
    cap_rows = list_capabilities(db, subject.org_id, get_schema(db, subject.org_id).id)
    cap_by_key = {c.key: c for c in cap_rows}
    db.commit()

    # 1. Whole-request rejection via manager decision creates an auto correction draft.
    first_draft_res = client.post(
        requests_path,
        headers=headers,
        json={"items": [payload("incident_support", evidence_ids=[str(ev_ctx.id)])]},
    )
    assert first_draft_res.status_code == 201, first_draft_res.text
    first_draft = first_draft_res.json()
    first_sub_res = client.post(
        f"{requests_path}/{first_draft['id']}/submit",
        headers=headers,
        json={"revision": first_draft["revision"]},
    )
    assert first_sub_res.status_code == 200, first_sub_res.text
    first_sub = first_sub_res.json()
    decision = client.post(
        f"{url}/reviews/{first_draft['id']}/decisions",
        headers=auth["manager"],
        json={
            "revision": first_sub["revision"],
            "decisions": [
                {
                    "item_id": first_draft["items"][0]["id"],
                    "decision": "rejected",
                    "reason": "请补充详细数据",
                }
            ],
        },
    )
    assert decision.status_code == 200, decision.text
    auto_draft_id = decision.json()["returned_request_id"]
    assert auto_draft_id is not None

    # Cloning from the rejected request reuses the existing auto-generated draft.
    reused = client.post(
        requests_path,
        headers=headers,
        json={
            "withdrawn_request_id": first_draft["id"],
            "items": [
                payload(
                    "incident_support",
                    statement="补充后陈述",
                    evidence_ids=[str(ev_ctx.id)],
                )
            ],
        },
    )
    assert reused.status_code == 201, reused.text
    reused_body = reused.json()
    assert reused_body["id"] == auto_draft_id
    assert reused_body["parent_request_id"] == first_draft["id"]

    # Submitting the reused draft blocks creating another draft from the same parent.
    preview = client.get(
        f"{requests_path}/{auto_draft_id}/preview", headers=headers
    ).json()
    submitted = client.post(
        f"{requests_path}/{auto_draft_id}/submit",
        headers=headers,
        json={
            "revision": preview["revision"],
            "policy_version": preview["policy_version"],
        },
    )
    assert submitted.status_code == 200, submitted.text
    assert (
        client.post(
            requests_path,
            headers=headers,
            json={
                "withdrawn_request_id": first_draft["id"],
                "items": [payload("incident_support", statement="重复重提")],
            },
        ).status_code
        == 409
    )

    # Even after manager decides the resubmitted request, parent cannot spawn a second branch.
    sub_decision = client.post(
        f"{url}/reviews/{auto_draft_id}/decisions",
        headers=auth["manager"],
        json={
            "revision": submitted.json()["revision"],
            "decisions": [
                {
                    "item_id": submitted.json()["items"][0]["id"],
                    "decision": "approved",
                }
            ],
        },
    )
    assert sub_decision.status_code == 200, sub_decision.text
    assert (
        client.post(
            requests_path,
            headers=headers,
            json={
                "withdrawn_request_id": first_draft["id"],
                "items": [payload("incident_support", statement="再次重复重提")],
            },
        ).status_code
        == 409
    )

    # 2. Mixed approved request without auto-draft: concurrent manual saves share one draft.
    mixed = ProfileChangeRequest(
        org_id=subject.org_id,
        subject_employee_id=subject.id,
        origin=RequestOrigin.MANUAL,
        status=RequestStatus.APPROVED,
        author={},
    )
    db.add(mixed)
    db.flush()
    mixed_item = ChangeItem(
        org_id=subject.org_id,
        request_id=mixed.id,
        position=0,
        op=ChangeOp.ADD,
        capability_definition_id=cap_by_key["observability"].id,
        after={
            "statement": "被拒项初始陈述",
            "level": "routine",
            "assessment_status": "tentative",
        },
        decision=ItemDecision.REJECTED,
    )
    db.add(mixed_item)
    db.flush()
    db.add(
        ChangeItemEvidence(
            org_id=subject.org_id,
            item_id=mixed_item.id,
            evidence_id=ev_ctx.id,
            relation=EvidenceRelation.CONTEXT,
        )
    )
    db.commit()
    mixed_id = str(mixed.id)
    ev_ctx_id = str(ev_ctx.id)

    def create_clone(suffix: int) -> dict:
        res = client.post(
            requests_path,
            headers=headers,
            json={
                "withdrawn_request_id": mixed_id,
                "items": [
                    payload(
                        "observability",
                        statement=f"并发手动重提-{suffix}",
                        evidence_ids=[ev_ctx_id],
                    )
                ],
            },
        )
        assert res.status_code == 201, res.text
        return res.json()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create_clone, [1, 2]))
    assert results[0]["id"] == results[1]["id"]
    assert results[0]["parent_request_id"] == str(mixed.id)
    assert results[0]["items"][0]["evidence"][0]["relation"] == "context"

    db.expire_all()
    children = db.exec(
        select(ProfileChangeRequest).where(
            ProfileChangeRequest.org_id == subject.org_id,
            ProfileChangeRequest.parent_request_id == mixed.id,
            ProfileChangeRequest.status != RequestStatus.WITHDRAWN,
        )
    ).all()
    assert len(children) == 1

    # Withdrawing that draft allows creating a new resubmission draft from the mixed source.
    assert (
        client.post(
            f"{requests_path}/{results[0]['id']}/withdraw", headers=headers
        ).status_code
        == 200
    )
    recreated = create_clone(3)
    assert recreated["id"] != results[0]["id"]
    assert recreated["parent_request_id"] == str(mixed.id)
