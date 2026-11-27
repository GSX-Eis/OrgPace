"""Add user.preferred_locale and inbox_item.message_en for bilingual UI.

Revision ID: e56a1b2c3d4f
Revises: e55a1b2c3d4f
Create Date: 2026-11-26 15:20:00.000000

"""

import sqlalchemy as sa
from alembic import op

revision = "e56a1b2c3d4f"
down_revision = "e55a1b2c3d4f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user",
        sa.Column("preferred_locale", sa.String(length=8), nullable=True),
    )
    op.create_check_constraint(
        "ck_user_preferred_locale",
        "user",
        "preferred_locale IS NULL OR preferred_locale IN ('zh-CN', 'en')",
    )
    op.add_column(
        "inbox_item",
        sa.Column("message_en", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("inbox_item", "message_en")
    op.drop_constraint("ck_user_preferred_locale", "user", type_="check")
    op.drop_column("user", "preferred_locale")
