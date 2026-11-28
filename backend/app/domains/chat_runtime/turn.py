import logging
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass
from time import monotonic

from pydantic import JsonValue
from sqlmodel import Session

from app.authz.principal import Principal
from app.domains.admin_assistant.models import AdminAssistantSession
from app.domains.bot.models import BotSession
from app.domains.chat_runtime.admission import (
    BotBusy,
    BotDraftingPriority,
    BotQuotaPaused,
    BotRateLimited,
)
from app.domains.chat_runtime.presentation import DEADLINE_MESSAGE, retry_time
from app.domains.chat_runtime.store import append_message, save_state
from app.domains.model import pi_client
from app.domains.model.client import ModelServiceError, ModelUnavailable
from app.i18n import tr


@dataclass(frozen=True)
class TurnErrorCopy:
    drafting_priority: str
    busy: str
    rate_limited: str
    quota_paused: str
    model_unavailable: str


@dataclass(frozen=True)
class PiTurnSpec:
    config: pi_client.PiModelConfig
    images: list[pi_client.PiImage]
    session_state: dict[str, JsonValue] | None
    system_prompt: str
    input_text: str
    tools: list[pi_client.ToolDefinition]
    on_tool_call: Callable[[str, dict[str, JsonValue]], JsonValue]
    stream: pi_client.TurnStream | None
    notice: str = ""


def execute_turn[T](
    db: Session,
    principal: Principal,
    session: BotSession | AdminAssistantSession,
    user_payload: JsonValue,
    *,
    notice: str,
    stream: pi_client.TurnStream | None,
    logger: logging.Logger,
    error_copy: TurnErrorCopy,
    begin_turn_fn: Callable[..., AbstractContextManager[object]],
    build_turn: Callable[[], PiTurnSpec],
    on_success: Callable[[pi_client.TurnResult, str], T],
    on_cancelled: Callable[[], T],
    build_fallback: Callable[[str, bool], T],
    save_fallback: Callable[[T], T],
    before_admit: Callable[[], None] | None = None,
    on_admitted: Callable[[], T | None] | None = None,
) -> T:
    admitted = False
    started = monotonic()
    active_notice = notice
    model_unavailable = False
    try:
        if before_admit is not None:
            before_admit()
        with begin_turn_fn(
            db,
            principal,
            session,
            user_payload,
            stream.cancelled if stream else None,
        ):
            admitted = True
            if on_admitted is not None:
                early = on_admitted()
                if early is not None:
                    return early
            spec = build_turn()
            active_notice = spec.notice
            if active_notice and stream:
                stream.on_text(active_notice + "\n")
            result = pi_client.run_turn(
                spec.config,
                mode="chat",
                images=spec.images,
                session_state=spec.session_state,
                system_prompt=spec.system_prompt,
                input=spec.input_text,
                tools=spec.tools,
                on_tool_call=spec.on_tool_call,
                stream=spec.stream,
            )
            if stream:
                stream.check()
            if result.stop_reason != "stop":
                raise ModelUnavailable()
            return on_success(result, active_notice)
    except pi_client.TurnCancelled:
        return on_cancelled()
    except BotDraftingPriority:
        message = tr(error_copy.drafting_priority)
    except BotBusy:
        message = tr(error_copy.busy)
    except (BotRateLimited, BotQuotaPaused) as error:
        template = (
            error_copy.rate_limited
            if isinstance(error, BotRateLimited)
            else error_copy.quota_paused
        )
        message = tr(template, retry_time=retry_time(error.retry_at))
    except pi_client.PiSessionInvalid:
        save_state(db, session, None)
        logger.warning("session_id=%s code=bad_request", session.id)
        message = tr("之前的对话上下文已失效，已经重新开始，请再说一次")
    except ModelUnavailable as error:
        model_unavailable = True
        logger.warning(
            "session_id=%s code=%s elapsed_ms=%d",
            session.id,
            error.code,
            (monotonic() - started) * 1000,
        )
        message = (
            tr(DEADLINE_MESSAGE)
            if error.code == "deadline"
            else tr(str(error))
            if isinstance(error, ModelServiceError)
            else tr(error_copy.model_unavailable)
        )
    reply_text = "\n".join(filter(None, [active_notice, message]))
    response = build_fallback(reply_text, model_unavailable)
    if stream and stream.cancelled.is_set():
        db.rollback()
        return on_cancelled()
    if admitted:
        if stream:
            session.turn_count += 1
            append_message(db, session, "user", user_payload)
        response = save_fallback(response)
        if stream and stream.cancelled.is_set():
            db.rollback()
            return on_cancelled()
        db.commit()
    return response
