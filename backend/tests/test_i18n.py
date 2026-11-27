import asyncio
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, inspect, text
from sqlmodel import Session, select

from app.core.config import settings
from app.core.db import engine
from app.core.security import get_password_hash
from app.domains.change_request.models import (
    ProfileChangeRequest,
    RequestOrigin,
    RequestStatus,
)
from app.domains.im import binding, notifications
from app.domains.im.adapters.telegram import Telegram
from app.domains.im.models import ImNotification
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.inbox.service import add_item, my_inbox, notify
from app.domains.org.models import Employee, Organization, OrgMembership
from app.i18n import (
    bilingual,
    current_locale,
    parse_accept_language,
    reply_language_instruction,
    tr,
    use_locale,
)
from app.models import User
from tests.domains.test_im_gateway import TOKEN, enable, principal
from tests.utils.migrations import migrate
from tests.utils.utils import random_email, random_lower_string

pytestmark = pytest.mark.usefixtures("reset_login_attempts")


def test_i18n_helpers_and_context() -> None:
    assert parse_accept_language(None) == "zh-CN"
    assert parse_accept_language("") == "zh-CN"
    assert parse_accept_language("zh-CN,zh;q=0.9,en;q=0.8") == "zh-CN"
    assert parse_accept_language("en") == "en"
    assert parse_accept_language("en-US,en;q=0.9") == "en"

    assert current_locale.get() == "zh-CN"
    assert reply_language_instruction() == ""
    assert tr("邮箱或密码错误") == "邮箱或密码错误"

    with use_locale("en"):
        assert current_locale.get() == "en"
        assert "英文" in reply_language_instruction()
        assert tr("邮箱或密码错误") == "Incorrect email or password"
        assert (
            tr(
                "登录失败次数过多，请 {minutes} 分钟后再试，或联系企业管理员重置密码",
                minutes=15,
            )
            == "Too many failed sign-in attempts. Please try again in 15 minutes or contact your organization administrator to reset your password."
        )
    assert current_locale.get() == "zh-CN"

    zh, en = bilingual("邮箱或密码错误")
    assert zh == "邮箱或密码错误"
    assert en == "Incorrect email or password"


