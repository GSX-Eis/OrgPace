import ast
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, inspect, text
from sqlmodel import Session, SQLModel, select

from app.domains.org.models import Organization
from app.domains.work.models import Task
from tests.utils.migrations import migrate

REVISION = "e57a1b2c3d4f"
PREVIOUS = "e56a1b2c3d4f"
_BACKEND_DIR = Path(__file__).resolve().parents[1]

# (index_name, table_name, columns, access_method)
EXPECTED_INDEXES: tuple[tuple[str, str, tuple[str, ...], str], ...] = (
    (
        "ix_profile_claim_org_subject",
        "profile_claim",
        ("org_id", "subject_employee_id"),
        "btree",
    ),
    (
        "ix_profile_claim_org_supersedes",
        "profile_claim",
        ("org_id", "supersedes_claim_id"),
        "btree",
    ),
    (
        "ix_evidence_org_subject_status",
        "evidence",
        ("org_id", "subject_employee_id", "status"),
        "btree",
    ),
    ("ix_evidence_org_occurred_at", "evidence", ("org_id", "occurred_at"), "btree"),
    (
        "ix_capacity_demand_org_target_status",
        "capacity_demand",
        ("org_id", "target_department_id", "status"),
        "btree",
    ),
    (
        "ix_capacity_demand_org_requester",
        "capacity_demand",
        ("org_id", "requester_user_id"),
        "btree",
    ),
    (
        "ix_capacity_demand_event_org_demand_created",
        "capacity_demand_event",
        ("org_id", "demand_id", "created_at"),
        "btree",
    ),
    (
        "ix_capacity_assignment_org_emp_status",
        "capacity_assignment",
        ("org_id", "employee_id", "status"),
        "btree",
    ),
    (
        "ix_capacity_assignment_org_demand",
        "capacity_assignment",
        ("org_id", "demand_id"),
        "btree",
    ),
    (
        "ix_capacity_unavailability_org_emp_dates",
        "capacity_unavailability",
        ("org_id", "employee_id", "start_date", "end_date"),
        "btree",
    ),
    (
        "ix_capacity_proposal_line_org_proposal",
        "capacity_proposal_line",
        ("org_id", "proposal_id"),
        "btree",
    ),
    (
        "ix_capacity_proposal_line_org_employee",
        "capacity_proposal_line",
        ("org_id", "employee_id"),
        "btree",
    ),
    (
        "ix_capacity_approval_org_proposal",
        "capacity_approval",
        ("org_id", "proposal_id"),
        "btree",
    ),
    (
        "ix_planning_snapshot_org_case",
        "planning_snapshot",
        ("org_id", "case_id"),
        "btree",
    ),
    (
        "ix_planning_option_org_snapshot",
        "planning_option",
        ("org_id", "snapshot_id"),
        "btree",
    ),
    ("ix_task_attributes_gin", "task", ("attributes",), "gin"),
)


