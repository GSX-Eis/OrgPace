import json
import re
from collections.abc import Callable
from dataclasses import replace
from typing import Literal, cast
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import BaseModel, Field, JsonValue, StrictBool, ValidationError
from sqlmodel import Session, col, func, select

from app.authz.principal import Principal
from app.domains.bot import attachments, project_drafts, reviews, team_workload
from app.domains.bot import schemas as s
from app.domains.bot.levels import name_levels
from app.domains.bot.models import BotSession
from app.domains.capability.proposals import suggest_capability
from app.domains.capability.schemas import SuggestCapability
from app.domains.capability.search import PeopleSearchInput, find_people
from app.domains.capability.service import get_schema, list_capabilities
from app.domains.capacity import assistant as capacity
from app.domains.capacity import demand as capacity_demand
from app.domains.capacity import forecast as capacity_forecast
from app.domains.capacity import proposal as capacity_proposal
from app.domains.capacity.demand_schemas import (
    DemandPublic,
    PlanReplyDemandInput,
    ProjectInput,
    ProposalLineInput,
)
from app.domains.capacity.schemas import (
    CapacityInput,
    LeaveInput,
    TeamWorkloadInput,
    Via,
)
from app.domains.capacity.settings import read_settings as read_capacity_settings
from app.domains.change_request import employee
from app.domains.change_request.models import RequestStatus
from app.domains.change_request.schemas import (
    ItemInput,
    RequestPreview,
    ToolInput,
    validation_message,
)
from app.domains.drafting.settings import read_auto_draft
from app.domains.employee_tools import EMPLOYEE_TOOLS, DraftRequestInput
from app.domains.evidence.models import Evidence
from app.domains.model.client import ModelUnavailable
from app.domains.model.pi_client import ToolDefinition
from app.domains.org.models import Department, Employee, EmploymentStatus
from app.domains.planning import service as planning_service
from app.domains.planning.models import (
    OptionKind,
    PlanningOption,
    PlanningSnapshot,
    PlanVerdict,
)
from app.domains.planning.schemas import VERDICT_LABELS, CasePublic, OptionPublic
from app.domains.planning.tools import BOT_FEASIBILITY_TOOL, COORDINATION_TOOLS
from app.domains.planning.tools import Result as CoordinationResult
from app.domains.profile.service import read_profile
from app.domains.review import direct
from app.i18n import tr

TOOLS = {t.name: t for t in EMPLOYEE_TOOLS if t.bot_allowed}
COORDINATION = {t.name: t for t in (*COORDINATION_TOOLS, BOT_FEASIBILITY_TOOL)}
PROJECT_READS = {
    name: capacity.READS[name] for name in ("list_projects", "get_project")
}
TITLES = {t.name: t.description for t in TOOLS.values()} | {
    "read_attachment": "读取会话附件",
    "suggest_capability": "建议新增能力",
    "list_team_members": "查看团队成员",
    "find_people": "按能力找人",
    "get_member_profile": "查看下属画像",
    "prepare_profile_edit": "预览直接修改画像",
    "list_pending_reviews": "查看待审批请求",
    "get_review": "查看审批详情",
    "prepare_review_decision": "审批决定",
}
COORDINATION_TITLES = {
    "coordination": "调查并模拟部门协调方案",
    "prepare_plan_proposal": "预览部门方案答复",
}
PROJECTIONS: dict[str, type[s.Projection]] = {
    "get_my_profile": s.Profile,
    "list_my_evidence": s.EvidenceList,
    "get_my_requests": s.Requests,
    "get_capability_dictionary": s.Dictionary,
    "draft_update_request": s.Request,
    "preview_request": s.Preview,
    "get_pending_questions": s.Questions,
    "answer_question": s.Question,
}


class TeamListInput(ToolInput):
    q: str | None = Field(default=None, max_length=100)
    department_id: UUID | None = None
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=100, ge=1, le=100)


class MemberInput(ToolInput):
    employee_id: UUID


class ProfileEditInput(direct.DirectEditInput):
    employee_id: UUID


class CoordinationInput(BaseModel):
    function: Literal[
        "assess_cross_department_feasibility",
        "read_coordination_context",
        "inspect_capacity",
        "search_qualified_candidates",
        "simulate_plan",
        "compare_plan_options",
        "get_approval_status",
        "prepare_project_draft",
        "get_named_workload",
        "prepare_leave",
        "prepare_team_workload",
        "list_projects",
        "get_project",
        "get_forecast_config",
        "prepare_forecast_policy",
        "prepare_forecast_event",
    ]
    arguments: dict[str, JsonValue]


FORECAST_COORDINATION_FUNCTIONS = frozenset(
    {
        "get_forecast_config",
        "prepare_forecast_policy",
        "prepare_forecast_event",
    }
)


class PreparePlanProposalInput(BaseModel):
    case_id: UUID
    option_id: UUID
    text: str = Field(min_length=1, max_length=2000)
    outside_basis: StrictBool = False
    lender_department_id: UUID | None = None
    borrow_headcount: int | None = Field(default=None, strict=True, ge=1)


