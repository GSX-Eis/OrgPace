"""Domain tests for worker scheduling, periodic task isolation, and alert times."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from procrastinate import periodic
from sqlalchemy import Engine, text
from sqlmodel import Session, select

from app.domains.inbox.models import InboxItem
from app.domains.org.models import (
    Department,
    Organization,
    OrgMembership,
    Role,
    RoleGrant,
)
from app.models import User
from app.worker.app import app
from app.worker.models import WorkerHeartbeat
from app.worker.monitor import dispatch_worker_alerts
from tests import test_worker


# Merged from test_m5_worker_alert_time.py (NERE-631).
def test_alert_times_follow_each_tenant_and_remain_deduplicated(
    migration_engine: Engine,
) -> None:
    beat_at = datetime(2026, 11, 14, 21, 31, 20, 123456, tzinfo=UTC)
    now = beat_at + timedelta(minutes=6)
    with Session(migration_engine) as db:
        beijing = Organization(slug=f"alert-bj-{uuid4()}", name="合成北京企业")
        tokyo = Organization(
            slug=f"alert-tokyo-{uuid4()}",
            name="合成东京企业",
            timezone="Asia/Tokyo",
        )
        for org in (beijing, tokyo):
            user = User(
                username=f"alert-{uuid4()}@example.com", hashed_password="synthetic"
            )
            db.add(org)
            db.add(user)
            db.flush()
            member = OrgMembership(org_id=org.id, user_id=user.id)
            db.add(member)
            db.flush()
            db.add(
                RoleGrant(org_id=org.id, membership_id=member.id, role=Role.ORG_ADMIN)
            )
        db.add(WorkerHeartbeat(beat_at=beat_at))
        db.commit()
        expected = {
            beijing.id: "2026-11-15 05:31",
            tokyo.id: "2026-11-15 06:31",
        }
        dispatch_worker_alerts(db, now)
        first_messages = {}
        for org_id, local_time in expected.items():
            item = db.exec(select(InboxItem).where(InboxItem.org_id == org_id)).one()
            assert f"最后心跳：{local_time}。" in item.message
            assert "+00:00" not in item.message
            assert "T" not in item.message
            assert "123456" not in item.message
            first_messages[org_id] = item.message

    with Session(migration_engine) as restarted:
        dispatch_worker_alerts(restarted, now + timedelta(seconds=10))
        for org_id, first_message in first_messages.items():
            items = restarted.exec(
                select(InboxItem).where(InboxItem.org_id == org_id)
            ).all()
            assert len(items) == 1
            assert items[0].message == first_message


# Merged from test_m5_worker_periodic_isolation.py (NERE-629).
@pytest.mark.parametrize("worker", ["ping", "recovery"])
def test_workers_do_not_run_periodic_tasks_after_the_hour(
    db: Session, shared_demo: tuple, monkeypatch: pytest.MonkeyPatch, worker: str
) -> None:
    org_id = next(iter(shared_demo[1].values())).org_id
    statement = (
        select(Department.id, Department.capability_failed_at)
        .where(Department.org_id == org_id)
        .order_by(Department.id)
    )
    before = db.exec(statement).all()
    jobs_before = db.execute(text("SELECT id FROM procrastinate_jobs")).scalars().all()
    defers_before = db.execute(
        text("SELECT id FROM procrastinate_periodic_defers")
    ).all()
    now = datetime(2026, 11, 15, 1, 1, tzinfo=UTC).timestamp()
    monkeypatch.setattr(periodic, "time", SimpleNamespace(time=lambda: now))
    due = list(periodic.PeriodicDeferrer(app.periodic_registry).get_previous_tasks(now))
    assert "capabilities.fill_department_defaults" in {
        task.task.name for task, _ in due
    }

    if worker == "ping":
        test_worker.test_ping_job_succeeds(db, monkeypatch)
        expected_task = "system.ping"
    else:
        test_worker.test_recover_only_stalled_jobs(db, "missing", monkeypatch)
        expected_task = "system.retry_stalled_jobs"

    db.rollback()
    assert db.exec(statement).all() == before
    new_tasks = db.execute(text("SELECT id, task_name FROM procrastinate_jobs")).all()
    assert [name for job_id, name in new_tasks if job_id not in jobs_before] == [
        expected_task
    ]
    assert (
        db.execute(text("SELECT id FROM procrastinate_periodic_defers")).all()
        == defers_before
    )
