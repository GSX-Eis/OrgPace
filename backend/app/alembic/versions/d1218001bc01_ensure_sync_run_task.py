"""Ensure sync_run_task exists for databases upgraded from pre-#472 c910001bc001."""

import sqlalchemy as sa
from alembic import op

revision = "d1218001bc01"
down_revision = "c910001bc001"
branch_labels = None
depends_on = None

_INDEXES = (
    ("ix_sync_run_task_org_id", ["org_id"]),
    ("ix_sync_run_task_sync_run_id", ["sync_run_id"]),
    ("ix_sync_run_task_task_id", ["task_id"]),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("sync_run_task"):
        op.create_table(
            "sync_run_task",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("org_id", sa.Uuid(), nullable=False),
            sa.Column("sync_run_id", sa.Uuid(), nullable=False),
            sa.Column("task_id", sa.Uuid(), nullable=False),
            sa.ForeignKeyConstraint(["org_id"], ["organization.id"]),
            sa.ForeignKeyConstraint(
                ["org_id", "sync_run_id"], ["sync_run.org_id", "sync_run.id"]
            ),
            sa.ForeignKeyConstraint(["org_id", "task_id"], ["task.org_id", "task.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("org_id", "sync_run_id", "task_id"),
        )
        existing_indexes: set[str] = set()
    else:
        existing_indexes = {
            idx["name"]
            for idx in inspector.get_indexes("sync_run_task")
            if idx["name"] is not None
        }

    for name, columns in _INDEXES:
        index_name = op.f(name)
        if index_name not in existing_indexes:
            op.create_index(index_name, "sync_run_task", columns, unique=False)


def downgrade() -> None:
    # No-op: sync_run_task belongs to d1215001bc01 in the canonical chain, so
    # dropping it here would break downgrades to c910001bc001 and c872001bc001.
    pass