BOT_COORDINATION_FUNCTIONS = {
    "prepare_project_draft": {
        "description": "只生成项目草稿。先查能力词典和可选部门；用户须在网页点击确认才创建项目。",
        "parameters": project_drafts.input_schema(),
    },
    "get_named_workload": {
        "description": "按完整姓名查询管辖内员工的周负荷，部门可选；普通员工仅可查自己。不需要需求编号。",
        "parameters": team_workload.NamedWorkloadQuery.model_json_schema(),
    },
    "prepare_leave": {
        "description": "请假（登记不可用日期），直接生效并通知部门经理（通知仅含日期，不收集请假说明）；仅生成确认卡，用户点击确认才写入。",
        "parameters": LeaveInput.model_json_schema(),
    },
    "prepare_team_workload": {
        "description": "预览调整管辖下属指定周范围的平台外工作占比（0–200%，周一开始，最多26周）；先用 list_team_members 或 get_named_workload 确认员工与周次，仅生成确认卡，经理点击确认后才生效并通知员工。",
        "parameters": TeamWorkloadInput.model_json_schema(),
    },
    "get_forecast_config": {
        "description": "查看系统默认周延续系数、推荐参考值、当前有权查看的预测策略、近期与未来业务波动事件、可选部门与岗位序列（仅管理员和部门经理可用）。",
        "parameters": CapacityInput.model_json_schema(),
    },
    "prepare_forecast_policy": {
        "description": "配置或删除部门/岗位的周延续系数预测策略（retention_rate 取值 0.0–1.0：0 脉冲波次型、0.5 常规均衡型、0.8 项目延续型）。只生成确认卡，点击确认后才落库并重算 26 周预测基线，不覆盖已确认排期与经理单周修正。",
        "parameters": capacity.PrepareForecastPolicyInput.model_json_schema(),
    },
    "prepare_forecast_event": {
        "description": "注入、修改或删除阶段性业务波动事件（周一开始 1–26 周，支持 multiplier 系数或 delta 百分点）。只生成确认卡，点击确认后才落库并重算 26 周预测基线。",
        "parameters": capacity.PrepareForecastEventInput.model_json_schema(),
    },
    **{
        name: {
            "description": tool.description,
            "parameters": tool.input_model.model_json_schema(),
        }
        for name, tool in PROJECT_READS.items()
    },
}


def confirm_plan_reply(
    p: Principal, db: Session, body: PlanReplyDemandInput, *, via: Via, client_name: str
) -> DemandPublic:
    """Compose Planning reads and Capacity writes only after a human clicks."""
    row = capacity_demand.demand_row(p, db, body.demand_id, lock=True)
    if not capacity_demand.represents_department(p, row.target_department_id):
        raise planning_service.PlanningStale()
    if body.outcome == "not_now":
        raise capacity_proposal.ProposalConflict("暂不能承接的答复不能带方案")
    found = db.exec(
        select(PlanningOption, PlanningSnapshot.case_id)
        .join(
            PlanningSnapshot,
            (col(PlanningSnapshot.org_id) == PlanningOption.org_id)
            & (col(PlanningSnapshot.id) == PlanningOption.snapshot_id),
        )
        .where(PlanningOption.org_id == p.org_id, PlanningOption.id == body.option_id)
    ).one_or_none()
    if found is None:
        raise planning_service.PlanningStale()
    saved, case_id = found
    _, snapshot, case_demand = planning_service.authorized_case(p, db, case_id)
    if case_demand.id != row.id or saved.snapshot_id != snapshot.id:
        raise planning_service.PlanningStale()
    if saved.verdict not in (PlanVerdict.FEASIBLE, PlanVerdict.CONDITIONAL):
        raise capacity_proposal.ProposalConflict("只有可行或有条件可行的方案可以提议")
    lines = capacity_proposal.plan_lines(
        p, db, row, body, saved.params, borrow=saved.kind == OptionKind.BORROW
    )
    current = planning_service.get_case(p, db, case_id)
    if current.stale or current.snapshot_id != saved.snapshot_id:
        raise planning_service.PlanningStale()
    direct = capacity_proposal.is_direct_commit(
        row, lines, is_borrow=saved.kind == OptionKind.BORROW
    )
    capacity_demand.reply_demand(
        p,
        db,
        **body.model_dump(
            exclude={
                "option_id",
                "outside_basis",
                "start_date",
                "end_date",
                "lender_department_id",
                "borrow_headcount",
            }
        ),
        start_date=min(line.start_date for line in lines),
        end_date=max(line.end_date for line in lines),
        via=via,
        client_name=client_name,
        allow_legacy_reply=True,
        notify_requester=not direct,
    )
    assert body.option_id is not None
    capacity_proposal.create(
        p, db, row, body.option_id, lines, direct_commit=direct, via=via
    )
    return capacity_demand.get_demand(p, db, row.id)


TEAM_INPUTS: dict[str, type[BaseModel]] = {
    "find_people": PeopleSearchInput,
    "list_team_members": TeamListInput,
    "get_member_profile": MemberInput,
    "prepare_profile_edit": ProfileEditInput,
}


class TeamMemberNotFound(HTTPException):
    def __init__(self) -> None:
        super().__init__(404, "找不到该员工")


def team_member(db: Session, p: Principal, employee_id: UUID) -> Employee:
    subject = db.exec(
        select(Employee).where(
            Employee.org_id == p.org_id,
            Employee.id == employee_id,
            col(Employee.department_id).in_(p.managed_department_ids),
            Employee.employment_status == EmploymentStatus.ACTIVE,
        )
    ).first()
    if subject is None:
        raise TeamMemberNotFound()
    return subject


