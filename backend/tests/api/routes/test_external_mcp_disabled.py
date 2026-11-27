import hashlib
from datetime import timedelta

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.core.config import settings
from app.core.security import ALGORITHM
from app.domains.access_token.models import (
    McpSetting,
    OAuthClient,
    OAuthGrant,
    PersonalAccessToken,
)
from app.domains.admin_assistant import change_set, core, prompts, registry, tools
from app.domains.audit.models import AuditEvent
from app.domains.base import utc_now
from app.domains.bot import store as bot_store
from app.domains.employee_tools import EMPLOYEE_TOOLS
from app.domains.im import settings as im_settings
from app.domains.im.schemas import ImSettingUpdate
from app.mcp.oauth import oauth_routes
from tests.admin_assistant.test_registry import principal as admin_principal
from tests.domains.test_bot_core import enable as enable_bot
from tests.domains.test_im_gateway import principal as employee_principal


def test_external_mcp_defaults_to_disabled(
    demo: tuple, db: Session, client: TestClient
) -> None:
    assert settings.EXTERNAL_MCP_ENABLED is False
    url, people, auth = demo
    owner = people["E02"]
    org_id = owner.org_id
    admin_p = admin_principal(db, demo)
    emp_p = employee_principal(db, org_id, owner.id)
    assert emp_p.user_id is not None and admin_p.user_id is not None

    # Seed historical PAT, OAuth grant/token, and enabled McpSetting directly in DB.
    mcp_setting = McpSetting(org_id=org_id, updated_by=admin_p.user_id, enabled=True)
    db.add(mcp_setting)
    pat_secret = "epp_historical_pat_secret_for_disabled_test"
    pat_hash = hashlib.sha256(pat_secret.encode()).hexdigest()
    pat = PersonalAccessToken(
        org_id=org_id,
        user_id=emp_p.user_id,
        employee_id=owner.id,
        name="Historical PAT",
        token_hash=pat_hash,
        prefix=pat_secret[:12],
        client_kind="pat",
        expires_at=utc_now() + timedelta(days=30),
    )
    oauth_client = OAuthClient(
        client_id="historical-client",
        client_metadata={
            "client_id": "historical-client",
            "client_name": "Historical OAuth Client",
            "redirect_uris": ["https://client.example/callback"],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": "employee",
            "token_endpoint_auth_method": "none",
        },
        registered_ip="127.0.0.1",
    )
    grant = OAuthGrant(
        org_id=org_id,
        user_id=emp_p.user_id,
        employee_id=owner.id,
        client_id=oauth_client.client_id,
        redirect_uri="https://client.example/callback",
        resource="http://localhost:5173/mcp",
        code_hash=hashlib.sha256(b"used-code").hexdigest(),
        code_challenge="a" * 43,
        code_expires_at=utc_now() + timedelta(minutes=10),
    )
    oauth_secret = "epp_historical_oauth_secret_for_disabled_test"
    oauth_hash = hashlib.sha256(oauth_secret.encode()).hexdigest()
    oauth_pat = PersonalAccessToken(
        org_id=org_id,
        user_id=emp_p.user_id,
        employee_id=owner.id,
        name="Historical OAuth Client",
        token_hash=oauth_hash,
        prefix=oauth_secret[:12],
        client_kind="oauth",
        oauth_grant_id=grant.id,
        expires_at=utc_now() + timedelta(hours=1),
    )
    db.add_all([pat, oauth_client, grant, oauth_pat])
    db.commit()

    session_jwt = jwt.encode(
        {
            "aud": "mcp-session",
            "sub": pat_hash,
            "client_name": "Cursor",
            "exp": utc_now() + timedelta(hours=1),
        },
        settings.SECRET_KEY,
        algorithm=ALGORITHM,
    )

    try:
        # 1. /mcp is closed (404) for unauthenticated requests and historical PAT / OAuth tokens.
        for token in (None, pat_secret, oauth_secret):
            headers = (
                {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json, text/event-stream",
                    "Mcp-Session-Id": session_jwt,
                }
                if token
                else {}
            )
            assert client.post("/mcp", headers=headers, json={}).status_code == 404
            assert client.get("/mcp", headers=headers).status_code == 404
            assert client.delete("/mcp", headers=headers).status_code == 404

        assert (
            db.exec(
                select(AuditEvent).where(
                    AuditEvent.org_id == org_id,
                    AuditEvent.action == "mcp.tool_called",
                )
            ).all()
            == []
        )

        # 2. Public OAuth discovery & protocol endpoints return 404.
        for method, path, kwargs in (
            ("GET", "/.well-known/oauth-authorization-server", {}),
            ("GET", "/.well-known/oauth-authorization-server/oauth", {}),
            ("GET", "/.well-known/oauth-protected-resource", {}),
            ("GET", "/.well-known/oauth-protected-resource/mcp", {}),
            (
                "POST",
                "/oauth/register",
                {
                    "json": {
                        "client_name": "New Client",
                        "redirect_uris": ["https://client.example/cb"],
                    }
                },
            ),
            ("GET", "/oauth/authorize", {}),
            ("POST", "/oauth/token", {"data": {"grant_type": "authorization_code"}}),
            ("POST", "/oauth/revoke", {"data": {"token": pat_secret}}),
        ):
            assert client.request(method, path, **kwargs).status_code == 404

        # 3. API PAT, mcp-setting, and OAuth consent/grants endpoints return 404.
        for method, path, role, kwargs in (
            ("GET", f"{url}/mcp-setting", "admin", {}),
            ("PUT", f"{url}/mcp-setting", "admin", {"json": {"enabled": True}}),
            ("GET", f"{url}/me/access-tokens", "employee", {}),
            (
                "POST",
                f"{url}/me/access-tokens",
                "employee",
                {"json": {"name": "New PAT"}},
            ),
            ("DELETE", f"{url}/me/access-tokens/{pat.id}", "employee", {}),
            (
                "GET",
                f"/api/v1/oauth/consent?org_id={org_id}&request=synthetic",
                "employee",
                {},
            ),
            (
                "POST",
                f"/api/v1/oauth/consent?org_id={org_id}",
                "employee",
                {"json": {"request": "synthetic", "approve": True}},
            ),
            ("GET", f"/api/v1/oauth/grants?org_id={org_id}", "employee", {}),
            (
                "DELETE",
                f"/api/v1/oauth/grants/{grant.id}?org_id={org_id}",
                "employee",
                {},
            ),
        ):
            assert (
                client.request(method, path, headers=auth[role], **kwargs).status_code
                == 404
            )
    finally:
        db.rollback()
        db.delete(oauth_pat)
        db.delete(pat)
        db.flush()
        db.delete(grant)
        db.flush()
        db.delete(oauth_client)
        db.delete(mcp_setting)
        db.commit()


