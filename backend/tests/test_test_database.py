import asyncio
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from sqlalchemy import Engine, text
from sqlalchemy.engine import make_url


def test_database_isolation(migration_template: str) -> None:
    from app.core.config import settings
    from app.core.db import engine
    from app.worker.app import app as worker_app
    from tests.utils.migrations import sanitize_db_prefix

    url = make_url(os.environ["DATABASE_URL"])
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    assert (
        url.database is not None
        and f"_{worker}_" in url.database
        and len(url.database) <= 63
    )
    if raw_prefix := os.environ.get("PYTEST_DB_PREFIX", "").strip():
        assert url.database.startswith(f"{sanitize_db_prefix(raw_prefix)}_{worker}_")
    assert engine.url == make_url(str(settings.DATABASE_URL)) == url
    shared_mode = os.environ.get("PYTEST_SHARED_TEMPLATE", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    assert migration_template.startswith(
        "orgpace_tpl_" if shared_mode else "migration_template_"
    )
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT current_database()")) == url.database

    async def queue_database() -> str:
        async with worker_app.open_async():
            row = await worker_app.connector.execute_query_one_async(
                "SELECT current_database() AS name"
            )
            return row["name"]

    assert asyncio.run(queue_database()) == url.database


@pytest.mark.unit
def test_migration_fingerprint_and_db_prefix_validation(tmp_path: Path) -> None:
    from tests.utils.migrations import (
        compute_migration_fingerprint,
        sanitize_db_prefix,
        shared_template_name,
    )

    repo_tpl = shared_template_name()
    assert repo_tpl.startswith("orgpace_tpl_") and len(repo_tpl) == 28

    backend_dir = tmp_path / "backend"
    tracked = {
        "alembic.ini": "[alembic]\n",
        "app/alembic/env.py": "target = 1\n",
        "app/alembic/versions/001.py": "revision = '001'\n",
        "app/alembic/versions/procrastinate_3_10_0.sql": "CREATE TABLE p();\n",
        "app/models.py": "class User: pass\n",
        "app/domains/org/models.py": "class Org: pass\n",
        "app/domains/org/models_extra.py": "class Extra: pass\n",
    }
    for rel, content in tracked.items():
        path = backend_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    fp_base = compute_migration_fingerprint(backend_dir)
    assert fp_base == compute_migration_fingerprint(backend_dir)
    assert shared_template_name(backend_dir) == f"orgpace_tpl_{fp_base}"

    for cache_rel in (
        "app/alembic/__pycache__/env.pyc",
        "app/domains/org/__pycache__/models.pyc",
    ):
        p = backend_dir / cache_rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"pyc")
    assert compute_migration_fingerprint(backend_dir) == fp_base

    for rel, old_text in tracked.items():
        target = backend_dir / rel
        target.write_text(old_text + "# changed\n", encoding="utf-8")
        assert compute_migration_fingerprint(backend_dir) != fp_base
        target.write_text(old_text, encoding="utf-8")

    assert sanitize_db_prefix("r1579_a1b2c3d4") == "r1579_a1b2c3d4"
    assert sanitize_db_prefix("a" * 30) == "a" * 20
    assert sanitize_db_prefix(None, fallback="123-my-app") == "_my_app"
    assert sanitize_db_prefix("", fallback="123") == "app"
    for bad in ("bad;drop", "bad-dash", "1starts_digit", "has space"):
        with pytest.raises(ValueError, match="PYTEST_DB_PREFIX"):
            sanitize_db_prefix(bad)


