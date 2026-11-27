from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, inspect, text
from sqlmodel import Session, SQLModel, select

from app.authz.principal import Principal
from app.domains.capacity.models import CapacityInboxLink
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.org.models import Organization, OrgMembership
from app.domains.source.models import SourceConnection, SyncRun
from app.domains.work.models import SyncRunTask, Task
from app.domains.work.preview import list_work_records
from app.models import User
from tests.utils.migrations import insert_historical_rows, isolated_database, migrate


def _seed_org_records(
    session: Session,
) -> tuple[UUID, UUID, UUID, str, UUID]:
    org = Organization(slug=f"mig-{uuid4().hex[:8]}", name="迁移测试企业")
    user = User(
        username=f"mig-{uuid4().hex[:8]}@example.com",
        email=f"mig-{uuid4().hex[:8]}@example.com",
        hashed_password="unused",
    )
    insert_historical_rows(session, org, user)

    session.add(OrgMembership(org_id=org.id, user_id=user.id))
    session.flush()

    inbox = InboxItem(
        org_id=org.id,
        recipient_user_id=user.id,
        kind=InboxKind.ADMIN_TODOS,
        message="保留既有收件箱关联",
    )
    insert_historical_rows(session, inbox)

    link = CapacityInboxLink(org_id=org.id, inbox_item_id=inbox.id)
    connection = SourceConnection(
        org_id=org.id,
        kind="jira",
        updated_by_user_id=user.id,
    )
    session.add_all([link, connection])
    session.flush()

    sync_run = SyncRun(
        org_id=org.id,
        connection_id=connection.id,
        requested_by_user_id=user.id,
        status="succeeded",
    )
    task = Task(
        org_id=org.id,
        source="jira",
        external_key=f"KEY-{uuid4().hex[:6]}",
        title="迁移批次关联任务",
    )
    session.add_all([sync_run, task])
    session.flush()
    return org.id, sync_run.id, task.id, task.external_key, link.id


def _assert_sync_run_task_schema(engine: Engine) -> None:
    with engine.connect() as connection:
        context = MigrationContext.configure(
            connection,
            opts={
                "include_name": lambda name, type_, parents: (
                    type_ != "table" or name == "sync_run_task"
                ),
                "include_object": lambda obj, name, type_, reflected, compare_to: (
                    type_ != "table" or name == "sync_run_task"
                ),
            },
        )
        assert compare_metadata(context, SQLModel.metadata) == []


def _assert_batch_preview_rw(
    engine: Engine,
    org_id: UUID,
    sync_run_id: UUID,
    task_id: UUID,
    expected_key: str,
    *,
    insert_link: bool,
) -> None:
    with Session(engine) as session:
        if insert_link:
            session.add(
                SyncRunTask(
                    org_id=org_id,
                    sync_run_id=sync_run_id,
                    task_id=task_id,
                )
            )
            session.commit()
        preview = list_work_records(
            session,
            Principal.system_worker(org_id),
            sync_run_id=sync_run_id,
        )
        assert preview.count == 1
        assert [item.external_key for item in preview.data] == [expected_key]


def test_single_alembic_head() -> None:
    scripts = ScriptDirectory(
        str(Path(__file__).resolve().parents[1] / "app" / "alembic")
    )
    assert len(scripts.get_heads()) == 1


def test_sync_run_task_migration(migration_engine: Engine) -> None:
    migrate(migration_engine, "downgrade", "c872001bc001")
    assert "sync_run_task" not in inspect(migration_engine).get_table_names()

    migrate(migration_engine, "upgrade", "head")
    assert "sync_run_task" in inspect(migration_engine).get_table_names()
    _assert_sync_run_task_schema(migration_engine)


