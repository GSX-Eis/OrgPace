from datetime import UTC, date, datetime
from uuid import uuid4

import pytest
import sqlalchemy as sa
from sqlalchemy import Engine
from sqlalchemy.engine.interfaces import ReflectedForeignKeyConstraint
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.domains.capacity.models import (
    CapacityForecastEvent,
    CapacityForecastPolicy,
    ForecastModifierKind,
    ForecastPreset,
)
from app.domains.org.models import Department, Organization, OrgMembership
from app.models import User
from tests.utils.migrations import migrate


def test_forecast_policy_and_event_migration_roundtrip(
    migration_engine: Engine,
) -> None:
    migrate(migration_engine, "downgrade", "e53a1b2c3d4f")
    inspector = sa.inspect(migration_engine)
    tables = set(inspector.get_table_names())
    assert "capacity_forecast_policy" not in tables
    assert "capacity_forecast_event" not in tables

    migrate(migration_engine, "upgrade", "head")
    inspector = sa.inspect(migration_engine)
    tables = set(inspector.get_table_names())
    assert "capacity_forecast_policy" in tables
    assert "capacity_forecast_event" in tables
    policy_checks = {
        c["name"] for c in inspector.get_check_constraints("capacity_forecast_policy")
    }
    assert {
        "forecast_policy_job_family",
        "forecast_policy_baseline",
        "forecast_policy_near_weeks",
        "forecast_policy_decay_rate",
    } <= policy_checks
    event_checks = {
        c["name"] for c in inspector.get_check_constraints("capacity_forecast_event")
    }
    assert {
        "forecast_event_job_family",
        "forecast_event_title",
        "forecast_event_weeks",
        "forecast_event_modifier",
        "forecast_event_reason",
    } <= event_checks
    event_indexes = {
        i["name"] for i in inspector.get_indexes("capacity_forecast_event")
    }
    assert "ix_forecast_event_org_weeks" in event_indexes

    org = Organization(slug="forecast-policy-mig", name="合成策略迁移企业")
    user = User(username=f"{uuid4()}@example.com", hashed_password="unused-synthetic")
    dept = Department(org_id=org.id, name="仓储部")
    now = datetime(2026, 11, 25, 8, 0, tzinfo=UTC)
    with Session(migration_engine) as session:
        session.add_all([org, user])
        session.flush()
        session.add_all([dept, OrgMembership(org_id=org.id, user_id=user.id)])
        session.flush()
        session.add(
            CapacityForecastPolicy(
                org_id=org.id,
                department_id=None,
                job_family=None,
                preset=ForecastPreset.CYCLICAL,
                baseline_percent=60,
                near_weeks=2,
                decay_rate=0.5,
                bidirectional_regression=True,
                use_jira_signal=False,
                use_assignment_signal=True,
                note="全企业默认",
                updated_by_user_id=user.id,
                updated_at=now,
            )
        )
        session.add(
            CapacityForecastPolicy(
                org_id=org.id,
                department_id=dept.id,
                job_family="理货",
                preset=ForecastPreset.PULSE,
                baseline_percent=45,
                near_weeks=1,
                decay_rate=0.8,
                bidirectional_regression=True,
                use_jira_signal=False,
                use_assignment_signal=False,
                updated_by_user_id=user.id,
                updated_at=now,
            )
        )
        session.add(
            CapacityForecastEvent(
                org_id=org.id,
                department_id=dept.id,
                job_family=None,
                title="下周无进货",
                start_week=date(2026, 11, 30),
                end_week=date(2026, 12, 7),
                modifier_kind=ForecastModifierKind.MULTIPLIER,
                modifier_value=0.4,
                reason="供应商盘点停发",
                created_by_user_id=user.id,
                updated_by_user_id=user.id,
                updated_at=now,
            )
        )
        session.commit()

        assert (
            len(
                session.exec(
                    select(CapacityForecastPolicy).where(
                        CapacityForecastPolicy.org_id == org.id
                    )
                ).all()
            )
            == 2
        )
        assert (
            len(
                session.exec(
                    select(CapacityForecastEvent).where(
                        CapacityForecastEvent.org_id == org.id
                    )
                ).all()
            )
            == 1
        )

        # Verify NULLS NOT DISTINCT uniqueness on (org_id, department_id, job_family).
        session.add(
            CapacityForecastPolicy(
                org_id=org.id,
                department_id=None,
                job_family=None,
                preset=ForecastPreset.CUSTOM,
                baseline_percent=50,
                updated_by_user_id=user.id,
                updated_at=now,
            )
        )
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()

    migrate(migration_engine, "downgrade", "e53a1b2c3d4f")
    inspector = sa.inspect(migration_engine)
    tables = set(inspector.get_table_names())
    assert "capacity_forecast_policy" not in tables
    assert "capacity_forecast_event" not in tables

    migrate(migration_engine, "upgrade", "head")
    inspector = sa.inspect(migration_engine)
    tables = set(inspector.get_table_names())
    assert "capacity_forecast_policy" in tables
    assert "capacity_forecast_event" in tables