@pytest.mark.unit
def test_conftest_shared_template_toggle(monkeypatch: pytest.MonkeyPatch) -> None:
    import tests.conftest as root_conftest
    import tests.utils.migrations as migrations_mod

    url = make_url("postgresql+psycopg://postgres:pw@127.0.0.1:15432/app")
    cleaned, isolated_calls = [], []

    class _DummyEngine:
        def dispose(self) -> None:
            pass

    @contextmanager
    def _track_isolated(_url: object, database: str, **_kw: object):
        isolated_calls.append(database)
        try:
            yield _DummyEngine()
        finally:
            cleaned.append(database)

    def _fake_ensure(target_url: object, **_kw: object) -> str:
        assert target_url == url
        return "orgpace_tpl_0123456789abcdef"

    monkeypatch.setattr(migrations_mod, "ensure_shared_template", _fake_ensure)
    monkeypatch.setattr(migrations_mod, "isolated_database", _track_isolated)
    monkeypatch.setattr(migrations_mod, "migrate", lambda _eng, _act, _rev: None)

    monkeypatch.setenv("PYTEST_SHARED_TEMPLATE", "1")
    with ExitStack() as stack:
        assert (
            root_conftest._create_template(stack, url) == "orgpace_tpl_0123456789abcdef"
        )
    assert not isolated_calls and not cleaned

    monkeypatch.setenv("PYTEST_SHARED_TEMPLATE", "0")
    monkeypatch.delenv("PYTEST_DB_PREFIX", raising=False)
    with ExitStack() as stack:
        tpl_legacy = root_conftest._create_template(stack, url)
        assert tpl_legacy.startswith("migration_template_") and not cleaned
    monkeypatch.setenv("PYTEST_DB_PREFIX", "r1579")
    with ExitStack() as stack:
        tpl_prefixed = root_conftest._create_template(stack, url)
        assert tpl_prefixed.startswith("r1579_tpl_")
    assert isolated_calls == [tpl_legacy, tpl_prefixed] and cleaned == [
        tpl_legacy,
        tpl_prefixed,
    ]


