"""Table-driven capacity assistant tool dispatch and facade."""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, JsonValue, ValidationError
from sqlmodel import Session

from app.authz.policies import can_view_org_aggregates
from app.authz.principal import Principal
from app.domains.bot import schemas as s
from app.domains.bot.models import BotSession
from app.domains.capacity import demand, proposal
from app.domains.capacity.assistant_demands import (
    DEMAND_REPLY_PLAN_GUIDANCE as DEMAND_REPLY_PLAN_GUIDANCE,
)
from app.domains.capacity.assistant_demands import (
    DEMAND_REPLY_REASON_GUIDANCE as DEMAND_REPLY_REASON_GUIDANCE,
)
from app.domains.capacity.assistant_demands import (
    PRIVATE_TEXT as PRIVATE_TEXT,
)
from app.domains.capacity.assistant_demands import (
    RESPONSES as RESPONSES,
)
from app.domains.capacity.assistant_demands import (
    SKILL_REPLY_TEXT as SKILL_REPLY_TEXT,
)
from app.domains.capacity.assistant_demands import (
    SKILL_REPLY_UNVERIFIED as SKILL_REPLY_UNVERIFIED,
)
from app.domains.capacity.assistant_demands import (
    STAFFING_FIELDS as STAFFING_FIELDS,
)
from app.domains.capacity.assistant_demands import (
    STAFFING_TEXT as STAFFING_TEXT,
)
from app.domains.capacity.assistant_demands import (
    ChangeOnWeb as ChangeOnWeb,
)
from app.domains.capacity.assistant_demands import (
    DemandDepartmentForbidden as DemandDepartmentForbidden,
)
from app.domains.capacity.assistant_demands import (
    DemandField as DemandField,
)
from app.domains.capacity.assistant_demands import (
    DraftTextInvalid as DraftTextInvalid,
)
from app.domains.capacity.assistant_demands import (
    PlanReplyHandler as PlanReplyHandler,
)
from app.domains.capacity.assistant_demands import (
    PrepareDemandInput as PrepareDemandInput,
)
from app.domains.capacity.assistant_demands import (
    _has_proposal_arguments,
    execute_demand_reply,
    format_demand_response_result,
    prepare_demand_preview,
    prepare_demand_reply_preview,
    prepare_demand_response_preview,
)
from app.domains.capacity.assistant_demands import (
    _is_skill_rejection as _is_skill_rejection,
)
from app.domains.capacity.assistant_demands import (
    check_demand as check_demand,
)
from app.domains.capacity.assistant_demands import (
    check_demand_reply as check_demand_reply,
)
from app.domains.capacity.assistant_demands import (
    check_demand_response as check_demand_response,
)
from app.domains.capacity.assistant_demands import (
    requester_departments as requester_departments,
)
from app.domains.capacity.assistant_demands import (
    validate_draft_text as validate_draft_text,
)
from app.domains.capacity.assistant_forecast import (
    ForecastAction,
    execute_forecast_event,
    execute_forecast_policy,
    parse_forecast_event_arguments,
    parse_forecast_policy_arguments,
)
from app.domains.capacity.assistant_forecast import (
    PrepareForecastEventInput as PrepareForecastEventInput,
)
from app.domains.capacity.assistant_forecast import (
    PrepareForecastPolicyInput as PrepareForecastPolicyInput,
)
from app.domains.capacity.assistant_forecast import (
    _affected_employee_count as _affected_employee_count,
)
from app.domains.capacity.assistant_forecast import (
    _build_event_card as _build_event_card,
)
from app.domains.capacity.assistant_forecast import (
    _find_policy_by_scope as _find_policy_by_scope,
)
from app.domains.capacity.assistant_forecast import (
    _format_modifier as _format_modifier,
)
from app.domains.capacity.assistant_forecast import (
    _scope_label as _scope_label,
)
from app.domains.capacity.assistant_forecast import (
    check_forecast_event as check_forecast_event,
)
from app.domains.capacity.assistant_forecast import (
    check_forecast_policy as check_forecast_policy,
)
from app.domains.capacity.assistant_forecast import (
    get_forecast_config_for_bot as get_forecast_config_for_bot,
)
from app.domains.capacity.assistant_workload import (
    check_extension_request as check_extension_request,
)
from app.domains.capacity.assistant_workload import (
    check_leave as check_leave,
)
from app.domains.capacity.assistant_workload import (
    check_team_workload as check_team_workload,
)
from app.domains.capacity.assistant_workload import (
    check_workload_request as check_workload_request,
)
from app.domains.capacity.assistant_workload import (
    execute_leave,
    execute_team_workload,
    format_workload_request_result,
)
from app.domains.capacity.common import CapacityConflict
from app.domains.capacity.demand_schemas import (
    DemandList,
    DemandListInput,
    DemandPublic,
    PlanReplyDemandInput,
    ProjectDetail,
)
from app.domains.capacity.schemas import (
    LeaveInput,
    TeamWorkloadInput,
    Via,
)
from app.domains.capacity.settings import read_settings, require_enabled
from app.domains.capacity.tools import CAPACITY_TOOLS
from app.domains.change_request.schemas import validation_message
from app.domains.model.pi_client import ToolDefinition
from app.i18n import tr

