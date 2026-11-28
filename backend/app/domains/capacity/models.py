from datetime import date, datetime
from enum import StrEnum
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

from app.domains.base import TenantRecord, enum_type, tenant_fk, utc_now


def member_fk(column: str) -> ForeignKeyConstraint:
    return ForeignKeyConstraint(
        ["org_id", column], ["org_membership.org_id", "org_membership.user_id"]
    )


class RequesterPolicy(StrEnum):
    EVERYONE = "everyone"
    MANAGERS = "managers"


class CapacityRequestStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    RETURNED = "returned"


class DemandStatus(StrEnum):
    SUBMITTED = "submitted"
    REPLIED = "replied"
    ACCEPTED = "accepted"
    WITHDRAWN = "withdrawn"


class DemandEventKind(StrEnum):
    SUBMITTED = "submitted"
    REPLIED = "replied"
    FOLLOW_UP = "follow_up"
    ACCEPTED = "accepted"
    WITHDRAWN = "withdrawn"
    COMMITMENT_CHANGED = "commitment_changed"
    COMMITTED = "committed"
    PROPOSAL_FAILED = "proposal_failed"


class DemandOutcome(StrEnum):
    CAN_DO = "can_do"
    PARTIAL = "partial"
    NOT_NOW = "not_now"


class TrackingState(StrEnum):
    NO_TASKS = "no_tasks"
    ON_TRACK = "on_track"
    TASKS_DONE = "tasks_done"
    OVERDUE = "overdue"
    HANDED_OVER = "handed_over"
    STATUS_UNKNOWN = "status_unknown"


TRACKING_STATE_CHECK = "tracking_state IN ('no_tasks', 'on_track', 'tasks_done', 'overdue', 'handed_over', 'status_unknown')"


class AssignmentStatus(StrEnum):
    ACTIVE = "active"
    DONE = "done"
    CANCELLED = "cancelled"


class ForecastSource(StrEnum):
    AGENT_AUTO = "agent_auto"
    MANAGER_OVERRIDE = "manager_override"


class ForecastPreset(StrEnum):  # deprecated: retained until drop migration
    PULSE = "pulse"
    PROJECT = "project"
    CYCLICAL = "cyclical"
    CUSTOM = "custom"


class ForecastModifierKind(StrEnum):
    MULTIPLIER = "multiplier"
    DELTA = "delta"


class CapacitySetting(TenantRecord, table=True):
    __tablename__ = "capacity_setting"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        UniqueConstraint("org_id"),
        member_fk("updated_by_user_id"),
        CheckConstraint(
            "default_allocation_cap_percent BETWEEN 50 AND 100",
            name="capacity_setting_default_cap",
        ),
    )
    enabled: bool = False
    requester_policy: RequesterPolicy = Field(
        default=RequesterPolicy.EVERYONE, sa_type=enum_type(RequesterPolicy)
    )
    default_allocation_cap_percent: int = 70
    updated_by_user_id: UUID
    updated_at: datetime = Field(
        default_factory=utc_now, sa_type=DateTime(timezone=True)
    )


class CapacityWeek(TenantRecord, table=True):
    __tablename__ = "capacity_week"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        UniqueConstraint("org_id", "employee_id", "week_start"),
        tenant_fk("employee_id", "employee"),
        member_fk("confirmed_by_user_id"),
        CheckConstraint("other_percent BETWEEN 0 AND 200", name="week_percent"),
        CheckConstraint("extract(isodow from week_start) = 1", name="week_monday"),
    )
    employee_id: UUID
    week_start: date
    other_percent: int
    confirmed_by_user_id: UUID
    confirmed_at: datetime = Field(
        default_factory=utc_now, sa_type=DateTime(timezone=True)
    )


class CapacityUnavailability(TenantRecord, table=True):
    __tablename__ = "capacity_unavailability"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        tenant_fk("employee_id", "employee"),
        member_fk("created_by_user_id"),
        Index(
            "ix_capacity_unavailability_org_emp_dates",
            "org_id",
            "employee_id",
            "start_date",
            "end_date",
        ),
        CheckConstraint("end_date >= start_date", name="unavailability_dates"),
    )
    employee_id: UUID
    start_date: date
    end_date: date
    created_by_user_id: UUID


