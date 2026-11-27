from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, delete, select

from app.domains.bot import core, store, tools
from app.domains.bot import schemas as bot_schemas
from app.domains.change_request import employee
from app.domains.change_request.claim import ClaimAfter
from app.domains.change_request.models import (
    ChangeItem,
    ChangeItemEvidence,
    ChangeOp,
    ProfileChangeRequest,
    RequestOrigin,
    RequestStatus,
)
from app.domains.profile.models import AssessmentStatus, ProfileClaim
from tests.api.routes.test_approval_policy import save as save_policy
from tests.api.routes.test_employee_requests import principal_for
from tests.api.routes.test_m47_stale_initial_draft import initial_draft


def _insert_legacy_mixed_draft(
    db: Session,
    *,
    org_id: UUID,
    employee_id: UUID,
    user_id: UUID,
    unchanged_cap_id: UUID,
    unchanged_claim: ProfileClaim,
    added_cap_id: UUID,
) -> ProfileChangeRequest:
    request = ProfileChangeRequest(
        org_id=org_id,
        subject_employee_id=employee_id,
        origin=RequestOrigin.MANUAL,
        status=RequestStatus.DRAFT,
        author={"actor_type": "user", "user_id": str(user_id)},
    )
    db.add(request)
    db.flush()
    db.add_all(
        [
            ChangeItem(
                org_id=org_id,
                request_id=request.id,
                position=0,
                op=ChangeOp.MODIFY,
                capability_definition_id=unchanged_cap_id,
                target_claim_id=unchanged_claim.id,
                after=ClaimAfter(
                    statement=unchanged_claim.statement,
                    level=unchanged_claim.level,
                    assessment_status=AssessmentStatus.TENTATIVE,
                ).model_dump(mode="json"),
            ),
            ChangeItem(
                org_id=org_id,
                request_id=request.id,
                position=1,
                op=ChangeOp.ADD,
                capability_definition_id=added_cap_id,
                target_claim_id=None,
                after=ClaimAfter(
                    statement="真实新增的能力判断",
                    level="routine",
                    assessment_status=AssessmentStatus.TENTATIVE,
                ).model_dump(mode="json"),
            ),
        ]
    )
    db.commit()
    return request


def _claim_count(
    db: Session, org_id: UUID, employee_id: UUID, capability_id: UUID
) -> int:
    return len(
        db.exec(
            select(ProfileClaim).where(
                ProfileClaim.org_id == org_id,
                ProfileClaim.subject_employee_id == employee_id,
                ProfileClaim.capability_definition_id == capability_id,
            )
        ).all()
    )


