"""Add default_allocation_cap_percent and capacity_week_forecast.

Revision ID: e53a1b2c3d4f
Revises: e52a1b2c3d4e
Create Date: 2026-11-24 15:30:00.000000

"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e53a1b2c3d4f"
down_revision = "e52a1b2c3d4e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "capacity_setting",
        sa.Column(
            "default_allocation_cap_percent",
            sa.Integer(),
            nullable=False,
            server_default="70",
        ),
    )
    op.create_check_constraint(
        "capacity_setting_default_cap",
        "capacity_setting",
        "default_allocation_cap_percent BETWEEN 50 AND 100",
    )
    op.create_table(
        "capacity_week_forecast",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("employee_id", sa.Uuid(), nullable=False),
        sa.Column("week_start", sa.Date(), nullable=False),
        sa.Column("forecast_other_percent", sa.Integer(), nullable=False),
        sa.Column(
            "source",
            sa.Enum(
                "agent_auto",
                "manager_override",
                name="forecastsource",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("basis_summary", sa.String(length=300), nullable=False),
        sa.Column(
            "signals",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by_user_id", sa.Uuid(), nullable=True),
        sa.CheckConstraint(
            "extract(isodow from week_start) = 1", name="forecast_week_monday"
        ),
        sa.CheckConstraint(
            "forecast_other_percent BETWEEN 0 AND 200", name="forecast_other_percent"
        ),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.ForeignKeyConstraint(
            ["org_id", "employee_id"], ["employee.org_id", "employee.id"]
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "updated_by_user_id"],
            ["org_membership.org_id", "org_membership.user_id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "id"),
        sa.UniqueConstraint("org_id", "employee_id", "week_start"),
    )
    op.create_index(
        op.f("ix_capacity_week_forecast_org_id"),
        "capacity_week_forecast",
        ["org_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_capacity_week_forecast_org_id"), table_name="capacity_week_forecast"
    )
    op.drop_table("capacity_week_forecast")
    op.drop_constraint(
        "capacity_setting_default_cap", "capacity_setting", type_="check"
    )
    op.drop_column("capacity_setting", "default_allocation_cap_percent")