def test_upgrade_from_legacy_c910001bc001_without_sync_run_task(
    migration_engine: Engine,
) -> None:
    migrate(migration_engine, "downgrade", "c910001bc001")
    # Simulate a database upgraded under PR #475 where c910001bc001 had
    # down_revision=c872001bc001 and skipped d1215001bc01.
    with migration_engine.begin() as conn:
        conn.execute(text("DROP TABLE sync_run_task"))
    assert inspect(migration_engine).has_table("capacity_inbox_link")
    assert not inspect(migration_engine).has_table("sync_run_task")

    with Session(migration_engine) as session:
        org_id, sync_run_id, task_id, external_key, link_id = _seed_org_records(session)
        session.commit()

    migrate(migration_engine, "upgrade", "head")
    insp = inspect(migration_engine)
    assert insp.has_table("capacity_inbox_link")
    assert insp.has_table("sync_run_task")
    _assert_sync_run_task_schema(migration_engine)

    with Session(migration_engine) as session:
        assert session.get(CapacityInboxLink, link_id) is not None

    _assert_batch_preview_rw(
        migration_engine,
        org_id,
        sync_run_id,
        task_id,
        external_key,
        insert_link=True,
    )

    migrate(migration_engine, "downgrade", "c910001bc001")
    assert inspect(migration_engine).has_table("sync_run_task")
    migrate(migration_engine, "upgrade", "head")
    migrate(migration_engine, "downgrade", "c872001bc001")
    assert not inspect(migration_engine).has_table("sync_run_task")
    assert not inspect(migration_engine).has_table("capacity_inbox_link")
    migrate(migration_engine, "upgrade", "head")


def test_upgrade_from_current_c910001bc001_preserves_existing_data(
    migration_engine: Engine,
) -> None:
    migrate(migration_engine, "downgrade", "c910001bc001")
    assert inspect(migration_engine).has_table("capacity_inbox_link")
    assert inspect(migration_engine).has_table("sync_run_task")

    with Session(migration_engine) as session:
        org_id, sync_run_id, task_id, external_key, link_id = _seed_org_records(session)
        existing_batch_link = SyncRunTask(
            org_id=org_id,
            sync_run_id=sync_run_id,
            task_id=task_id,
        )
        session.add(existing_batch_link)
        batch_link_id = existing_batch_link.id
        session.commit()

    migrate(migration_engine, "upgrade", "head")
    _assert_sync_run_task_schema(migration_engine)

    with Session(migration_engine) as session:
        assert session.get(CapacityInboxLink, link_id) is not None
        assert session.get(SyncRunTask, batch_link_id) is not None

    _assert_batch_preview_rw(
        migration_engine,
        org_id,
        sync_run_id,
        task_id,
        external_key,
        insert_link=False,
    )

    migrate(migration_engine, "downgrade", "c910001bc001")
    with Session(migration_engine) as session:
        assert session.exec(
            select(SyncRunTask).where(SyncRunTask.id == batch_link_id)
        ).one()
    migrate(migration_engine, "upgrade", "head")


@pytest.mark.slow
def test_fresh_empty_database_install_and_roundtrip(migration_engine: Engine) -> None:
    with isolated_database(
        migration_engine.url, f"fresh_install_{uuid4().hex}"
    ) as fresh_engine:
        migrate(fresh_engine, "upgrade", "head")
        insp = inspect(fresh_engine)
        assert insp.has_table("capacity_inbox_link")
        assert insp.has_table("sync_run_task")
        _assert_sync_run_task_schema(fresh_engine)

        with Session(fresh_engine) as session:
            org_id, sync_run_id, task_id, external_key, _ = _seed_org_records(session)
            session.commit()

        _assert_batch_preview_rw(
            fresh_engine,
            org_id,
            sync_run_id,
            task_id,
            external_key,
            insert_link=True,
        )

        migrate(fresh_engine, "downgrade", "c872001bc001")
        assert not inspect(fresh_engine).has_table("sync_run_task")
        assert not inspect(fresh_engine).has_table("capacity_inbox_link")
        migrate(fresh_engine, "upgrade", "head")