def _alembic_config() -> Config:
    config = Config(str(_BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(_BACKEND_DIR / "app/alembic"))
    config.attributes["configure_logger"] = False
    return config


def _pg_index_specs(engine: Engine) -> dict[str, tuple[str, tuple[str, ...], str]]:
    """Return {index_name: (table_name, ordered_columns, access_method)} from pg_catalog."""
    query = text(
        """
        SELECT
            ic.relname AS index_name,
            tc.relname AS table_name,
            am.amname AS access_method,
            array_agg(a.attname ORDER BY ord.n) AS columns
        FROM pg_index ix
        JOIN pg_class ic ON ic.oid = ix.indexrelid
        JOIN pg_class tc ON tc.oid = ix.indrelid
        JOIN pg_namespace ns ON ns.oid = tc.relnamespace
        JOIN pg_am am ON am.oid = ic.relam
        CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS ord(attnum, n)
        JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = ord.attnum
        WHERE ns.nspname = 'public'
          AND ic.relname = ANY(:names)
        GROUP BY ic.relname, tc.relname, am.amname
        """
    )
    names = [name for name, _, _, _ in EXPECTED_INDEXES]
    with engine.connect() as connection:
        rows = connection.execute(query, {"names": names}).all()
    return {
        row.index_name: (row.table_name, tuple(row.columns), row.access_method)
        for row in rows
    }


def _assert_preserved_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    assert "review_delegation" in inspector.get_table_names()
    assert {
        "preset",
        "baseline_percent",
        "near_weeks",
        "bidirectional_regression",
        "use_jira_signal",
        "use_assignment_signal",
    }.issubset(
        {col["name"] for col in inspector.get_columns("capacity_forecast_policy")}
    )
    assert "no_approval" in {
        col["name"] for col in inspector.get_columns("approval_policy")
    }
    assert "legacy_username" in {col["name"] for col in inspector.get_columns("user")}
    assert "uq_capacity_approval_party" in {
        uc["name"] for uc in inspector.get_unique_constraints("capacity_approval")
    }


@pytest.mark.unit
def test_core_indexes_migration_metadata_and_safety() -> None:
    import app.models  # noqa: F401

    script = ScriptDirectory.from_config(_alembic_config())
    assert script.get_heads() == [REVISION]
    rev = script.get_revision(REVISION)
    assert rev is not None
    assert rev.down_revision == PREVIOUS

    tree = ast.parse(Path(rev.path).read_text(encoding="utf-8"))
    op_calls = {
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "op"
    }
    assert "drop_table" not in op_calls
    assert "drop_column" not in op_calls

    upgrade_fn = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "upgrade"
    )
    upgrade_ops = {
        node.func.attr
        for node in ast.walk(upgrade_fn)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "op"
    }
    assert upgrade_ops == {"create_index"}

    for index_name, table_name, columns, access_method in EXPECTED_INDEXES:
        table = SQLModel.metadata.tables[table_name]
        matched = [idx for idx in table.indexes if idx.name == index_name]
        assert len(matched) == 1, f"Missing model index {index_name} on {table_name}"
        idx = matched[0]
        assert tuple(col.name for col in idx.columns) == columns
        if access_method == "gin":
            assert idx.dialect_options["postgresql"]["using"] == "gin"


def test_core_indexes_migration_roundtrip_and_alembic_check(
    migration_engine: Engine,
) -> None:
    org = Organization(slug=f"core-idx-{uuid4().hex[:8]}", name="索引迁移测试企业")
    with Session(migration_engine) as session:
        session.add(org)
        session.flush()
        org_id = org.id
        task = Task(
            org_id=org_id,
            source="jira",
            external_key=f"IDX-{uuid4().hex[:8]}",
            title="合成任务",
            attributes={"team": "platform", "priority": "high"},
        )
        session.add(task)
        session.flush()
        task_id = task.id
        session.commit()

    expected_map = {
        name: (table, cols, am) for name, table, cols, am in EXPECTED_INDEXES
    }
    assert _pg_index_specs(migration_engine) == expected_map
    _assert_preserved_schema(migration_engine)

    migrate(migration_engine, "downgrade", PREVIOUS)
    assert _pg_index_specs(migration_engine) == {}
    _assert_preserved_schema(migration_engine)
    with Session(migration_engine) as session:
        saved = session.exec(select(Task).where(Task.id == task_id)).one()
        assert saved.attributes == {"team": "platform", "priority": "high"}

    migrate(migration_engine, "upgrade", "head")
    assert _pg_index_specs(migration_engine) == expected_map
    _assert_preserved_schema(migration_engine)
    with Session(migration_engine) as session:
        found = session.exec(
            select(Task).where(
                Task.org_id == org_id,
                Task.__table__.c.attributes.contains({"team": "platform"}),
            )
        ).one()
        assert found.id == task_id

    config = _alembic_config()
    with migration_engine.connect() as connection:
        config.attributes["connection"] = connection
        command.check(config)
