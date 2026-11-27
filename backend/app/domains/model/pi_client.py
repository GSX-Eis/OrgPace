import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from threading import Event
from time import monotonic, sleep
from typing import Literal
from urllib.parse import quote
from uuid import UUID, uuid4

import httpx
from pydantic import BaseModel, ConfigDict, Field, JsonValue, SecretStr

from app.core.config import settings
from app.domains.model.client import (
    ModelAuthenticationError,
    ModelRateLimited,
    ModelServiceError,
    ModelUnavailable,
)

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
RETRY_DELAYS = (0.5, 1.0)
_RETRYABLE_CODES = frozenset(
    {"busy", "upstream_unavailable", "model_error", "unavailable"}
)


class _ToolCallbackError(ModelUnavailable):
    pass


class _AttemptFailed(Exception):
    def __init__(
        self,
        error: Exception,
        *,
        retryable: bool,
        code: str,
        delete_failed: bool = False,
    ) -> None:
        self.error = error
        self.retryable = retryable
        self.code = code
        self.delete_failed = delete_failed


class PiModelConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    org_id: UUID | None = Field(default=None, exclude=True)
    provider: str
    api: Literal[
        "openai-responses",
        "anthropic-messages",
        "openai-completions",
        "openai-codex-responses",
    ]
    id: str
    baseUrl: str
    api_key: SecretStr = Field(default=SecretStr(""), repr=False)
    thinkingLevel: Literal["off", "minimal", "low", "medium", "high", "xhigh"] = "off"
    reasoning: bool = False
    contextWindow: int = Field(default=128000, gt=0)
    maxTokens: int = Field(default=4096, gt=0)
    compat: dict[str, JsonValue] = Field(default_factory=dict)


class ToolDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    description: str
    parameters: dict[str, JsonValue]


class PiImage(BaseModel):
    name: str
    data: str = Field(repr=False)
    mimeType: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]


class PiBusy(ModelUnavailable):
    pass


class PiSessionInvalid(ModelUnavailable):
    def __init__(self) -> None:
        super().__init__("会话已失效，请新开对话")


class TurnCancelled(Exception):
    pass


@dataclass
class TurnStream:
    run_id: str
    on_text: Callable[[str], None]
    on_tool: Callable[[str, Literal["start", "end"], bool], None]
    cancelled: Event

    def check(self) -> None:
        if self.cancelled.is_set():
            raise TurnCancelled()


def cancel_run(run_id: str) -> None:
    with httpx.Client(
        base_url=settings.PI_URL,
        headers={
            "Authorization": f"Bearer {settings.PI_SERVICE_TOKEN.get_secret_value()}"
        },
        timeout=5,
        trust_env=False,
    ) as client:
        response = client.delete(f"/v1/turns/{quote(run_id, safe='')}")
        if response.status_code != 404:
            response.raise_for_status()


class TurnResult(BaseModel):
    session_state: dict[str, JsonValue] | None = Field(default=None, repr=False)
    text: str
    stop_reason: Literal["stop", "length", "toolUse", "aborted"]
    model_calls: int = Field(ge=0, le=8)
    tool_calls: int = Field(ge=0, le=16)


def _error(event: dict[str, JsonValue]) -> None:
    value = event.get("code")
    code = value if isinstance(value, str) else ""
    if code == "busy":
        raise PiBusy("模型服务繁忙，请稍后再试", code="busy")

    if code == "model_unauthorized":
        raise ModelAuthenticationError()
    match code:
        case "model_not_found" | "upstream_rejected" | "upstream_unavailable":
            raise ModelServiceError(code)
    if code == "rate_limited":
        retry_at = datetime.fromisoformat(str(event["retry_at"]))
        if retry_at.tzinfo is None:
            raise ValueError("Invalid retry time")
        reason = "模型用量到上限" + (
            "；恢复时间为估计" if event.get("estimated") else ""
        )
        raise ModelRateLimited(retry_at, reason)
    if code in ("unauthorized", "bad_request"):
        logger.error("Pi protocol failure: %s", code)
    messages = {
        "unauthorized": "模型服务暂时不可用",
        "bad_request": "模型服务暂时不可用",
        "model_error": "模型服务暂时不可用",
        "model_forbidden": "密钥不对或没有权限",
        "busy": "模型服务繁忙，请稍后再试",
        "deadline": "模型调用超时",
        "limit_exceeded": "模型调用次数达到上限",
        "cancelled": "模型调用已取消",
        "local_auth_unavailable": "本机 Codex 授权不可用或有效期不足一小时，请在本机正常运行一次 codex 刷新",
    }
    raise ModelUnavailable(
        messages.get(code, "模型服务暂时不可用"),
        code=code if code in messages else "unavailable",
    )