READS = {t.name: t for t in CAPACITY_TOOLS if not t.writes}
WRITES = {t.name: t for t in CAPACITY_TOOLS if t.writes}
CardKind = Literal[
    "demand",
    "demand_response",
    "demand_reply",
    "workload_request",
    "extension_request",
    "leave",
    "team_workload",
    "forecast_policy",
    "forecast_event",
]
PREPARES: dict[str, tuple[CardKind, str, str]] = {
    "prepare_demand": ("demand", "submit_demand", "提交部门需求"),
    "prepare_demand_response": ("demand_response", "respond_demand", "回应部门需求"),
    "prepare_demand_reply": ("demand_reply", "reply_demand", "答复部门需求"),
    "prepare_workload_request": (
        "workload_request",
        "request_workload_change",
        "申请调整负荷",
    ),
    "prepare_extension_request": ("extension_request", "request_extension", "申请延期"),
    "prepare_leave": ("leave", "register_leave", "登记请假"),
    "prepare_team_workload": ("team_workload", "set_weeks", "调整下属负荷"),
    "prepare_forecast_policy": ("forecast_policy", "", "配置负荷预测策略"),
    "prepare_forecast_event": ("forecast_event", "", "注入业务波动事件"),
}
FORECAST_PREPARE_NAMES = frozenset(
    {"prepare_forecast_policy", "prepare_forecast_event"}
)
FORECAST_CARD_KINDS = frozenset({"forecast_policy", "forecast_event"})
TITLES = {name: t.description for name, t in READS.items()} | {
    name: title for name, (_, _, title) in PREPARES.items()
}
PREPARE_MODELS: dict[str, type[BaseModel]] = {
    "prepare_demand": PrepareDemandInput,
    "prepare_leave": LeaveInput,
    "prepare_team_workload": TeamWorkloadInput,
    "prepare_forecast_policy": PrepareForecastPolicyInput,
    "prepare_forecast_event": PrepareForecastEventInput,
}
CHECKS: dict[CardKind, Callable[[Session, Principal, BaseModel], str]] = {
    "demand_reply": check_demand_reply,
    "workload_request": check_workload_request,
    "extension_request": check_extension_request,
    "leave": check_leave,
    "team_workload": check_team_workload,
}
RESULTS: dict[CardKind, str] = {
    "demand": "需求已提交",
    "demand_response": "需求回应已提交",
    "demand_reply": "部门答复已发送",
    "workload_request": "负荷调整申请已提交，等待经理审批",
    "extension_request": "延期申请已提交，等待经理审批",
    "leave": "请假已登记并生效，已通知部门经理",
    "team_workload": "下属周负荷已更新并通知本人",
}