class CapacityDecision(SQLModel):
    status: CapacityRequestStatus = Field(
        default=CapacityRequestStatus.PENDING, sa_type=enum_type(CapacityRequestStatus)
    )
    reason: str = Field(min_length=1, max_length=500)
    decided_by_user_id: UUID | None = None
    decided_for_user_id: UUID | None = None
    decision_note: str | None = Field(default=None, max_length=500)
    decided_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))


class CapacityWorkloadRequest(CapacityDecision, TenantRecord, table=True):
    __tablename__ = "capacity_workload_request"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        tenant_fk("employee_id", "employee"),
        member_fk("decided_by_user_id"),
        member_fk("decided_for_user_id"),
        CheckConstraint(
            "requested_percent BETWEEN 0 AND 200", name="requested_percent"
        ),
        CheckConstraint("length(reason) BETWEEN 1 AND 500", name="workload_reason"),
        CheckConstraint(
            "(start_week IS NULL AND end_week IS NULL) OR "
            "(start_week IS NOT NULL AND end_week IS NOT NULL AND start_week <= end_week "
            "AND extract(isodow from start_week) = 1 AND extract(isodow from end_week) = 1)",
            name="request_weeks",
        ),
        Index(
            "uq_capacity_workload_pending",
            "org_id",
            "employee_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )
    employee_id: UUID
    requested_percent: int
    start_week: date | None = None
    end_week: date | None = None


REASON_CODE_CHECK = (
    "reason_code IN ('capacity', 'skill', 'timing', 'priority', 'scope', 'other')"
)


class CapacityProject(TenantRecord, table=True):
    __tablename__ = "capacity_project"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        tenant_fk("requesting_department_id", "department"),
        member_fk("requester_user_id"),
        CheckConstraint("length(title) BETWEEN 1 AND 100", name="project_title"),
        CheckConstraint("length(description) <= 2000", name="project_description"),
    )
    requesting_department_id: UUID
    requester_user_id: UUID
    title: str = Field(max_length=100)
    description: str = Field(max_length=2000)


class CapacityDemand(TenantRecord, table=True):
    __tablename__ = "capacity_demand"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        tenant_fk("requesting_department_id", "department"),
        tenant_fk("target_department_id", "department"),
        ForeignKeyConstraint(
            ["org_id", "project_id"],
            ["capacity_project.org_id", "capacity_project.id"],
            name="fk_demand_project",
        ),
        Index("ix_capacity_demand_project", "org_id", "project_id"),
        Index(
            "ix_capacity_demand_org_target_status",
            "org_id",
            "target_department_id",
            "status",
        ),
        Index("ix_capacity_demand_org_requester", "org_id", "requester_user_id"),
        CheckConstraint(
            "project_id IS NULL OR (role_name IS NOT NULL AND length(role_name) BETWEEN 1 AND 50)",
            name="demand_project_role",
        ),
        member_fk("requester_user_id"),
        CheckConstraint(
            "headcount IS NULL OR headcount BETWEEN 1 AND 50", name="demand_headcount"
        ),
        CheckConstraint(
            "allocation_percent IS NULL OR allocation_percent BETWEEN 10 AND 100",
            name="demand_allocation",
        ),
        CheckConstraint("window_end >= window_start", name="demand_window"),
        CheckConstraint(
            "committed_end_date >= committed_start_date", name="demand_commitment"
        ),
        CheckConstraint(
            "length(description) BETWEEN 1 AND 2000", name="demand_description"
        ),
    )
    requesting_department_id: UUID
    requester_user_id: UUID
    target_department_id: UUID
    capability_key: str
    capability_name: str
    minimum_level: str | None = None
    headcount: int | None = None
    allocation_percent: int | None = None
    window_start: date
    window_end: date
    description: str = Field(max_length=2000)
    status: DemandStatus = Field(
        default=DemandStatus.SUBMITTED, sa_type=enum_type(DemandStatus)
    )
    committed_start_date: date | None = None
    committed_end_date: date | None = None
    revision: int = 1

    project_id: UUID | None = None
    role_name: str | None = Field(default=None, max_length=50)
    extra_capabilities: list[dict[str, JsonValue]] = Field(
        default_factory=list,
        sa_column=Column(JSONB, nullable=False, server_default=text("'[]'::jsonb")),
    )


