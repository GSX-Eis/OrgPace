import math
import re
from collections.abc import Callable, Iterable
from dataclasses import replace
from datetime import date
from typing import Literal, Protocol
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import (
    BaseModel,
    Field,
    JsonValue,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic.json_schema import SkipJsonSchema
from sqlmodel import Session, col, func, select

from app.authz.policies import (
    can_manage_department,
    can_view_employee,
    can_view_org_aggregates,
    manages_department,
)
from app.authz.principal import Principal
from app.domains.bot import schemas as s
from app.domains.bot.models import BotSession
from app.domains.capability.service import get_schema, list_capabilities
from app.domains.capacity import demand, forecast_policy, proposal
from app.domains.capacity.assignment import assignment_rows
from app.domains.capacity.common import (
    CapacityConflict,
    CapacityForbidden,
    CapacityNotFound,
    employee,
)
from app.domains.capacity.demand_schemas import (
    DemandInput,
    DemandList,
    DemandListInput,
    DemandPublic,
    PlanReplyDemandInput,
    ProjectDetail,
    ReplyInput,
    RespondDemandInput,
)
from app.domains.capacity.extension_schemas import RequestExtensionInput
from app.domains.capacity.models import (
    AssignmentStatus,
    CapacityExtensionRequest,
    CapacityForecastEvent,
    CapacityForecastPolicy,
    CapacityRequestStatus,
    DemandOutcome,
    DemandStatus,
    ForecastModifierKind,
    ProposalStatus,
)
from app.domains.capacity.schemas import (
    REASON_LABELS,
    CapacityInput,
    ForecastEventInput,
    ForecastPolicyInput,
    LeaveInput,
    TeamWorkloadInput,
    UnavailabilityInput,
    Via,
    WorkloadRequestInput,
    WorkloadRequestPublic,
    WorkloadWeekItem,
    WorkloadWeeksInput,
    _reject_bool_float,
    _strip_optional_text,
)
from app.domains.capacity.settings import (
    read_settings,
    require_enabled,
)
from app.domains.capacity.tools import CAPACITY_TOOLS
from app.domains.capacity.workload import (
    get_my_workload,
    register_unavailability,
    set_weeks,
    workload_reviewer_names,
    workload_reviewers,
)
from app.domains.change_request.schemas import validation_message
from app.domains.model.pi_client import ToolDefinition
from app.domains.org.models import Department, Employee, EmploymentStatus
from app.domains.org.timezone import read_timezone
from app.i18n import tr


class ChangeOnWeb(CapacityConflict):
    def __init__(self) -> None:
        super().__init__()
        self.detail = "请在网页发起或确认变更"


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
RESPONSES = {"accept": "接受", "follow_up": "追问", "withdraw": "撤回"}
DEMAND_REPLY_REASON_GUIDANCE = (
    "必需能力未知或未确认时，未知不等于不会。暂时不能承接时须用 reason_code=other（其他）"
    "并说明待核实的能力。reason_code=skill（能力不匹配）只用于已核实的等级差距足以导致"
    "符合必需能力等级的人数不足的情况；服务端会核对当前已确认画像。"
    "仅凭需求依据中没有匹配结果，不能选择 skill。"
)
DEMAND_REPLY_PLAN_GUIDANCE = (
    "普通答复请省略 option_id、outside_basis、lender_department_id 和 borrow_headcount；"
    "仅提交实际方案时使用 prepare_plan_proposal 生成确认卡"
)
SKILL_REPLY_TEXT = "根据已确认的画像等级核对，达到必需能力等级要求的人数不足。"
SKILL_REPLY_UNVERIFIED = "当前依据无法核实能力不匹配，请选择「其他」并说明待核实的能力"

DemandField = Literal[
    "requesting_department_id",
    "target_department_id",
    "capability_key",
    "minimum_level",
    "window_start",
    "window_end",
    "description",
]


STAFFING_FIELDS = {"headcount", "allocation_percent"}
STAFFING_TEXT = re.compile(
    r"人数|人头|几人|几个人|多少人|人手|每人投入|投入比|投入\s*\d|"
    r"\d+(?:\.\d+)?\s*[%％]|\d+\s*(?:名|位|个)?\s*(?:员工|人员|人)(?![工员])"
)
PRIVATE_TEXT = re.compile(
    r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
    r"|[\w.+-]+@[\w.-]+|https?://|员工编号|工号|员工\s*id|个人负荷|周负荷|其他工作占比|"
    r"平台分配|超负荷|满负荷|(?:负荷|可用容量|余量)[^。；，,\n]{0,12}\d",
    re.IGNORECASE,
)


class DraftTextInvalid(HTTPException):
    def __init__(self, detail: str) -> None:
        super().__init__(422, detail)


def validate_draft_text(db: Session, p: Principal, text: str, error: str) -> None:
    names = db.exec(select(Employee.display_name).where(Employee.org_id == p.org_id))
    prose = text.casefold()
    if (
        STAFFING_TEXT.search(prose)
        or PRIVATE_TEXT.search(prose)
        or any(name and name.casefold() in prose for name in names)
    ):
        raise DraftTextInvalid(error)


class PrepareDemandInput(DemandInput):
    headcount: SkipJsonSchema[None] = None
    allocation_percent: SkipJsonSchema[None] = None
    unclear_fields: list[DemandField] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list, max_length=2)

    @model_validator(mode="before")
    @classmethod
    def discard_staffing(cls, data: dict[str, JsonValue]) -> dict[str, JsonValue]:
        if not isinstance(data, dict):
            return data
        result = {
            key: value for key, value in data.items() if key not in STAFFING_FIELDS
        }
        if isinstance(unclear := result.get("unclear_fields"), list):
            result["unclear_fields"] = [
                key
                for key in unclear
                if not isinstance(key, str) or key not in STAFFING_FIELDS
            ]
        if isinstance(questions := result.get("questions"), list):
            result["questions"] = [
                q
                for q in questions
                if not isinstance(q, str) or not STAFFING_TEXT.search(q)
            ]
        return result


