"""E52 nullable demand headcount and allocation_percent.

Revision ID: e52a1b2c3d4e
Revises: d1217001bc01
Create Date: 2026-11-23 17:50:00.000000

"""

import sqlalchemy as sa
from alembic import op

revision = "e52a1b2c3d4e"
down_revision = "d1217001bc01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("demand_headcount", "capacity_demand", type_="check")
    op.drop_constraint("demand_allocation", "capacity_demand", type_="check")
    op.alter_column(
        "capacity_demand",
        "headcount",
        existing_type=sa.Integer(),
        nullable=True,
    )
    op.alter_column(
        "capacity_demand",
        "allocation_percent",
        existing_type=sa.Integer(),
        nullable=True,
    )
    op.create_check_constraint(
        "demand_headcount",
        "capacity_demand",
        "headcount IS NULL OR headcount BETWEEN 1 AND 50",
    )
    op.create_check_constraint(
        "demand_allocation",
        "capacity_demand",
        "allocation_percent IS NULL OR allocation_percent BETWEEN 10 AND 100",
    )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("LOCK TABLE capacity_demand IN SHARE ROW EXCLUSIVE MODE"))
    null_count = conn.execute(
        sa.text(
            "SELECT count(*) FROM capacity_demand "
            "WHERE headcount IS NULL OR allocation_percent IS NULL"
        )
    ).scalar_one()
    if null_count:
        raise RuntimeError(
            f"Cannot downgrade: {null_count} capacity_demand rows have NULL headcount or allocation_percent"
        )
    op.drop_constraint("demand_headcount", "capacity_demand", type_="check")
    op.drop_constraint("demand_allocation", "capacity_demand", type_="check")
    op.alter_column(
        "capacity_demand",
        "allocation_percent",
        existing_type=sa.Integer(),
        nullable=False,
    )
    op.alter_column(
        "capacity_demand",
        "headcount",
        existing_type=sa.Integer(),
        nullable=False,
    )
    op.create_check_constraint(
        "demand_headcount",
        "capacity_demand",
        "headcount BETWEEN 1 AND 50",
    )
    op.create_check_constraint(
        "demand_allocation",
        "capacity_demand",
        "allocation_percent BETWEEN 10 AND 100",
    )