class CapacityDemandDependency(SQLModel, table=True):
    __tablename__ = "capacity_demand_dependency"
    __table_args__ = (
        tenant_fk("project_id", "capacity_project"),
        tenant_fk("demand_id", "capacity_demand"),
        tenant_fk("depends_on_demand_id", "capacity_demand"),
        Index("ix_capacity_demand_dependency_project", "org_id", "project_id"),
        CheckConstraint(
            "demand_id <> depends_on_demand_id", name="dependency_not_self"
        ),
    )
    org_id: UUID = Field(primary_key=True)
    project_id: UUID
    demand_id: UUID = Field(primary_key=True)
    depends_on_demand_id: UUID = Field(primary_key=True)


class CapacityDemandEvent(TenantRecord, table=True):
    __tablename__ = "capacity_demand_event"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        tenant_fk("demand_id", "capacity_demand"),
        member_fk("actor_user_id"),
        Index(
            "ix_capacity_demand_event_org_demand_created",
            "org_id",
            "demand_id",
            "created_at",
        ),
        CheckConstraint(REASON_CODE_CHECK, name="demand_event_reason_code"),
        CheckConstraint("length(text) <= 2000", name="demand_event_text"),
        CheckConstraint(
            "via IN ('web', 'bot', 'feishu', 'mcp')", name="demand_event_via"
        ),
    )
    demand_id: UUID
    kind: DemandEventKind = Field(sa_type=enum_type(DemandEventKind))
    actor_user_id: UUID
    reason_code: str | None = None
    text: str = Field(max_length=2000)
    outcome: DemandOutcome | None = Field(
        default=None, sa_type=enum_type(DemandOutcome)
    )
    start_date: date | None = None
    end_date: date | None = None
    basis: dict[str, JsonValue] = Field(
        default_factory=dict, sa_column=Column(JSONB, nullable=False)
    )
    via: str


class CapacityAssignment(TenantRecord, table=True):
    __tablename__ = "capacity_assignment"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        tenant_fk("demand_id", "capacity_demand"),
        tenant_fk("employee_id", "employee"),
        tenant_fk("proposal_line_id", "capacity_proposal_line"),
        member_fk("assigned_by_user_id"),
        CheckConstraint(TRACKING_STATE_CHECK, name="assignment_tracking_state"),
        CheckConstraint(
            "allocation_percent BETWEEN 10 AND 100", name="assignment_allocation"
        ),
        CheckConstraint(
            "start_date IS NULL OR start_date <= due_date", name="assignment_dates"
        ),
        Index(
            "uq_capacity_assignment_active",
            "org_id",
            "demand_id",
            "employee_id",
            unique=True,
            postgresql_where=text("status = 'active' AND proposal_line_id IS NULL"),
        ),
        Index(
            "uq_capacity_assignment_proposal_line",
            "org_id",
            "proposal_line_id",
            unique=True,
            postgresql_where=text("proposal_line_id IS NOT NULL"),
        ),
        Index(
            "ix_capacity_assignment_org_emp_status",
            "org_id",
            "employee_id",
            "status",
        ),
        Index("ix_capacity_assignment_org_demand", "org_id", "demand_id"),
    )
    demand_id: UUID
    employee_id: UUID
    allocation_percent: int
    start_date: date | None = None
    due_date: date
    status: AssignmentStatus = Field(
        default=AssignmentStatus.ACTIVE, sa_type=enum_type(AssignmentStatus)
    )
    assigned_by_user_id: UUID
    proposal_line_id: UUID | None = None
    closed_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))

    tracking_state: TrackingState | None = Field(default=None, sa_type=String)
    tracking_changed_at: datetime | None = Field(
        default=None, sa_type=DateTime(timezone=True)
    )