class PrepareForecastPolicyInput(CapacityInput):
    action: Literal["upsert", "delete"] = "upsert"
    policy_id: UUID | None = None
    department_id: UUID | None = None
    job_family: str | None = Field(default=None, max_length=50)
    retention_rate: float | None = Field(default=None, ge=0.0, le=1.0)
    note: str | None = Field(default=None, max_length=200)

    @field_validator("job_family", "note", mode="before")
    @classmethod
    def clean_optional_text(cls, value: object) -> object:
        return _strip_optional_text(value)

    @field_validator("retention_rate", mode="before")
    @classmethod
    def reject_bool_retention(cls, value: object) -> object:
        return _reject_bool_float(value)

    @field_validator("retention_rate")
    @classmethod
    def finite_retention(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError(tr("周延续系数必须是有限数值"))
        return value

    @model_validator(mode="after")
    def validate_delete(self) -> PrepareForecastPolicyInput:
        if self.action == "delete" and self.policy_id is None:
            raise ValueError(tr("删除预测策略时必须提供 policy_id"))
        return self


class PrepareForecastEventInput(CapacityInput):
    action: Literal["create", "update", "delete"] = "create"
    event_id: UUID | None = None
    department_id: UUID | None = None
    job_family: str | None = Field(default=None, max_length=50)
    title: str | None = Field(default=None, max_length=100)
    start_week: date | None = None
    end_week: date | None = None
    modifier_kind: ForecastModifierKind | None = None
    modifier_value: float | None = None
    reason: str | None = Field(default=None, max_length=300)

    @field_validator("job_family", "title", "reason", mode="before")
    @classmethod
    def clean_optional_text(cls, value: object) -> object:
        return _strip_optional_text(value)

    @field_validator("modifier_value", mode="before")
    @classmethod
    def reject_bool_modifier(cls, value: object) -> object:
        return _reject_bool_float(value)

    @field_validator("modifier_value")
    @classmethod
    def finite_modifier(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError(tr("波动幅度必须是有限数值"))
        return value

    @model_validator(mode="after")
    def validate_event_id(self) -> PrepareForecastEventInput:
        if self.action in ("update", "delete") and self.event_id is None:
            raise ValueError(tr("修改或删除业务波动事件时必须提供 event_id"))
        return self


PREPARE_MODELS: dict[str, type[BaseModel]] = {
    "prepare_demand": PrepareDemandInput,
    "prepare_leave": LeaveInput,
    "prepare_team_workload": TeamWorkloadInput,
    "prepare_forecast_policy": PrepareForecastPolicyInput,
    "prepare_forecast_event": PrepareForecastEventInput,
}


def requester_departments(db: Session, p: Principal) -> list[Department]:
    try:
        demand.require_requester(p, db)
    except HTTPException:
        return []
    query = select(Department).where(Department.org_id == p.org_id)
    if not p.is_org_admin:
        ids = p.managed_department_ids
        if not ids:
            department_id = employee(p, db, p.employee_id).department_id
            ids = frozenset({department_id}) if department_id else frozenset()
        query = query.where(col(Department.id).in_(ids))
    return list(db.exec(query.order_by(Department.name, col(Department.id))).all())


class DemandDepartmentForbidden(CapacityForbidden):
    def __init__(self, departments: list[Department]) -> None:
        super().__init__()
        self.detail = tr(
            "需求方部门只能选择：{names}",
            names=tr("、").join(d.name for d in departments),
        )


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


def _scope_label(
    department_name: str | None,
    job_family: str | None,
    *,
    default_label: str,
) -> str:
    if department_name and job_family:
        return f"{department_name} / {job_family}"
    if department_name:
        return department_name
    if job_family:
        return tr("全企业 / {job_family}", job_family=job_family)
    return default_label


def _format_modifier(kind: ForecastModifierKind, value: float) -> str:
    if kind == ForecastModifierKind.MULTIPLIER:
        return f"×{value:g}"
    return f"{value:+g}%"


def _affected_employee_count(
    db: Session,
    org_id: UUID,
    scopes: Iterable[tuple[UUID | None, str | None]],
) -> int:
    collected: set[UUID] = set()
    for dept_id, job_family in scopes:
        ids = forecast_policy.scope_employee_ids(db, org_id, dept_id, job_family)
        if ids is None:
            return int(
                db.exec(
                    select(func.count(col(Employee.id))).where(
                        Employee.org_id == org_id,
                        Employee.employment_status == EmploymentStatus.ACTIVE,
                    )
                ).one()
            )
        collected.update(ids)
    return len(collected)


def get_forecast_config_for_bot(p: Principal, db: Session) -> dict[str, JsonValue]:
    config = forecast_policy.get_forecast_config(p, db)
    events = forecast_policy.list_forecast_events(p, db, include_past=False)
    dept_query = select(Department).where(Department.org_id == p.org_id)
    if p.is_org_admin:
        depts = list(
            db.exec(dept_query.order_by(Department.name, col(Department.id))).all()
        )
    elif p.managed_department_ids:
        depts = list(
            db.exec(
                dept_query.where(
                    col(Department.id).in_(p.managed_department_ids)
                ).order_by(Department.name, col(Department.id))
            ).all()
        )
    else:
        depts = []
    return {
        "default_allocation_cap_percent": config.default_allocation_cap_percent,
        "default_retention_rate": config.default_retention_rate,
        "recommended_retention_rates": [
            {
                "retention_rate": 0.0,
                "label": tr("脉冲波次型"),
                "description": tr("干完即清零，适合客服、仓储、短期波次"),
            },
            {
                "retention_rate": 0.5,
                "label": tr("常规均衡型"),
                "description": tr("约 2 周衰减至 25%，适合常规周期性业务"),
            },
            {
                "retention_rate": 0.8,
                "label": tr("项目延续型"),
                "description": tr("延续性强，适合研发、设计、咨询"),
            },
        ],
        "policies": [item.model_dump(mode="json") for item in config.policies],
        "events": [item.model_dump(mode="json") for item in events.data],
        "departments": [
            {
                "id": str(d.id),
                "name": d.name,
                "parent_department_id": (
                    str(d.parent_department_id) if d.parent_department_id else None
                ),
                "can_edit": can_manage_department(p, d.id),
            }
            for d in depts
        ],
        "job_families": list(config.job_families),
    }


def _find_policy_by_scope(
    db: Session,
    org_id: UUID,
    department_id: UUID | None,
    job_family: str | None,
) -> CapacityForecastPolicy | None:
    dept_filter = (
        col(CapacityForecastPolicy.department_id).is_(None)
        if department_id is None
        else CapacityForecastPolicy.department_id == department_id
    )
    jf_filter = (
        col(CapacityForecastPolicy.job_family).is_(None)
        if job_family is None
        else CapacityForecastPolicy.job_family == job_family
    )
    return db.exec(
        select(CapacityForecastPolicy).where(
            CapacityForecastPolicy.org_id == org_id,
            dept_filter,
            jf_filter,
        )
    ).one_or_none()


def check_forecast_policy(
    db: Session, p: Principal, value: BaseModel
) -> tuple[str, str, list[s.CardField], dict[str, JsonValue]]:
    body = PrepareForecastPolicyInput.model_validate(value)
    forecast_policy.require_manager_or_admin(p)

    if body.action == "delete":
        assert body.policy_id is not None
        existing = db.exec(
            select(CapacityForecastPolicy).where(
                CapacityForecastPolicy.org_id == p.org_id,
                CapacityForecastPolicy.id == body.policy_id,
            )
        ).one_or_none()
        if existing is None:
            raise CapacityNotFound("未找到该预测策略")
        dept = forecast_policy.require_write_scope(p, db, existing.department_id)
        scope_text = _scope_label(
            dept.name if dept else None,
            existing.job_family,
            default_label=tr("企业默认"),
        )
        before_rate = forecast_policy.retention_from_decay(existing.decay_rate)
        affected_count = _affected_employee_count(
            db, p.org_id, [(existing.department_id, existing.job_family)]
        )
        notice = tr("确认后立即重算 26 周预测基线，不覆盖已确认排期与经理单周修正。")
        fields = [
            s.CardField(label=tr("适用范围"), value=scope_text),
            s.CardField(
                label=tr("修改前"),
                value=forecast_policy.format_retention_summary(before_rate),
            ),
            s.CardField(
                label=tr("修改后"),
                value=tr(
                    "回退至上级部门或系统默认（{rate}）",
                    rate=f"{forecast_policy.DEFAULT_RETENTION_RATE:g}",
                ),
            ),
            s.CardField(
                label=tr("受影响人数"),
                value=tr("{count} 名在职员工", count=affected_count),
            ),
        ]
        content = "\n".join(
            [
                *(tr("{label}：{value}", label=f.label, value=f.value) for f in fields),
                notice,
            ]
        )
        return (
            tr("删除负荷预测策略"),
            content,
            fields,
            {"action": "delete", "policy_id": str(existing.id)},
        )

    dept_id = body.department_id
    job_family = body.job_family
    if body.policy_id is not None:
        existing_by_id = db.exec(
            select(CapacityForecastPolicy).where(
                CapacityForecastPolicy.org_id == p.org_id,
                CapacityForecastPolicy.id == body.policy_id,
            )
        ).one_or_none()
        if existing_by_id is None:
            raise CapacityNotFound("未找到该预测策略")
        forecast_policy.require_write_scope(p, db, existing_by_id.department_id)
        if "department_id" not in body.model_fields_set:
            dept_id = existing_by_id.department_id
        if "job_family" not in body.model_fields_set:
            job_family = existing_by_id.job_family

    dept = forecast_policy.require_write_scope(p, db, dept_id)
    existing = _find_policy_by_scope(db, p.org_id, dept_id, job_family)

    retention_rate = (
        body.retention_rate
        if body.retention_rate is not None
        else (
            forecast_policy.retention_from_decay(existing.decay_rate)
            if existing is not None
            else None
        )
    )
    if retention_rate is None:
        raise DraftTextInvalid(
            tr(
                "请提供周延续系数 retention_rate（0.0–1.0：0 脉冲波次型、0.5 常规均衡型、0.8 项目延续型）"
            )
        )

    note = (
        body.note
        if "note" in body.model_fields_set
        else (existing.note if existing is not None else None)
    )
    policy_input = ForecastPolicyInput(
        department_id=dept_id,
        job_family=job_family,
        retention_rate=retention_rate,
        note=note,
    )
    scope_text = _scope_label(
        dept.name if dept else None,
        policy_input.job_family,
        default_label=tr("企业默认"),
    )
    if existing is not None:
        before_text = forecast_policy.format_retention_summary(
            forecast_policy.retention_from_decay(existing.decay_rate)
        )
    elif dept_id is None and job_family is None:
        before_text = tr(
            "未单独配置（沿用系统默认 {rate}）",
            rate=f"{forecast_policy.DEFAULT_RETENTION_RATE:g}",
        )
    else:
        before_text = tr("未单独配置（沿用上级或系统默认）")

    after_text = forecast_policy.format_retention_summary(policy_input.retention_rate)
    affected_count = _affected_employee_count(
        db, p.org_id, [(policy_input.department_id, policy_input.job_family)]
    )
    notice = tr("确认后立即重算 26 周预测基线，不覆盖已确认排期与经理单周修正。")
    fields = [
        s.CardField(label=tr("适用范围"), value=scope_text),
        s.CardField(label=tr("周延续系数"), value=after_text),
        s.CardField(label=tr("修改前"), value=before_text),
        s.CardField(label=tr("修改后"), value=after_text),
        *(
            [s.CardField(label=tr("备注"), value=policy_input.note)]
            if policy_input.note
            else []
        ),
        s.CardField(
            label=tr("受影响人数"),
            value=tr("{count} 名在职员工", count=affected_count),
        ),
    ]
    content = "\n".join(
        [
            *(tr("{label}：{value}", label=f.label, value=f.value) for f in fields),
            notice,
        ]
    )
    return (
        tr("配置负荷预测策略"),
        content,
        fields,
        {"action": "upsert", **policy_input.model_dump(mode="json")},
    )


def _build_event_card(
    card_title: str,
    scope_text: str,
    *,
    title: str,
    start_week: date,
    end_week: date,
    modifier_kind: ForecastModifierKind,
    modifier_value: float,
    reason: str,
    affected_count: int,
    notice: str,
    card_arguments: dict[str, JsonValue],
) -> tuple[str, str, list[s.CardField], dict[str, JsonValue]]:
    fields = [
        s.CardField(label=tr("事件名称"), value=title),
        s.CardField(label=tr("生效范围"), value=scope_text),
        s.CardField(
            label=tr("起止周"),
            value=tr(
                "{start} 至 {end}",
                start=start_week.isoformat(),
                end=end_week.isoformat(),
            ),
        ),
        s.CardField(
            label=tr("修正方式"),
            value=_format_modifier(modifier_kind, modifier_value),
        ),
        s.CardField(label=tr("原因说明"), value=reason),
        s.CardField(
            label=tr("受影响人数"),
            value=tr("{count} 名在职员工", count=affected_count),
        ),
    ]
    content = "\n".join(
        [
            *(tr("{label}：{value}", label=f.label, value=f.value) for f in fields),
            notice,
        ]
    )
    return card_title, content, fields, card_arguments


def check_forecast_event(
    db: Session, p: Principal, value: BaseModel
) -> tuple[str, str, list[s.CardField], dict[str, JsonValue]]:
    body = PrepareForecastEventInput.model_validate(value)
    forecast_policy.require_manager_or_admin(p)

    if body.action == "delete":
        assert body.event_id is not None
        existing = db.exec(
            select(CapacityForecastEvent).where(
                CapacityForecastEvent.org_id == p.org_id,
                CapacityForecastEvent.id == body.event_id,
            )
        ).one_or_none()
        if existing is None:
            raise CapacityNotFound("未找到该业务波动事件")
        dept = forecast_policy.require_write_scope(p, db, existing.department_id)
        return _build_event_card(
            tr("删除业务波动事件"),
            _scope_label(
                dept.name if dept else None,
                existing.job_family,
                default_label=tr("全企业"),
            ),
            title=existing.title,
            start_week=existing.start_week,
            end_week=existing.end_week,
            modifier_kind=existing.modifier_kind,
            modifier_value=existing.modifier_value,
            reason=existing.reason,
            affected_count=_affected_employee_count(
                db, p.org_id, [(existing.department_id, existing.job_family)]
            ),
            notice=tr(
                "确认后删除该事件并立即重算 26 周预测基线，不覆盖已确认排期与经理单周修正。"
            ),
            card_arguments={"action": "delete", "event_id": str(existing.id)},
        )

    if body.action == "update":
        assert body.event_id is not None
        existing = db.exec(
            select(CapacityForecastEvent).where(
                CapacityForecastEvent.org_id == p.org_id,
                CapacityForecastEvent.id == body.event_id,
            )
        ).one_or_none()
        if existing is None:
            raise CapacityNotFound("未找到该业务波动事件")
        forecast_policy.require_write_scope(p, db, existing.department_id)
        dept_id = (
            body.department_id
            if "department_id" in body.model_fields_set
            else existing.department_id
        )
        job_family = (
            body.job_family
            if "job_family" in body.model_fields_set
            else existing.job_family
        )
        title_val = body.title if "title" in body.model_fields_set else existing.title
        start_week = (
            body.start_week
            if "start_week" in body.model_fields_set
            else existing.start_week
        )
        end_week = (
            body.end_week if "end_week" in body.model_fields_set else existing.end_week
        )
        modifier_kind = (
            body.modifier_kind
            if "modifier_kind" in body.model_fields_set
            else existing.modifier_kind
        )
        modifier_value = (
            body.modifier_value
            if "modifier_value" in body.model_fields_set
            else existing.modifier_value
        )
        reason_val = (
            body.reason if "reason" in body.model_fields_set else existing.reason
        )
        old_scope = (existing.department_id, existing.job_family)
        card_title = tr("修改业务波动事件")
        extra_args: dict[str, JsonValue] = {
            "action": "update",
            "event_id": str(existing.id),
        }
    else:
        dept_id = body.department_id
        job_family = body.job_family
        title_val = body.title
        start_week = body.start_week
        end_week = body.end_week
        modifier_kind = body.modifier_kind
        modifier_value = body.modifier_value
        reason_val = body.reason
        old_scope = None
        card_title = tr("注入业务波动事件")
        extra_args = {"action": "create"}

    dept = forecast_policy.require_write_scope(p, db, dept_id)
    if (
        title_val is None
        or start_week is None
        or end_week is None
        or modifier_kind is None
        or modifier_value is None
        or reason_val is None
    ):
        raise DraftTextInvalid(
            "业务波动事件需要提供 title、start_week、end_week、modifier_kind、modifier_value 和 reason"
        )
    event_input = ForecastEventInput(
        department_id=dept_id,
        job_family=job_family,
        title=title_val,
        start_week=start_week,
        end_week=end_week,
        modifier_kind=modifier_kind,
        modifier_value=modifier_value,
        reason=reason_val,
    )
    scopes: list[tuple[UUID | None, str | None]] = [
        (event_input.department_id, event_input.job_family)
    ]
    if old_scope is not None:
        scopes.append(old_scope)
    return _build_event_card(
        card_title,
        _scope_label(
            dept.name if dept else None,
            event_input.job_family,
            default_label=tr("全企业"),
        ),
        title=event_input.title,
        start_week=event_input.start_week,
        end_week=event_input.end_week,
        modifier_kind=event_input.modifier_kind,
        modifier_value=event_input.modifier_value,
        reason=event_input.reason,
        affected_count=_affected_employee_count(db, p.org_id, scopes),
        notice=tr("确认后立即重算 26 周预测基线，不覆盖已确认排期与经理单周修正。"),
        card_arguments={**extra_args, **event_input.model_dump(mode="json")},
    )


def check_demand(
    db: Session, p: Principal, value: BaseModel, unclear: set[str]
) -> tuple[str, list[s.CardField]]:
    body = DemandInput.model_validate(value)
    demand.require_requester(p, db)
    source = demand.department(db, p.org_id, body.requesting_department_id)
    departments = requester_departments(db, p)
    if source.id not in {d.id for d in departments}:
        raise DemandDepartmentForbidden(departments)
    reference = demand.capacity_reference(
        p, db, body.target_department_id, body.capability_key, body.minimum_level
    )
    validate_draft_text(
        db, p, body.description, tr("需求说明只写工作目标、时间和必要条件")
    )
    dictionary = s.Dictionary.model_validate(
        {"data": list_capabilities(db, p.org_id, get_schema(db, p.org_id).id)}
    )
    level = next(
        (
            level.label
            for c in dictionary.data
            if c.key == body.capability_key and c.level_rubric
            for level in c.level_rubric.levels
            if level.key == body.minimum_level
        ),
        tr("未定级"),
    )
    content = tr(
        "需求方：{source}\n目标部门：{target}\n能力：{cap}\n最低等级：{level}\n时间：{start} 至 {end}\n说明：{desc}\n可行性参考不是承诺，以对方部门经理正式答复为准。",
        source=source.name,
        target=reference.department_name,
        cap=reference.capability_name,
        level=level,
        start=body.window_start,
        end=body.window_end,
        desc=body.description,
    )
    values = (
        ("requesting_department_id", tr("需求方"), source.name),
        ("target_department_id", tr("目标部门"), reference.department_name),
        ("capability_key", tr("能力"), reference.capability_name),
        ("minimum_level", tr("最低等级"), level),
        ("window_start", tr("开始日期"), str(body.window_start)),
        ("window_end", tr("结束日期"), str(body.window_end)),
        ("description", tr("说明"), body.description),
    )
    return content, [
        s.CardField(label=label, value=value, unclear=key in unclear)
        for key, label, value in values
    ]


def check_demand_response(
    db: Session, p: Principal, value: BaseModel
) -> tuple[str, s.CardLink | None]:
    body = RespondDemandInput.model_validate(value)
    row = demand.demand_row(p, db, body.demand_id)
    if p.user_id is None or not (
        row.requester_user_id == p.user_id
        or manages_department(p, row.requesting_department_id)
    ):
        raise CapacityNotFound(demand.DEMAND_NOT_FOUND)
    if (
        row.status == DemandStatus.ACCEPTED
        and proposal.latest(db, p.org_id, row.id, status=ProposalStatus.COMMITTED)
        is not None
    ):
        raise ChangeOnWeb()
    if row.revision != body.revision or row.status in (
        DemandStatus.ACCEPTED,
        DemandStatus.WITHDRAWN,
    ):
        raise CapacityConflict()
    if body.action != "withdraw" and row.status != DemandStatus.REPLIED:
        raise CapacityConflict()
    detail = demand.get_demand(p, db, row.id)
    pending = detail.proposal
    if body.action == "accept" and (
        pending is None or pending.status != ProposalStatus.PENDING
    ):
        raise demand.DemandAwaitingSchedule()
    proposal_text = ""
    detail_link = None
    if pending is not None and pending.status == "pending":
        if body.action == "follow_up":
            demand.require_rejection_reason(body.reason_code, body.text)
        if body.action == "follow_up" and (not body.text or len(body.text) > 500):
            raise proposal.ProposalConflict("拒绝方案时必须填写不超过 500 字的理由")
        detail_link = s.CardLink(
            label=tr("查看需求详情"), href=f"/capacity?tab=outgoing&demand={row.id}"
        )
        timezone = ZoneInfo(read_timezone(db, p.org_id).timezone)
        phases = tr("、").join(
            tr("{start} 至 {end}", start=phase.start_date, end=phase.end_date)
            for phase in pending.schedule_phases
        )
        hint_text = (
            tr("确认后记录需求方接受，原部门经理和员工本人也同意后才生成分配")
            if body.action == "accept" and pending.borrow_progress
            else tr("确认后替代排期生效并生成分配")
            if body.action == "accept"
            else tr("确认后放弃替代排期并释放预占")
            if body.action == "follow_up"
            else tr("确认后撤回需求并释放预占")
        )
        proposal_text = tr(
            "\n状态：待确认替代排期\n开始日期：{start}\n结束日期：{end}{phases}\n请前往需求详情查看状态和排期\n暂留截止：{expires}{hint}",
            start=pending.start_date,
            end=pending.end_date,
            phases=tr("\n阶段排期：{phases}", phases=phases) if phases else "",
            expires=f"{pending.hold_expires_at.astimezone(timezone):%Y-%m-%d %H:%M}",
            hint=f"\n{hint_text}",
        )
    rejecting = (
        pending is not None
        and pending.status == "pending"
        and body.action == "follow_up"
    )
    reason = (
        tr("拒绝原因：{reason}\n", reason=tr(REASON_LABELS[body.reason_code]))
        if rejecting and body.reason_code is not None
        else ""
    )
    if body.text:
        validate_draft_text(
            db, p, body.text, tr("回应说明只写工作目标、日期和必要条件")
        )
    content = (
        tr(
            "需求：{cap}\n操作：{action}\n{reason}说明：{note}\n修订：{revision}",
            cap=detail.capability_name,
            action=tr("拒绝方案") if rejecting else tr(RESPONSES[body.action]),
            reason=reason,
            note=body.text or tr("无"),
            revision=body.revision,
        )
        + proposal_text
    )
    return content, detail_link


def _is_skill_rejection(body: ReplyInput) -> bool:
    return body.outcome == DemandOutcome.NOT_NOW and body.reason_code == "skill"


def _has_proposal_arguments(arguments: dict[str, JsonValue]) -> bool:
    return (
        arguments.get("option_id") is not None
        or arguments.get("outside_basis") is True
        or "lender_department_id" in arguments
        or "borrow_headcount" in arguments
    )


def check_demand_reply(
    db: Session,
    p: Principal,
    value: BaseModel,
    *,
    lock: bool = False,
    direct_commit: bool = False,
) -> str:
    body = PlanReplyDemandInput.model_validate(value)
    row = demand.demand_row(p, db, body.demand_id, lock=lock)
    if not demand.represents_department(p, row.target_department_id):
        raise CapacityNotFound(demand.DEMAND_NOT_FOUND)
    if p.user_id is None or p.user_id == row.requester_user_id:
        raise CapacityForbidden()
    if (
        row.status == DemandStatus.ACCEPTED
        and proposal.latest(db, p.org_id, row.id, status=ProposalStatus.COMMITTED)
        is not None
    ):
        raise ChangeOnWeb()
    if row.revision != body.revision or (
        row.status != DemandStatus.SUBMITTED
        and not (body.option_id and demand.is_legacy_verbal_reply(db, row))
    ):
        raise CapacityConflict()
    if (
        body.option_id is None
        and body.outcome != DemandOutcome.NOT_NOW
        and (row.headcount is None or row.allocation_percent is None)
    ):
        raise proposal.ProposalConflict("请先模拟内部排期，再为可行方案生成确认卡")
    reason = ""
    if body.outcome == DemandOutcome.NOT_NOW:
        demand.require_rejection_reason(body.reason_code, body.text)
        if _is_skill_rejection(body) and not demand.verified_skill_shortage(p, db, row):
            raise demand.RejectionReasonInvalid(tr(SKILL_REPLY_UNVERIFIED))
        if body.reason_code is not None:
            reason = tr(
                "暂不能承接的原因：{reason}\n",
                reason=tr(REASON_LABELS[body.reason_code]),
            )
    description, _, conditions = body.text.partition("\n条件：")
    outcome_label = tr(
        {
            "can_do": "能做",
            "partial": "能做一部分：请核对以下条件",
            "not_now": "暂时不能",
        }[body.outcome]
    )
    content = tr(
        "需求：{cap}\n结论：{outcome}\n承诺日期：{start} 至 {end}\n{reason}条件：{conditions}\n说明：{description}\n修订：{revision}\n",
        cap=row.capability_name,
        outcome=outcome_label,
        start=body.start_date or tr("未定"),
        end=body.end_date or tr("未定"),
        reason=reason,
        conditions=conditions.strip() or tr("无"),
        description=description,
        revision=body.revision,
    )
    if body.lender_department_id is not None:
        lender = demand.department(db, p.org_id, body.lender_department_id)
        content += tr(
            "\n借出部门：{lender} · 借调 {headcount} 人\n确认后通知原部门经理选人，选人后才开始预占。",
            lender=lender.name,
            headcount=body.borrow_headcount,
        )
    elif body.option_id is not None:
        content += tr(
            "排期在需求方窗口内，确认后将直接生效并生成正式分配。"
            if direct_commit
            else "排期超出需求方窗口，确认后将预占 72 小时等待需求方确认。"
        )
        if body.outside_basis:
            content += tr("\n本次明确同意安排需求依据以外的人员")
    else:
        content += tr("确认后把答复发给需求方，不分配人员，不改其他承诺。")
    demand.validate_department_text(p, db, row.target_department_id, content)
    demand.validate_reply_text(p, db, row, body.text)
    return content


def check_workload_request(db: Session, p: Principal, value: BaseModel) -> str:
    from app.domains.capacity.workload import validate_request_week

    body = WorkloadRequestInput.model_validate(value)
    if p.user_id is None:
        raise CapacityForbidden()
    current = get_my_workload(p, db)
    validate_request_week(body.end_week, current.weeks[0].week_start)
    if any(r.status == CapacityRequestStatus.PENDING for r in current.requests):
        raise CapacityConflict()
    reviewers = tr("、").join(current.reviewer_names)
    waiting = (
        tr("提交后等待 {reviewers} 审批", reviewers=reviewers)
        if reviewers
        else tr("提交后等待经理审批")
    )
    return tr(
        "申请调整本人负荷\n其他工作占比：{percent}%\n周范围：{start} 至 {end}\n原因：{reason}\n{waiting}",
        percent=body.requested_percent,
        start=body.start_week,
        end=body.end_week,
        reason=body.reason,
        waiting=waiting,
    )


def check_leave(db: Session, p: Principal, value: BaseModel) -> str:
    body = LeaveInput.model_validate(value)
    if p.user_id is None or p.employee_id is None or p.is_org_admin:
        raise CapacityForbidden()
    subject = employee(p, db, p.employee_id)
    reviewers = workload_reviewer_names(p, db, workload_reviewers(p, db, subject.id))
    notify_text = (
        tr("并通知 {reviewers}", reviewers=tr("、").join(reviewers))
        if reviewers
        else tr("并通知部门经理")
    )
    return tr(
        "请假（登记不可用日期）\n日期：{start} 至 {end}\n确认后直接生效，{notify_text}（通知仅含日期）",
        start=body.start_date,
        end=body.end_date,
        notify_text=notify_text,
    )


def check_team_workload(db: Session, p: Principal, value: BaseModel) -> str:
    body = TeamWorkloadInput.model_validate(value)
    if p.user_id is None or not p.managed_department_ids:
        raise CapacityForbidden()
    scoped = replace(p, is_org_admin=False)
    subject = employee(scoped, db, body.employee_id)
    if not can_view_employee(scoped, subject):
        raise CapacityNotFound()
    if subject.id == scoped.employee_id or not manages_department(
        scoped, subject.department_id
    ):
        raise CapacityForbidden()
    return tr(
        "调整下属周负荷\n员工：{name}\n平台外工作占比：{percent}%\n周范围：{start} 至 {end}\n确认后立即生效并通知本人",
        name=subject.display_name,
        percent=body.other_percent,
        start=body.start_week,
        end=body.end_week,
    )


def check_extension_request(db: Session, p: Principal, value: BaseModel) -> str:
    body = RequestExtensionInput.model_validate(value)
    row, _ = assignment_rows(p, db, body.assignment_id)
    if p.user_id is None or row.employee_id != p.employee_id:
        raise CapacityNotFound()
    if row.status != AssignmentStatus.ACTIVE or body.requested_due_date <= row.due_date:
        raise CapacityConflict()
    pending = db.exec(
        select(CapacityExtensionRequest.id).where(
            CapacityExtensionRequest.org_id == p.org_id,
            CapacityExtensionRequest.assignment_id == row.id,
            CapacityExtensionRequest.status == CapacityRequestStatus.PENDING,
        )
    ).first()
    if pending:
        raise CapacityConflict()
    return tr(
        "申请延期\n分配编号：{id}\n原完成日期：{due}\n申请完成日期：{requested}\n原因：{reason}\n提交后等待经理审批",
        id=row.id,
        due=row.due_date,
        requested=body.requested_due_date,
        reason=body.reason,
    )


CHECKS: dict[CardKind, Callable[[Session, Principal, BaseModel], str]] = {
    "demand_reply": check_demand_reply,
    "workload_request": check_workload_request,
    "extension_request": check_extension_request,
    "leave": check_leave,
    "team_workload": check_team_workload,
}
RESULTS = {
    "demand": "需求已提交",
    "demand_response": "需求回应已提交",
    "demand_reply": "部门答复已发送",
    "workload_request": "负荷调整申请已提交，等待经理审批",
    "extension_request": "延期申请已提交，等待经理审批",
    "leave": "请假已登记并生效，已通知部门经理",
    "team_workload": "下属周负荷已更新并通知本人",
}


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
        kind, write_name, title = PREPARES[name]
        fields: list[s.CardField] = []
        questions: list[str] = []
        detail_link = None
        card_arguments: dict[str, JsonValue] | None = None
        if name == "prepare_demand":
            preview = PrepareDemandInput.model_validate(arguments)
            body = DemandInput.model_validate(
                preview.model_dump(exclude={"unclear_fields", "questions"})
            )
            content, fields = check_demand(db, p, body, set(preview.unclear_fields))
            questions = preview.questions
            validate_draft_text(
                db, p, "\n".join(questions), tr("核对问题只写工作目标、部门或时间")
            )
        elif name == "prepare_forecast_policy":
            title, content, fields, card_arguments = check_forecast_policy(
                db, p, PrepareForecastPolicyInput.model_validate(arguments)
            )
        elif name == "prepare_forecast_event":
            title, content, fields, card_arguments = check_forecast_event(
                db, p, PrepareForecastEventInput.model_validate(arguments)
            )
        else:
            input_model = (
                PREPARE_MODELS[name]
                if name in PREPARE_MODELS
                else PlanReplyDemandInput
                if name == "prepare_demand_reply" and plan_reply
                else WRITES[write_name].input_model
            )
            body = input_model.model_validate(arguments)
            if (
                kind == "demand_reply"
                and isinstance(body, ReplyInput)
                and _is_skill_rejection(body)
            ):
                body.text = SKILL_REPLY_TEXT
            if kind == "demand_response":
                content, detail_link = check_demand_response(db, p, body)
            elif plan_reply:
                content = check_demand_reply(db, p, body, direct_commit=direct_commit)
            else:
                content = CHECKS[kind](db, p, body)
        card = s.CapacityCard(
            kind=kind,
            title=tr(title),
            content=content,
            fields=fields,
            questions=questions,
            arguments=(
                card_arguments
                if card_arguments is not None
                else body.model_dump(
                    mode="json", exclude=STAFFING_FIELDS if kind == "demand" else None
                )
            ),
            detail_link=detail_link,
        )
        card.actions = [
            s.CapacityAction(action=a, card_id=card.card_id)
            for a in ("confirm_capacity", "cancel_capacity")
        ]
        cards.append(card)
        return {"card_id": str(card.card_id), "preview": content, "status": "pending"}
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


class PlanReplyHandler(Protocol):
    def __call__(
        self,
        p: Principal,
        db: Session,
        body: PlanReplyDemandInput,
        *,
        via: Via,
        client_name: str,
    ) -> DemandPublic: ...


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
        prepare_name, (_, name, _) = next(
            (prep, item) for prep, item in PREPARES.items() if item[0] == card.kind
        )
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
        forecast_action: str | None = None
        forecast_id: UUID | None = None
        policy_body: ForecastPolicyInput | None = None
        event_body: ForecastEventInput | None = None
        body: BaseModel | None = None
        try:
            if card.kind == "forecast_policy":
                raw_action = card.arguments.get("action")
                if raw_action == "delete":
                    forecast_action = "delete"
                    forecast_id = UUID(str(card.arguments["policy_id"]))
                elif raw_action == "upsert":
                    forecast_action = "upsert"
                    policy_body = ForecastPolicyInput.model_validate(
                        {k: v for k, v in card.arguments.items() if k != "action"}
                    )
                else:
                    raise ValueError(tr("不支持的策略操作"))
            elif card.kind == "forecast_event":
                raw_action = card.arguments.get("action")
                if raw_action == "delete":
                    forecast_action = "delete"
                    forecast_id = UUID(str(card.arguments["event_id"]))
                elif raw_action == "update":
                    forecast_action = "update"
                    forecast_id = UUID(str(card.arguments["event_id"]))
                    event_body = ForecastEventInput.model_validate(
                        {
                            k: v
                            for k, v in card.arguments.items()
                            if k not in ("action", "event_id")
                        }
                    )
                elif raw_action == "create":
                    forecast_action = "create"
                    event_body = ForecastEventInput.model_validate(
                        {k: v for k, v in card.arguments.items() if k != "action"}
                    )
                else:
                    raise ValueError(tr("不支持的事件操作"))
            else:
                input_model = (
                    PlanReplyDemandInput
                    if plan_reply
                    else LeaveInput
                    if card.kind == "leave"
                    else TeamWorkloadInput
                    if card.kind == "team_workload"
                    else WRITES[name].input_model
                )
                body = input_model.model_validate(card.arguments)
        except ValidationError, KeyError, ValueError, TypeError:
            card.status, card.result = "failed", tr("申请内容已变化，请重新生成确认卡")
            return card
        with db.begin_nested():
            if (
                card.kind == "demand_reply"
                and isinstance(body, ReplyInput)
                and body.outcome == DemandOutcome.NOT_NOW
            ):
                demand.require_rejection_reason(body.reason_code, body.text)
                if _is_skill_rejection(body):
                    check_demand_reply(db, p, body, lock=True)
                    if body.text != SKILL_REPLY_TEXT:
                        raise demand.RejectionReasonInvalid(tr("能力核实说明已更新"))
            try:
                via: Literal["bot", "feishu"] = (
                    "feishu" if session.channel == "feishu" else "bot"
                )
                result: BaseModel
                if card.kind == "forecast_policy":
                    if forecast_action == "delete":
                        assert forecast_id is not None
                        refresh_res = forecast_policy.delete_forecast_policy(
                            p,
                            db,
                            forecast_id,
                            via=via,
                            client_name=session.channel,
                        )
                        card.status = "confirmed"
                        card.result = tr(
                            "预测策略已删除，已重算 {count} 条周预测基线",
                            count=refresh_res.updated_rows,
                        )
                        return card
                    assert policy_body is not None
                    policy_res = forecast_policy.upsert_forecast_policy(
                        p,
                        db,
                        policy_body,
                        via=via,
                        client_name=session.channel,
                    )
                    card.status = "confirmed"
                    card.result = tr(
                        "预测策略已保存，已重算 {count} 条周预测基线",
                        count=policy_res.updated_rows,
                    )
                    return card
                if card.kind == "forecast_event":
                    if forecast_action == "delete":
                        assert forecast_id is not None
                        refresh_res = forecast_policy.delete_forecast_event(
                            p,
                            db,
                            forecast_id,
                            via=via,
                            client_name=session.channel,
                        )
                        card.status = "confirmed"
                        card.result = tr(
                            "业务波动事件已删除，已重算 {count} 条周预测基线",
                            count=refresh_res.updated_rows,
                        )
                        return card
                    if forecast_action == "update":
                        assert forecast_id is not None and event_body is not None
                        event_res = forecast_policy.update_forecast_event(
                            p,
                            db,
                            forecast_id,
                            event_body,
                            via=via,
                            client_name=session.channel,
                        )
                        card.status = "confirmed"
                        card.result = tr(
                            "业务波动事件已更新，已重算 {count} 条周预测基线",
                            count=event_res.updated_rows,
                        )
                        return card
                    assert event_body is not None
                    event_res = forecast_policy.create_forecast_event(
                        p,
                        db,
                        event_body,
                        via=via,
                        client_name=session.channel,
                    )
                    card.status = "confirmed"
                    card.result = tr(
                        "业务波动事件已注入，已重算 {count} 条周预测基线",
                        count=event_res.updated_rows,
                    )
                    return card
                if plan_reply:
                    if on_plan_reply is None:
                        raise RuntimeError("on_plan_reply callback is required")
                    result = on_plan_reply(
                        p,
                        db,
                        PlanReplyDemandInput.model_validate(body),
                        via=via,
                        client_name=session.channel,
                    )
                elif card.kind == "leave":
                    assert isinstance(body, LeaveInput)
                    if p.employee_id is None:
                        raise CapacityForbidden()
                    leave_result = register_unavailability(
                        p,
                        db,
                        UnavailabilityInput(
                            employee_id=p.employee_id, **body.model_dump()
                        ),
                        via=via,
                        client_name=session.channel,
                    )
                    card.status = "confirmed"
                    over = (
                        tr(
                            "（以下周次已有任务超出可用负荷：{weeks}）",
                            weeks=tr("、").join(
                                w.isoformat() for w in leave_result.over_weeks
                            ),
                        )
                        if leave_result.over_weeks
                        else ""
                    )
                    card.result = tr(
                        "{result}{over}，编号：{id}",
                        result=tr(RESULTS[card.kind]),
                        over=over,
                        id=leave_result.id,
                    )
                    return card
                elif card.kind == "team_workload":
                    assert isinstance(body, TeamWorkloadInput)
                    team_result = set_weeks(
                        replace(p, is_org_admin=False),
                        db,
                        WorkloadWeeksInput(
                            items=[
                                WorkloadWeekItem(
                                    employee_id=body.employee_id,
                                    other_percent=body.other_percent,
                                )
                            ],
                            start_week=body.start_week,
                            end_week=body.end_week,
                        ),
                        via=via,
                        client_name=session.channel,
                    )
                    card.status = "confirmed"
                    card.result = tr(
                        "{result}，员工：{name}",
                        result=tr(RESULTS[card.kind]),
                        name=team_result.data[0].employee_name,
                    )
                    return card
                else:
                    assert body is not None
                    result = WRITES[name].handler(
                        p,
                        db,
                        **body.model_dump(),
                        via=via,
                        client_name=session.channel,
                    )
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
        card.status = "confirmed"
        if isinstance(result, WorkloadRequestPublic) and result.reviewer_names:
            card.result = tr(
                "{result}（审批人：{reviewers}），编号：{id}",
                result=tr(RESULTS[card.kind]),
                reviewers=tr("、").join(result.reviewer_names),
                id=result.id,
            )
        elif (
            plan_reply
            and isinstance(result, DemandPublic)
            and result.proposal is not None
        ):
            status = tr(
                "排期已生效，已生成正式分配"
                if result.proposal.status == ProposalStatus.COMMITTED
                else "替代排期已预占，等待需求方确认"
                if result.proposal.borrow_progress is None
                else "借调方案已发出，请查看审批进度"
            )
            card.result = tr("{status}，编号：{id}", status=status, id=result.id)
        elif (
            isinstance(body, RespondDemandInput)
            and body.action == "accept"
            and isinstance(result, DemandPublic)
            and result.proposal is not None
            and result.proposal.borrow_progress
        ):
            status = tr(
                proposal.BORROW_COMMITTED
                if result.proposal.status == ProposalStatus.COMMITTED
                else proposal.BORROW_ACCEPTED_PENDING
            )
            card.result = tr("{status}，编号：{id}", status=status, id=result.id)
        else:
            card.result = tr(
                "{result}{over}，编号：{id}",
                result=tr(RESULTS[card.kind]),
                over="",
                id=result.model_dump(mode="json")["id"],
            )
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