def definitions(db: Session, p: Principal) -> list[ToolDefinition]:
    if not read_settings(p, db).enabled:
        return []
    allowed = True
    try:
        demand.require_requester(p, db)
    except HTTPException:
        allowed = False
    return [
        ToolDefinition(
            name=name,
            description=TITLES[name]
            + ("；只出预览卡，用户点击确认才写入" if name in PREPARES else "")
            + (
                f"。{DEMAND_REPLY_REASON_GUIDANCE}{DEMAND_REPLY_PLAN_GUIDANCE}。"
                if name == "prepare_demand_reply"
                else ""
            ),
            parameters=(
                PREPARE_MODELS[name]
                if name in PREPARE_MODELS
                else WRITES[PREPARES[name][1]].input_model
                if name in PREPARES
                else READS[name].input_model
            ).model_json_schema(),
        )
        for name in TITLES
        if name
        not in {"prepare_leave", "prepare_team_workload", *FORECAST_PREPARE_NAMES}
        and (
            allowed
            or name
            not in {"prepare_demand", "capacity_reference", "list_capacity_departments"}
        )
        and (
            can_view_org_aggregates(p)
            or name not in {"get_demand_basis", "prepare_demand_reply"}
        )
        and (
            p.employee_id is not None
            or name not in {"prepare_workload_request", "prepare_extension_request"}
        )
    ]


def read_progress(p: Principal, db: Session, name: str, body: BaseModel) -> JsonValue:
    result = READS[name].handler(p, db, **body.model_dump())
    view = result.model_dump(mode="json")
    if isinstance(result, DemandPublic):
        row = demand.demand_row(p, db, result.id)
        if not demand.can_view_demand_internals(p, row):
            return result.requester_progress()
    elif (
        isinstance(result, DemandList)
        and isinstance(body, DemandListInput)
        and body.side == "outgoing"
    ):
        view["data"] = [item.requester_progress() for item in result.data]
    elif isinstance(result, ProjectDetail):
        for role, role_view in zip(result.roles, view["roles"], strict=True):
            if role.demand is not None:
                view.pop("description", None)
                row = demand.demand_row(p, db, role.id)
                role.demand.proposal = proposal.public(p, db, row)
                role_view["demand"] = role.demand.requester_progress()
                role_view["status_label"] = role_view["demand"]["status_label"]
    return view


@dataclass(frozen=True)
class _PreparedCard:
    title: str
    content: str
    arguments: dict[str, JsonValue]
    fields: list[s.CardField] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)
    detail_link: s.CardLink | None = None


def _prepare_checked_card(
    kind: CardKind,
    write_name: str,
    title: str,
    db: Session,
    p: Principal,
    arguments: dict[str, JsonValue],
) -> _PreparedCard:
    input_model = (
        PREPARE_MODELS[f"prepare_{kind}"]
        if f"prepare_{kind}" in PREPARE_MODELS
        else WRITES[write_name].input_model
    )
    body = input_model.model_validate(arguments)
    content = CHECKS[kind](db, p, body)
    return _PreparedCard(
        title=title,
        content=content,
        arguments=body.model_dump(mode="json"),
    )


def _prepare_demand_card(
    db: Session,
    p: Principal,
    arguments: dict[str, JsonValue],
    *,
    title: str,
    plan_reply: bool,
    direct_commit: bool,
) -> _PreparedCard:
    del plan_reply, direct_commit
    content, fields, questions, card_args, detail_link = prepare_demand_preview(
        db, p, arguments
    )
    return _PreparedCard(
        title=title,
        content=content,
        arguments=card_args,
        fields=fields,
        questions=questions,
        detail_link=detail_link,
    )


def _prepare_demand_response_card(
    db: Session,
    p: Principal,
    arguments: dict[str, JsonValue],
    *,
    title: str,
    plan_reply: bool,
    direct_commit: bool,
) -> _PreparedCard:
    del plan_reply, direct_commit
    content, fields, questions, card_args, detail_link = (
        prepare_demand_response_preview(
            db, p, arguments, WRITES["respond_demand"].input_model
        )
    )
    return _PreparedCard(
        title=title,
        content=content,
        arguments=card_args,
        fields=fields,
        questions=questions,
        detail_link=detail_link,
    )


def _prepare_demand_reply_card(
    db: Session,
    p: Principal,
    arguments: dict[str, JsonValue],
    *,
    title: str,
    plan_reply: bool,
    direct_commit: bool,
) -> _PreparedCard:
    content, fields, questions, card_args, detail_link = prepare_demand_reply_preview(
        db,
        p,
        arguments,
        WRITES["reply_demand"].input_model,
        plan_reply=plan_reply,
        direct_commit=direct_commit,
    )
    return _PreparedCard(
        title=title,
        content=content,
        arguments=card_args,
        fields=fields,
        questions=questions,
        detail_link=detail_link,
    )