def team_call(
    db: Session,
    p: Principal,
    cards: list[s.Message],
    name: str,
    arguments: dict[str, JsonValue],
    *,
    on_read: Callable[[set[str]], None] | None = None,
) -> JsonValue:
    if not p.managed_department_ids:
        return {"error": "不允许调用此工具"}
    p = replace(p, is_org_admin=False)
    try:
        body = TEAM_INPUTS[name].model_validate(arguments)
    except ValidationError as exc:
        return {"error": validation_message(exc, "工具参数不正确")}
    if isinstance(body, PeopleSearchInput):
        result = find_people(db, p, body).model_dump(mode="json")
        if on_read:
            on_read({row["employee_id"] for row in result["data"]})
        for row in result["data"]:
            row["profile_url"] = f"/employees/{row['employee_id']}"
        return result
    if isinstance(body, TeamListInput):
        query = (
            select(Employee, Department)
            .join(
                Department,
                (col(Department.org_id) == Employee.org_id)
                & (col(Department.id) == Employee.department_id),
            )
            .where(
                Employee.org_id == p.org_id,
                col(Employee.department_id).in_(p.managed_department_ids),
                Employee.employment_status == EmploymentStatus.ACTIVE,
            )
        )
        if body.q:
            query = query.where(
                col(Employee.display_name).icontains(body.q, autoescape=True)
            )
        if body.department_id:
            query = query.where(Employee.department_id == body.department_id)
        total = db.exec(select(func.count()).select_from(query.subquery())).one()
        rows = (
            db.exec(
                query.order_by(col(Employee.id)).offset(body.offset).limit(body.limit)
            ).all()
            if body.offset < total
            else []
        )
        next_offset = body.offset + len(rows)
        has_more = next_offset < total
        if on_read:
            on_read({str(e.id) for e, _ in rows})
        return {
            "data": [
                {
                    "employee_id": str(e.id),
                    "name": e.display_name,
                    "department": d.name,
                    "title": e.title,
                }
                for e, d in rows
            ],
            "total": total,
            "offset": body.offset,
            "limit": body.limit,
            "has_more": has_more,
            "truncated": has_more,
            "next_offset": next_offset if has_more else None,
        }
    assert isinstance(body, (MemberInput, ProfileEditInput))
    subject = team_member(db, p, body.employee_id)
    if on_read:
        on_read({str(subject.id)})
    if isinstance(body, ProfileEditInput):
        edit = direct.DirectEditInput(
            items=body.items, base_revision=body.base_revision
        )
        preview = direct.preview_direct_edit(p, db, subject.id, edit)
        card = s.ProfileEditCard(
            **preview.model_dump(),
            employee_id=subject.id,
            employee_name=subject.display_name,
            edit=edit,
        )
        card.actions = [
            s.ProfileEditAction(action=a, card_id=card.card_id)
            for a in ("confirm_profile_edit", "continue_profile_edit")
        ]
        card = name_levels(db, p, card)
        cards.append(card)
        return {
            "card_id": str(card.card_id),
            "items": [i.model_dump(mode="json") for i in card.items],
            "revision": card.revision,
        }
    profile = read_profile(db, p, subject.id)
    projected = name_levels(db, p, s.Profile.model_validate(profile))
    return {
        "employee_id": str(subject.id),
        "revision": profile.latest_published.revision
        if profile.latest_published
        else None,
        "items": [item.model_dump(mode="json") for item in projected.items],
    }


def _coordination_schema(can_manage_forecast: bool) -> dict[str, JsonValue]:
    schema = cast("dict[str, JsonValue]", CoordinationInput.model_json_schema())
    if can_manage_forecast:
        return schema
    props = schema.get("properties")
    if isinstance(props, dict) and isinstance(fn := props.get("function"), dict):
        enum_values = fn.get("enum")
        if isinstance(enum_values, list):
            fn["enum"] = [
                name
                for name in enum_values
                if name not in FORECAST_COORDINATION_FUNCTIONS
            ]
    return schema


def definitions(
    p: Principal | None = None, *, db: Session | None = None, channel: str = "web"
) -> list[ToolDefinition]:
    coordination_enabled = bool(
        db is not None
        and p
        and channel in ("web", "feishu")
        and read_capacity_settings(p, db).enabled
    )
    can_manage_forecast = bool(p and (p.is_org_admin or p.managed_department_ids))
    bot_coord_functions = {
        k: v
        for k, v in BOT_COORDINATION_FUNCTIONS.items()
        if can_manage_forecast or k not in FORECAST_COORDINATION_FUNCTIONS
    }
    team = (
        [
            ToolDefinition(
                name=name,
                description=TITLES[name]
                + "；仅限管辖部门。"
                + (
                    "只校验，不写入；必须点击确认修改才发布并通知员工。"
                    if name == "prepare_profile_edit"
                    else ""
                )
                + (
                    "has_more 或 truncated 为 true 时仅返回部分名单，不可当作全员；"
                    "保留原筛选条件，用 offset=next_offset 继续翻页。"
                    if name == "list_team_members"
                    else ""
                ),
                parameters=model.model_json_schema(),
            )
            for name, model in TEAM_INPUTS.items()
        ]
        if p and p.managed_department_ids
        else []
    )
    return (
        (
            [
                tool
                for tool in capacity.definitions(db, p)
                if tool.name not in PROJECT_READS
                and (
                    not coordination_enabled
                    or tool.name not in {"get_demand", "get_demand_basis"}
                )
            ]
            if db is not None and p and channel in ("web", "feishu")
            else []
        )
        + team
        + (
            [
                ToolDefinition(
                    name="coordination",
                    description=(
                        "按当前用户权限调查、模拟和比较部门方案；方案不是承诺。"
                        "simulate_plan 首次模拟只传 demand_id，生成快照和候选方案；"
                        "已有首次模拟后，传 demand_id 和 assignees 校验自定方案。"
                        "项目草稿、项目查询、姓名查负荷及预测配置与事件管理的 function 及 arguments JSON Schema：\n"
                        + json.dumps(bot_coord_functions, ensure_ascii=False)
                        + "\n"
                        "各 function 的说明及 arguments JSON Schema 如下（required 为必填字段）：\n"
                        + json.dumps(
                            {
                                tool.name: {
                                    "description": tool.description,
                                    "parameters": tool.input_model.model_json_schema(),
                                }
                                for tool in COORDINATION.values()
                            },
                            ensure_ascii=False,
                        )
                    ),
                    parameters=_coordination_schema(can_manage_forecast),
                )
            ]
            if coordination_enabled
            else []
        )
        + (
            [
                ToolDefinition(
                    name="prepare_plan_proposal",
                    description=(
                        "只为目标部门经理生成内部方案确认卡。"
                        "窗内排期经经理确认直接生效，超窗排期预占 72 小时等待需求方确认。"
                        "说明与系统追加的完整方案条件合计最多 2000 字；"
                        "超限时按工具提示缩短说明后重新预览，不删减方案条件。"
                    ),
                    parameters=PreparePlanProposalInput.model_json_schema(),
                )
            ]
            if coordination_enabled
            and p
            and (p.is_org_admin or p.managed_department_ids)
            else []
        )
        + [
            attachments.READ_TOOL,
            ToolDefinition(
                name="suggest_capability",
                description=TITLES["suggest_capability"]
                + "；先复述名称和说明，员工明确同意后才调用；只建议，不改画像或词典。",
                parameters=SuggestCapability.model_json_schema(),
            ),
        ]
        + reviews.definitions()
        + [
            ToolDefinition(
                name=t.name,
                description=t.description,
                parameters=t.input_model.model_json_schema(),
            )
            for t in TOOLS.values()
        ]
    )


