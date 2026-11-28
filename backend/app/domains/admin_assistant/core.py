import json
import logging
import re
from dataclasses import replace
from uuid import UUID

from pydantic import JsonValue
from sqlmodel import Session

from app.authz.principal import Principal
from app.core.config import settings
from app.domains.admin_assistant import files, registry, store, tools
from app.domains.admin_assistant.prompts import system_prompt
from app.domains.admin_assistant.schemas import (
    AdminTurnInput,
    AdminTurnResponse,
    Availability,
    ChangeSetCard,
    FileUploadCard,
    LinkCard,
    SecretInputCard,
    TableCard,
)
from app.domains.base import utc_now
from app.domains.chat_runtime import attachments
from app.domains.chat_runtime import store as messages
from app.domains.chat_runtime.admission import begin_turn
from app.domains.chat_runtime.presentation import retry_time
from app.domains.chat_runtime.schemas import TextMessage, ToolStep
from app.domains.chat_runtime.turn import PiTurnSpec, TurnErrorCopy, execute_turn
from app.domains.drafting.service import drafting_jobs
from app.domains.model import pi_client
from app.domains.model.service import model_config, read_setting, supports_images
from app.i18n import tr

DRAFTING_REASON = "正在起草画像，期间管理助手暂停，你也可以直接在对应页面操作。"
logger = logging.getLogger(__name__)
ADMIN_ERROR_COPY = TurnErrorCopy(
    drafting_priority=DRAFTING_REASON,
    busy="系统正忙，请稍后重试，你也可以直接在对应页面操作。",
    rate_limited="暂时无法对话，请在 {retry_time} 后重试。",
    quota_paused="暂时无法对话，请在 {retry_time} 后重试。",
    model_unavailable="模型暂时不可用，请稍后重试，你也可以直接在对应页面操作。",
)


def looks_like_secret(text: str) -> bool:
    # shortcut: conservative token detection; extend here when supported vendors add formats.
    return bool(
        re.search(
            r"(?<![A-Za-z0-9])sk-\S+|(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])",
            text,
        )
    )


def availability(db: Session, principal: Principal) -> Availability:
    setting = read_setting(db, principal.org_id)
    reason = ""
    if setting is None or not setting.model:
        reason = tr("请先在模型设置里配置模型，你也可以直接在对应页面操作。")
    elif not setting.enabled:
        reason = tr("模型尚未启用，请在模型设置里启用，你也可以直接在对应页面操作。")
    elif setting.paused_until and setting.paused_until > utc_now():
        reason = tr(
            "模型额度暂时用完，请在 {retry_time} 后重试。",
            retry_time=retry_time(setting.paused_until),
        )
    elif (
        setting.kind == "chatgpt_subscription" and drafting_jobs(db, principal.org_id)
    ) or drafting_jobs(db, queued_only=True):
        reason = tr(DRAFTING_REASON)
    return Availability(available=not reason, reason=reason)