def test_http_oauth_routes_return_404_when_external_mcp_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "FRONTEND_HOST", "http://192.0.2.10:8080")
    local_app = FastAPI()
    local_app.router.routes.extend(oauth_routes())
    with TestClient(local_app) as local:
        for path in (
            "/.well-known/oauth-authorization-server",
            "/.well-known/oauth-protected-resource",
            "/oauth/register",
            "/oauth/token",
            "/oauth/authorize",
            "/oauth/revoke",
        ):
            assert local.get(path).status_code == 404
            assert local.post(path).status_code == 404


def test_admin_assistant_hides_external_mcp_when_disabled(
    demo: tuple, db: Session
) -> None:
    p = admin_principal(db, demo)
    assert "get_mcp_setting" not in registry.FUNCTIONS
    assert "update_mcp_setting" not in registry.FUNCTIONS
    connection_names = {
        fn["name"] for fn in registry.list_admin_functions("connections")["data"]
    }
    assert "update_im_setting" in connection_names
    assert "get_mcp_setting" not in connection_names
    assert "update_mcp_setting" not in connection_names

    prompt = prompts.system_prompt(p, "/admin/assistant")
    assert "get_mcp_setting" not in prompt
    assert "update_mcp_setting" not in prompt
    assert "/admin/data-ai?tab=mcp" not in prompt

    cards: list = []
    read_res = tools.call(
        db, p, cards, "admin_read", {"function": "get_mcp_setting", "args": {}}
    )
    assert "error" in read_res["data"]
    assert cards == []

    from app.domains.admin_assistant.store import create_session

    session = create_session(db, p)
    session_id = session.id
    propose_res = tools.call(
        db,
        p,
        cards,
        "propose_changes",
        {"items": [{"function": "update_mcp_setting", "args": {"enabled": True}}]},
        session_id=session_id,
    )
    assert "error" in propose_res
    assert (
        change_set.list_drafts(db, p, "update_mcp_setting", session_id=session_id) == []
    )

    for legacy_page, expected_target in (
        ("/admin/data-ai?tab=mcp", "/admin/data-ai?tab=sources"),
        ("/admin/connections?tab=mcp", "/admin/data-ai?tab=im"),
    ):
        fallback = core._fallback("请到对应页面操作", legacy_page)
        assert all(
            getattr(msg, "page", None) != legacy_page for msg in fallback.messages
        )
        assert any(
            getattr(msg, "page", None) == expected_target for msg in fallback.messages
        )


