from fastapi.testclient import TestClient
from sqlmodel import Session

from app.domains.change_request import employee as employee_requests
from app.domains.change_request.models import ItemDecision
from app.domains.change_request.schemas import ItemInput
from app.domains.org.models import EmploymentStatus
from app.domains.review import service as review_service
from app.domains.review.schemas import DecisionInput
from tests.api.routes.test_reviews import actor, manager


def _item_by_key(profile: dict, key: str) -> dict:
    return next(item for item in profile["items"] if item["capability"]["key"] == key)


def test_pending_change_visibility_and_isolation(
    demo: tuple, client: TestClient, db: Session
) -> None:
    url, employees, auth = demo
    e02 = employees["E02"]
    owner = actor(db, e02.org_id, "employee.platform@demo.example.com")

    draft = employee_requests.save_draft(
        owner,
        db,
        None,
        [
            ItemInput(
                op="modify",
                capability_key="backend_api",
                statement="待审批的后端接口新陈述",
                level="routine",
            ),
            ItemInput(
                op="add",
                capability_key="frontend_ui",
                statement="待审批的新增云基础设施陈述",
                level="needs_support",
            ),
        ],
        "bot",
        "内置助手",
    )
    submitted = employee_requests.submit(
        owner, db, draft.id, draft.revision, "bot", "内置助手"
    )
    db.commit()

    profile_url = f"{url}/employees/{e02.id}/profile"
    for role in ("employee", "manager"):
        response = client.get(profile_url, headers=auth[role])
        assert response.status_code == 200
        data = response.json()

        backend_item = _item_by_key(data, "backend_api")
        assert backend_item["status"] == "confirmed"
        assert backend_item["claim"]["level"] == "independent_complex"
        assert backend_item["pending_change"] is not None
        assert backend_item["pending_change"]["request_id"] == str(submitted.id)
        assert backend_item["pending_change"]["op"] == "modify"
        assert backend_item["pending_change"]["statement"] == "待审批的后端接口新陈述"
        assert backend_item["pending_change"]["level"] == "routine"

        added_item = _item_by_key(data, "frontend_ui")
        assert added_item["status"] == "unknown"
        assert added_item["claim"] is None
        assert added_item["pending_change"] is not None
        assert added_item["pending_change"]["request_id"] == str(submitted.id)
        assert added_item["pending_change"]["op"] == "add"
        assert added_item["pending_change"]["statement"] == "待审批的新增云基础设施陈述"
        assert added_item["pending_change"]["level"] == "needs_support"

    admin_response = client.get(profile_url, headers=auth["admin"])
    assert admin_response.status_code == 200
    assert "待审批的后端接口新陈述" not in admin_response.text
    assert "待审批的新增云基础设施陈述" not in admin_response.text
    for item in admin_response.json()["items"]:
        assert item["pending_change"] is None

    assert client.get(profile_url, headers=auth["foreign"]).status_code == 404

    # Candidate changes must not enter people search or coverage.
    search = client.get(
        f"{url}/people-search",
        params={"capability_key": "frontend_ui"},
        headers=auth["manager"],
    )
    assert search.status_code == 200
    assert all(row["employee_id"] != str(e02.id) for row in search.json()["data"])

    coverage = client.get(f"{url}/coverage", headers=auth["manager"]).json()
    assert coverage["total"] > 0