def test_shared_template_race_failure_readonly_cloning_and_pruning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import tests.utils.migrations as migrations_mod
    from app.core.db import engine

    admin_dsn = engine.url.set(
        drivername="postgresql", database="postgres"
    ).render_as_string(hide_password=False)
    suffix = uuid4().hex[:8]
    run_prefix = migrations_mod.sanitize_db_prefix(
        os.environ.get("PYTEST_DB_PREFIX"), fallback="r1579"
    )
    tpl_main = f"{run_prefix}_tpl_{suffix}"
    other_staging = f"{run_prefix}_stg_{suffix}"
    prune_prefix = f"{run_prefix}_gc_{suffix}_"
    prune_regex = rf"^{prune_prefix}[0-9]+$"
    prune_names = [f"{prune_prefix}1", f"{prune_prefix}2", f"{prune_prefix}3"]
    prod_tpl = f"orgpace_tpl_{uuid4().hex[:16]}"

    def _drop_dbs(names: list[str]) -> None:
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            for name in names:
                if admin.execute(
                    "SELECT 1 FROM pg_database WHERE datname = %s", (name,)
                ).fetchone():
                    admin.execute(
                        sql.SQL("ALTER DATABASE {} WITH IS_TEMPLATE false").format(
                            sql.Identifier(name)
                        )
                    )
                    admin.execute(
                        sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(
                            sql.Identifier(name)
                        )
                    )

    try:
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            admin.execute(
                sql.SQL("CREATE DATABASE {}").format(sql.Identifier(other_staging))
            )

        # 1. Failures during migrate AND after IS_TEMPLATE=true (at atomic RENAME) clean ONLY
        # that staging DB, preserve concurrent other_staging, and never mask the original error.
        for stage, err_msg in (("migrate", "migrate_boom"), ("rename", "rename_boom")):
            staging_seen: list[str] = []

            def failing_migrate(
                eng: Engine,
                _act: str,
                _rev: str,
                *,
                _msg: str = err_msg,
                _seen: list[str] = staging_seen,
            ) -> None:
                assert eng.url.database is not None
                _seen.append(eng.url.database)
                raise RuntimeError(_msg)

            def failing_rename(
                admin: psycopg.Connection[object],
                source: str,
                _target: str,
                *,
                _msg: str = err_msg,
                _seen: list[str] = staging_seen,
            ) -> None:
                _seen.append(source)
                assert admin.execute(
                    "SELECT datistemplate, datallowconn FROM pg_database WHERE datname = %s",
                    (source,),
                ).fetchone() == (True, False)
                raise RuntimeError(_msg)

            with monkeypatch.context() as mp:
                if stage == "migrate":
                    mp.setattr(migrations_mod, "migrate", failing_migrate)
                else:
                    mp.setattr(migrations_mod, "migrate", lambda *_a: None)
                    mp.setattr(migrations_mod, "_rename_database", failing_rename)
                with pytest.raises(RuntimeError, match=err_msg):
                    migrations_mod.ensure_shared_template(
                        engine.url, template_name=tpl_main, max_templates=0
                    )
            assert len(staging_seen) == 1
            with psycopg.connect(admin_dsn, autocommit=True) as admin:
                assert (
                    admin.execute(
                        "SELECT 1 FROM pg_database WHERE datname IN (%s, %s)",
                        (tpl_main, staging_seen[0]),
                    ).fetchone()
                    is None
                )
                assert (
                    admin.execute(
                        "SELECT 1 FROM pg_database WHERE datname = %s",
                        (other_staging,),
                    ).fetchone()
                    is not None
                )

        # 2. Concurrent cold build race: only one migrate invocation runs.
        migrate_calls, lock = 0, threading.Lock()

        def slow_seed(eng: Engine, _act: str, _rev: str) -> None:
            nonlocal migrate_calls
            with lock:
                migrate_calls += 1
            time.sleep(0.15)
            with eng.begin() as conn:
                conn.execute(text("CREATE TABLE tpl_probe (marker TEXT NOT NULL)"))
                conn.execute(text("INSERT INTO tpl_probe (marker) VALUES ('seed')"))

        monkeypatch.setattr(migrations_mod, "migrate", slow_seed)
        barrier = threading.Barrier(2)
        with ThreadPoolExecutor(max_workers=2) as pool:
            f1 = pool.submit(
                lambda: (
                    barrier.wait(timeout=5),
                    migrations_mod.ensure_shared_template(
                        engine.url, template_name=tpl_main, max_templates=0
                    ),
                )[1]
            )
            f2 = pool.submit(
                lambda: (
                    barrier.wait(timeout=5),
                    migrations_mod.ensure_shared_template(
                        engine.url, template_name=tpl_main, max_templates=0
                    ),
                )[1]
            )
            assert f1.result(timeout=15) == tpl_main
            assert f2.result(timeout=15) == tpl_main
        assert migrate_calls == 1

        # 3. Template is IS_TEMPLATE=true, ALLOW_CONNECTIONS=false and rejects direct connect.
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            assert admin.execute(
                "SELECT datistemplate, datallowconn FROM pg_database WHERE datname = %s",
                (tpl_main,),
            ).fetchone() == (True, False)
        with pytest.raises(psycopg.OperationalError):
            psycopg.connect(
                engine.url.set(
                    drivername="postgresql", database=tpl_main
                ).render_as_string(hide_password=False)
            )

        # 4. Concurrent clones stay isolated from each other and from tpl_main.
        clone_barrier = threading.Barrier(2)

        def clone_run(tag: str) -> list[str]:
            clone_barrier.wait(timeout=5)
            with migrations_mod.isolated_database(
                engine.url,
                migrations_mod.run_scoped_db_name(
                    f"iso_{tag}", fallback_prefix="r1579"
                ),
                template=tpl_main,
            ) as cloned:
                with cloned.begin() as conn:
                    conn.execute(
                        text("INSERT INTO tpl_probe (marker) VALUES (:t)"), {"t": tag}
                    )
                    return list(
                        conn.execute(
                            text("SELECT marker FROM tpl_probe ORDER BY marker")
                        ).scalars()
                    )

        with ThreadPoolExecutor(max_workers=2) as pool:
            c1, c2 = pool.submit(clone_run, "c1"), pool.submit(clone_run, "c2")
            assert c1.result(timeout=15) == ["c1", "seed"]
            assert c2.result(timeout=15) == ["c2", "seed"]

        # 5. Session lease protects oldest template between clones; GC ignores non-managed DBs.
        monkeypatch.setattr(migrations_mod, "migrate", lambda *_a: None)
        with ExitStack() as lease_a:
            migrations_mod.ensure_shared_template(
                engine.url,
                template_name=prune_names[0],
                max_templates=0,
                lease_stack=lease_a,
            )
            # First clone completes and releases CREATE lock, while session A stays alive.
            with migrations_mod.isolated_database(
                engine.url,
                migrations_mod.run_scoped_db_name("p1", fallback_prefix="r1579"),
                template=prune_names[0],
            ):
                pass
            for name in prune_names[1:]:
                migrations_mod.ensure_shared_template(
                    engine.url, template_name=name, max_templates=0
                )
            with psycopg.connect(admin_dsn, autocommit=True) as admin:
                # Even without active CREATE lock, session A's lease blocks eviction of prune_names[0].
                migrations_mod._prune_old_shared_templates(
                    admin,
                    keep=prune_names[2],
                    max_templates=2,
                    name_regex=prune_regex,
                )
                assert [
                    r[0]
                    for r in admin.execute(
                        "SELECT datname FROM pg_database WHERE datname ~ %s ORDER BY oid",
                        (prune_regex,),
                    ).fetchall()
                ] == prune_names
                # Default production regex never selects test-scoped tpl_main or prune_names.
                assert tpl_main not in [
                    r[0]
                    for r in admin.execute(
                        "SELECT datname FROM pg_database WHERE datistemplate AND NOT datallowconn AND datname ~ %s",
                        (migrations_mod.SHARED_TEMPLATE_REGEX,),
                    ).fetchall()
                ]
            # Session A can still clone again after B's GC ran.
            with migrations_mod.isolated_database(
                engine.url,
                migrations_mod.run_scoped_db_name("p2", fallback_prefix="r1579"),
                template=prune_names[0],
            ):
                pass
        # After session A releases its lease, GC evicts prune_names[0].
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            migrations_mod._prune_old_shared_templates(
                admin, keep=prune_names[2], max_templates=2, name_regex=prune_regex
            )
            assert [
                r[0]
                for r in admin.execute(
                    "SELECT datname FROM pg_database WHERE datname ~ %s ORDER BY oid",
                    (prune_regex,),
                ).fetchall()
            ] == [prune_names[1], prune_names[2]]

        # 6. B4: Run-prefix cleanup reclaims crashed run's normal/template/staging DBs,
        # preserves peer run DBs and real SHARED_TEMPLATE_REGEX templates.
        for owned in (tpl_main, other_staging, *prune_names):
            assert owned.startswith(f"{run_prefix}_")
            assert not re.fullmatch(migrations_mod.SHARED_TEMPLATE_REGEX, owned)
        with pytest.raises(ValueError, match="len <= 40"):
            migrations_mod.cleanup_run_databases(admin_dsn, "a" * 41)

        sim_a = f"{run_prefix}_sa_{suffix[:4]}"
        sim_b = f"{run_prefix}_sb_{suffix[:4]}"
        a_dbs = [
            f"{sim_a}_gw0_{suffix}",
            f"{sim_a}_hb_{suffix}",
            f"{sim_a}_fresh_{suffix}",
            f"{sim_a}_iso_{suffix}",
            f"{sim_a}_tpl_{suffix}",
            f"{sim_a}_stg_{suffix}",
        ]
        b_dbs = [f"{sim_b}_gw0_{suffix}", f"{sim_b}_hb_{suffix}"]
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            for d in [*a_dbs, *b_dbs, prod_tpl]:
                admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(d)))
            for tpl_db in (f"{sim_a}_tpl_{suffix}", prod_tpl):
                admin.execute(
                    sql.SQL(
                        "ALTER DATABASE {} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false"
                    ).format(sql.Identifier(tpl_db))
                )
            try:
                dropped = set(migrations_mod.cleanup_run_databases(admin_dsn, sim_a))
                assert dropped == set(a_dbs)
                remaining = {
                    r[0]
                    for r in admin.execute(
                        "SELECT datname FROM pg_database WHERE datname = ANY(%s)",
                        ([*a_dbs, *b_dbs, prod_tpl],),
                    ).fetchall()
                }
                assert remaining == {*b_dbs, prod_tpl}
            finally:
                _drop_dbs([*a_dbs, *b_dbs, prod_tpl])
    finally:
        _drop_dbs([tpl_main, other_staging, *prune_names, prod_tpl])


