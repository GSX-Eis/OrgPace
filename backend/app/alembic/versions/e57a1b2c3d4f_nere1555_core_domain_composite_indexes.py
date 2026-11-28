"""Add composite multi-tenant indexes and task attributes GIN index.

Revision ID: e57a1b2c3d4f
Revises: e56a1b2c3d4f
Create Date: 2026-11-28 16:50:00.000000

"""

from alembic import op

revision = "e57a1b2c3d4f"
down_revision = "e56a1b2c3d4f"
branch_labels = None
depends_on = None

_INDEXES: tuple[tuple[str, str, list[str], str | None], ...] = (
    (
        "ix_profile_claim_org_subject",
        "profile_claim",
        ["org_id", "subject_employee_id"],
        None,
    ),
    (
        "ix_profile_claim_org_supersedes",
        "profile_claim",
        ["org_id", "supersedes_claim_id"],
        None,
    ),
    (
        "ix_evidence_org_subject_status",
        "evidence",
        ["org_id", "subject_employee_id", "status"],
        None,
    ),
    (
        "ix_evidence_org_occurred_at",
        "evidence",
        ["org_id", "occurred_at"],
        None,
    ),
    (
        "ix_capacity_demand_org_target_status",
        "capacity_demand",
        ["org_id", "target_department_id", "status"],
        None,
    ),
    (
        "ix_capacity_demand_org_requester",
        "capacity_demand",
        ["org_id", "requester_user_id"],
        None,
    ),
    (
        "ix_capacity_demand_event_org_demand_created",
        "capacity_demand_event",
        ["org_id", "demand_id", "created_at"],
        None,
    ),
    (
        "ix_capacity_assignment_org_emp_status",
        "capacity_assignment",
        ["org_id", "employee_id", "status"],
        None,
    ),
    (
        "ix_capacity_assignment_org_demand",
        "capacity_assignment",
        ["org_id", "demand_id"],
        None,
    ),
    (
        "ix_capacity_unavailability_org_emp_dates",
        "capacity_unavailability",
        ["org_id", "employee_id", "start_date", "end_date"],
        None,
    ),
    (
        "ix_capacity_proposal_line_org_proposal",
        "capacity_proposal_line",
        ["org_id", "proposal_id"],
        None,
    ),
    (
        "ix_capacity_proposal_line_org_employee",
        "capacity_proposal_line",
        ["org_id", "employee_id"],
        None,
    ),
    (
        "ix_capacity_approval_org_proposal",
        "capacity_approval",
        ["org_id", "proposal_id"],
        None,
    ),
    (
        "ix_planning_snapshot_org_case",
        "planning_snapshot",
        ["org_id", "case_id"],
        None,
    ),
    (
        "ix_planning_option_org_snapshot",
        "planning_option",
        ["org_id", "snapshot_id"],
        None,
    ),
    (
        "ix_task_attributes_gin",
        "task",
        ["attributes"],
        "gin",
    ),
)


def upgrade() -> None:
    for index_name, table_name, columns, using in _INDEXES:
        if using is not None:
            op.create_index(
                index_name,
                table_name,
                columns,
                unique=False,
                postgresql_using=using,
            )
        else:
            op.create_index(index_name, table_name, columns, unique=False)


def downgrade() -> None:
    for index_name, table_name, _, _ in reversed(_INDEXES):
        op.drop_index(index_name, table_name=table_name)