class CapacityAssignmentTask(TenantRecord, table=True):
    __tablename__ = "capacity_assignment_task"
    __table_args__ = (
        tenant_fk("assignment_id", "capacity_assignment"),
        tenant_fk("task_id", "task"),
        member_fk("linked_by_user_id"),
        UniqueConstraint("org_id", "assignment_id", "task_id"),
    )
    assignment_id: UUID
    task_id: UUID
    linked_by_user_id: UUID


class CapacityExtensionRequest(CapacityDecision, TenantRecord, table=True):
    __tablename__ = "capacity_extension_request"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        tenant_fk("assignment_id", "capacity_assignment"),
        member_fk("decided_by_user_id"),
        member_fk("decided_for_user_id"),
        CheckConstraint("length(reason) BETWEEN 1 AND 500", name="extension_reason"),
        Index(
            "uq_capacity_extension_pending",
            "org_id",
            "assignment_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )
    assignment_id: UUID
    requested_due_date: date


class ProposalStatus(StrEnum):
    PENDING = "pending"
    COMMITTED = "committed"
    FAILED = "failed"
    WITHDRAWN = "withdrawn"


class CapacityProposal(TenantRecord, table=True):
    __tablename__ = "capacity_proposal"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        tenant_fk("demand_id", "capacity_demand"),
        tenant_fk("replaces_proposal_id", "capacity_proposal"),
        member_fk("proposed_by_user_id"),
        CheckConstraint("kind IN ('initial', 'change')", name="proposal_kind"),
        CheckConstraint(
            "(status = 'failed' AND fail_reason IS NOT NULL AND fail_reason IN "
            "('rejected', 'expired', 'recheck_failed', 'borrow_declined')) OR "
            "(status <> 'failed' AND fail_reason IS NULL)",
            name="proposal_failure",
        ),
        Index(
            "uq_capacity_proposal_pending",
            "org_id",
            "demand_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )
    demand_id: UUID
    kind: str = "initial"
    status: ProposalStatus = Field(
        default=ProposalStatus.PENDING, sa_type=enum_type(ProposalStatus)
    )
    fail_reason: str | None = None
    source_option_id: UUID
    replaces_proposal_id: UUID | None = None
    demand_revision: int
    proposed_by_user_id: UUID
    hold_expires_at: datetime = Field(sa_type=DateTime(timezone=True))
    committed_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    revision: int = 1


class CapacityProposalLine(TenantRecord, table=True):
    __tablename__ = "capacity_proposal_line"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        UniqueConstraint("org_id", "proposal_id", "id"),
        tenant_fk("proposal_id", "capacity_proposal"),
        tenant_fk("employee_id", "employee"),
        tenant_fk("lender_department_id", "department"),
        Index("ix_capacity_proposal_line_org_proposal", "org_id", "proposal_id"),
        Index("ix_capacity_proposal_line_org_employee", "org_id", "employee_id"),
        CheckConstraint(
            "employee_id IS NOT NULL OR lender_department_id IS NOT NULL",
            name="proposal_line_subject",
        ),
        CheckConstraint(
            "allocation_percent BETWEEN 10 AND 100", name="proposal_line_allocation"
        ),
        CheckConstraint("start_date <= end_date", name="proposal_line_dates"),
    )
    proposal_id: UUID
    employee_id: UUID | None = None
    lender_department_id: UUID | None = None
    allocation_percent: int
    start_date: date
    end_date: date
    outside_basis: bool = False


class CapacityApproval(TenantRecord, table=True):
    __tablename__ = "capacity_approval"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        tenant_fk("proposal_id", "capacity_proposal"),
        ForeignKeyConstraint(
            ["org_id", "proposal_id", "line_id"],
            [
                "capacity_proposal_line.org_id",
                "capacity_proposal_line.proposal_id",
                "capacity_proposal_line.id",
            ],
        ),
        member_fk("user_id"),
        Index("ix_capacity_approval_org_proposal", "org_id", "proposal_id"),
        UniqueConstraint(
            "proposal_id",
            "party",
            "line_id",
            name="uq_capacity_approval_party",
            postgresql_nulls_not_distinct=True,
        ),
        CheckConstraint(
            "party IN ('resource_manager', 'requester', 'lender_manager', 'employee')",
            name="approval_party",
        ),
        CheckConstraint(
            "decision IN ('approved', 'rejected')", name="approval_decision"
        ),
        CheckConstraint(
            "length(reason) <= 500 AND (decision <> 'rejected' OR (reason IS NOT NULL AND length(trim(reason)) > 0))",
            name="approval_reason",
        ),
        CheckConstraint("via IN ('web', 'bot', 'feishu', 'mcp')", name="approval_via"),
        CheckConstraint(REASON_CODE_CHECK, name="approval_reason_code"),
    )
    proposal_id: UUID
    line_id: UUID | None = None
    party: str
    decision: str
    reason: str | None = Field(default=None, max_length=500)
    reason_code: str | None = None
    user_id: UUID
    via: str


