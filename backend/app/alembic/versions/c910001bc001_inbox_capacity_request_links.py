"""Link capacity request results to inbox notifications."""

import sqlalchemy as sa
from alembic import op

revision = "c910001bc001"
down_revision = "d1215001bc01"
branch_labels = None
depends_on = None

TABLE = "capacity_inbox_link"
WORKLOAD_FK = "fk_capacity_inbox_link_workload_request"
EXTENSION_FK = "fk_capacity_inbox_link_extension_request"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("inbox_item_id", sa.Uuid(), nullable=False),
        sa.Column("workload_request_id", sa.Uuid(), nullable=True),
        sa.Column("extension_request_id", sa.Uuid(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "id"),
        sa.UniqueConstraint("org_id", "inbox_item_id"),
        sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
        sa.ForeignKeyConstraint(
            ["org_id", "inbox_item_id"],
            ["inbox_item.org_id", "inbox_item.id"],
            ondelete="CASCADE",
        ),
    )
    op.execute(
        f"""
        ALTER TABLE {TABLE}
            ADD CONSTRAINT {WORKLOAD_FK}
                FOREIGN KEY (org_id, workload_request_id)
                REFERENCES capacity_workload_request (org_id, id)
                ON DELETE SET NULL (workload_request_id),
            ADD CONSTRAINT {EXTENSION_FK}
                FOREIGN KEY (org_id, extension_request_id)
                REFERENCES capacity_extension_request (org_id, id)
                ON DELETE SET NULL (extension_request_id);
        """
    )


def downgrade() -> None:
    op.drop_table(TABLE)