def _department_fk(engine: Engine, table: str) -> ReflectedForeignKeyConstraint:
    inspector = sa.inspect(engine)
    return next(
        fk
        for fk in inspector.get_foreign_keys(table)
        if fk.get("referred_table") == "department"
        and fk.get("constrained_columns") == ["org_id", "department_id"]
        and fk.get("referred_columns") == ["org_id", "id"]
    )


def test_forecast_department_fk_cascade_migration_roundtrip(
    migration_engine: Engine,
) -> None:
    migrate(migration_engine, "downgrade", "e54a1b2c3d4f")
    for table in ("capacity_forecast_policy", "capacity_forecast_event"):
        fk = _department_fk(migration_engine, table)
        assert fk.get("options", {}).get("ondelete") != "CASCADE"

    migrate(migration_engine, "upgrade", "head")
    expected_names = {
        "capacity_forecast_policy": "fk_forecast_policy_department",
        "capacity_forecast_event": "fk_forecast_event_department",
    }
    for table, fk_name in expected_names.items():
        fk = _department_fk(migration_engine, table)
        assert fk["name"] == fk_name
        assert fk.get("options", {}).get("ondelete") == "CASCADE"

    org = Organization(slug="forecast-fk-cascade-mig", name="合成级联迁移企业")
    user = User(username=f"{uuid4()}@example.com", hashed_password="unused-synthetic")
    dept = Department(org_id=org.id, name="待删除部门")
    now = datetime(2026, 11, 25, 8, 0, tzinfo=UTC)
    with Session(migration_engine) as session:
        session.add_all([org, user])
        session.flush()
        session.add_all([dept, OrgMembership(org_id=org.id, user_id=user.id)])
        session.flush()
        session.add(
            CapacityForecastPolicy(
                org_id=org.id,
                department_id=dept.id,
                job_family=None,
                preset=ForecastPreset.PULSE,
                baseline_percent=45,
                updated_by_user_id=user.id,
                updated_at=now,
            )
        )
        session.add(
            CapacityForecastEvent(
                org_id=org.id,
                department_id=dept.id,
                job_family=None,
                title="历史测试事件",
                start_week=date(2026, 11, 16),
                end_week=date(2026, 11, 16),
                modifier_kind=ForecastModifierKind.DELTA,
                modifier_value=-10,
                reason="迁移级联验证",
                created_by_user_id=user.id,
                updated_by_user_id=user.id,
                updated_at=now,
            )
        )
        session.commit()

        session.delete(dept)
        session.commit()

        assert (
            session.exec(
                select(CapacityForecastPolicy).where(
                    CapacityForecastPolicy.org_id == org.id
                )
            ).all()
            == []
        )
        assert (
            session.exec(
                select(CapacityForecastEvent).where(
                    CapacityForecastEvent.org_id == org.id
                )
            ).all()
            == []
        )

    migrate(migration_engine, "downgrade", "e54a1b2c3d4f")
    for table in expected_names:
        fk = _department_fk(migration_engine, table)
        assert fk.get("options", {}).get("ondelete") is None

    migrate(migration_engine, "upgrade", "head")
    for table, fk_name in expected_names.items():
        fk = _department_fk(migration_engine, table)
        assert fk["name"] == fk_name
        assert fk.get("options", {}).get("ondelete") == "CASCADE"