def redact_text(value: str) -> str:
    return re.sub(
        r"https?://[^\s<>]+|[\w.+-]+@[\w.-]+", "[已隐藏]", value, flags=re.IGNORECASE
    )


def redact(value: JsonValue) -> JsonValue:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    return value


VERDICT_ORDER = {
    "feasible": 0,
    "conditional": 1,
    "insufficient_data": 2,
    "infeasible": 3,
}


def plan_metrics(option: OptionPublic) -> list[s.CardField]:
    summary = option.summary
    return [
        s.CardField(label=tr("类型"), value=tr(option.kind_label)),
        s.CardField(label=tr("结论"), value=tr(option.verdict_label)),
        s.CardField(
            label=tr("交付日期"), value=str(summary.get("finish_date") or tr("未定"))
        ),
        s.CardField(
            label=tr("覆盖人数"),
            value=tr("{count} 人", count=summary.get("covered_headcount", 0)),
        ),
        s.CardField(
            label=tr("缺口"),
            value=tr("{count} 人周", count=summary.get("gap_person_weeks", 0)),
        ),
        s.CardField(
            label=tr("新人数"),
            value=tr("{count} 人", count=summary.get("newcomer_count", 0)),
        ),
    ]


def plan_card(option: OptionPublic, case: CasePublic) -> s.PlanCard:
    names = {str(person.employee_id): person.display_name for person in case.people}
    assignees = cast("list[dict[str, JsonValue]]", option.params.get("assignees", []))
    summary = option.summary
    affected = cast("list[str]", summary.get("affected_assignment_ids", []))
    findings = option.findings
    people = tr("、").join(
        names.get(str(person.get("employee_id")), tr("待确认人员"))
        for person in assignees
    ) or tr("尚未确定具体人员")
    risks = tr("；").join(tr(str(item.get("message", ""))) for item in findings) or tr(
        "暂无已发现风险"
    )
    approvers = cast("list[str]", summary.get("approvers", []))
    metrics = plan_metrics(option)
    fields = [
        *metrics[:5],
        s.CardField(label=tr("人员"), value=people),
        s.CardField(
            label=tr("受影响的工作数"), value=tr("{count} 项", count=len(affected))
        ),
        s.CardField(label=tr("风险"), value=risks),
        s.CardField(label=tr("审批人"), value=tr("、").join(approvers) or tr("未定")),
    ]
    if summary.get("uses_elastic"):
        fields.append(
            s.CardField(
                label=tr("弹性配额占用"),
                value=tr(
                    "已占用弹性配额 {percent}%",
                    percent=summary.get("elastic_used_percent", 0),
                ),
            )
        )
    changes = None
    if isinstance(summary.get("diff"), dict):
        diff = cast("dict[str, dict[str, JsonValue]]", summary["diff"])
        parts = [str(summary.get("changes") or tr("已修改方案"))]
        for key, label in (
            ("verdict", "结论"),
            ("finish_date", "交付日期"),
            ("covered_headcount", "覆盖人数"),
            ("gap_person_weeks", "缺口"),
        ):
            values = diff.get(key)
            if isinstance(values, dict) and values.get("before") != values.get("after"):
                before, after = values.get("before"), values.get("after")
                if key == "verdict":
                    before = tr(
                        next(
                            (
                                verdict_label
                                for verdict, verdict_label in VERDICT_LABELS.items()
                                if verdict.value == before
                            ),
                            str(before),
                        )
                    )
                    after = tr(
                        next(
                            (
                                verdict_label
                                for verdict, verdict_label in VERDICT_LABELS.items()
                                if verdict.value == after
                            ),
                            str(after),
                        )
                    )
                if key == "covered_headcount":
                    before_text = (
                        tr("未定") if before is None else tr("{value} 人", value=before)
                    )
                    after_text = (
                        tr("未定") if after is None else tr("{value} 人", value=after)
                    )
                elif key == "gap_person_weeks":
                    before_text = (
                        tr("未定")
                        if before is None
                        else tr("{value} 人周", value=before)
                    )
                    after_text = (
                        tr("未定") if after is None else tr("{value} 人周", value=after)
                    )
                else:
                    before_text = tr("未定") if before is None else str(before)
                    after_text = tr("未定") if after is None else str(after)
                parts.append(
                    tr(
                        "{label}：{before} → {after}",
                        label=tr(label),
                        before=before_text,
                        after=after_text,
                    )
                )
        changes = tr("；").join(parts)
    base_link = f"/capacity?tab=incoming&demand={case.demand_id}&plans=1"
    link = f"{base_link}#case={case.id}&option={option.id}"
    best = min(
        (
            o
            for o in case.options
            if o.kind not in {OptionKind.CUSTOM, OptionKind.OPTIMIZED}
            and o.snapshot_id == option.snapshot_id
        ),
        key=lambda o: VERDICT_ORDER[o.verdict],
        default=None,
    )
    fallback = None
    if best is not None and VERDICT_ORDER[option.verdict] > VERDICT_ORDER[best.verdict]:
        rule_metrics = plan_metrics(best)
        fields.insert(5, metrics[-1])
        fallback = s.RulePlanFallback(
            fields=rule_metrics,
            differences=[
                s.CardField(label=a.label, value=f"{a.value} → {b.value}")
                for a, b in zip(metrics, rule_metrics, strict=True)
            ],
            link=f"{base_link}#case={case.id}&option={best.id}",
        )
    return s.PlanCard(
        title=(
            tr(option.kind_label)
            if option.kind == OptionKind.OPTIMIZED
            else tr("{kind}方案", kind=tr(option.kind_label))
        ),
        fields=fields,
        changes=changes,
        link=link,
        rule_fallback=fallback,
    )