def _prepare_forecast_policy_card(
    db: Session,
    p: Principal,
    arguments: dict[str, JsonValue],
    *,
    title: str,
    plan_reply: bool,
    direct_commit: bool,
) -> _PreparedCard:
    del title, plan_reply, direct_commit
    card_title, content, fields, card_args = check_forecast_policy(
        db, p, PrepareForecastPolicyInput.model_validate(arguments)
    )
    return _PreparedCard(
        title=card_title, content=content, arguments=card_args, fields=fields
    )


def _prepare_forecast_event_card(
    db: Session,
    p: Principal,
    arguments: dict[str, JsonValue],
    *,
    title: str,
    plan_reply: bool,
    direct_commit: bool,
) -> _PreparedCard:
    del title, plan_reply, direct_commit
    card_title, content, fields, card_args = check_forecast_event(
        db, p, PrepareForecastEventInput.model_validate(arguments)
    )
    return _PreparedCard(
        title=card_title, content=content, arguments=card_args, fields=fields
    )


def _make_simple_prepare(
    kind: CardKind, write_name: str, default_title: str
) -> Callable[..., _PreparedCard]:
    def _prepare(
        db: Session,
        p: Principal,
        arguments: dict[str, JsonValue],
        *,
        title: str = default_title,
        plan_reply: bool,
        direct_commit: bool,
    ) -> _PreparedCard:
        del plan_reply, direct_commit
        return _prepare_checked_card(kind, write_name, title, db, p, arguments)

    return _prepare


_PREPARE_HANDLERS: dict[str, Callable[..., _PreparedCard]] = {
    "prepare_demand": _prepare_demand_card,
    "prepare_demand_response": _prepare_demand_response_card,
    "prepare_demand_reply": _prepare_demand_reply_card,
    "prepare_forecast_policy": _prepare_forecast_policy_card,
    "prepare_forecast_event": _prepare_forecast_event_card,
    "prepare_workload_request": _make_simple_prepare(
        "workload_request", "request_workload_change", "申请调整负荷"
    ),
    "prepare_extension_request": _make_simple_prepare(
        "extension_request", "request_extension", "申请延期"
    ),
    "prepare_leave": _make_simple_prepare("leave", "register_leave", "登记请假"),
    "prepare_team_workload": _make_simple_prepare(
        "team_workload", "set_weeks", "调整下属负荷"
    ),
}


def call(
    db: Session,
    p: Principal,
    cards: list[s.Message],
    name: str,
    arguments: dict[str, JsonValue],
    *,
    plan_reply: bool = False,
    direct_commit: bool = False,
) -> JsonValue:
    try:
        require_enabled(p, db)
        if (
            name == "prepare_demand_reply"
            and not plan_reply
            and _has_proposal_arguments(arguments)
        ):
            return {"error": DEMAND_REPLY_PLAN_GUIDANCE}
        if name in READS:
            tool = READS[name]
            body = tool.input_model.model_validate(arguments)
            return read_progress(p, db, name, body)
        if name not in PREPARES:
            return {"error": tr("请使用预览工具，并点击卡片确认")}
        kind, _, title = PREPARES[name]
        prepared = _PREPARE_HANDLERS[name](
            db,
            p,
            arguments,
            title=title,
            plan_reply=plan_reply,
            direct_commit=direct_commit,
        )
        card = s.CapacityCard(
            kind=kind,
            title=tr(prepared.title),
            content=prepared.content,
            fields=prepared.fields,
            questions=prepared.questions,
            arguments=prepared.arguments,
            detail_link=prepared.detail_link,
        )
        card.actions = [
            s.CapacityAction(action=a, card_id=card.card_id)
            for a in ("confirm_capacity", "cancel_capacity")
        ]
        cards.append(card)
        return {
            "card_id": str(card.card_id),
            "preview": prepared.content,
            "status": "pending",
        }
    except ValidationError as exc:
        return {"error": validation_message(exc, tr("工具参数不正确"))}
    except demand.RejectionReasonInvalid as exc:
        detail_text = tr(exc.detail) if isinstance(exc.detail, str) else exc.detail
        return {
            "error": tr("{detail}，请用答复卡重新提交", detail=detail_text)
            if name == "prepare_demand_reply"
            else detail_text
        }
    except HTTPException as exc:
        if isinstance(exc.detail, dict):
            msg = exc.detail.get("message")
            if isinstance(msg, str):
                return {"error": {**exc.detail, "message": tr(msg)}}
            return {"error": exc.detail}
        return {"error": tr(exc.detail) if isinstance(exc.detail, str) else exc.detail}


