import asyncio
import json
from collections.abc import Iterator
from copy import deepcopy
from unittest.mock import patch
from uuid import uuid4

import httpx
import pytest
import sentry_sdk
from pydantic import ValidationError
from sentry_sdk.envelope import Envelope
from sentry_sdk.integrations.httpx import HttpxIntegration
from sentry_sdk.transport import Transport

from app.core.config import Settings

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "password", ["changethis", "demo-password-2026", "unique-demo-pass"]
)
@pytest.mark.parametrize("development", [True, False])
@pytest.mark.parametrize("seed", [True, False])
def test_demo_password(
    password: str, development: bool, seed: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FIRST_SUPERUSER", "example@example.com")
    monkeypatch.setenv("FIRST_SUPERUSER_PASSWORD", "changethis")
    values = {
        "PROJECT_NAME": "test",
        "SECRET_KEY": "test-secret",
        "PI_SERVICE_TOKEN": "test-token",
        "FIRST_SUPERUSER": None,
        "FIRST_SUPERUSER_PASSWORD": None,
        "DATABASE_URL": "postgresql://postgres:test-password@localhost/app",
        "FASTAPI_ENV": "development" if development else None,
        "SEED_DEMO_DATA": seed,
        "DEMO_USER_PASSWORD": password,
    }
    if seed and not development and password != "unique-demo-pass":
        with pytest.raises(ValidationError, match="DEMO_USER_PASSWORD"):
            Settings(_env_file=None, **values)  # type: ignore[call-arg, arg-type]
    else:
        assert Settings(_env_file=None, **values).DEMO_USER_PASSWORD == password  # type: ignore[call-arg, arg-type]


@pytest.mark.parametrize(
    "hook", ["before_breadcrumb", "before_send", "before_send_transaction"]
)
@pytest.mark.parametrize(
    "payload",
    [
        {"url": "https://api.telegram.org/bot123456:SECRET_TOKEN/getUpdates"},
        {
            "description": "GET https://example.com/api?access_token=SECRET_TOKEN&other=keep"
        },
        {"query_string": "corpsecret=SECRET_TOKEN&other=keep"},
        {"headers": {"Authorization": "Bearer SECRET_TOKEN"}},
        {"message": "Authorization: Bearer SECRET_TOKEN"},
        {"body": {"app_secret": "SECRET_TOKEN", "other": "keep"}},
        {"headers": [["authorization", "Bearer SECRET_TOKEN"]]},
        {"http.query": "corpid=SECRET_TOKEN&userid=SECRET_TOKEN&other=keep"},
        {"query": [["open_userid", "SECRET_TOKEN"]]},
        {
            "description": "GET https://open.feishu.cn/open-apis/im/v1/chats/SECRET_TOKEN"
        },
        {
            "url": "https://open.feishu.cn/open-apis/contact/v3/users/SECRET_TOKEN?user_id_type=open_id"
        },
    ],
)
def test_sentry_payloads_redact_credentials(hook: str, payload: dict) -> None:
    from app.core import observability

    event = {"data": deepcopy(payload), "safe": "keep"}
    result = getattr(observability, hook)(event, {})
    serialized = json.dumps(result)
    assert "SECRET_TOKEN" not in serialized
    assert "[Filtered]" in serialized
    assert result["safe"] == "keep"
    if "other" in json.dumps(payload):
        assert "keep" in serialized and "other" in serialized


@pytest.mark.parametrize(
    "dsn,env,enabled",
    [
        (None, None, False),
        ("https://public@example.com/1", "development", False),
        ("https://public@example.com/1", None, True),
    ],
)
def test_init_observability(
    monkeypatch: pytest.MonkeyPatch, dsn: str | None, env: str | None, enabled: bool
) -> None:
    from app.core import observability

    monkeypatch.setattr(observability.settings, "SENTRY_DSN", dsn)
    monkeypatch.setattr(observability.settings, "FASTAPI_ENV", env)
    monkeypatch.setattr(observability.settings, "SENTRY_TRACES_SAMPLE_RATE", 0.25)
    with patch.object(observability.sentry_sdk, "init") as init:
        observability.init_observability()
    if enabled:
        assert init.call_args.kwargs["traces_sample_rate"] == 0.25
        assert "enable_tracing" not in init.call_args.kwargs
        for name in ("before_breadcrumb", "before_send", "before_send_transaction"):
            assert init.call_args.kwargs[name] is getattr(observability, name)
    else:
        init.assert_not_called()


@pytest.fixture
def sentry_envelopes() -> Iterator[list[Envelope]]:
    from app.core.observability import (
        before_breadcrumb,
        before_send,
        before_send_transaction,
    )

    sent: list[Envelope] = []

    class MemoryTransport(Transport):
        def capture_envelope(self, envelope: Envelope) -> None:
            sent.append(envelope)

    with sentry_sdk.isolation_scope() as scope:
        scope.set_client(
            sentry_sdk.Client(
                dsn="https://public@example.com/1",
                release="synthetic-test",
                transport=MemoryTransport(),
                default_integrations=False,
                auto_enabling_integrations=False,
                integrations=[HttpxIntegration()],
                traces_sample_rate=1.0,
                before_breadcrumb=before_breadcrumb,
                before_send=before_send,
                before_send_transaction=before_send_transaction,
                include_local_variables=False,
                max_request_body_size="never",
                send_default_pii=False,
                trace_propagation_targets=[],
            )
        )
        yield sent


def test_sentry_httpx_envelopes_are_scrubbed(sentry_envelopes: list[Envelope]) -> None:
    with sentry_sdk.start_transaction(name="synthetic-im-request"):
        with httpx.Client(
            transport=httpx.MockTransport(lambda _: httpx.Response(200))
        ) as client:
            client.get(
                "https://api.telegram.org/bot123456:SECRET_TOKEN/getUpdates?access_token=SECOND_SECRET"
            )
        sentry_sdk.capture_message("synthetic event")
    body = b"\n".join(envelope.serialize() for envelope in sentry_envelopes)
    assert b"synthetic-im-request" in body and b"synthetic event" in body
    assert b"getUpdates" in body and b"[Filtered]" in body
    assert b"SECRET_TOKEN" not in body and b"SECOND_SECRET" not in body


@pytest.mark.parametrize("platform", ["feishu", "wecom"])
def test_private_im_requests_in_event_and_transaction(
    platform: str, sentry_envelopes: list[Envelope]
) -> None:
    from app.domains.im.adapters.feishu import Feishu
    from app.domains.im.adapters.wecom import Wecom

    message_id, file_key = "SYNTHETIC-MESSAGE-ID", "SYNTHETIC/FILE-KEY"
    corp_id, user_id = "SYNTHETIC-CORP-ID", "SYNTHETIC-USER-ID"
    token, secret = "SYNTHETIC-ACCESS-TOKEN", "SYNTHETIC-CONTACT-SECRET"
    converted_id = "SYNTHETIC-CONVERTED-ID"

    def respond(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if "/auth/" in path:
            return httpx.Response(
                200, json={"code": 0, "tenant_access_token": token, "expire": 3600}
            )
        if "/resources/" in path:
            assert request.headers["authorization"] == f"Bearer {token}"
            return httpx.Response(200, content=b"synthetic attachment")
        if path.endswith("gettoken"):
            assert request.url.params["corpid"] == corp_id
            assert request.url.params["corpsecret"] == secret
            return httpx.Response(200, json={"access_token": token})
        if path.endswith("openuserid_to_userid"):
            return httpx.Response(
                200,
                json={
                    "userid_list": [{"open_userid": user_id, "userid": converted_id}]
                },
            )
        if request.url.params["userid"] == user_id:
            return httpx.Response(200, json={"errcode": 60111})
        assert request.url.params["userid"] == converted_id
        return httpx.Response(
            200, json={"errcode": 0, "biz_mail": "example@example.com"}
        )

    async def run() -> None:
        if platform == "feishu":
            adapter = Feishu(uuid4(), {"app_id": "synthetic-app", "app_secret": secret})
            await adapter.client.aclose()
            adapter.client = httpx.AsyncClient(
                base_url="https://open.feishu.cn/open-apis/",
                transport=httpx.MockTransport(respond),
            )
            try:
                result = await adapter._attachment(
                    message_id, file_key, "file", "test.txt"
                )
                assert result.content == b"synthetic attachment"
            finally:
                await adapter.close()
        else:
            wecom = Wecom(uuid4(), {"corp_id": corp_id, "contact_secret": secret})
            await wecom.client.aclose()
            wecom.client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
            try:
                assert await wecom.enterprise_email(user_id) == "example@example.com"
            finally:
                await wecom.close()
        sentry_sdk.capture_message("synthetic private IM event")

    with sentry_sdk.start_transaction(name="synthetic-private-im"):
        asyncio.run(run())
    event = [e.get_event() for e in sentry_envelopes if e.get_event() is not None]
    transaction = [
        e.get_transaction_event()
        for e in sentry_envelopes
        if e.get_transaction_event() is not None
    ]
    assert len(event) == len(transaction) == 1
    for payload in (event[0], transaction[0]):
        serialized = json.dumps(payload)
        for private in (
            message_id,
            file_key,
            "SYNTHETIC%2FFILE-KEY",
            corp_id,
            user_id,
            converted_id,
            token,
            secret,
        ):
            assert private not in serialized
        assert (
            "resources" in serialized
            if platform == "feishu"
            else "gettoken" in serialized and "user/get" in serialized
        )
