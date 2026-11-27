from datetime import date, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import Engine, inspect
from sqlmodel import Session, select

from app.domains.capacity.models import CapacityDemand
from app.domains.org.models import Department, Organization, OrgMembership
from app.models import User
from tests.utils.migrations import insert_historical_rows, migrate

PREVIOUS = "d1217001bc01"


def _seed_legacy_demand(session: Session) -> CapacityDemand:
    org = Organization(slug=str(uuid4()), name="合成迁移企业")
    user = User(username=f"{uuid4()}@example.com", hashed_password="unused")
    first = Department(org_id=org.id, name="需求部")
    second = Department(org_id=org.id, name="交付部")
    insert_historical_rows(session, org, user)
    session.add_all([first, second, OrgMembership(org_id=org.id, user_id=user.id)])
    session.flush()
    demand = CapacityDemand(
        org_id=org.id,
        requesting_department_id=first.id,
        requester_user_id=user.id,
        target_department_id=second.id,
        capability_key="delivery",
        capability_name="交付",
        headcount=2,
        allocation_percent=50,
        window_start=date(2026, 12, 1),
        window_end=date(2026, 12, 31),
        description="历史需求保留",
    )
    insert_historical_rows(session, demand)
    session.commit()
    return demand


def test_e52_migration_roundtrip_and_null_guard(migration_engine: Engine) -> None:
    migrate(migration_engine, "downgrade", PREVIOUS)
    with Session(migration_engine) as session:
        legacy = _seed_legacy_demand(session)
        legacy_id = legacy.id
        org_id = legacy.org_id
        first_id = legacy.requesting_department_id
        second_id = legacy.target_department_id
        user_id = legacy.requester_user_id

    migrate(migration_engine, "upgrade", "head")
    cols = {
        col["name"]: col
        for col in inspect(migration_engine).get_columns("capacity_demand")
    }
    assert cols["headcount"]["nullable"] is True
    assert cols["allocation_percent"]["nullable"] is True

    nullable_id = uuid4()
    with Session(migration_engine) as session:
        kept = session.exec(
            select(CapacityDemand).where(CapacityDemand.id == legacy_id)
        ).one()
        assert kept.headcount == 2
        assert kept.allocation_percent == 50

        nullable_row = CapacityDemand(
            id=nullable_id,
            org_id=org_id,
            requesting_department_id=first_id,
            requester_user_id=user_id,
            target_department_id=second_id,
            capability_key="delivery",
            capability_name="交付",
            headcount=None,
            allocation_percent=None,
            window_start=date(2026, 12, 1) + timedelta(days=7),
            window_end=date(2026, 12, 31),
            description="无人数需求",
        )
        session.add(nullable_row)
        session.commit()

    with pytest.raises(RuntimeError, match="Cannot downgrade"):
        migrate(migration_engine, "downgrade", PREVIOUS)

    with Session(migration_engine) as session:
        row = session.get(CapacityDemand, nullable_id)
        assert row is not None
        session.delete(row)
        session.commit()

    migrate(migration_engine, "downgrade", PREVIOUS)
    cols_after = {
        col["name"]: col
        for col in inspect(migration_engine).get_columns("capacity_demand")
    }
    assert cols_after["headcount"]["nullable"] is False
    assert cols_after["allocation_percent"]["nullable"] is False
    migrate(migration_engine, "upgrade", "head")