def _default_result(result: BaseModel, title: str) -> str:
    return tr(
        "{result}{over}，编号：{id}",
        result=tr(title),
        over="",
        id=result.model_dump(mode="json")["id"],
    )


@dataclass(frozen=True)
class _CardExecutor:
    parse: Callable[[dict[str, JsonValue], bool], Any]
    execute: Callable[..., str]


def _parse_model_card(
    kind: CardKind, write_name: str
) -> Callable[[dict[str, JsonValue], bool], BaseModel]:
    def _parse(arguments: dict[str, JsonValue], plan_reply: bool) -> BaseModel:
        input_model = (
            PlanReplyDemandInput
            if plan_reply
            else LeaveInput
            if kind == "leave"
            else TeamWorkloadInput
            if kind == "team_workload"
            else WRITES[write_name].input_model
        )
        return input_model.model_validate(arguments)

    return _parse


def _make_write_executor(
    kind: CardKind,
    write_name: str,
    formatter: Callable[[BaseModel, BaseModel, str], str] | None = None,
) -> _CardExecutor:
    def _execute(
        p: Principal,
        db: Session,
        body: BaseModel,
        *,
        via: Via,
        client_name: str,
        plan_reply: bool,
        on_plan_reply: PlanReplyHandler | None,
    ) -> str:
        del plan_reply, on_plan_reply
        result = WRITES[write_name].handler(
            p, db, **body.model_dump(), via=via, client_name=client_name
        )
        title = RESULTS[kind]
        if formatter is not None:
            return formatter(body, result, title)
        return _default_result(result, title)

    return _CardExecutor(_parse_model_card(kind, write_name), _execute)


def _execute_demand_reply_card(
    p: Principal,
    db: Session,
    body: BaseModel,
    *,
    via: Via,
    client_name: str,
    plan_reply: bool,
    on_plan_reply: PlanReplyHandler | None,
) -> str:
    return execute_demand_reply(
        db,
        p,
        body,
        plan_reply=plan_reply,
        via=via,
        client_name=client_name,
        write_handler=WRITES["reply_demand"].handler,
        on_plan_reply=on_plan_reply,
        result_title=RESULTS["demand_reply"],
    )


def _execute_leave_card(
    p: Principal,
    db: Session,
    body: BaseModel,
    *,
    via: Via,
    client_name: str,
    plan_reply: bool,
    on_plan_reply: PlanReplyHandler | None,
) -> str:
    del plan_reply, on_plan_reply
    return execute_leave(
        p, db, body, via=via, client_name=client_name, result_title=RESULTS["leave"]
    )


def _execute_team_workload_card(
    p: Principal,
    db: Session,
    body: BaseModel,
    *,
    via: Via,
    client_name: str,
    plan_reply: bool,
    on_plan_reply: PlanReplyHandler | None,
) -> str:
    del plan_reply, on_plan_reply
    return execute_team_workload(
        p,
        db,
        body,
        via=via,
        client_name=client_name,
        result_title=RESULTS["team_workload"],
    )


def _execute_forecast_policy_card(
    p: Principal,
    db: Session,
    parsed: ForecastAction,
    *,
    via: Via,
    client_name: str,
    plan_reply: bool,
    on_plan_reply: PlanReplyHandler | None,
) -> str:
    del plan_reply, on_plan_reply
    return execute_forecast_policy(p, db, parsed, via=via, client_name=client_name)


def _execute_forecast_event_card(
    p: Principal,
    db: Session,
    parsed: ForecastAction,
    *,
    via: Via,
    client_name: str,
    plan_reply: bool,
    on_plan_reply: PlanReplyHandler | None,
) -> str:
    del plan_reply, on_plan_reply
    return execute_forecast_event(p, db, parsed, via=via, client_name=client_name)


