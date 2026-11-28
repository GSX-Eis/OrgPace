from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, inspect
from sqlmodel import Session, select

from app.authz.deps import get_org_principal
from app.domains.admin_assistant.models import (
    AdminAssistantAttachment,
    AdminAssistantMessage,
    AdminAssistantSession,
    AdminChangeSet,
)
from app.domains.admin_assistant.store import ensure_setup_session
from app.domains.base import utc_now
from app.domains.bot.models import BotSetting
from app.domains.bot.store import (
    append_message,
    cleanup_messages,
    load_state,
    messages_for,
    save_state,
)
from app.domains.chat_runtime import attachments
from app.domains.setup import wizard
from app.domains.setup.models import SetupStatus, SetupStepState
from app.models import User
from tests.api.routes.test_setup_steps import SetupTenant
from tests.api.routes.test_setup_steps import tenant as tenant
from tests.utils.migrations import migrate


def sessions(client: TestClient, tenant: SetupTenant, role: str = "admin") -> dict:
    response = client.get(
        "/api/v1/admin-assistant/sessions",
        params={"org_id": str(tenant.org_id)},
        headers=tenant.auth[role],
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_setup_session(client: TestClient, db: Session, tenant: SetupTenant) -> None:
    data = sessions(client, tenant)["data"]
    assert len(data) == 1 and data[0]["purpose"] == "setup"
    row = db.exec(
        select(AdminAssistantSession).where(
            AdminAssistantSession.org_id == tenant.org_id
        )
    ).one()
    assert row.turn_count == 0
    payload = messages_for(db, row)[0].payload
    assert isinstance(payload, dict)
    assert "企业名称" not in payload["messages"][0]["text"]
    assert "配置 AI 模型" in payload["messages"][0]["text"]
    assert [card["type"] for card in payload["messages"]] == [
        "text",
        "setup_checklist",
        "setup_form",
    ]
    assert payload["messages"][2]["step"] == "model"
    assert sessions(client, tenant)["data"] == data
    todo = next(
        t
        for t in client.get(
            tenant.url + "/admin/overview", headers=tenant.auth["admin"]
        ).json()["todos"]
        if t["kind"] == "setup_step"
    )
    assert todo["page"] == f"/admin/assistant?session={row.id}"
    for role in ("manager", "employee", "foreign"):
        assert (
            client.get(
                f"/api/v1/admin-assistant/sessions/{row.id}/messages",
                params={"org_id": str(tenant.org_id)},
                headers=tenant.auth[role],
            ).status_code
            == 404
        )
        assert (
            client.get(
                "/api/v1/admin-assistant/sessions",
                params={"org_id": str(tenant.org_id)},
                headers=tenant.auth[role],
            ).status_code
            == 404
        )
    other = client.get(
        "/api/v1/admin-assistant/sessions",
        params={"org_id": str(tenant.foreign_org_id)},
        headers=tenant.auth["foreign"],
    ).json()
    assert len(other["data"]) == 1 and other["data"][0]["id"] != str(row.id)
    normal = AdminAssistantSession(org_id=tenant.org_id, user_id=tenant.admin_id)
    db.add(normal)
    append_message(db, normal, "user", {"text": "最近的普通对话"})
    db.commit()
    assert sessions(client, tenant)["data"][0]["id"] == str(row.id)


def test_concurrent_setup(db: Session, tenant: SetupTenant) -> None:
    principal = get_org_principal(tenant.org_id, db.get(User, tenant.admin_id), db)

    def ensure() -> None:
        with Session(db.get_bind()) as connection:
            ensure_setup_session(connection, principal)

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: ensure(), range(2)))
    rows = db.exec(
        select(AdminAssistantSession).where(
            AdminAssistantSession.org_id == tenant.org_id
        )
    ).all()
    assert len(rows) == 1
    assert len(messages_for(db, rows[0])) == 1