class CapacityInboxLink(TenantRecord, table=True):
    __tablename__ = "capacity_inbox_link"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        UniqueConstraint("org_id", "inbox_item_id"),
        ForeignKeyConstraint(
            ["org_id", "inbox_item_id"],
            ["inbox_item.org_id", "inbox_item.id"],
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["org_id", "workload_request_id"],
            ["capacity_workload_request.org_id", "capacity_workload_request.id"],
            name="fk_capacity_inbox_link_workload_request",
            ondelete="SET NULL (workload_request_id)",
        ),
        ForeignKeyConstraint(
            ["org_id", "extension_request_id"],
            ["capacity_extension_request.org_id", "capacity_extension_request.id"],
            name="fk_capacity_inbox_link_extension_request",
            ondelete="SET NULL (extension_request_id)",
        ),
    )
    # Covered by the (org_id, id) and (org_id, inbox_item_id) leading unique indexes.
    org_id: UUID = Field(foreign_key="organization.id", index=False)
    inbox_item_id: UUID
    workload_request_id: UUID | None = None
    extension_request_id: UUID | None = None


class CapacityCarryOver(TenantRecord, table=True):
    __tablename__ = "capacity_carry_over"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        member_fk("created_by_user_id"),
        member_fk("reverted_by_user_id"),
    )
    created_by_user_id: UUID
    reverted_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    reverted_by_user_id: UUID | None = None


class CapacityCarryOverItem(TenantRecord, table=True):
    __tablename__ = "capacity_carry_over_item"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        UniqueConstraint("org_id", "batch_id", "employee_id", "week_start"),
        tenant_fk("batch_id", "capacity_carry_over"),
        tenant_fk("employee_id", "employee"),
        member_fk("before_confirmed_by_user_id"),
        CheckConstraint(
            "extract(isodow from week_start) = 1",
            name="carry_over_week_monday",
        ),
        CheckConstraint(
            "extract(isodow from baseline_week_start) = 1",
            name="carry_over_baseline_monday",
        ),
        CheckConstraint(
            "after_percent BETWEEN 0 AND 200",
            name="carry_over_after_percent",
        ),
        CheckConstraint(
            "before_percent IS NULL OR before_percent BETWEEN 0 AND 200",
            name="carry_over_before_percent",
        ),
    )
    batch_id: UUID
    employee_id: UUID
    week_start: date
    baseline_week_start: date
    after_percent: int
    after_confirmed_at: datetime = Field(sa_type=DateTime(timezone=True))
    before_percent: int | None = None
    before_confirmed_by_user_id: UUID | None = None
    before_confirmed_at: datetime | None = Field(
        default=None, sa_type=DateTime(timezone=True)
    )


class CapacityWeekForecast(TenantRecord, table=True):
    __tablename__ = "capacity_week_forecast"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        UniqueConstraint("org_id", "employee_id", "week_start"),
        tenant_fk("employee_id", "employee"),
        member_fk("updated_by_user_id"),
        CheckConstraint(
            "extract(isodow from week_start) = 1", name="forecast_week_monday"
        ),
        CheckConstraint(
            "forecast_other_percent BETWEEN 0 AND 200", name="forecast_other_percent"
        ),
    )
    employee_id: UUID
    week_start: date
    forecast_other_percent: int
    source: ForecastSource = Field(sa_type=enum_type(ForecastSource))
    basis_summary: str = Field(max_length=300)
    signals: dict[str, JsonValue] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )
    generated_at: datetime = Field(
        default_factory=utc_now, sa_type=DateTime(timezone=True)
    )
    updated_by_user_id: UUID | None = None


