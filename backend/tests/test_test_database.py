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
) -> None:
    import tests.conftest as root_conftest
    from app.core.config import settings

    if os.environ.get("PYTEST_NO_DB") == "1":
        assert str(settings.DATABASE_URL).endswith("@127.0.0.1:1/no_db_mode")

    # Verify _enforce_no_db_env overwrites even an explicit shell DATABASE_URL.
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql://postgres:real@127.0.0.1:5432/prod_like"
    )
    root_conftest._enforce_no_db_env()
    assert os.environ["DATABASE_URL"] == root_conftest.NO_DB_DATABASE_URL

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

    # Verify empty selection under PYTEST_NO_DB=1 also fails instead of false-greening.
    with pytest.raises(pytest.UsageError, match="selected 0 tests"):
        monkeypatch.setenv("PYTEST_NO_DB", "1")
        root_conftest.pytest_collection_modifyitems(None, [])  # type: ignore[arg-type]