def test_internal_channels_continue_working_when_external_mcp_disabled(
    demo: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth = demo
    owner = people["E02"]
    org_id = owner.org_id
    emp_p = employee_principal(db, org_id, owner.id)
    admin_p = admin_principal(db, demo)

    # Web profile & change request submission works.
    profile = client.get(
        f"{url}/employees/{owner.id}/profile", headers=auth["employee"]
    )
    assert profile.status_code == 200
    draft = client.post(
        f"{url}/me/requests",
        headers=auth["employee"],
        json={
            "items": [
                {
                    "op": "add",
                    "capability_key": "automated_testing",
                    "statement": "内部通道回归测试陈述",
                    "level": "routine",
                    "owner_statement": "本人确认内部通道可用",
                }
            ]
        },
    )
    assert draft.status_code == 201, draft.text
    created = draft.json()
    submitted = client.post(
        f"{url}/me/requests/{created['id']}/submit",
        headers=auth["employee"],
        json={"revision": created["revision"]},
    )
    assert submitted.status_code == 200
    assert submitted.json()["status"] == "pending_review"

    # IM bindings & IM settings continue working.
    assert (
        client.get(f"{url}/me/im-bindings", headers=auth["employee"]).status_code == 200
    )
    assert (
        client.post(f"{url}/me/im-bind-code", headers=auth["employee"]).status_code
        == 200
    )
    saved_im = im_settings.save_setting(
        db,
        admin_p,
        "feishu",
        ImSettingUpdate(enabled=False, email_auto_bind=True, credentials={}),
    )
    assert saved_im.platform == "feishu"

    # Built-in bot / shared EMPLOYEE_TOOLS continue working.
    enable_bot(db, org_id)
    bot_query = {"org_id": str(org_id)}
    bot_session = client.post(
        "/api/v1/bot/sessions", params=bot_query, headers=auth["employee"]
    )
    assert bot_session.status_code == 201, bot_session.text
    assert (
        client.get(
            "/api/v1/bot/sessions", params=bot_query, headers=auth["employee"]
        ).status_code
        == 200
    )
    assert bot_store.list_sessions(db, emp_p)
    get_profile_tool = next(t for t in EMPLOYEE_TOOLS if t.name == "get_my_profile")
    profile_result = get_profile_tool.handler(principal=emp_p, session=db)
    assert profile_result.employee.id == owner.id
