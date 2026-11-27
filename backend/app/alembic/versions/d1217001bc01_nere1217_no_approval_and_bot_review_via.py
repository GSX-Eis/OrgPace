"""Add no_approval policy fields and bot review_via value.

Revision ID: d1217001bc01
Revises: c916001bc001
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "d1217001bc01"
down_revision = "c916001bc001"
branch_labels = None
depends_on = None

OLD_VIA = "'web','mcp','im','policy','sync','direct'"


def upgrade() -> None:
    op.add_column(
        "approval_policy",
        sa.Column(
            "no_approval", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )
    op.add_column(
        "approval_policy",
        sa.Column(
            "no_approval_category_overrides",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.drop_constraint("review_decision_via_check", "review_decision")
    op.create_check_constraint(
        "review_decision_via_check",
        "review_decision",
        f"via IN ({OLD_VIA},'bot')",
    )


def downgrade() -> None:
    op.execute(
        "UPDATE review_decision SET via = 'web' WHERE via = 'bot' AND client_name = '网页'"
    )
    op.execute("UPDATE review_decision SET via = 'im' WHERE via = 'bot'")
    op.drop_constraint("review_decision_via_check", "review_decision")
    op.create_check_constraint(
        "review_decision_via_check",
        "review_decision",
        f"via IN ({OLD_VIA})",
    )
    op.drop_column("approval_policy", "no_approval_category_overrides")
    op.drop_column("approval_policy", "no_approval")