def test_duplicate_conflicting_key_raises_on_load(
    monkeypatch: pytest.MonkeyPatch, tmp_path: object
) -> None:
    import sys
    from pathlib import Path

    import app.i18n as i18n_pkg

    pkg_dir = Path(str(tmp_path)) / "fake_i18n"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("", encoding="utf-8")
    (pkg_dir / "en_a.py").write_text('EN = {"重复键": "First"}\n', encoding="utf-8")
    (pkg_dir / "en_b.py").write_text('EN = {"重复键": "Second"}\n', encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setattr(i18n_pkg, "__path__", [str(pkg_dir)])
    monkeypatch.setattr(i18n_pkg, "__name__", "fake_i18n")
    try:
        with pytest.raises(RuntimeError, match="Conflicting English translation"):
            i18n_pkg._load_catalog()
    finally:
        for mod_name in ("fake_i18n", "fake_i18n.en_a", "fake_i18n.en_b"):
            sys.modules.pop(mod_name, None)


def test_bilingual_migration_roundtrip(migration_engine: Engine) -> None:
    migrate(migration_engine, "downgrade", "e55a1b2c3d4f")
    with migration_engine.connect() as conn:
        assert "preferred_locale" not in {
            c["name"] for c in inspect(conn).get_columns("user")
        }
        assert "message_en" not in {
            c["name"] for c in inspect(conn).get_columns("inbox_item")
        }
    migrate(migration_engine, "upgrade", "head")
    with migration_engine.connect() as conn:
        assert "preferred_locale" in {
            c["name"] for c in inspect(conn).get_columns("user")
        }
        assert "message_en" in {
            c["name"] for c in inspect(conn).get_columns("inbox_item")
        }
        assert (
            conn.execute(text("SELECT count(*) FROM alembic_version")).scalar_one() == 1
        )


def test_http_errors_follow_accept_language(
    client: TestClient, db: Session, superuser_token_headers: dict[str, str]
) -> None:
    # Unauthenticated login failure
    res = client.post(
        f"{settings.API_V1_STR}/login/access-token",
        data={"username": settings.FIRST_SUPERUSER, "password": "wrong-password"},
        headers={"Accept-Language": "en"},
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "Incorrect email or password"

    # Unauthenticated invalid token
    res = client.get(
        f"{settings.API_V1_STR}/users/me",
        headers={"Authorization": "Bearer invalid", "Accept-Language": "en"},
    )
    assert res.status_code == 401
    assert res.json()["detail"] == "Session expired. Please sign in again."

    # Password change error
    res = client.patch(
        f"{settings.API_V1_STR}/users/me/password",
        headers={**superuser_token_headers, "Accept-Language": "en"},
        json={
            "current_password": "wrong-current-password",
            "new_password": "new-password-123",
        },
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "Current password is incorrect"

    # Dict detail keeps code and translates message
    email = random_email()
    password = random_lower_string()
    user = User(
        username=email,
        email=email,
        hashed_password=get_password_hash(password),
        is_active=True,
        must_change_password=True,
    )
    db.add(user)
    db.commit()
    token_res = client.post(
        f"{settings.API_V1_STR}/login/access-token",
        data={"username": email, "password": password},
    )
    token = token_res.json()["access_token"]
    res = client.post(
        f"{settings.API_V1_STR}/login/test-token",
        headers={"Authorization": f"Bearer {token}", "Accept-Language": "en"},
    )
    assert res.status_code == 403
    assert res.json()["detail"] == {
        "code": "password_change_required",
        "message": "Please change your password on first sign-in",
    }


def test_user_preferences_endpoint(client: TestClient, db: Session) -> None:
    email = random_email()
    other_email = random_email()
    password = random_lower_string()
    user = User(
        username=email,
        email=email,
        hashed_password=get_password_hash(password),
        is_active=True,
    )
    other = User(
        username=other_email,
        email=other_email,
        hashed_password=get_password_hash(password),
        is_active=True,
    )
    db.add_all([user, other])
    db.commit()

    # Requires auth
    unauth = client.patch(
        f"{settings.API_V1_STR}/users/me/preferences",
        json={"preferred_locale": "en"},
    )
    assert unauth.status_code == 401

    token = client.post(
        f"{settings.API_V1_STR}/login/access-token",
        data={"username": email, "password": password},
    ).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # Default preferred_locale is None
    me = client.get(f"{settings.API_V1_STR}/users/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["preferred_locale"] is None

    # Invalid value -> 422
    assert (
        client.patch(
            f"{settings.API_V1_STR}/users/me/preferences",
            headers=headers,
            json={"preferred_locale": "fr"},
        ).status_code
        == 422
    )
    # Extra field -> 422
    assert (
        client.patch(
            f"{settings.API_V1_STR}/users/me/preferences",
            headers=headers,
            json={"preferred_locale": "en", "user_id": str(other.id)},
        ).status_code
        == 422
    )

    # Valid update only updates own user
    updated = client.patch(
        f"{settings.API_V1_STR}/users/me/preferences",
        headers=headers,
        json={"preferred_locale": "en"},
    )
    assert updated.status_code == 200
    assert updated.json()["preferred_locale"] == "en"
    db.refresh(user)
    db.refresh(other)
    assert user.preferred_locale == "en"
    assert other.preferred_locale is None


def test_inbox_bilingual_and_historical_fallback(
    client: TestClient, db: Session
) -> None:
    email = random_email()
    password = random_lower_string()
    user = User(
        username=email,
        email=email,
        hashed_password=get_password_hash(password),
        is_active=True,
    )
    org = Organization(slug=f"i18n-{uuid4().hex[:8]}", name="Bilingual Org")
    db.add_all([user, org])
    db.flush()
    employee = Employee(
        org_id=org.id,
        employee_code="E901",
        display_name="Test Employee",
    )
    db.add(employee)
    db.flush()
    db.add(OrgMembership(org_id=org.id, user_id=user.id, employee_id=employee.id))
    req = ProfileChangeRequest(
        org_id=org.id,
        subject_employee_id=employee.id,
        origin=RequestOrigin.MANUAL,
        status=RequestStatus.DRAFT,
        author={},
    )
    db.add(req)
    db.flush()

    notify(
        db,
        req,
        InboxKind.DECIDED,
        "画像请求已完成审批",
        message_en="Your profile change request has been reviewed",
    )
    notify(db, req, InboxKind.SUBMITTED, "历史中文通知")
    db.commit()

    token = client.post(
        f"{settings.API_V1_STR}/login/access-token",
        data={"username": email, "password": password},
    ).json()["access_token"]

    en_items = client.get(
        f"{settings.API_V1_STR}/orgs/{org.id}/me/inbox",
        headers={"Authorization": f"Bearer {token}", "Accept-Language": "en"},
    ).json()["data"]
    assert {item["message"] for item in en_items} == {
        "Your profile change request has been reviewed",
        "历史中文通知",
    }

    zh_items = client.get(
        f"{settings.API_V1_STR}/orgs/{org.id}/me/inbox",
        headers={"Authorization": f"Bearer {token}", "Accept-Language": "zh-CN"},
    ).json()["data"]
    assert {item["message"] for item in zh_items} == {
        "画像请求已完成审批",
        "历史中文通知",
    }

    with use_locale("en"):
        p_inbox = my_inbox(
            principal(db, org.id, employee.id),
            db,
        )
        assert {item.message for item in p_inbox.data} == {
            "Your profile change request has been reviewed",
            "历史中文通知",
        }


def test_im_notification_uses_recipient_preferred_locale(
    demo: tuple, db: Session, telegram_server: dict
) -> None:
    p = principal(db, demo[1]["E02"].org_id, demo[1]["E02"].id)
    setting = enable(db, p)
    code = binding.create_code(db, p).code
    assert binding.bind(db, p.org_id, "telegram", "200", "200", "12345", code)

    user = db.exec(select(User).where(User.id == p.user_id)).one()
    old_locale = user.preferred_locale
    try:
        user.preferred_locale = "en"
        db.add(user)
        add_item(
            db,
            InboxItem(
                org_id=p.org_id,
                recipient_employee_id=p.employee_id,
                kind=InboxKind.REVIEW_REQUESTED,
                message="有新的待审批请求",
            ),
        )
        db.commit()

        async def run() -> None:
            adapter = Telegram(p.org_id, {"bot_token": TOKEN})
            try:
                await notifications.send_pending(
                    engine, {(p.org_id, "telegram"): (setting.credentials, adapter)}
                )
            finally:
                await adapter.close()

        asyncio.run(run())
        sends = [
            b["text"] for m, b in telegram_server["requests"] if m == "sendMessage"
        ]
        assert sends == [
            "You have a new request awaiting approval. Check on the web or message me directly."
        ]
        pending_left = db.exec(
            select(ImNotification).where(
                ImNotification.org_id == p.org_id,
                ImNotification.status == "pending",
            )
        ).all()
        assert pending_left == []
    finally:
        user.preferred_locale = old_locale
        db.add(user)
        db.commit()