def _run_turn_once(
    config: PiModelConfig,
    *,
    run_id: str,
    attempt_timeout: float,
    mode: Literal["draft", "chat"],
    session_state: dict[str, JsonValue] | None,
    images: list[PiImage] | None,
    system_prompt: str,
    input: str,
    tools: list[ToolDefinition],
    on_tool_call: Callable[[str, dict[str, JsonValue]], JsonValue],
    stream: TurnStream | None,
) -> TurnResult:
    path = f"/v1/turns/{run_id}"
    model = config.model_dump(mode="json", exclude={"api_key"}, exclude_unset=True)
    model["api_key"] = config.api_key.get_secret_value()
    body = {
        "version": 2 if mode == "chat" else 1,
        "run_id": run_id,
        "mode": mode,
        "model": model,
        "system_prompt": system_prompt,
        "input": input,
        "tools": [tool.model_dump(mode="json") for tool in tools],
    }
    if mode == "chat":
        body["session_state"] = (
            session_state
            if session_state is not None
            else {"version": 1, "messages": []}
        )
    elif session_state is not None:
        raise ValueError("Session state requires chat mode")
    if images:
        if mode != "chat":
            raise ValueError("Images require chat mode")
        body["images"] = [image.model_dump(mode="json") for image in images]
    terminal = False
    emitted_text = False
    tool_invoked = False
    delete_failed = False
    names = {tool.name for tool in tools}
    if stream:
        stream.check()
    try:
        with httpx.Client(
            base_url=settings.PI_URL,
            headers={
                "Authorization": f"Bearer {settings.PI_SERVICE_TOKEN.get_secret_value()}"
            },
            timeout=httpx.Timeout(
                attempt_timeout,
                connect=5 if attempt_timeout >= 5 else attempt_timeout,
            ),
            trust_env=False,
        ) as client:
            with client.stream("POST", "/v1/turns", json=body) as response:
                try:
                    if response.status_code != 200:
                        terminal = True
                        response.read()
                        event = response.json()
                        if mode == "chat" and event.get("code") == "bad_request":
                            raise PiSessionInvalid()
                        _error(event)
                    chunks: list[str] = []
                    lines = response.iter_lines()
                    for line in lines:
                        if stream:
                            stream.check()
                        event = json.loads(line)
                        match event["type"]:
                            case "text":
                                emitted_text = True
                                chunks.append(event["text"])
                                if stream:
                                    stream.on_text(event["text"])
                            case "tool_call":
                                if event["name"] not in names or not isinstance(
                                    event["arguments"], dict
                                ):
                                    raise ValueError("Invalid tool call")
                                tool_invoked = True
                                try:
                                    if stream:
                                        stream.on_tool(event["name"], "start", True)
                                    result = on_tool_call(
                                        event["name"], event["arguments"]
                                    )
                                except Exception:
                                    if stream:
                                        stream.on_tool(event["name"], "end", False)
                                    client.post(
                                        path
                                        + "/results/"
                                        + quote(event["call_id"], safe=""),
                                        json={
                                            "result": "平台工具调用失败",
                                            "is_error": True,
                                        },
                                    ).raise_for_status()
                                    raise _ToolCallbackError(
                                        "平台工具调用失败"
                                    ) from None
                                if stream:
                                    stream.on_tool(
                                        event["name"],
                                        "end",
                                        not (
                                            isinstance(result, dict)
                                            and "error" in result
                                        ),
                                    )
                                client.post(
                                    path
                                    + "/results/"
                                    + quote(event["call_id"], safe=""),
                                    json={"result": result, "is_error": False},
                                ).raise_for_status()
                            case "error":
                                terminal = True
                                _error(event)
                            case "done":
                                terminal = True
                                if mode == "chat" and not isinstance(
                                    event.get("session_state"), dict
                                ):
                                    raise ValueError("Missing chat state")
                                return TurnResult(
                                    session_state=event["session_state"]
                                    if mode == "chat"
                                    else None,
                                    text="".join(chunks),
                                    stop_reason=event["stopReason"],
                                    model_calls=event["model_calls"],
                                    tool_calls=event["tool_calls"],
                                )
                            case _:
                                raise ValueError("Invalid Pi event")
                    raise ModelUnavailable("模型服务连接中断")
                finally:
                    if not terminal:
                        # DELETE acknowledges only after abort and slot release.
                        try:
                            cancelled = client.delete(path)
                        except httpx.HTTPError:
                            delete_failed = True
                            raise
                        if cancelled.status_code == 404:
                            # The model may finish between a tool error and DELETE.
                            if not (stream and stream.cancelled.is_set()) and not any(
                                json.loads(line).get("type") in ("done", "error")
                                for line in lines
                            ):
                                raise ModelUnavailable("模型服务连接中断")
                        else:
                            try:
                                cancelled.raise_for_status()
                            except httpx.HTTPError:
                                delete_failed = True
                                raise
    except TurnCancelled:
        raise
    except PiSessionInvalid as error:
        raise _AttemptFailed(
            error, retryable=False, code="bad_request", delete_failed=delete_failed
        ) from None
    except ModelRateLimited as error:
        raise _AttemptFailed(
            error, retryable=False, code="rate_limited", delete_failed=delete_failed
        ) from None
    except _ToolCallbackError as error:
        raise _AttemptFailed(
            ModelUnavailable(str(error), code=error.code),
            retryable=False,
            code="tool_error",
            delete_failed=delete_failed,
        ) from None
    except ModelAuthenticationError as error:
        if config.org_id is not None:
            from app.domains.model.chatgpt import RELOGIN, invalidate

            invalidate(config.org_id, config.api_key.get_secret_value())
            raise _AttemptFailed(
                ModelUnavailable(RELOGIN, code="model_unauthorized"),
                retryable=False,
                code="model_unauthorized",
                delete_failed=delete_failed,
            ) from None
        raise _AttemptFailed(
            error,
            retryable=False,
            code="model_unauthorized",
            delete_failed=delete_failed,
        ) from None
    except ModelUnavailable as error:
        retryable = (
            not emitted_text and not tool_invoked and error.code in _RETRYABLE_CODES
        )
        raise _AttemptFailed(
            error, retryable=retryable, code=error.code, delete_failed=delete_failed
        ) from None
    except httpx.HTTPError as error:
        code = "timeout" if isinstance(error, httpx.TimeoutException) else "unavailable"
        retryable = not emitted_text and not tool_invoked
        raise _AttemptFailed(
            ModelUnavailable("模型服务连接失败或协议错误", code=code),
            retryable=retryable,
            code=code,
            delete_failed=delete_failed,
        ) from None
    except ValueError, KeyError, TypeError:
        raise _AttemptFailed(
            ModelUnavailable("模型服务连接失败或协议错误"),
            retryable=False,
            code="protocol_error",
            delete_failed=delete_failed,
        ) from None