def preview_card(
    db: Session,
    p: Principal,
    request_id: UUID,
    preview_data: RequestPreview | None = None,
) -> s.PreviewCard:
    if preview_data is None:
        preview_data = employee.preview(p, db, request_id)
    preview = name_levels(db, p, s.Preview.model_validate(preview_data))
    preview_id = (
        uuid4()
        if any(
            item.submission_notice == employee.IMMEDIATE_RETRACTION_NOTICE
            for item in preview.items
        )
        else None
    )
    return s.PreviewCard(
        **preview.model_dump(),
        actions=[
            s.RequestAction(
                action=a,
                request_id=preview.request_id,
                revision=preview.revision,
                base_revision=preview.base_revision,
                policy_version=preview.policy_version
                if a == "confirm_submit"
                else None,
                preview_id=preview_id if a == "confirm_submit" else None,
            )
            for a in ("confirm_submit", "continue_editing")
        ],
    )


def status_card(request: s.Request) -> s.StatusCard:
    return s.StatusCard(
        **request.model_dump(),
        actions=[
            s.RequestAction(
                action="withdraw", request_id=request.id, revision=request.revision
            )
        ]
        if request.status == "pending_review"
        else [],
    )


def question_card(question: s.Question) -> s.QuestionCard:
    return s.QuestionCard(
        **question.model_dump(),
        actions=["answer_question"] if question.status == "open" else [],
    )


def request_card(cards: list[s.Message], card: s.PreviewCard | s.StatusCard) -> None:
    request_id = card.request_id if isinstance(card, s.PreviewCard) else card.id
    cards[:] = [
        existing
        for existing in cards
        if not (
            isinstance(existing, s.PreviewCard)
            and existing.request_id == request_id
            or isinstance(existing, s.StatusCard)
            and existing.id == request_id
        )
    ]
    cards.append(card)


def pending_overlap(
    db: Session,
    p: Principal,
    session: BotSession,
    cards: list[s.Message],
    items: list[ItemInput],
) -> tuple[list[ItemInput], dict[str, JsonValue]]:
    keys = {item.capability_key for item in items}
    blocked: set[str] = set()
    overlaps: list[JsonValue] = []
    for request in employee.my_requests(p, db).data:
        if request.status != RequestStatus.PENDING_REVIEW:
            continue
        matching = [
            i for i in request.items if i.decision is None and i.capability.key in keys
        ]
        if not matching:
            continue
        blocked.update(i.capability.key for i in matching)
        # Withdrawal retracts these reports; resubmission recreates them from the statements.
        reports = set(
            db.exec(
                select(Evidence.id).where(
                    Evidence.org_id == p.org_id,
                    Evidence.subject_employee_id == p.employee_id,
                    col(Evidence.provenance)["request_id"].astext == str(request.id),
                )
            ).all()
        )
        overlaps.append(
            {
                "request_id": str(request.id),
                "capabilities": [i.capability.name for i in matching],
                "submitted_at": request.submitted_at.astimezone(
                    ZoneInfo("Asia/Shanghai")
                ).isoformat()
                if request.submitted_at
                else None,
                "reviewers": [r.model_dump(mode="json") for r in request.reviewers],
                "original_items": [
                    ItemInput(
                        op=i.op,
                        capability_key=i.capability.key,
                        statement=i.after.statement if i.after else "撤回或补充依据",
                        level=i.after.level if i.after else None,
                        owner_statement=i.owner_statement,
                        objection=i.objection,
                        uncertainty=i.uncertainty,
                        evidence_ids=[
                            e.evidence_id
                            for e in i.evidence
                            if e.evidence_id not in reports
                        ],
                    ).model_dump(mode="json")
                    for i in request.items
                    if i.decision is None
                ],
            }
        )
        if request.id not in session.request_ids:
            session.request_ids = [*session.request_ids, request.id]
            db.add(session)
        request_card(
            cards, status_card(name_levels(db, p, s.Request.model_validate(request)))
        )
    notice: dict[str, JsonValue] = {}
    if overlaps:
        notice = {
            "overlaps": overlaps,
            "message": "重叠能力已有待审请求，本次没有为这些能力保存草稿或生成预览。"
            "请说明下面各能力的提交时间（北京时间）和正在等谁审批，并让员工选择："
            "等原请求审完再补充；或者点击撤回卡，撤回原请求后合并重提。"
            "员工明确选择合并重提时，先请其点击撤回卡；确认撤回成功后，"
            "将 original_items 中原请求的全部待审内容与本次补充合并，"
            "复用 draft_update_request 的 items 参数新建草稿，保留原有等级和依据说明，"
            "再请员工核对预览并点击确认提交。其他不重叠的能力照常保存。",
        }
    return [item for item in items if item.capability_key not in blocked], notice


