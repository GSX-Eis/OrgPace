"""Add structured navigation target columns to inbox_item.

Revision ID: e58a1b2c3d4f
Revises: e57a1b2c3d4f
Create Date: 2026-11-29 01:50:00.000000

"""

import sqlalchemy as sa
from alembic import op

revision = "e58a1b2c3d4f"
down_revision = "e57a1b2c3d4f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "inbox_item",
        sa.Column("target_type", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "inbox_item",
        sa.Column("target_id", sa.Uuid(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("inbox_item", "target_id")
    op.drop_column("inbox_item", "target_type")
