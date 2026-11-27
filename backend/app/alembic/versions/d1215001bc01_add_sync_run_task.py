"""add sync run task link table

Revision ID: d1215001bc01
Revises: c872001bc001
Create Date: 2026-11-23 00:25:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'd1215001bc01'
down_revision = 'c872001bc001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'sync_run_task',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('sync_run_id', sa.Uuid(), nullable=False),
        sa.Column('task_id', sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organization.id']),
        sa.ForeignKeyConstraint(['org_id', 'sync_run_id'], ['sync_run.org_id', 'sync_run.id']),
        sa.ForeignKeyConstraint(['org_id', 'task_id'], ['task.org_id', 'task.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('org_id', 'sync_run_id', 'task_id'),
    )
    op.create_index(op.f('ix_sync_run_task_org_id'), 'sync_run_task', ['org_id'], unique=False)
    op.create_index(op.f('ix_sync_run_task_sync_run_id'), 'sync_run_task', ['sync_run_id'], unique=False)
    op.create_index(op.f('ix_sync_run_task_task_id'), 'sync_run_task', ['task_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_sync_run_task_task_id'), table_name='sync_run_task')
    op.drop_index(op.f('ix_sync_run_task_sync_run_id'), table_name='sync_run_task')
    op.drop_index(op.f('ix_sync_run_task_org_id'), table_name='sync_run_task')
    op.drop_table('sync_run_task')
