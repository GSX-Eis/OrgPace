from datetime import UTC, date, datetime
from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy import Engine
from sqlmodel import Session, select

from app.domains.capacity.models import (
    CapacitySetting,
    CapacityWeekForecast,
    ForecastSource,
)
from app.domains.org.models import Employee, Organization, OrgMembership
from app.models import User
from tests.utils.migrations import migrate


def test_forecast_and_default_cap_migration_roundtrip(migration_engine: Engine) -> None:
    migrate(migration_engine, "downgrade", "e52a1b2c3d4e")
    inspector = sa.inspect(migration_engine)
    assert "capacity_week_forecast" not in inspector.get_table_names()
    setting_cols = {c["name"] for c in inspector.get_columns("capacity_setting")}
    assert "default_allocation_cap_percent" not in setting_cols

    migrate(migration_engine, "upgrade", "head")
    inspector = sa.inspect(migration_engine)
    assert "capacity_week_forecast" in inspector.get_table_names()
    setting_cols = {c["name"] for c in inspector.get_columns("capacity_setting")}
    assert "default_allocation_cap_percent" in setting_cols
    assert any(
        c["name"] == "capacity_setting_default_cap"
        for c in inspector.get_check_constraints("capacity_setting")
    )

    org = Organization(slug="forecast-migration", name="合成预测迁移企业")
    user = User(username=f"{uuid4()}@example.com", hashed_password="unused-synthetic")
    person = Employee(org_id=org.id, display_name="合成员工")
    now = datetime(2026, 11, 23, 8, 0, tzinfo=UTC)
    with Session(migration_engine) as session:
        session.add_all([org, user])
        session.flush()
        session.add_all([person, OrgMembership(org_id=org.id, user_id=user.id)])
        session.flush()
        session.add(
            CapacitySetting(
                org_id=org.id,
                enabled=True,
                default_allocation_cap_percent=75,
                updated_by_user_id=user.id,
            )
        )
        session.add(
            CapacityWeekForecast(
                org_id=org.id,
                employee_id=person.id,
                week_start=date(2026, 11, 30),
                forecast_other_percent=65,
                source=ForecastSource.AGENT_AUTO,
                basis_summary="基于近 4 周已确认均值 65%",
                signals={"history_mean": 65.0, "history_weeks": 4},
                generated_at=now,
            )
        )
        session.commit()
        assert (
            session.exec(
                select(CapacitySetting).where(CapacitySetting.org_id == org.id)
            )
            .one()
            .default_allocation_cap_percent
            == 75
        )
        assert session.exec(
            select(CapacityWeekForecast).where(CapacityWeekForecast.org_id == org.id)
        ).one()

    migrate(migration_engine, "downgrade", "e52a1b2c3d4e")
    inspector = sa.inspect(migration_engine)
    assert "capacity_week_forecast" not in inspector.get_table_names()
    setting_cols = {c["name"] for c in inspector.get_columns("capacity_setting")}
    assert "default_allocation_cap_percent" not in setting_cols

    migrate(migration_engine, "upgrade", "head")
    inspector = sa.inspect(migration_engine)
    assert "capacity_week_forecast" in inspector.get_table_names()
    setting_cols = {c["name"] for c in inspector.get_columns("capacity_setting")}
    assert "default_allocation_cap_percent" in setting_cols
