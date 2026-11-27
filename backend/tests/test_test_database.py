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
    from app.core.config import settings

    if os.environ.get("PYTEST_NO_DB") == "1":
        assert str(settings.DATABASE_URL).endswith("@127.0.0.1:1/no_db_mode")

    # Verify _enforce_no_db_env overwrites all keys without leaking into the process env.
    env_before = dict(os.environ)
    with monkeypatch.context() as mp:
        for key in (*root_conftest.NO_DB_ENV_OVERRIDES, "PYTEST_NO_DB"):
            if key in os.environ:
                mp.setenv(key, os.environ[key])
            else:
                mp.delenv(key, raising=False)
        mp.setenv("DATABASE_URL", "postgresql://postgres:real@127.0.0.1:5432/prod_like")
        root_conftest._enforce_no_db_env()
        assert all(
            os.environ[k] == v for k, v in root_conftest.NO_DB_ENV_OVERRIDES.items()
        )
        mp.setenv("PYTEST_NO_DB", "1")
        with pytest.raises(pytest.UsageError, match="selected 0 tests"):
            root_conftest.pytest_collection_modifyitems(None, [])  # type: ignore[arg-type]
    assert dict(os.environ) == env_before

    # Verify real pytest invocation with PYTEST_NO_DB=1 rejects non-unit selection before execution.
    backend_dir = Path(__file__).resolve().parents[1]
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