def test_setup_welcome_includes_unfinished_company_profile(
    client: TestClient,
    db: Session,
    tenant: SetupTenant,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    setup = wizard.read_setup(db, tenant.org_id)
    next(step for step in setup.steps if step.key == "org_profile").status = "pending"
    monkeypatch.setattr(wizard, "read_setup", lambda *_: setup)
    row = sessions(client, tenant)["data"][0]
    response = client.get(
        f"/api/v1/admin-assistant/sessions/{row['id']}/messages",
        params={"org_id": str(tenant.org_id)},
        headers=tenant.auth["admin"],
    )
    assert response.status_code == 200
    cards = response.json()[0]["payload"]["messages"]
    assert "填写企业名称" in cards[0]["text"]
    assert [card["step"] for card in cards if card["type"] == "setup_form"] == [
        "org_profile",
        "model",
    ]


@pytest.mark.parametrize("days", [0, 7])
def test_setup_retention(
    client: TestClient, db: Session, tenant: SetupTenant, days: int
) -> None:
    sessions(client, tenant)
    row = db.exec(
        select(AdminAssistantSession).where(
            AdminAssistantSession.org_id == tenant.org_id
        )
    ).one()
    db.add(BotSetting(org_id=tenant.org_id, retention_days=days))
    db.commit()
    principal = get_org_principal(tenant.org_id, db.get(User, tenant.admin_id), db)
    uploaded = attachments.save_bytes(
        db, principal, "admin", row.id, "sample.txt", b"synthetic setup material"
    )
    attachment = db.get(AdminAssistantAttachment, uploaded.id)
    assert attachment is not None
    old = utc_now() - timedelta(days=8)
    row.last_activity_at = old
    db.add(row)
    message = db.exec(
        select(AdminAssistantMessage).where(
            AdminAssistantMessage.org_id == tenant.org_id
        )
    ).one()
    message.created_at = old
    db.add(message)
    state = {"version": 1, "messages": ["synthetic context"]}
    save_state(db, row, state)
    attachment.created_at = old
    draft = AdminChangeSet(
        org_id=row.org_id,
        session_id=row.id,
        created_by_user_id=row.user_id,
        items=[{"synthetic": True}],
        secrets="synthetic",
        confirmed_once_at=old,
    )
    db.add_all([attachment, draft])
    db.commit()
    attachment_id, draft_id = attachment.id, draft.id
    assert not wizard.read_setup(db, tenant.org_id).completed
    assert load_state(db, row) == state
    cleanup_messages(db, utc_now())
    db.refresh(row)
    db.refresh(draft)
    assert load_state(db, row) == state
    assert db.get(AdminAssistantAttachment, attachment_id) is not None
    assert str(attachment_id) in attachments.manifest(db, principal, "admin", row.id)
    assert "synthetic setup material" in str(
        attachments.read_attachment(db, principal, "admin", row.id, attachment_id)
    )
    url = f"/api/v1/admin-assistant/sessions/{row.id}/attachments/{attachment_id}"
    response = client.get(
        url, params={"org_id": str(tenant.org_id)}, headers=tenant.auth["admin"]
    )
    assert (
        response.status_code == 200 and response.content == b"synthetic setup material"
    )
    for role in ("manager", "employee", "foreign"):
        assert (
            client.get(
                url, params={"org_id": str(tenant.org_id)}, headers=tenant.auth[role]
            ).status_code
            == 404
        )
    assert (draft.status, draft.secrets, draft.confirmed_once_at) == (
        "draft",
        "synthetic",
        old,
    )
    assert sessions(client, tenant)["data"][0]["id"] == str(row.id)
    assert len(messages_for(db, row)) == 1
    append_message(db, row, "user", {"text": "回来继续"})
    db.commit()
    assert len(messages_for(db, row)) == 2
    row.last_activity_at = old
    for message in db.exec(
        select(AdminAssistantMessage).where(
            AdminAssistantMessage.org_id == tenant.org_id
        )
    ).all():
        message.created_at = old
        db.add(message)
    db.add(row)
    db.add(
        SetupStepState(
            org_id=tenant.org_id,
            step_key="model",
            status=SetupStatus.SKIPPED,
            updated_by_user_id=tenant.admin_id,
        )
    )
    db.commit()
    assert wizard.read_setup(db, tenant.org_id).completed
    assert load_state(db, row) is None
    assert attachments.manifest(db, principal, "admin", row.id) == ""
    response = client.get(
        url, params={"org_id": str(tenant.org_id)}, headers=tenant.auth["admin"]
    )
    assert response.status_code == 404
    cleanup_messages(db, utc_now())
    db.expire_all()
    assert row.state_ciphertext is None
    assert db.get(AdminAssistantAttachment, attachment_id) is None
    stale = db.get(AdminChangeSet, draft_id)
    assert stale is not None
    assert (stale.status, stale.secrets, stale.confirmed_once_at) == (
        "stale",
        None,
        None,
    )
    assert messages_for(db, row) == []
    assert sessions(client, tenant)["data"] == []


@pytest.mark.parametrize("days", [0, 7])
def test_setup_attachments_count_toward_user_limit(
    client: TestClient,
    db: Session,
    tenant: SetupTenant,
    days: int,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sessions(client, tenant)
    setup = db.exec(
        select(AdminAssistantSession).where(
            AdminAssistantSession.org_id == tenant.org_id,
            AdminAssistantSession.purpose == "setup",
        )
    ).one()
    principal = get_org_principal(tenant.org_id, db.get(User, tenant.admin_id), db)
    normal = AdminAssistantSession(org_id=tenant.org_id, user_id=tenant.admin_id)
    db.add_all([normal, BotSetting(org_id=tenant.org_id, retention_days=days)])
    db.commit()
    monkeypatch.setattr(attachments, "USER_LIMIT", 10)
    uploaded = attachments.save_bytes(
        db, principal, "admin", setup.id, "old.txt", b"123456"
    )
    old = db.get(AdminAssistantAttachment, uploaded.id)
    assert old is not None
    old.created_at = utc_now() - timedelta(days=8)
    db.add(old)
    db.commit()
    cleanup_messages(db, utc_now())
    assert attachments.save_bytes(
        db, principal, "admin", normal.id, "fresh.txt", b"1234"
    )
    with pytest.raises(attachments.AttachmentError, match="附件总量已达上限"):
        attachments.save_bytes(db, principal, "admin", normal.id, "excess.txt", b"1")
    with pytest.raises(attachments.AttachmentError):
        attachments.get_session_attachment(
            db, principal, "admin", normal.id, uploaded.id
        )
    db.add(
        SetupStepState(
            org_id=tenant.org_id,
            step_key="model",
            status=SetupStatus.SKIPPED,
            updated_by_user_id=tenant.admin_id,
        )
    )
    db.commit()
    assert wizard.read_setup(db, tenant.org_id).completed
    assert attachments.save_bytes(
        db, principal, "admin", normal.id, "after.txt", b"123456"
    )


def test_completed_no_setup(
    client: TestClient, db: Session, tenant: SetupTenant
) -> None:
    db.add(
        SetupStepState(
            org_id=tenant.org_id,
            step_key="model",
            status=SetupStatus.SKIPPED,
            updated_by_user_id=tenant.admin_id,
        )
    )
    db.commit()
    assert sessions(client, tenant)["data"] == []


def test_setup_session_migration(migration_engine: Engine) -> None:
    # Removing purpose preserves sessions and messages, including a setup conversation.
    from uuid import uuid4

    from app.domains.org.models import Organization, OrgMembership

    with Session(migration_engine) as db:
        org = Organization(slug=str(uuid4()), name="合成迁移企业")
        user = User(username=str(uuid4()), hashed_password="unused")
        db.add_all([org, user])
        db.flush()
        db.add(OrgMembership(org_id=org.id, user_id=user.id))
        db.flush()
        row = AdminAssistantSession(org_id=org.id, user_id=user.id, purpose="setup")
        db.add(row)
        db.flush()
        append_message(
            db, row, "assistant", {"messages": [{"type": "setup_checklist"}]}
        )
        db.commit()
        row_id = row.id
    migrate(migration_engine, "downgrade", "b361001dc001")
    assert "purpose" not in {
        c["name"]
        for c in inspect(migration_engine).get_columns("admin_assistant_session")
    }
    migrate(migration_engine, "upgrade", "head")
    with Session(migration_engine) as db:
        row = db.get(AdminAssistantSession, row_id)
        assert row is not None and row.purpose is None
        assert len(messages_for(db, row)) == 1
