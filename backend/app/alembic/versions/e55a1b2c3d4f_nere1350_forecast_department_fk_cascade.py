"""Add ON DELETE CASCADE to forecast policy and event department foreign keys.

Revision ID: e55a1b2c3d4f
Revises: e54a1b2c3d4f
Create Date: 2026-11-25 02:15:00.000000

"""

import sqlalchemy as sa
from alembic import op

revision = "e55a1b2c3d4f"
down_revision = "e54a1b2c3d4f"
branch_labels = None
depends_on = None

DEPARTMENT_FKS: tuple[tuple[str, str], ...] = (
    ("capacity_forecast_policy", "fk_forecast_policy_department"),
    ("capacity_forecast_event", "fk_forecast_event_department"),
)


def _replace_department_fk(
    table: str, new_name: str | None, *, ondelete: str | None
) -> None:
    inspector = sa.inspect(op.get_bind())
    existing = next(
        (
            fk
            for fk in inspector.get_foreign_keys(table)
            if fk.get("referred_table") == "department"
            and fk.get("constrained_columns") == ["org_id", "department_id"]
            and fk.get("referred_columns") == ["org_id", "id"]
        ),
        None,
    )
    existing_name = existing.get("name") if existing is not None else None
    if existing_name is not None:
        op.drop_constraint(existing_name, table, type_="foreignkey")
    op.create_foreign_key(
        new_name,
        table,
        "department",
        ["org_id", "department_id"],
        ["org_id", "id"],
        ondelete=ondelete,
    )


def upgrade() -> None:
    for table, fk_name in DEPARTMENT_FKS:
        _replace_department_fk(table, fk_name, ondelete="CASCADE")


def downgrade() -> None:
    for table, _ in DEPARTMENT_FKS:
        _replace_department_fk(table, None, ondelete=None)