def _filter_unchanged_items(
    db: Session, p: Principal, items: list[ItemInput]
) -> tuple[list[ItemInput], list[str]]:
    current = {
        i.capability.key: i.claim for i in employee.my_profile(p, db).items if i.claim
    }
    kept: list[ItemInput] = []
    skipped: list[str] = []
    for item in items:
        if employee.is_unchanged_item(item, current.get(item.capability_key)):
            skipped.append(item.capability_key)
        else:
            kept.append(item)
    return kept, skipped


def checked_preview_card(
    db: Session,
    p: Principal,
    session: BotSession,
    cards: list[s.Message],
    request_id: UUID,
) -> dict[str, JsonValue]:
    request = next(
        r for r in employee.my_requests(p, db, "all").data if r.id == request_id
    )
    if request.status in ("draft", "pending_owner"):
        remaining, notice = pending_overlap(
            db,
            p,
            session,
            cards,
            [
                ItemInput(
                    op=i.op,
                    capability_key=i.capability.key,
                    statement=i.after.statement if i.after else "撤回或补充依据",
                )
                for i in request.items
            ],
        )
        if notice:
            keys = {i.capability_key for i in remaining}
            names = "、".join(
                i.capability.name for i in request.items if i.capability.key not in keys
            )
            request_card(
                cards,
                status_card(name_levels(db, p, s.Request.model_validate(request))),
            )
            return {
                "request_id": str(request_id),
                "message": f"这份旧草稿的{names}已有待审请求，暂不提供确认提交预览。"
                "可以等审完再处理，或者在画像页删除这份草稿。",
            }
        preview_data = employee.preview(p, db, request_id)
        if not preview_data.items:
            return {
                "request_id": str(request_id),
                "message": "该草稿当前没有实际改动项，暂不生成预览卡。",
            }
        request_card(cards, preview_card(db, p, request_id, preview_data))
    else:
        request_card(
            cards, status_card(name_levels(db, p, s.Request.model_validate(request)))
        )
    return {}


def _set_feasibility_card(
    db: Session, p: Principal, cards: list[s.Message], data: dict[str, JsonValue]
) -> None:
    key = str(data["capability_key"])
    departments = [
        s.FeasibilityDepartmentItem.model_validate(row)
        for row in cast("list[dict[str, JsonValue]]", data["departments"])
        if not (
            row["conclusion"] == "cannot_do"
            and row["load_level"] == "unknown"
            and row["department_load_percent"] is None
            and row["earliest_start_date"] is None
        )
    ]
    index = next(
        (
            i
            for i, card in enumerate(cards)
            if isinstance(card, s.FeasibilityCard) and card.capability_key == key
        ),
        len(cards),
    )
    if not departments:
        del cards[index : index + 1]
        return
    schema = get_schema(db, p.org_id)
    name = next(
        (c.name for c in list_capabilities(db, p.org_id, schema.id) if c.key == key),
        key,
    )
    cards[index : index + 1] = [
        s.FeasibilityCard.model_validate(
            {**data, "capability_name": redact_text(name), "departments": departments}
        )
    ]