class CapacityForecastPolicy(TenantRecord, table=True):
    __tablename__ = "capacity_forecast_policy"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        UniqueConstraint(
            "org_id",
            "department_id",
            "job_family",
            name="uq_forecast_policy_scope",
            postgresql_nulls_not_distinct=True,
        ),
        ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["department.org_id", "department.id"],
            ondelete="CASCADE",
        ),
        member_fk("updated_by_user_id"),
        CheckConstraint(
            "job_family IS NULL OR length(trim(job_family)) BETWEEN 1 AND 50",
            name="forecast_policy_job_family",
        ),
        CheckConstraint(
            "baseline_percent BETWEEN 0 AND 150",
            name="forecast_policy_baseline",
        ),
        CheckConstraint(
            "near_weeks BETWEEN 0 AND 12",
            name="forecast_policy_near_weeks",
        ),
        CheckConstraint(
            "decay_rate >= 0.0 AND decay_rate <= 1.0",
            name="forecast_policy_decay_rate",
        ),
    )
    department_id: UUID | None = None
    job_family: str | None = Field(default=None, max_length=50)
    # deprecated: retained until drop migration (preset, baseline_percent, near_weeks,
    # bidirectional_regression, use_jira_signal, use_assignment_signal)
    preset: ForecastPreset | None = Field(
        default=None, sa_type=enum_type(ForecastPreset)
    )
    baseline_percent: int
    near_weeks: int = 4
    decay_rate: float = 0.5
    bidirectional_regression: bool = True
    use_jira_signal: bool = True
    use_assignment_signal: bool = True
    note: str | None = Field(default=None, max_length=200)
    updated_by_user_id: UUID
    updated_at: datetime = Field(
        default_factory=utc_now, sa_type=DateTime(timezone=True)
    )


class CapacityForecastEvent(TenantRecord, table=True):
    __tablename__ = "capacity_forecast_event"
    __table_args__ = (
        UniqueConstraint("org_id", "id"),
        ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["department.org_id", "department.id"],
            ondelete="CASCADE",
        ),
        member_fk("created_by_user_id"),
        member_fk("updated_by_user_id"),
        Index("ix_forecast_event_org_weeks", "org_id", "start_week", "end_week"),
        CheckConstraint(
            "job_family IS NULL OR length(trim(job_family)) BETWEEN 1 AND 50",
            name="forecast_event_job_family",
        ),
        CheckConstraint(
            "length(trim(title)) BETWEEN 1 AND 100",
            name="forecast_event_title",
        ),
        CheckConstraint(
            "extract(isodow from start_week) = 1 AND extract(isodow from end_week) = 1 "
            "AND start_week <= end_week AND end_week <= start_week + 175",
            name="forecast_event_weeks",
        ),
        CheckConstraint(
            "(modifier_kind = 'multiplier' AND modifier_value >= 0.0 AND modifier_value <= 2.0) "
            "OR (modifier_kind = 'delta' AND modifier_value >= -100.0 AND modifier_value <= 100.0)",
            name="forecast_event_modifier",
        ),
        CheckConstraint(
            "length(trim(reason)) BETWEEN 1 AND 300",
            name="forecast_event_reason",
        ),
    )
    department_id: UUID | None = None
    job_family: str | None = Field(default=None, max_length=50)
    title: str = Field(max_length=100)
    start_week: date
    end_week: date
    modifier_kind: ForecastModifierKind = Field(sa_type=enum_type(ForecastModifierKind))
    modifier_value: float
    reason: str = Field(max_length=300)
    created_by_user_id: UUID
    updated_by_user_id: UUID
    updated_at: datetime = Field(
        default_factory=utc_now, sa_type=DateTime(timezone=True)
    )