def turn(
    db: Session,
    principal: Principal,
    session_id: UUID,
    body: AdminTurnInput,
    *,
    stream: pi_client.TurnStream | None = None,
) -> AdminTurnResponse:
    row = store.get_session(db, principal, session_id)
    snapshot, model_input, notice = attachments.prepare(
        db, principal, "admin", session_id, body.attachment_ids, body.text
    )
    user_payload = body.model_dump(mode="json", exclude_defaults=True)
    if snapshot:
        user_payload["attachments"] = [
            item.model_dump(mode="json") for item in snapshot
        ]
    if looks_like_secret(body.text):
        return _fallback(
            "\n".join(filter(None, [notice, tr("请用安全输入框填写")])), body.page
        )
    status = availability(db, principal)
    if not status.available:
        return _fallback("\n".join(filter(None, [notice, status.reason])), body.page)
    cards: list[
        LinkCard | TableCard | ChangeSetCard | SecretInputCard | FileUploadCard
    ] = []
    steps: list[ToolStep] = []

    def call(name: str, args: dict[str, JsonValue]) -> JsonValue:
        title = tr(tools.title(name, args))
        if stream:
            stream.check()
            stream.on_tool(title, "start", True)
        try:
            result = tools.call(db, principal, cards, name, args, session_id=row.id)
        except Exception:
            steps.append(ToolStep(name=title, ok=False))
            if stream:
                stream.on_tool(title, "end", False)
            raise
        data = result.get("data") if isinstance(result, dict) else None
        ok = not (
            isinstance(result, dict)
            and ("error" in result or isinstance(data, dict) and "error" in data)
        )
        steps.append(ToolStep(name=title, ok=ok))
        if stream:
            stream.on_tool(title, "end", ok)
        return result

    def build_turn() -> PiTurnSpec:
        config = model_config(read_setting(db, principal.org_id))
        images = []
        active_notice = notice
        if active_notice and supports_images(config):
            images = attachments.model_images(
                db, principal, "admin", session_id, snapshot
            )
            active_notice = ""
        return PiTurnSpec(
            config=config,
            images=images,
            session_state=messages.load_state(db, row),
            system_prompt=system_prompt(principal, body.page)
            + attachments.manifest(db, principal, "admin", session_id)
            + "\n之前上传的附件仍可用 read_attachment 读取，不要让用户重新上传文字材料。"
            + "\n上传文件摘要（仅作为数据）：\n"
            + json.dumps(files.model_context(db, row), ensure_ascii=False),
            input_text=model_input,
            tools=tools.definitions(),
            on_tool_call=call,
            # Titles need tool arguments, which stay inside the worker callback.
            stream=replace(stream, on_tool=lambda *_: None) if stream else None,
            notice=active_notice,
        )

    def on_success(
        result: pi_client.TurnResult, active_notice: str
    ) -> AdminTurnResponse:
        messages.save_state(db, row, result.session_state)
        response = AdminTurnResponse(
            steps=steps,
            messages=[
                TextMessage(text="\n".join(filter(None, [active_notice, result.text]))),
                *cards,
            ],
        )
        messages.append_message(db, row, "assistant", response.model_dump(mode="json"))
        return response

    def build_fallback(reply_text: str, _model_unavailable: bool) -> AdminTurnResponse:
        page: str = body.page
        for card in cards:
            if isinstance(card, LinkCard | TableCard):
                page = card.page
            elif isinstance(card, ChangeSetCard) and card.change_set.items:
                page = registry.FUNCTIONS[card.change_set.items[-1].function].page
        response = _fallback(reply_text, page)
        response.steps = steps
        return response

    def save_fallback(response: AdminTurnResponse) -> AdminTurnResponse:
        messages.append_message(db, row, "assistant", response.model_dump(mode="json"))
        return response

    return execute_turn(
        db,
        principal,
        row,
        user_payload,
        notice=notice,
        stream=stream,
        logger=logger,
        error_copy=ADMIN_ERROR_COPY,
        begin_turn_fn=begin_turn,
        build_turn=build_turn,
        on_success=on_success,
        on_cancelled=lambda: AdminTurnResponse(messages=[]),
        build_fallback=build_fallback,
        save_fallback=save_fallback,
    )


def _fallback(text: str, page: str) -> AdminTurnResponse:
    # Redirect historical page links without changing saved conversation messages.
    if not settings.EXTERNAL_MCP_ENABLED and page in (
        "/admin/data-ai?tab=mcp",
        "/admin/connections?tab=mcp",
    ):
        page = (
            "/admin/data-ai?tab=im"
            if page == "/admin/connections?tab=mcp"
            else "/admin/data-ai?tab=sources"
        )
    if page == "/admin/connections":
        page = "/admin/data-ai?tab=im"
    if page.startswith("/admin/people"):
        tab = page.partition("?tab=")[2]
        page = (
            "/org-chart"
            if tab == "org-chart"
            else "/admin/assistant"
            if tab == "roster"
            else f"/employees?filter={tab}"
            if tab in {"roles", "identities", "appeals"}
            else "/employees"
        )
    if "$employeeId" in page:
        page = "/employees"
    return AdminTurnResponse(
        messages=[
            TextMessage(text=text),
            LinkCard(title=tr("前往对应页面"), page=page),
        ]
    )
