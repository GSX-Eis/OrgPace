from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Any

import sentry_sdk

from app.core.config import settings

if TYPE_CHECKING:
    from sentry_sdk._types import Breadcrumb, BreadcrumbHint, Event, Hint

_REDACTED = "[Filtered]"
_SENSITIVE = re.compile(
    r"(?:token|secret|password|api[_-]?key|authorization|cookie|credentials?)$",
    re.IGNORECASE,
)
_TELEGRAM = re.compile(r"/bot\d+(?::|%3a)[^/\s?#\"']+", re.IGNORECASE)
_TEXT_SECRET = re.compile(
    r"(?i)\b([\w.-]*(?:token|secret|password|api[_-]?key))([\"']?\s*[:=]\s*[\"']?)([^&\s,;\"'<>}]+)"
)
_AUTH = re.compile(
    r"(?i)\b((?:proxy-)?authorization[\"']?\s*[:=]\s*[\"']?)(?:(?:bearer|basic)\s+)?[^&\s,;\"'<>}]+"
)


def _sensitive(key: object) -> bool:
    return isinstance(key, str) and _SENSITIVE.search(key) is not None


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        for key, item in value.items():
            value[key] = _REDACTED if _sensitive(key) else _redact(item)
    elif isinstance(value, (list, tuple)):
        # Headers and query parameters may be represented as name/value pairs.
        if len(value) == 2 and _sensitive(value[0]):
            return [value[0], _REDACTED]
        return [_redact(item) for item in value]
    elif isinstance(value, str):
        value = _TELEGRAM.sub(f"/bot{_REDACTED}", value)
        value = _TEXT_SECRET.sub(r"\1\2" + _REDACTED, value)
        return _AUTH.sub(r"\1" + _REDACTED, value)
    return value


def before_breadcrumb(crumb: Breadcrumb, _hint: BreadcrumbHint) -> Breadcrumb:
    _redact(crumb)
    return crumb


def before_send(event: Event, _hint: Hint) -> Event:
    _redact(event)
    return event


def before_send_transaction(event: Event, hint: Hint) -> Event:
    return before_send(event, hint)


def init_observability() -> None:
    logging.basicConfig(level=logging.INFO)
    if settings.SENTRY_DSN and settings.FASTAPI_ENV != "development":
        sentry_sdk.init(
            dsn=str(settings.SENTRY_DSN),
            traces_sample_rate=settings.SENTRY_TRACES_SAMPLE_RATE,
            before_breadcrumb=before_breadcrumb,
            before_send=before_send,
            before_send_transaction=before_send_transaction,
            include_local_variables=False,
            max_request_body_size="never",
            send_default_pii=False,
            trace_propagation_targets=[],
        )
