import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url


def test_database_isolation(migration_template: str) -> None:
    from app.core.config import settings
    from app.core.db import engine
    from app.worker.app import app as worker_app

    url = make_url(os.environ["DATABASE_URL"])
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    assert f"_{worker}_" in url.database
    assert engine.url == make_url(str(settings.DATABASE_URL)) == url
    assert migration_template.startswith("migration_template_")
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