def call(
    db: Session,
    p: Principal,
    session: BotSession,
    cards: list[s.Message],
    name: str,
    arguments: dict[str, JsonValue],
    *,
    on_read: Callable[[set[str]], None] | None = None,
    drafted_ids: list[UUID] | None = None,
    decided_review_ids: list[UUID] | None = None,
    turn_text: str | None = None,
    refreshed_forecast: list[bool] | None = None,
) -> JsonValue:
    if name in {"coordination", "prepare_plan_proposal"}:
        if session.channel not in ("web", "feishu"):
            return {"error": "不允许调用此工具"}
        if not read_capacity_settings(p, db).enabled:
            return {
                "error": team_workload.DISABLED
                if name == "coordination"
                and arguments.get("function") == "get_named_workload"
                else "不允许调用此工具"
            }
        try:
            if name == "coordination":
                coord_request = CoordinationInput.model_validate(arguments)
                if coord_request.function == "get_named_workload":
                    query = team_workload.NamedWorkloadQuery.model_validate(
                        coord_request.arguments
                    )
                    return redact(team_workload.read(db, p, query, on_read))
                if coord_request.function == "prepare_project_draft":
                    project_input = ProjectInput.model_validate(coord_request.arguments)
                    project_drafts.prepare(db, p, session, cards, project_input)
                    return {"message": "项目草稿已生成，请在网页核对并点击确认创建项目"}
                if coord_request.function == "prepare_leave":
                    return redact(
                        capacity.call(
                            db,
                            p,
                            cards,
                            "prepare_leave",
                            coord_request.arguments,
                        )
                    )
                if coord_request.function == "prepare_team_workload":
                    result_data = redact(
                        capacity.call(
                            db,
                            p,
                            cards,
                            "prepare_team_workload",
                            coord_request.arguments,
                        )
                    )
                    if (
                        on_read
                        and isinstance(result_data, dict)
                        and "error" not in result_data
                        and isinstance(
                            emp_id := coord_request.arguments.get("employee_id"), str
                        )
                    ):
                        on_read({emp_id})
                    return result_data
                if coord_request.function in PROJECT_READS:
                    return redact(
                        capacity.call(
                            db,
                            p,
                            cards,
                            coord_request.function,
                            coord_request.arguments,
                        )
                    )
                if coord_request.function in FORECAST_COORDINATION_FUNCTIONS:
                    if not (p.is_org_admin or p.managed_department_ids):
                        return {"error": "不允许调用此工具"}
                    if coord_request.function == "get_forecast_config":
                        CapacityInput.model_validate(coord_request.arguments)
                        result_data = redact(
                            capacity.get_forecast_config_for_bot(p, db)
                        )
                        if on_read:
                            on_read(set())
                        return result_data
                    result_data = redact(
                        capacity.call(
                            db,
                            p,
                            cards,
                            coord_request.function,
                            coord_request.arguments,
                        )
                    )
                    if on_read:
                        on_read(set())
                    return result_data
                coord_tool = COORDINATION[coord_request.function]
                input_body = coord_tool.input_model.model_validate(
                    coord_request.arguments
                )
                should_refresh_forecast = (
                    coord_request.function == "assess_cross_department_feasibility"
                    and not (refreshed_forecast and refreshed_forecast[0])
                )
                with db.begin_nested():
                    if should_refresh_forecast:
                        capacity_forecast.refresh_org_forecasts(db, p.org_id)
                    result = coord_tool.handler(p, db, input_body)
                if should_refresh_forecast and refreshed_forecast is not None:
                    refreshed_forecast[:] = [True]
                read_ids = (
                    result._read_employee_ids
                    if isinstance(result, CoordinationResult) and result._reads_complete
                    else None
                )
                if on_read and read_ids is not None:
                    on_read(read_ids)
                data = result.model_dump(mode="json")
                if (
                    coord_request.function in {"simulate_plan", "compare_plan_options"}
                    and "error" not in data
                ):
                    case = planning_service.get_case(p, db, UUID(data["case_id"]))
                    if on_read and read_ids is not None:
                        on_read({str(person.employee_id) for person in case.people})
                    row = capacity_demand.demand_row(p, db, case.demand_id)
                    if not capacity_demand.represents_department(
                        p, row.target_department_id
                    ):
                        return {"error": "无权查看方案"}
                    selected = [
                        UUID(item["id"])
                        for item in data.get("options", [data.get("option")])
                        if item
                    ]
                    new_cards = [
                        plan_card(option, case)
                        for option in case.options
                        if option.id in selected
                    ]
                    cards.extend(new_cards)
                public_data = redact(data)
                if (
                    coord_request.function == "assess_cross_department_feasibility"
                    and isinstance(public_data, dict)
                    and "error" not in public_data
                ):
                    _set_feasibility_card(db, p, cards, public_data)
                return public_data
            proposal = PreparePlanProposalInput.model_validate(arguments)
            case = planning_service.get_case(p, db, proposal.case_id)
            if on_read:
                on_read({str(person.employee_id) for person in case.people})
            row = capacity_demand.demand_row(p, db, case.demand_id)
            if not capacity_demand.represents_department(p, row.target_department_id):
                return {"error": "无权查看方案"}
            option = next((o for o in case.options if o.id == proposal.option_id), None)
            if option is None or case.stale:
                return {"error": "方案已变化，请重新模拟"}
            if any(
                person.display_name and person.display_name in proposal.text
                for person in case.people
            ):
                return {"error": "答复只写部门层面的结论，不写人名"}
            assignees = cast("list[dict[str, str]]", option.params.get("assignees", []))
            start_date = min((a["start_date"] for a in assignees), default=None)
            end_date = max((a["end_date"] for a in assignees), default=None)
            outcome = {
                "feasible": "can_do",
                "conditional": "partial",
                "infeasible": "not_now",
                "insufficient_data": "not_now",
            }[option.verdict]
            conditions = cast("list[str]", option.summary.get("conditions", []))
            condition_text = "\n条件：" + ("；".join(conditions) or "无")
            text = proposal.text + condition_text
            if len(text) > 2000:
                return {
                    "error": (
                        "说明与完整方案条件合计不能超过 2000 字，"
                        f"本次说明最多可写 {2000 - len(condition_text)} 字，"
                        f"当前超出 {len(text) - 2000} 字。"
                        "请缩短说明后重新预览，保留全部方案条件。"
                    )
                }
            is_borrow = option.kind == OptionKind.BORROW
            if not is_borrow and (
                proposal.lender_department_id is not None
                or proposal.borrow_headcount is not None
            ):
                return {"error": "只有借调方案可以指定借出部门和人数"}
            if is_borrow:
                start_date, end_date = (
                    row.window_start.isoformat(),
                    row.window_end.isoformat(),
                )
            has_plan = outcome != "not_now"
            reply_body = PlanReplyDemandInput.model_validate(
                {
                    "demand_id": str(row.id),
                    "revision": row.revision,
                    "outcome": outcome,
                    "start_date": start_date,
                    "end_date": end_date,
                    "text": text,
                    "option_id": option.id if has_plan else None,
                    "outside_basis": proposal.outside_basis,
                    "lender_department_id": proposal.lender_department_id,
                    "borrow_headcount": proposal.borrow_headcount,
                }
            )
            if is_borrow and has_plan:
                capacity_proposal.plan_lines(
                    p, db, row, reply_body, option.params, borrow=True
                )
            direct_commit = (
                has_plan
                and not is_borrow
                and capacity_proposal.is_direct_commit(
                    row,
                    [ProposalLineInput.model_validate(line) for line in assignees],
                    is_borrow=False,
                )
            )
            reply_result = capacity.call(
                db,
                p,
                cards,
                "prepare_demand_reply",
                reply_body.model_dump(mode="json", exclude_none=True),
                plan_reply=True,
                direct_commit=direct_commit,
            )
            if isinstance(reply_result, dict) and "error" not in reply_result:
                card = plan_card(option, case)
                if card.rule_fallback is not None:
                    message = cards[-1]
                    assert isinstance(message, s.CapacityCard)
                    message.plan = card.model_copy(
                        update={"fields": plan_metrics(option), "changes": None}
                    )
            return redact(reply_result)
        except ValidationError as exc:
            return {"error": validation_message(exc, "工具参数不正确")}
        except HTTPException as exc:
            if 400 <= exc.status_code < 500:
                return {"error": exc.detail}
            raise ModelUnavailable(code="coordination_tool") from None
        except Exception:
            raise ModelUnavailable(code="coordination_tool") from None
    if name in PROJECT_READS:
        return {"error": "请通过 coordination 调用此工具"}
    if name in capacity.FORECAST_PREPARE_NAMES:
        if not read_capacity_settings(p, db).enabled:
            return {"error": "规划与负荷功能未开启"}
        return {"error": "请通过 coordination 调用此工具"}
    if name in capacity.TITLES or name in capacity.WRITES:
        if session.channel not in ("web", "feishu"):
            return {"error": "不允许调用此工具"}
        return redact(capacity.call(db, p, cards, name, arguments))
    if name == "suggest_capability":
        try:
            suggestion = SuggestCapability.model_validate(arguments)
            return suggest_capability(
                p, db, **suggestion.model_dump(), commit=False
            ).model_dump(mode="json")
        except ValidationError as exc:
            return {"error": validation_message(exc, "工具参数不正确")}
        except HTTPException as exc:
            return {"error": exc.detail}
    if name == "read_attachment":
        try:
            body_attachment = attachments.ReadAttachmentInput.model_validate(arguments)
            return redact(
                attachments.read_attachment(
                    db, p, "bot", session.id, body_attachment.attachment_id
                )
            )
        except ValidationError as exc:
            return {"error": validation_message(exc, "工具参数不正确")}
        except HTTPException:
            return {"error": "附件不存在"}
    if name in TEAM_INPUTS:
        try:
            return redact(team_call(db, p, cards, name, arguments, on_read=on_read))
        except employee.InvalidItems as exc:
            return {"error": "；".join(str(e["message"]) for e in exc.errors)}
    if name in reviews.INPUTS:
        return redact(
            reviews.call(
                db,
                p,
                session,
                cards,
                name,
                arguments,
                decided_review_ids=decided_review_ids,
                turn_text=turn_text,
            )
        )
    tool = TOOLS.get(name)
    if tool is None:
        return {"error": "不允许调用此工具，请使用卡片动作"}
    try:
        body = tool.input_model.model_validate(arguments)
    except ValidationError as exc:
        return {"error": validation_message(exc, "工具参数不正确")}
    kwargs = dict(body)
    notice: dict[str, JsonValue] = {}
    skipped_keys: list[str] = []
    if name == "draft_update_request":
        assert isinstance(body, DraftRequestInput)
        changed_items, skipped_keys = _filter_unchanged_items(db, p, body.items)
        if not changed_items:
            return {"error": "没有实际改动的内容，请说明需要修改的能力或新内容"}
        remaining, notice = pending_overlap(db, p, session, cards, changed_items)
        if notice and not remaining:
            if skipped_keys:
                notice["skipped_unchanged"] = cast(JsonValue, skipped_keys)
            return redact(notice)
        if body.request_id is None and drafted_ids:
            current_draft_id = drafted_ids[-1]
            existing_request = next(
                (
                    r
                    for r in employee.my_requests(p, db, "open").data
                    if r.id == current_draft_id and r.status == RequestStatus.DRAFT
                ),
                None,
            )
            if existing_request is not None:
                merged = {
                    i.capability.key: ItemInput(
                        op=i.op,
                        capability_key=i.capability.key,
                        statement=i.after.statement if i.after else "撤回或补充依据",
                        level=i.after.level if i.after else None,
                        owner_statement=i.owner_statement,
                        objection=i.objection,
                        uncertainty=i.uncertainty,
                        evidence_ids=[e.evidence_id for e in i.evidence],
                    )
                    for i in existing_request.items
                }
                for item in remaining:
                    merged[item.capability_key] = item
                remaining = list(merged.values())
                kwargs["request_id"] = current_draft_id
        kwargs["items"] = remaining
        kwargs.update(via="bot", client_name="内置助手")
    try:
        result = PROJECTIONS[name].model_validate(tool.handler(p, db, **kwargs))
    except employee.InvalidItems as exc:
        return {"error": "；".join(str(e["message"]) for e in exc.errors)}
    result = name_levels(db, p, result)
    if isinstance(result, s.Profile):
        auto = read_auto_draft(db, p)
        result.auto_draft_enabled = auto.enabled and not auto.org_disabled
    blocked_drafts: list[JsonValue] = []
    if isinstance(result, (s.Request, s.Preview)):
        request_id = result.id if isinstance(result, s.Request) else result.request_id
        if request_id not in session.request_ids:
            session.request_ids = [*session.request_ids, request_id]
            db.add(session)
        if name == "draft_update_request":
            if drafted_ids is not None and request_id not in drafted_ids:
                drafted_ids.append(request_id)
            cards[:] = [
                c
                for c in cards
                if not isinstance(c, s.PreviewCard) or c.request_id == request_id
            ]
        if not (
            name == "preview_request" and drafted_ids and request_id != drafted_ids[-1]
        ):
            blocked = checked_preview_card(db, p, session, cards, request_id)
            if blocked:
                blocked_drafts.append(blocked)
    if isinstance(result, s.Requests):
        for request in result.data:
            if request.id not in session.request_ids:
                session.request_ids = [*session.request_ids, request.id]
                db.add(session)
            if request.status in ("draft", "pending_owner"):
                if drafted_ids and request.id != drafted_ids[-1]:
                    continue
                blocked = checked_preview_card(db, p, session, cards, request.id)
                if blocked:
                    blocked_drafts.append(blocked)
            else:
                request_card(cards, status_card(request))
    if isinstance(result, s.Questions):
        cards.extend(question_card(q) for q in result.data)
    if isinstance(result, s.Question):
        cards.append(question_card(result))
    if blocked_drafts:
        notice["blocked_drafts"] = blocked_drafts
    if skipped_keys:
        notice["skipped_unchanged"] = cast(JsonValue, skipped_keys)
    return redact(result.model_dump(mode="json") | notice)