def run_turn(
    config: PiModelConfig,
    *,
    mode: Literal["draft", "chat"] = "draft",
    session_state: dict[str, JsonValue] | None = None,
    images: list[PiImage] | None = None,
    system_prompt: str,
    input: str,
    tools: list[ToolDefinition],
    on_tool_call: Callable[[str, dict[str, JsonValue]], JsonValue],
    stream: TurnStream | None = None,
) -> TurnResult:
    if mode == "draft" and session_state is not None:
        raise ValueError("Session state requires chat mode")
    if images and mode != "chat":
        raise ValueError("Images require chat mode")
    total_timeout = 190.0 if mode == "chat" else 130.0
    deadline_at = monotonic() + total_timeout
    max_attempts = MAX_ATTEMPTS if mode == "chat" else 1
    delete_failed = False
    for attempt in range(1, max_attempts + 1):
        if stream:
            stream.check()
        remaining = deadline_at - monotonic()
        if remaining <= 0:
            raise ModelUnavailable(
                "模型调用超时", code="deadline", attempts=attempt - 1
            )
        attempt_timeout = total_timeout if attempt == 1 else remaining
        run_id = (
            str(uuid4())
            if delete_failed
            else (stream.run_id if stream else str(uuid4()))
        )
        if stream and delete_failed:
            stream.run_id = run_id
        try:
            return _run_turn_once(
                config,
                run_id=run_id,
                attempt_timeout=attempt_timeout,
                mode=mode,
                session_state=session_state,
                images=images,
                system_prompt=system_prompt,
                input=input,
                tools=tools,
                on_tool_call=on_tool_call,
                stream=stream,
            )
        except _AttemptFailed as failure:
            delete_failed = failure.delete_failed
            can_retry = failure.retryable and attempt < max_attempts
            delay = RETRY_DELAYS[attempt - 1] if can_retry else 0.0
            if can_retry and (deadline_at - monotonic()) > delay:
                logger.warning(
                    "Pi turn attempt failed, retrying: run_id=%s mode=%s attempt=%d/%d code=%s error_type=%s",
                    run_id,
                    mode,
                    attempt,
                    max_attempts,
                    failure.code,
                    type(failure.error).__name__,
                )
                if stream:
                    if stream.cancelled.wait(delay):
                        raise TurnCancelled() from None
                else:
                    sleep(delay)
                continue
            if isinstance(failure.error, ModelUnavailable):
                failure.error.attempts = attempt
            logger.warning(
                "Pi turn failed: run_id=%s mode=%s attempts=%d code=%s error_type=%s retryable=%s",
                run_id,
                mode,
                attempt,
                failure.code,
                type(failure.error).__name__,
                failure.retryable,
            )
            raise failure.error from None
    raise AssertionError("unreachable")