def test_legacy_mixed_draft_preview_and_submit_reproduction(
    demo: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = demo
    e02 = people["E02"]
    principal = principal_for(db, e02.org_id)
    assert principal.user_id is not None
    profile = employee.my_profile(principal, db)
    existing = next(i for i in profile.items if i.claim)
    missing = next(i for i in profile.items if i.claim is None)
    assert existing.claim is not None
    unchanged_claim = db.get(ProfileClaim, existing.claim.id)
    assert unchanged_claim is not None
    claims_before = _claim_count(db, e02.org_id, e02.id, existing.capability.id)

    draft = _insert_legacy_mixed_draft(
        db,
        org_id=e02.org_id,
        employee_id=e02.id,
        user_id=principal.user_id,
        unchanged_cap_id=existing.capability.id,
        unchanged_claim=unchanged_claim,
        added_cap_id=missing.capability.id,
    )

    base = f"{url}/me/requests/{draft.id}"
    preview_resp = client.get(f"{base}/preview", headers=auth["employee"])
    assert preview_resp.status_code == 200, preview_resp.text
    preview = preview_resp.json()
    assert [i["after"]["capability"]["key"] for i in preview["items"]] == [
        missing.capability.key
    ]

    submit_resp = client.post(
        f"{base}/submit",
        headers=auth["employee"],
        json={
            "revision": preview["revision"],
            "policy_version": preview["policy_version"],
        },
    )
    assert submit_resp.status_code == 200, submit_resp.text
    submitted = submit_resp.json()
    assert submitted["status"] == "pending_review"
    assert [i["capability"]["key"] for i in submitted["items"]] == [
        missing.capability.key
    ]

    review_resp = client.get(f"{url}/reviews/{draft.id}", headers=auth["manager"])
    assert review_resp.status_code == 200, review_resp.text
    assert [i["after"]["capability"]["key"] for i in review_resp.json()["items"]] == [
        missing.capability.key
    ]

    db.expire_all()
    assert _claim_count(db, e02.org_id, e02.id, existing.capability.id) == claims_before


def test_legacy_mixed_draft_bot_confirm_and_auto_publish(
    demo: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = demo
    e02 = people["E02"]
    principal = principal_for(db, e02.org_id)
    assert principal.user_id is not None
    profile = employee.my_profile(principal, db)
    existing = next(i for i in profile.items if i.claim and i.capability.category)
    missing = next(
        i
        for i in profile.items
        if i.claim is None
        and i.capability.category
        and i.capability.category != existing.capability.category
    )
    assert existing.claim is not None
    assert existing.capability.category and missing.capability.category
    unchanged_claim = db.get(ProfileClaim, existing.claim.id)
    assert unchanged_claim is not None
    claims_before = _claim_count(db, e02.org_id, e02.id, existing.capability.id)

    # Exempt ONLY the added item's category; the hidden unchanged item still requires manager.
    save_policy(
        client,
        demo,
        require_manager=True,
        category_overrides={missing.capability.category: False},
    )

    draft = _insert_legacy_mixed_draft(
        db,
        org_id=e02.org_id,
        employee_id=e02.id,
        user_id=principal.user_id,
        unchanged_cap_id=existing.capability.id,
        unchanged_claim=unchanged_claim,
        added_cap_id=missing.capability.id,
    )
    session = store.create_session(db, principal, "web")
    card = tools.preview_card(db, principal, draft.id)
    assert [i.after.capability.key for i in card.items] == [missing.capability.key]
    assert card.requires_manager is False
    core._save(db, session, [card])
    db.commit()

    resp = core.act(db, principal, session.id, card.actions[0])
    status_card = next(
        m for m in resp.messages if isinstance(m, bot_schemas.StatusCard)
    )
    assert status_card.status == "approved"
    assert [i.capability.key for i in status_card.items] == [missing.capability.key]
    pending_ids = {
        r["id"]
        for r in client.get(f"{url}/reviews", headers=auth["manager"]).json()["data"]
    }
    assert str(draft.id) not in pending_ids

    db.expire_all()
    assert _claim_count(db, e02.org_id, e02.id, existing.capability.id) == claims_before


def test_legacy_only_unchanged_draft_blocked_on_submit(
    demo: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = demo
    e02 = people["E02"]
    principal = principal_for(db, e02.org_id)
    existing = next(i for i in employee.my_profile(principal, db).items if i.claim)
    assert existing.claim is not None

    request = ProfileChangeRequest(
        org_id=e02.org_id,
        subject_employee_id=e02.id,
        origin=RequestOrigin.MANUAL,
        status=RequestStatus.DRAFT,
        author={"actor_type": "user", "user_id": str(principal.user_id)},
    )
    db.add(request)
    db.flush()
    db.add(
        ChangeItem(
            org_id=e02.org_id,
            request_id=request.id,
            position=0,
            op=ChangeOp.MODIFY,
            capability_definition_id=existing.capability.id,
            target_claim_id=existing.claim.id,
            after=ClaimAfter(
                statement=existing.claim.statement,
                level=existing.claim.level,
                assessment_status=AssessmentStatus.TENTATIVE,
            ).model_dump(mode="json"),
        )
    )
    db.commit()

    preview = client.get(
        f"{url}/me/requests/{request.id}/preview", headers=auth["employee"]
    )
    assert preview.status_code == 200
    assert preview.json()["items"] == []

    submit_resp = client.post(
        f"{url}/me/requests/{request.id}/submit",
        headers=auth["employee"],
        json={"revision": preview.json()["revision"]},
    )
    assert submit_resp.status_code == 422


@pytest.mark.parametrize("policy_scope", ["hidden_only", "effective"])
def test_legacy_mixed_draft_policy_version_and_stale_revision(
    demo: tuple, db: Session, client: TestClient, policy_scope: str
) -> None:
    url, people, auth = demo
    e02 = people["E02"]
    principal = principal_for(db, e02.org_id)
    assert principal.user_id is not None
    profile = employee.my_profile(principal, db)
    existing = next(i for i in profile.items if i.claim and i.capability.category)
    missing = next(
        i
        for i in profile.items
        if i.claim is None
        and i.capability.category
        and i.capability.category != existing.capability.category
    )
    assert existing.claim is not None
    assert existing.capability.category and missing.capability.category
    unchanged_claim = db.get(ProfileClaim, existing.claim.id)
    assert unchanged_claim is not None

    draft = _insert_legacy_mixed_draft(
        db,
        org_id=e02.org_id,
        employee_id=e02.id,
        user_id=principal.user_id,
        unchanged_cap_id=existing.capability.id,
        unchanged_claim=unchanged_claim,
        added_cap_id=missing.capability.id,
    )
    base = f"{url}/me/requests/{draft.id}"
    preview_v0 = client.get(f"{base}/preview", headers=auth["employee"]).json()

    # Stale revision is still rejected with 409.
    stale = client.post(
        f"{base}/submit",
        headers=auth["employee"],
        json={
            "revision": preview_v0["revision"] + 1,
            "policy_version": preview_v0["policy_version"],
        },
    )
    assert stale.status_code == 409

    # Policy change on ONLY the hidden unchanged category does NOT block submit.
    save_policy(
        client,
        demo,
        require_manager=True,
        category_overrides={existing.capability.category: False},
    )
    if policy_scope == "hidden_only":
        submitted = client.post(
            f"{base}/submit",
            headers=auth["employee"],
            json={
                "revision": preview_v0["revision"],
                "policy_version": preview_v0["policy_version"],
            },
        )
        assert submitted.status_code == 200, submitted.text
        assert submitted.json()["status"] == "pending_review"
        assert [i["capability"]["key"] for i in submitted.json()["items"]] == [
            missing.capability.key
        ]
        return

    # Policy change on the effective item's category triggers 409 ApprovalPolicyChanged without mutating draft.
    updated_policy = save_policy(
        client,
        demo,
        require_manager=True,
        category_overrides={
            existing.capability.category: False,
            missing.capability.category: False,
        },
    )
    changed = client.post(
        f"{base}/submit",
        headers=auth["employee"],
        json={
            "revision": preview_v0["revision"],
            "policy_version": preview_v0["policy_version"],
        },
    )
    assert changed.status_code == 409
    assert changed.json()["detail"]["code"] == "approval_policy_changed"
    assert [
        i["after"]["capability"]["key"]
        for i in changed.json()["detail"]["preview"]["items"]
    ] == [missing.capability.key]

    # Confirm with the refreshed policy_version succeeds.
    confirmed = client.post(
        f"{base}/submit",
        headers=auth["employee"],
        json={
            "revision": preview_v0["revision"],
            "policy_version": updated_policy["current"]["version"],
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["status"] == "approved"
    assert [i["capability"]["key"] for i in confirmed.json()["items"]] == [
        missing.capability.key
    ]


@pytest.mark.parametrize("with_changed_item", [False, True])
def test_initial_draft_realignment_with_unchanged_item(
    demo: tuple, db: Session, client: TestClient, with_changed_item: bool
) -> None:
    url, people, auth = demo
    base, initial = initial_draft(client, demo)
    e02 = people["E02"]
    first = initial["items"][0]
    other = initial["items"][1]

    # Remove evidence links & extra notes from `first` so a matching direct edit makes `first` truly unchanged.
    db.exec(
        delete(ChangeItemEvidence).where(
            ChangeItemEvidence.org_id == e02.org_id,
            ChangeItemEvidence.item_id == UUID(first["id"]),
        )
    )
    first_row = db.get(ChangeItem, UUID(first["id"]))
    assert first_row is not None
    first_row.uncertainty = None
    first_row.owner_statement = None
    first_row.objection = None
    db.add(first_row)
    db.commit()

    profile_url = f"{url}/employees/{e02.id}/profile"
    profile = client.get(profile_url, headers=auth["manager"]).json()
    direct_items = [
        {
            "op": "add",
            "capability_key": first["capability"]["key"],
            "statement": first["after"]["statement"],
            "level": first["after"]["level"],
        }
    ]
    if with_changed_item:
        direct_items.append(
            {
                "op": "add",
                "capability_key": other["capability"]["key"],
                "statement": "经理直接修改为不同判断",
                "level": other["after"]["level"],
            }
        )
    direct = client.post(
        f"{profile_url}/direct-edits",
        headers=auth["manager"],
        json={
            "base_revision": profile["latest_published"]["revision"],
            "items": direct_items,
        },
    )
    assert direct.status_code == 200, direct.text

    preview = client.get(f"{base}/preview", headers=auth["employee"]).json()
    keys_in_preview = [i["after"]["capability"]["key"] for i in preview["items"]]
    assert first["capability"]["key"] not in keys_in_preview
    assert other["capability"]["key"] in keys_in_preview

    if with_changed_item:
        stale = client.post(
            f"{base}/submit",
            headers=auth["employee"],
            json={"revision": preview["revision"]},
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "stale_initial_draft"
        stale_keys = [c["key"] for c in stale.json()["detail"]["capabilities"]]
        assert first["capability"]["key"] not in stale_keys
        assert other["capability"]["key"] in stale_keys

    submitted = client.post(
        f"{base}/submit",
        headers=auth["employee"],
        json={
            "revision": preview["revision"],
            "base_revision": preview["base_revision"],
            "policy_version": preview["policy_version"],
        },
    )
    assert submitted.status_code == 200, submitted.text
    submitted_keys = [i["capability"]["key"] for i in submitted.json()["items"]]
    assert first["capability"]["key"] not in submitted_keys
    assert other["capability"]["key"] in submitted_keys
    if with_changed_item:
        realigned = next(
            i
            for i in submitted.json()["items"]
            if i["capability"]["key"] == other["capability"]["key"]
        )
        assert realigned["op"] == "modify"
        assert realigned["target_claim_id"] is not None