@pytest.mark.unit
def test_no_db_mode_blocks_non_unit_and_overrides_database_url(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import tests.conftest as root_conftest

    env_before = dict(os.environ)
    if os.environ.get("PYTEST_NO_DB") == "1":
        from app.core.config import settings

        assert str(settings.DATABASE_URL).endswith("@127.0.0.1:1/no_db_mode")

    backend_dir = Path(__file__).resolve().parents[1]

    # Verify _enforce_no_db_env in an isolated subprocess across full and GitHub-CI-sparse envs.
    probe_code = (
        "import os, tests.conftest as c\n"
        "expected = c.NO_DB_ENV_OVERRIDES\n"
        "os.environ.update({\n"
        "    'DATABASE_URL': 'postgresql://postgres:real@127.0.0.1:5432/prod_like',\n"
        "    'FASTAPI_ENV': 'production',\n"
        "    'PROJECT_NAME': 'Prod',\n"
        "    'SECRET_KEY': 'real-secret',\n"
        "    'PI_SERVICE_TOKEN': 'real-token',\n"
        "    'FIRST_SUPERUSER': 'admin@example.com',\n"
        "    'FIRST_SUPERUSER_PASSWORD': 'real-password',\n"
        "})\n"
        "c._enforce_no_db_env()\n"
        "assert all(os.environ[k] == v for k, v in expected.items()), 'scenario A failed'\n"
        "for k in expected:\n"
        "    os.environ.pop(k, None)\n"
        "os.environ['DATABASE_URL'] = 'postgresql://postgres:ci@127.0.0.1:5432/ci_db'\n"
        "os.environ['FASTAPI_ENV'] = 'development'\n"
        "c._enforce_no_db_env()\n"
        "assert all(os.environ[k] == v for k, v in expected.items()), 'scenario B failed'\n"
    )
    enforce_probe = subprocess.run(
        [sys.executable, "-c", probe_code],
        cwd=backend_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    assert enforce_probe.returncode == 0, enforce_probe.stdout + enforce_probe.stderr

    # Verify empty selection under PYTEST_NO_DB=1 fails without mutating parent env.
    with monkeypatch.context() as mp:
        mp.setenv("PYTEST_NO_DB", "1")
        with pytest.raises(pytest.UsageError, match="selected 0 tests"):
            root_conftest.pytest_collection_modifyitems(None, [])  # type: ignore[arg-type]

    # Verify real pytest invocation with PYTEST_NO_DB=1 rejects non-unit selection before execution.
    env = {
        **os.environ,
        "PYTEST_NO_DB": "1",
        "DATABASE_URL": "postgresql://postgres:real@127.0.0.1:5432/prod_like",
    }
    rejected = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "tests/test_test_database.py",
            "-k",
            "test_database_isolation",
            "--no-cov",
            "-q",
        ],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert rejected.returncode == 4
    assert "forbids running non-unit tests" in rejected.stderr + rejected.stdout

    # Verify standard pytest marker semantics (including aliased `from pytest import mark as m`).
    probe = tmp_path / "marker_probe"
    probe.mkdir()
    (probe / "pytest.ini").write_text("[pytest]\nmarkers =\n    unit: unit\n")
    (probe / "conftest.py").write_text(
        "from tests.conftest import pytest_collection_modifyitems, pytest_configure, pytest_sessionstart\n"
    )
    (probe / "test_direct.py").write_text(
        "import pytest\n\n@pytest.mark.unit\ndef test_direct():\n    assert True\n"
    )
    (probe / "test_alias.py").write_text(
        "from pytest import mark as m\n\n@m.unit\ndef test_alias():\n    assert True\n"
    )
    probe_env = {**env, "PYTHONPATH": str(backend_dir)}
    collected = subprocess.run(
        [sys.executable, "-m", "pytest", "-m", "unit", "--no-cov", "-q"],
        cwd=probe,
        env=probe_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert collected.returncode == 0, collected.stdout + collected.stderr
    assert "2 passed" in collected.stdout

    changed_keys = sorted(
        k
        for k in set(os.environ) | set(env_before)
        if os.environ.get(k) != env_before.get(k)
    )
    assert not changed_keys, f"Process env mutated keys: {changed_keys}"