def test_latest_review_returned_and_rejected_on_profile(
    demo: tuple, client: TestClient, db: Session
) -> None:
    url, employees, auth = demo
    e02 = employees["E02"]
    owner = actor(db, e02.org_id, "employee.platform@demo.example.com")
    reviewer = manager(db, demo)

    draft = employee_requests.save_draft(
        owner,
        db,
        None,
        [
            ItemInput(
                op="modify",
                capability_key="backend_api",
                statement="第一次提交的后端修改",
                level="routine",
            ),
            ItemInput(
                op="add",
                capability_key="frontend_ui",
                statement="第一次提交的云基础设施新增",
                level="needs_support",
            ),
        ],
        "web",
    )
    submitted = employee_requests.submit(owner, db, draft.id, draft.revision, "web")
    by_key = {item.capability.key: item.id for item in submitted.items}
    review_service.decide(
        reviewer,
        db,
        submitted.id,
        submitted.revision,
        [
            DecisionInput(
                item_id=by_key["backend_api"],
                decision=ItemDecision.REJECTED,
                reason="请补充性能压测结果",
            ),
            DecisionInput(
                item_id=by_key["frontend_ui"],
                decision=ItemDecision.REJECTED,
                reason="当前未达到独立负责标准",
            ),
        ],
    )
    db.commit()

    profile_url = f"{url}/employees/{e02.id}/profile"
    for role in ("employee", "manager"):
        data = client.get(profile_url, headers=auth[role]).json()
        backend_item = _item_by_key(data, "backend_api")
        assert backend_item["status"] == "confirmed"
        assert backend_item["claim"]["level"] == "independent_complex"
        assert backend_item["pending_change"] is None
        assert backend_item["latest_review"] is not None
        assert backend_item["latest_review"]["request_id"] == str(submitted.id)
        assert backend_item["latest_review"]["decision"] == "rejected"
        assert backend_item["latest_review"]["reason"] == "请补充性能压测结果"

        cloud_item = _item_by_key(data, "frontend_ui")
        assert cloud_item["status"] == "unknown"
        assert cloud_item["claim"] is None
        assert cloud_item["pending_change"] is None
        assert cloud_item["latest_review"] is not None
        assert cloud_item["latest_review"]["request_id"] == str(submitted.id)
        assert cloud_item["latest_review"]["decision"] == "rejected"
        assert cloud_item["latest_review"]["reason"] == "当前未达到独立负责标准"

    admin_response = client.get(profile_url, headers=auth["admin"])
    assert admin_response.status_code == 200
    assert "请补充性能压测结果" not in admin_response.text
    assert "当前未达到独立负责标准" not in admin_response.text
    assert all(item["latest_review"] is None for item in admin_response.json()["items"])

    # Resubmitting and approving clears latest_review.
    next_draft = employee_requests.save_draft(
        owner,
        db,
        None,
        [
            ItemInput(
                op="modify",
                capability_key="backend_api",
                statement="补充压测结果后的后端陈述",
                level="independent_complex",
            )
        ],
        "web",
    )
    next_submitted = employee_requests.submit(
        owner, db, next_draft.id, next_draft.revision, "web"
    )
    db.commit()
    pending_data = client.get(profile_url, headers=auth["employee"]).json()
    pending_backend = _item_by_key(pending_data, "backend_api")
    assert pending_backend["pending_change"] is not None
    assert pending_backend["latest_review"] is None

    review_service.decide(
        reviewer,
        db,
        next_submitted.id,
        next_submitted.revision,
        [
            DecisionInput(
                item_id=next_submitted.items[0].id,
                decision=ItemDecision.APPROVED,
            )
        ],
    )
    db.commit()
    approved_data = client.get(profile_url, headers=auth["employee"]).json()
    approved_backend = _item_by_key(approved_data, "backend_api")
    assert approved_backend["pending_change"] is None
    assert approved_backend["latest_review"] is None
    assert approved_backend["claim"]["statement"] == "补充压测结果后的后端陈述"


def test_offboarded_employee_hides_pending_and_review(
    demo: tuple, client: TestClient, db: Session
) -> None:
    url, employees, auth = demo
    e02 = employees["E02"]
    owner = actor(db, e02.org_id, "employee.platform@demo.example.com")
    draft = employee_requests.save_draft(
        owner,
        db,
        None,
        [
            ItemInput(
                op="add",
                capability_key="frontend_ui",
                statement="离职前待审陈述",
                level="needs_support",
            )
        ],
        "web",
    )
    employee_requests.submit(owner, db, draft.id, draft.revision, "web")
    e02.employment_status = EmploymentStatus.INACTIVE
    db.add(e02)
    db.commit()

    response = client.get(f"{url}/employees/{e02.id}/profile", headers=auth["admin"])
    assert response.status_code == 200
    assert "离职前待审陈述" not in response.text
    assert all(
        item["pending_change"] is None and item["latest_review"] is None
        for item in response.json()["items"]
    )
