from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StrictBool,
    computed_field,
    model_validator,
)

from app.domains.planning.models import OptionKind, PlanVerdict
from app.i18n import tr

KIND_LABELS: dict[OptionKind, str] = {
    OptionKind.DIRECT: "直接安排",
    OptionKind.NEWCOMER: "安排新人",
    OptionKind.BORROW: "向其他部门借调",
    OptionKind.DELAY: "推迟交付",
    OptionKind.REDUCE_SCOPE: "缩小范围",
    OptionKind.PHASED: "分阶段交付",
    OptionKind.OPTIMIZED: "优化方案",
    OptionKind.CUSTOM: "自定方案",
}
VERDICT_LABELS: dict[PlanVerdict, str] = {
    PlanVerdict.FEASIBLE: "可行",
    PlanVerdict.CONDITIONAL: "有条件可行",
    PlanVerdict.INFEASIBLE: "不可行",
    PlanVerdict.INSUFFICIENT_DATA: "数据不足",
}


class AssigneeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: UUID
    allocation_percent: int = Field(strict=True, ge=10, le=100)
    start_date: date
    end_date: date


class CreateCaseInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    allow_elastic: StrictBool = False


class OptionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assignees: list[AssigneeInput] = Field(min_length=1)
    locked_employee_ids: list[UUID] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_locks(self) -> OptionInput:
        if not set(self.locked_employee_ids) <= {a.employee_id for a in self.assignees}:
            raise ValueError(tr("锁定人员必须已在方案中"))
        return self


class ReviseInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    change: Literal["replace", "dates", "allocation", "phased", "lock", "unlock"]
    from_employee_id: UUID | None = None
    to_employee_id: UUID | None = None
    employee_id: UUID | None = None
    employee_ids: list[UUID] | None = None
    start_date: date | None = None
    end_date: date | None = None
    allocation_percent: int | None = Field(default=None, strict=True, ge=10, le=100)
    split_date: date | None = None

    @model_validator(mode="after")
    def valid_fields(self) -> ReviseInput:
        fields = {
            "replace": ({"from_employee_id", "to_employee_id"}, set()),
            "dates": ({"start_date", "end_date"}, {"employee_id"}),
            "allocation": ({"allocation_percent"}, {"employee_id"}),
            "phased": ({"split_date"}, set()),
            "lock": ({"employee_ids"}, set()),
            "unlock": ({"employee_ids"}, set()),
        }
        required, optional = fields[self.change]
        present = set(self.model_fields_set) - {"change"}
        if (
            not required <= present
            or any(getattr(self, name) is None for name in required)
            or present - required - optional
        ):
            raise ValueError(tr("快捷修改只能提交这一项所需的字段"))
        if self.employee_ids is not None and not self.employee_ids:
            raise ValueError(tr("至少选择一名人员"))
        return self


class OptionPublic(BaseModel):
    id: UUID
    snapshot_id: UUID
    kind: OptionKind
    params: dict[str, JsonValue]
    verdict: PlanVerdict
    findings: list[dict[str, JsonValue]]
    summary: dict[str, JsonValue]
    created_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def kind_label(self) -> str:
        return tr(KIND_LABELS[self.kind])

    @computed_field  # type: ignore[prop-decorator]
    @property
    def verdict_label(self) -> str:
        return tr(VERDICT_LABELS[self.verdict])


class CasePerson(BaseModel):
    employee_id: UUID
    display_name: str


class CasePublic(BaseModel):
    id: UUID
    demand_id: UUID
    snapshot_id: UUID
    snapshot_created_at: datetime
    data: dict[str, JsonValue]
    stale: bool
    notes: list[str]
    people: list[CasePerson]
    options: list[OptionPublic]


class ExtraCapabilityFeasibilityInput(BaseModel):
    key: str = Field(min_length=1, max_length=200)
    minimum_level: str | None = Field(default=None, max_length=200)
    required: StrictBool = True


class CrossDeptFeasibilityInput(BaseModel):
    capability_key: str = Field(min_length=1, max_length=200)
    minimum_level: str | None = Field(default=None, max_length=200)
    extra_capabilities: list[ExtraCapabilityFeasibilityInput] = Field(
        default_factory=list, max_length=5
    )
    window_start: date
    window_end: date
    estimated_headcount: int | None = Field(default=None, strict=True, ge=1, le=50)
    estimated_allocation_percent: int | None = Field(
        default=None, strict=True, ge=10, le=100
    )

    @model_validator(mode="after")
    def valid_window(self) -> CrossDeptFeasibilityInput:
        if self.window_end < self.window_start:
            raise ValueError(tr("结束日期不能早于开始日期"))
        return self


class CrossDeptFeasibilityDepartment(BaseModel):
    department_id: UUID
    department_name: str
    conclusion: Literal["can_do", "later", "needs_confirmation", "cannot_do"]
    earliest_start_date: date | None = None
    suggested_start_date: date | None = None
    suggested_end_date: date | None = None
    department_load_percent: int | None = None
    regular_used_percent: int | None = None
    elastic_used_percent: int | None = None
    regular_headroom_percent: int | None = None
    elastic_headroom_percent: int | None = None
    load_level: Literal["low", "medium", "high", "very_high", "unknown", "withheld"] = (
        "unknown"
    )
    has_likely_availability: bool | None = None
    is_estimated: bool = False
    exceeds_regular_cap: bool = False
    needs_elastic: bool = False
    data_source: Literal["confirmed", "forecast_baseline", "mixed", "unknown"] = (
        "unknown"
    )


class CrossDeptFeasibilityResult(BaseModel):
    capability_key: str
    window_start: date
    window_end: date
    allocation_cap_percent: int = 70
    departments: list[CrossDeptFeasibilityDepartment]
