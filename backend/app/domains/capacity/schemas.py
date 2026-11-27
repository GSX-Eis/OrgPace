import math
from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StringConstraints,
    field_validator,
    model_validator,
)

from app.domains.capacity.calendar import MAX_WORKLOAD_WEEKS, WeekLoad
from app.domains.capacity.models import (
    CapacityRequestStatus,
    ForecastModifierKind,
    RequesterPolicy,
)
from app.i18n import tr

Percent = Annotated[int, Field(strict=True, ge=0, le=200)]
CapPercent = Annotated[int, Field(strict=True, ge=0, le=100, multiple_of=20)]
Note = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]
Via = Literal["web", "bot", "feishu", "mcp"]
ReasonCode = Literal["capacity", "skill", "timing", "priority", "scope", "other"]
REASON_LABELS: dict[ReasonCode, str] = {
    "capacity": "人手或余量不足",
    "skill": "能力不匹配",
    "timing": "时间不合适",
    "priority": "与其他工作冲突",
    "scope": "需求不清或范围变化",
    "other": "其他",
}


class CapacityInput(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class CapacitySettingsInput(CapacityInput):
    enabled: StrictBool = False
    requester_policy: RequesterPolicy = RequesterPolicy.EVERYONE
    default_allocation_cap_percent: int = Field(default=70, strict=True, ge=50, le=100)


class WorkloadWeekItem(CapacityInput):
    employee_id: UUID
    other_percent: Percent
    capacity_percent: CapPercent | None = None
    on_leave: StrictBool | None = None
    leave_dates: list[date] | None = None

    @model_validator(mode="after")
    def valid_leave_cap(self) -> WorkloadWeekItem:
        if (
            self.on_leave is False
            and self.capacity_percent is not None
            and self.capacity_percent < 100
        ):
            raise ValueError(tr("未标记请假时可用上限应为 100%"))
        if self.on_leave is True and self.capacity_percent == 100:
            raise ValueError(tr("标记请假时可用上限应低于 100%"))
        if self.leave_dates is not None:
            if len(set(self.leave_dates)) != len(self.leave_dates):
                raise ValueError(tr("请假日期不能重复"))
            if any(day.weekday() >= 5 for day in self.leave_dates):
                raise ValueError(tr("请假日期只能选择工作日（周一至周五）"))
            if self.on_leave is False and self.leave_dates:
                raise ValueError(tr("未标记请假时不能指定请假日期"))
            if self.on_leave is True and not self.leave_dates:
                raise ValueError(tr("标记请假时请选定具体请假日期"))
        return self


class WorkloadWeeksInput(CapacityInput):
    items: Annotated[list[WorkloadWeekItem], Field(min_length=1, max_length=200)]
    start_week: date
    end_week: date

    @model_validator(mode="after")
    def valid_weeks(self) -> WorkloadWeeksInput:
        if self.start_week.weekday() or self.end_week.weekday():
            raise ValueError(tr("请选择周一"))
        if not 0 <= (self.end_week - self.start_week).days <= 25 * 7:
            raise ValueError(tr("请选择 1–26 周"))
        if len({item.employee_id for item in self.items}) != len(self.items):
            raise ValueError(tr("员工不能重复"))
        return self


class WorkloadQuery(CapacityInput):
    from_week: date | None = None
    weeks: int = Field(default=8, ge=1, le=MAX_WORKLOAD_WEEKS)

    @model_validator(mode="after")
    def monday(self) -> WorkloadQuery:
        if self.from_week is not None and self.from_week.weekday():
            raise ValueError(tr("请选择周一"))
        return self


class WorkloadListQuery(WorkloadQuery):
    department_id: UUID | None = None


class LastConfirmed(BaseModel):
    percent: int
    week_start: date
    confirmed_at: datetime


class WorkloadRequestInput(CapacityInput):
    requested_percent: Percent
    reason: Note
    start_week: date
    end_week: date

    @model_validator(mode="after")
    def valid_weeks(self) -> WorkloadRequestInput:
        if self.start_week.weekday() or self.end_week.weekday():
            raise ValueError(tr("请选择周一"))
        if not 0 <= (self.end_week - self.start_week).days <= 25 * 7:
            raise ValueError(tr("请选择 1–26 周"))
        return self


class WorkloadDecisionInput(CapacityInput):
    approve: StrictBool
    note: Note | None = None

    @model_validator(mode="after")
    def returned_note(self) -> WorkloadDecisionInput:
        if not self.approve and not self.note:
            raise ValueError(tr("退回时必须填写说明"))
        return self


class WorkloadRequestPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    employee_id: UUID
    employee_name: str | None = None
    on_behalf_of_name: str | None = None
    reviewer_names: list[str] = Field(default_factory=list)
    requested_percent: int
    start_week: date | None
    end_week: date | None
    reason: str
    status: CapacityRequestStatus
    created_at: datetime
    decided_by_user_id: UUID | None
    decided_for_user_id: UUID | None
    decision_note: str | None
    decided_at: datetime | None


class WorkloadAssignmentSegment(BaseModel):
    id: UUID
    demand_id: UUID
    title: str
    capability_name: str
    requesting_department_name: str
    kind: Literal["committed", "borrow"]
    allocation_percent: int
    start_date: date
    due_date: date
    legacy_start: bool = False


class WorkloadHoldSegment(BaseModel):
    proposal_id: UUID
    demand_id: UUID
    title: str
    capability_name: str
    requesting_department_name: str
    is_borrow: bool
    allocation_percent: int
    start_date: date
    end_date: date
    expires_at: datetime


class WorkloadUnavailabilitySegment(BaseModel):
    id: UUID
    start_date: date
    end_date: date


class WorkloadPublic(BaseModel):
    employee_id: UUID
    employee_name: str
    department_id: UUID | None
    department_name: str | None
    jira_task_count: int | None
    base_percent: int | None
    platform_percent: int
    confirmed_percent: int | None
    band: Literal["unconfirmed", "available", "full", "overloaded"]

    weeks: list[WeekLoad]
    correction_pending: dict[date, bool]
    last_confirmed: LastConfirmed | None
    assignments: list[WorkloadAssignmentSegment] = Field(default_factory=list)
    holds: list[WorkloadHoldSegment] = Field(default_factory=list)
    unavailabilities: list[WorkloadUnavailabilitySegment] = Field(default_factory=list)


class MyWorkload(WorkloadPublic):
    requests: list[WorkloadRequestPublic]
    reviewer_names: list[str]


class WorkloadList(BaseModel):
    data: list[WorkloadPublic]
    count: int


class WorkloadRequestList(BaseModel):
    data: list[WorkloadRequestPublic]
    count: int


class LeaveInput(CapacityInput):
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def valid_dates(self) -> LeaveInput:
        if not 0 <= (self.end_date - self.start_date).days < 92:
            raise ValueError(tr("请选择先后有序的 1–92 天"))
        return self


class TeamWorkloadInput(CapacityInput):
    employee_id: UUID
    other_percent: Percent
    start_week: date
    end_week: date

    @model_validator(mode="after")
    def valid_weeks(self) -> TeamWorkloadInput:
        if self.start_week.weekday() or self.end_week.weekday():
            raise ValueError(tr("请选择周一"))
        if not 0 <= (self.end_week - self.start_week).days <= 25 * 7:
            raise ValueError(tr("请选择 1–26 周"))
        return self


class UnavailabilityInput(LeaveInput):
    employee_id: UUID


class UnavailabilityQuery(CapacityInput):
    employee_id: UUID
    from_date: date = Field(alias="from")
    to_date: date = Field(alias="to")

    @model_validator(mode="after")
    def valid_dates(self) -> UnavailabilityQuery:
        if self.to_date < self.from_date:
            raise ValueError(tr("结束日期不能早于开始日期"))
        return self


class UnavailabilityPublic(CapacityInput):
    id: UUID
    employee_id: UUID
    start_date: date
    end_date: date
    created_by_user_id: UUID
    created_at: datetime
    can_delete: bool
    over_weeks: list[date]


class UnavailabilityList(BaseModel):
    data: list[UnavailabilityPublic]
    count: int


class CarryOverPlanItem(BaseModel):
    employee_id: UUID
    employee_name: str
    baseline_week_start: date
    target_week_start: date
    other_percent: int


class CarryOverBatchItemPublic(BaseModel):
    employee_id: UUID
    employee_name: str
    department_name: str | None = None
    week_start: date
    baseline_week_start: date
    other_percent: int
    before_percent: int | None


class CarryOverBatchPublic(BaseModel):
    id: UUID
    created_at: datetime
    created_by_name: str
    department_names: list[str]
    employee_names: list[str]
    week_starts: list[date]
    reverted_at: datetime | None = None
    items: list[CarryOverBatchItemPublic]


class CarryOverPreview(BaseModel):
    items: list[CarryOverPlanItem]
    skipped_no_baseline: int
    latest_batch: CarryOverBatchPublic | None
    reversible_count: int


class CarryOverRevertPreview(BaseModel):
    latest_batch: CarryOverBatchPublic | None
    reversible_count: int


class CarryOverRevertInput(CapacityInput):
    batch_id: UUID | None = None


class CarryOverCommitItem(CapacityInput):
    employee_id: UUID
    week_start: date
    baseline_week_start: date
    other_percent: Percent

    @model_validator(mode="after")
    def valid_weeks(self) -> CarryOverCommitItem:
        if self.week_start.weekday() or self.baseline_week_start.weekday():
            raise ValueError(tr("请选择周一"))
        return self


class CarryOverCommitInput(CapacityInput):
    items: Annotated[list[CarryOverCommitItem], Field(min_length=1, max_length=200)]

    @model_validator(mode="after")
    def unique_employees(self) -> CarryOverCommitInput:
        if len({item.employee_id for item in self.items}) != len(self.items):
            raise ValueError(tr("员工不能重复"))
        return self


class CarryOverQuery(CapacityInput):
    department_id: UUID | None = None


def _validate_monday_range(start_week: date, end_week: date) -> None:
    if start_week.weekday() or end_week.weekday():
        raise ValueError(tr("请选择周一"))
    if not 0 <= (end_week - start_week).days <= 25 * 7:
        raise ValueError(tr("请选择 1–26 周"))


class ForecastOverrideInput(CapacityInput):
    employee_id: UUID
    start_week: date
    end_week: date
    forecast_other_percent: Percent
    note: str | None = Field(default=None, max_length=200)

    @field_validator("note")
    @classmethod
    def clean_note(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @model_validator(mode="after")
    def valid_weeks(self) -> ForecastOverrideInput:
        _validate_monday_range(self.start_week, self.end_week)
        return self


class ForecastResetQuery(CapacityInput):
    employee_id: UUID
    start_week: date
    end_week: date

    @model_validator(mode="after")
    def valid_weeks(self) -> ForecastResetQuery:
        _validate_monday_range(self.start_week, self.end_week)
        return self


class ForecastRefreshInput(CapacityInput):
    department_id: UUID | None = None


class ForecastRefreshResult(BaseModel):
    updated_rows: int


def _strip_optional_text(value: object) -> object:
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned or None
    return value


def _reject_bool_float(value: object) -> object:
    if isinstance(value, bool):
        raise ValueError(tr("请输入有效数值"))
    return value


class ForecastPolicyInput(CapacityInput):
    department_id: UUID | None = None
    job_family: str | None = Field(default=None, max_length=50)
    retention_rate: float = Field(ge=0.0, le=1.0)
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
    def finite_retention(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError(tr("周延续系数必须是有限数值"))
        return value


class ForecastPolicyPublic(BaseModel):
    id: UUID
    department_id: UUID | None
    department_name: str | None = None
    job_family: str | None
    retention_rate: float
    label: str
    note: str | None
    updated_by_user_id: UUID
    updated_at: datetime
    can_edit: bool


class ForecastConfigPublic(BaseModel):
    default_allocation_cap_percent: int
    default_retention_rate: float
    policies: list[ForecastPolicyPublic]
    job_families: list[str]


class ForecastPolicyMutationResult(BaseModel):
    policy: ForecastPolicyPublic
    updated_rows: int


class ForecastEventInput(CapacityInput):
    department_id: UUID | None = None
    job_family: str | None = Field(default=None, max_length=50)
    title: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)
    ]
    start_week: date
    end_week: date
    modifier_kind: ForecastModifierKind
    modifier_value: float
    reason: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)
    ]

    @field_validator("job_family", mode="before")
    @classmethod
    def clean_job_family(cls, value: object) -> object:
        return _strip_optional_text(value)

    @field_validator("modifier_value", mode="before")
    @classmethod
    def reject_bool_modifier(cls, value: object) -> object:
        return _reject_bool_float(value)

    @model_validator(mode="after")
    def valid_event(self) -> ForecastEventInput:
        _validate_monday_range(self.start_week, self.end_week)
        if not math.isfinite(self.modifier_value):
            raise ValueError(tr("波动幅度必须是有限数值"))
        if self.modifier_kind == ForecastModifierKind.MULTIPLIER and not (
            0.0 <= self.modifier_value <= 2.0
        ):
            raise ValueError(tr("负荷系数须在 0.0 至 2.0 之间"))
        if self.modifier_kind == ForecastModifierKind.DELTA and not (
            -100.0 <= self.modifier_value <= 100.0
        ):
            raise ValueError(tr("负荷偏置须在 -100 至 100 之间"))
        return self


class ForecastEventPublic(BaseModel):
    id: UUID
    department_id: UUID | None
    department_name: str | None = None
    job_family: str | None
    title: str
    start_week: date
    end_week: date
    modifier_kind: ForecastModifierKind
    modifier_value: float
    reason: str
    created_by_user_id: UUID
    updated_by_user_id: UUID
    created_at: datetime
    updated_at: datetime
    can_edit: bool


class ForecastEventList(BaseModel):
    data: list[ForecastEventPublic]
    count: int


class ForecastEventMutationResult(BaseModel):
    event: ForecastEventPublic
    updated_rows: int
