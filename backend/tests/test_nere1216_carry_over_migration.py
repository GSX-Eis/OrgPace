from datetime import UTC, date, datetime
from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy import Engine
from sqlmodel import Session, select

from app.domains.capacity.models import CapacityCarryOver, CapacityCarryOverItem
from app.domains.org.models import Employee, Organization, OrgMembership
from app.models import User
from tests.utils.migrations import migrate


def test_carry_over_migration_roundtrip(migration_engine: Engine) -> None:
    migrate(migration_engine, "downgrade", "d1218001bc01")
    inspector = sa.inspect(migration_engine)
    assert "capacity_carry_over" not in inspector.get_table_names()
    assert "capacity_carry_over_item" not in inspector.get_table_names()

    migrate(migration_engine, "upgrade", "head")
    inspector = sa.inspect(migration_engine)
    assert "capacity_carry_over" in inspector.get_table_names()
    assert "capacity_carry_over_item" in inspector.get_table_names()

    org = Organization(slug="carry-over-migration", name="合成企业")
    user = User(username=f"{uuid4()}@example.com", hashed_password="unused-synthetic")
    person = Employee(org_id=org.id, display_name="合成员工")
    now = datetime(2026, 11, 23, 8, 0, tzinfo=UTC)
    with Session(migration_engine) as session:
        session.add_all([org, user])
        session.flush()
        session.add_all([person, OrgMembership(org_id=org.id, user_id=user.id)])
        session.flush()
        batch = CapacityCarryOver(org_id=org.id, created_by_user_id=user.id)
        session.add(batch)
        session.flush()
        session.add(
            CapacityCarryOverItem(
                org_id=org.id,
                batch_id=batch.id,
                employee_id=person.id,
                week_start=date(2026, 11, 30),
                baseline_week_start=date(2026, 11, 23),
                after_percent=50,
                after_confirmed_at=now,
            )
        )
        session.commit()
        assert session.exec(
            select(CapacityCarryOver).where(CapacityCarryOver.org_id == org.id)
        ).one()

    migrate(migration_engine, "downgrade", "d1218001bc01")
    inspector = sa.inspect(migration_engine)
    assert "capacity_carry_over" not in inspector.get_table_names()
    assert "capacity_carry_over_item" not in inspector.get_table_names()

    migrate(migration_engine, "upgrade", "head")
    inspector = sa.inspect(migration_engine)
    assert "capacity_carry_over" in inspector.get_table_names()
    assert "capacity_carry_over_item" in inspector.get_table_names()
