import json
from copy import deepcopy
from unittest.mock import patch

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
def test_demo_password(password: str, development: bool, seed: bool) -> None:
    values = {
        "PROJECT_NAME": "test",
        "SECRET_KEY": "test-secret",
        "PI_SERVICE_TOKEN": "test-token",
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


def test_sentry_httpx_envelopes_are_scrubbed() -> None:
    from app.core.observability import (
        before_breadcrumb,
        before_send,
        before_send_transaction,
    )

    sent: list[bytes] = []

    class MemoryTransport(Transport):
        def capture_envelope(self, envelope: Envelope) -> None:
            sent.append(envelope.serialize())

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
                trace_propagation_targets=[],
            )
        )
        with sentry_sdk.start_transaction(name="synthetic-im-request"):
            with httpx.Client(
                transport=httpx.MockTransport(lambda _: httpx.Response(200))
            ) as client:
                client.get(
                    "https://api.telegram.org/bot123456:SECRET_TOKEN/getUpdates?access_token=SECOND_SECRET"
                )
            sentry_sdk.capture_message("synthetic event")
    body = b"\n".join(sent)
    assert b"synthetic-im-request" in body and b"synthetic event" in body
    assert b"getUpdates" in body and b"[Filtered]" in body
    assert b"SECRET_TOKEN" not in body and b"SECOND_SECRET" not in body
