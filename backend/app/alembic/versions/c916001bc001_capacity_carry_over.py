"""Add capacity carry-over batch and item history tables."""

import sqlalchemy as sa
from alembic import op

revision = "c916001bc001"
down_revision = "d1218001bc01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "capacity_carry_over",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("created_by_user_id", sa.Uuid(), nullable=False),
        sa.Column("reverted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reverted_by_user_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["org_id", "created_by_user_id"],
            ["org_membership.org_id", "org_membership.user_id"],
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "reverted_by_user_id"],
            ["org_membership.org_id", "org_membership.user_id"],
        ),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "id"),
    )
    op.create_index(
        op.f("ix_capacity_carry_over_org_id"),
        "capacity_carry_over",
        ["org_id"],
        unique=False,
    )
    op.create_table(
        "capacity_carry_over_item",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.Column("employee_id", sa.Uuid(), nullable=False),
        sa.Column("week_start", sa.Date(), nullable=False),
        sa.Column("baseline_week_start", sa.Date(), nullable=False),
        sa.Column("after_percent", sa.Integer(), nullable=False),
        sa.Column("after_confirmed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("before_percent", sa.Integer(), nullable=True),
        sa.Column("before_confirmed_by_user_id", sa.Uuid(), nullable=True),
        sa.Column("before_confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "extract(isodow from week_start) = 1",
            name="carry_over_week_monday",
        ),
        sa.CheckConstraint(
            "extract(isodow from baseline_week_start) = 1",
            name="carry_over_baseline_monday",
        ),
        sa.CheckConstraint(
            "after_percent BETWEEN 0 AND 200",
            name="carry_over_after_percent",
        ),
        sa.CheckConstraint(
            "before_percent IS NULL OR before_percent BETWEEN 0 AND 200",
            name="carry_over_before_percent",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "batch_id"],
            ["capacity_carry_over.org_id", "capacity_carry_over.id"],
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "employee_id"],
            ["employee.org_id", "employee.id"],
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "before_confirmed_by_user_id"],
            ["org_membership.org_id", "org_membership.user_id"],
        ),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "id"),
        sa.UniqueConstraint("org_id", "batch_id", "employee_id", "week_start"),
    )
    op.create_index(
        op.f("ix_capacity_carry_over_item_org_id"),
        "capacity_carry_over_item",
        ["org_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_table("capacity_carry_over_item")
    op.drop_table("capacity_carry_over")
