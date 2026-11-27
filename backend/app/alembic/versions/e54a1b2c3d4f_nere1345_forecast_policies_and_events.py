"""Add capacity_forecast_policy and capacity_forecast_event tables.

Revision ID: e54a1b2c3d4f
Revises: e53a1b2c3d4f
Create Date: 2026-11-25 00:15:00.000000

"""

import sqlalchemy as sa
from alembic import op

revision = "e54a1b2c3d4f"
down_revision = "e53a1b2c3d4f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "capacity_forecast_policy",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=True),
        sa.Column("job_family", sa.String(length=50), nullable=True),
        sa.Column(
            "preset",
            sa.Enum(
                "pulse",
                "project",
                "cyclical",
                "custom",
                name="forecastpreset",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=True,
        ),
        sa.Column("baseline_percent", sa.Integer(), nullable=False),
        sa.Column("near_weeks", sa.Integer(), nullable=False, server_default="4"),
        sa.Column("decay_rate", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column(
            "bidirectional_regression",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column(
            "use_jira_signal",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column(
            "use_assignment_signal",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column("updated_by_user_id", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "job_family IS NULL OR length(trim(job_family)) BETWEEN 1 AND 50",
            name="forecast_policy_job_family",
        ),
        sa.CheckConstraint(
            "baseline_percent BETWEEN 0 AND 150",
            name="forecast_policy_baseline",
        ),
        sa.CheckConstraint(
            "near_weeks BETWEEN 0 AND 12",
            name="forecast_policy_near_weeks",
        ),
        sa.CheckConstraint(
            "decay_rate >= 0.0 AND decay_rate <= 1.0",
            name="forecast_policy_decay_rate",
        ),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"], ["department.org_id", "department.id"]
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "updated_by_user_id"],
            ["org_membership.org_id", "org_membership.user_id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "id"),
        sa.UniqueConstraint(
            "org_id",
            "department_id",
            "job_family",
            name="uq_forecast_policy_scope",
            postgresql_nulls_not_distinct=True,
        ),
    )
    op.create_index(
        op.f("ix_capacity_forecast_policy_org_id"),
        "capacity_forecast_policy",
        ["org_id"],
        unique=False,
    )

    op.create_table(
        "capacity_forecast_event",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=True),
        sa.Column("job_family", sa.String(length=50), nullable=True),
        sa.Column("title", sa.String(length=100), nullable=False),
        sa.Column("start_week", sa.Date(), nullable=False),
        sa.Column("end_week", sa.Date(), nullable=False),
        sa.Column(
            "modifier_kind",
            sa.Enum(
                "multiplier",
                "delta",
                name="forecastmodifierkind",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("modifier_value", sa.Float(), nullable=False),
        sa.Column("reason", sa.String(length=300), nullable=False),
        sa.Column("created_by_user_id", sa.Uuid(), nullable=False),
        sa.Column("updated_by_user_id", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "job_family IS NULL OR length(trim(job_family)) BETWEEN 1 AND 50",
            name="forecast_event_job_family",
        ),
        sa.CheckConstraint(
            "length(trim(title)) BETWEEN 1 AND 100",
            name="forecast_event_title",
        ),
        sa.CheckConstraint(
            "extract(isodow from start_week) = 1 AND extract(isodow from end_week) = 1 "
            "AND start_week <= end_week AND end_week <= start_week + 175",
            name="forecast_event_weeks",
        ),
        sa.CheckConstraint(
            "(modifier_kind = 'multiplier' AND modifier_value >= 0.0 AND modifier_value <= 2.0) "
            "OR (modifier_kind = 'delta' AND modifier_value >= -100.0 AND modifier_value <= 100.0)",
            name="forecast_event_modifier",
        ),
        sa.CheckConstraint(
            "length(trim(reason)) BETWEEN 1 AND 300",
            name="forecast_event_reason",
        ),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"], ["department.org_id", "department.id"]
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "created_by_user_id"],
            ["org_membership.org_id", "org_membership.user_id"],
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "updated_by_user_id"],
            ["org_membership.org_id", "org_membership.user_id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "id"),
    )
    op.create_index(
        op.f("ix_capacity_forecast_event_org_id"),
        "capacity_forecast_event",
        ["org_id"],
        unique=False,
    )
    op.create_index(
        "ix_forecast_event_org_weeks",
        "capacity_forecast_event",
        ["org_id", "start_week", "end_week"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_forecast_event_org_weeks", table_name="capacity_forecast_event")
    op.drop_index(
        op.f("ix_capacity_forecast_event_org_id"),
        table_name="capacity_forecast_event",
    )
    op.drop_table("capacity_forecast_event")
    op.drop_index(
        op.f("ix_capacity_forecast_policy_org_id"),
        table_name="capacity_forecast_policy",
    )
    op.drop_table("capacity_forecast_policy")