_CARD_EXECUTORS: dict[CardKind, _CardExecutor] = {
    "demand": _make_write_executor("demand", "submit_demand"),
    "demand_response": _make_write_executor(
        "demand_response", "respond_demand", format_demand_response_result
    ),
    "demand_reply": _CardExecutor(
        _parse_model_card("demand_reply", "reply_demand"),
        _execute_demand_reply_card,
    ),
    "workload_request": _make_write_executor(
        "workload_request",
        "request_workload_change",
        lambda _body, result, title: format_workload_request_result(result, title),
    ),
    "extension_request": _make_write_executor("extension_request", "request_extension"),
    "leave": _CardExecutor(
        _parse_model_card("leave", "register_leave"),
        _execute_leave_card,
    ),
    "team_workload": _CardExecutor(
        _parse_model_card("team_workload", "set_weeks"),
        _execute_team_workload_card,
    ),
    "forecast_policy": _CardExecutor(
        lambda args, _plan_reply: parse_forecast_policy_arguments(args),
        _execute_forecast_policy_card,
    ),
    "forecast_event": _CardExecutor(
        lambda args, _plan_reply: parse_forecast_event_arguments(args),
        _execute_forecast_event_card,
    ),
}


def act(
    db: Session,
    p: Principal,
    session: BotSession,
    cards: list[s.Message],
    action: s.CapacityAction,
    *,
    on_plan_reply: PlanReplyHandler | None = None,
) -> s.CapacityCard:
    card = next(
        (
            c
            for c in reversed(cards)
            if isinstance(c, s.CapacityCard) and c.card_id == action.card_id
        ),
        None,
    )
    if card is None or card.status != "pending" or action not in card.actions:
        raise CapacityConflict()
    if card.kind == "demand_reply":
        latest = next(
            (
                c
                for c in reversed(cards)
                if isinstance(c, s.CapacityCard)
                and c.kind == card.kind
                and c.arguments.get("demand_id") == card.arguments.get("demand_id")
            ),
            None,
        )
        if latest is None or latest.card_id != card.card_id:
            raise CapacityConflict()
    card = card.model_copy(deep=True)
    card.actions = []
    if action.action == "cancel_capacity":
        card.status, card.result = "cancelled", tr("已取消，未提交")
        return card
    try:
        require_enabled(p, db)
        plan_reply = card.kind == "demand_reply" and bool(
            card.arguments.get("option_id")
        )
        if (
            card.kind == "demand_reply"
            and not plan_reply
            and _has_proposal_arguments(card.arguments)
        ):
            card.status, card.result = (
                "failed",
                tr("答复包含方案参数，请重新生成确认卡"),
            )
            return card
        executor = _CARD_EXECUTORS[card.kind]
        try:
            parsed = executor.parse(card.arguments, plan_reply)
        except ValidationError, KeyError, ValueError, TypeError:
            card.status, card.result = "failed", tr("申请内容已变化，请重新生成确认卡")
            return card
        with db.begin_nested():
            try:
                via: Literal["bot", "feishu"] = (
                    "feishu" if session.channel == "feishu" else "bot"
                )
                card.result = executor.execute(
                    p,
                    db,
                    parsed,
                    via=via,
                    client_name=session.channel,
                    plan_reply=plan_reply,
                    on_plan_reply=on_plan_reply,
                )
                card.status = "confirmed"
                return card
            except proposal.ProposalFailed as exc:
                raw_msg = (
                    exc.detail.get("message", exc.detail)
                    if isinstance(exc.detail, dict)
                    else exc.detail
                )
                card.status, card.result = (
                    "failed",
                    tr(raw_msg) if isinstance(raw_msg, str) else str(raw_msg),
                )
                return card
    except demand.RejectionReasonInvalid as exc:
        detail_text = tr(exc.detail) if isinstance(exc.detail, str) else exc.detail
        card.status, card.result = (
            "failed",
            tr("{detail}，请重新出卡", detail=detail_text),
        )
    except HTTPException as exc:
        raw_msg = (
            exc.detail.get("message", exc.detail)
            if isinstance(exc.detail, dict)
            else exc.detail
        )
        card.status, card.result = (
            "failed",
            tr(raw_msg) if isinstance(raw_msg, str) else str(raw_msg),
        )
    return card
