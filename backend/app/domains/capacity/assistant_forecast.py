"""Capacity assistant forecast policy and event preview/confirm helpers."""

import math
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, JsonValue, field_validator, model_validator
from sqlmodel import Session, col, func, select

from app.authz.policies import can_manage_department
from app.authz.principal import Principal
from app.domains.bot import schemas as s
from app.domains.capacity import forecast_policy
from app.domains.capacity.assistant_demands import DraftTextInvalid
from app.domains.capacity.common import CapacityNotFound
from app.domains.capacity.models import (
    CapacityForecastEvent,
    CapacityForecastPolicy,
    ForecastModifierKind,
)
from app.domains.capacity.schemas import (
    CapacityInput,
    ForecastEventInput,
    ForecastPolicyInput,
    Via,
    _reject_bool_float,
    _strip_optional_text,
)
from app.domains.org.models import Department, Employee, EmploymentStatus
from app.i18n import tr


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


@dataclass(frozen=True)
class ForecastAction:
    action: str
    target_id: UUID | None = None
    body: BaseModel | None = None


def parse_forecast_policy_arguments(arguments: dict[str, JsonValue]) -> ForecastAction:
    raw_action = arguments.get("action")
    if raw_action == "delete":
        return ForecastAction("delete", target_id=UUID(str(arguments["policy_id"])))
    if raw_action == "upsert":
        return ForecastAction(
            "upsert",
            body=ForecastPolicyInput.model_validate(
                {k: v for k, v in arguments.items() if k != "action"}
            ),
        )
    raise ValueError(tr("不支持的策略操作"))


def execute_forecast_policy(
    p: Principal,
    db: Session,
    parsed: ForecastAction,
    *,
    via: Via,
    client_name: str,
) -> str:
    if parsed.action == "delete":
        assert parsed.target_id is not None
        refresh_res = forecast_policy.delete_forecast_policy(
            p, db, parsed.target_id, via=via, client_name=client_name
        )
        return tr(
            "预测策略已删除，已重算 {count} 条周预测基线",
            count=refresh_res.updated_rows,
        )
    assert isinstance(parsed.body, ForecastPolicyInput)
    policy_res = forecast_policy.upsert_forecast_policy(
        p, db, parsed.body, via=via, client_name=client_name
    )
    return tr(
        "预测策略已保存，已重算 {count} 条周预测基线",
        count=policy_res.updated_rows,
    )


def parse_forecast_event_arguments(arguments: dict[str, JsonValue]) -> ForecastAction:
    raw_action = arguments.get("action")
    if raw_action == "delete":
        return ForecastAction("delete", target_id=UUID(str(arguments["event_id"])))
    if raw_action == "update":
        return ForecastAction(
            "update",
            target_id=UUID(str(arguments["event_id"])),
            body=ForecastEventInput.model_validate(
                {k: v for k, v in arguments.items() if k not in ("action", "event_id")}
            ),
        )
    if raw_action == "create":
        return ForecastAction(
            "create",
            body=ForecastEventInput.model_validate(
                {k: v for k, v in arguments.items() if k != "action"}
            ),
        )
    raise ValueError(tr("不支持的事件操作"))


def execute_forecast_event(
    p: Principal,
    db: Session,
    parsed: ForecastAction,
    *,
    via: Via,
    client_name: str,
) -> str:
    if parsed.action == "delete":
        assert parsed.target_id is not None
        refresh_res = forecast_policy.delete_forecast_event(
            p, db, parsed.target_id, via=via, client_name=client_name
        )
        return tr(
            "业务波动事件已删除，已重算 {count} 条周预测基线",
            count=refresh_res.updated_rows,
        )
    assert isinstance(parsed.body, ForecastEventInput)
    if parsed.action == "update":
        assert parsed.target_id is not None
        event_res = forecast_policy.update_forecast_event(
            p, db, parsed.target_id, parsed.body, via=via, client_name=client_name
        )
        return tr(
            "业务波动事件已更新，已重算 {count} 条周预测基线",
            count=event_res.updated_rows,
        )
    created_res = forecast_policy.create_forecast_event(
        p, db, parsed.body, via=via, client_name=client_name
    )
    return tr(
        "业务波动事件已注入，已重算 {count} 条周预测基线",
        count=created_res.updated_rows,
    )
