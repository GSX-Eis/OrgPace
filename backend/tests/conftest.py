import os
import re
import time
from contextlib import ExitStack
from pathlib import Path
from uuid import uuid4

import pytest
from dotenv import dotenv_values
from sqlalchemy.engine import URL, make_url
from xdist.workermanage import WorkerController

DATABASES = pytest.StashKey[ExitStack]()
SHARED_TEMPLATE = pytest.StashKey[str]()
NO_DB_DATABASE_URL = "postgresql://no-db:no-db@127.0.0.1:1/no_db_mode"
NO_DB_ENV_OVERRIDES: dict[str, str] = {
    "DATABASE_URL": NO_DB_DATABASE_URL,
    "FASTAPI_ENV": "development",
    "PROJECT_NAME": "OrgPace No-DB Unit Tests",
    "SECRET_KEY": "no-db-unit-test-secret",
    "PI_SERVICE_TOKEN": "no-db-unit-test-token",
    "FIRST_SUPERUSER": "no-db@example.com",
    "FIRST_SUPERUSER_PASSWORD": "no-db-unit-test-password",
}


def _no_db_mode() -> bool:
    return os.environ.get("PYTEST_NO_DB", "").strip().lower() in {"1", "true", "yes"}


def _enforce_no_db_env() -> None:
    # Override even existing .env or shell DATABASE_URL so no-DB runs never touch a live DB.
    os.environ.update(NO_DB_ENV_OVERRIDES)


@pytest.hookimpl(tryfirst=True)
def pytest_configure(config: pytest.Config) -> None:  # noqa: ARG001
    if _no_db_mode():
        _enforce_no_db_env()


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(
    config: pytest.Config,  # noqa: ARG001
    items: list[pytest.Item],
) -> None:
    if not _no_db_mode():
        return
    if not items:
        raise pytest.UsageError(
            "PYTEST_NO_DB=1 selected 0 tests; run with @pytest.mark.unit tests (e.g. -m unit)."
        )
    non_unit = [
        item.nodeid for item in items if item.get_closest_marker("unit") is None
    ]
    if non_unit:
        sample = ", ".join(non_unit[:5])
        raise pytest.UsageError(
            f"PYTEST_NO_DB=1 forbids running non-unit tests without an isolated database ({len(non_unit)} selected, e.g. {sample})."
        )


def _database_url() -> URL:
    env = dotenv_values(Path(__file__).resolve().parents[2] / ".env")
    return make_url(os.environ.get("DATABASE_URL") or env["DATABASE_URL"]).set(
        drivername="postgresql+psycopg"
    )


def _shared_template_mode() -> bool:
    return os.environ.get("PYTEST_SHARED_TEMPLATE", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def _create_template(stack: ExitStack, url: URL) -> str:
    from tests.utils.migrations import (
        ensure_shared_template,
        isolated_database,
        migrate,
        record_db_metric,
        run_scoped_db_name,
    )

    if _shared_template_mode():
        return ensure_shared_template(url, lease_stack=stack)

    started = time.monotonic()
    template = (
        run_scoped_db_name("tpl")
        if os.environ.get("PYTEST_DB_PREFIX", "").strip()
        else f"migration_template_{uuid4().hex}"
    )
    engine = stack.enter_context(isolated_database(url, template))
    migrate(engine, "upgrade", "head")
    engine.dispose()
    record_db_metric("template", time.monotonic() - started)
    return template


@pytest.hookimpl(optionalhook=True)
def pytest_configure_node(node: WorkerController) -> None:
    if _no_db_mode():
        return
    config = node.config
    template = config.stash.get(SHARED_TEMPLATE, None)
    if template is None:
        with ExitStack() as stack:
            template = _create_template(stack, _database_url())
            config.stash[SHARED_TEMPLATE] = template
            config.add_cleanup(stack.pop_all().close)
    node.workerinput["migration_template"] = template


@pytest.hookimpl(trylast=True)
def pytest_sessionstart(session: pytest.Session) -> None:
    if _no_db_mode():
        _enforce_no_db_env()
        return
    # pytest-cov starts worker coverage in sessionstart, before application imports.
    config = session.config
    if config.getoption("numprocesses", default=0) and not hasattr(
        config, "workerinput"
    ):
        return

    from tests.utils.migrations import (
        MIGRATION_TEMPLATE,
        isolated_database,
        run_scoped_db_name,
    )

    with ExitStack() as stack:
        url = _database_url()
        raw_worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
        worker = re.sub(r"[^A-Za-z0-9_]", "_", raw_worker)[:9] or "main"
        database = run_scoped_db_name(worker, fallback_prefix=url.database or "app")
        patch = stack.enter_context(pytest.MonkeyPatch.context())
        # Configure before importing any app module, including Alembic's model imports.
        patch.setenv(
            "DATABASE_URL",
            url.set(database=database).render_as_string(hide_password=False),
        )
        template = (
            config.workerinput["migration_template"]
            if hasattr(config, "workerinput")
            else _create_template(stack, url)
        )
        stack.enter_context(isolated_database(url, database, template=template))
        config.stash[MIGRATION_TEMPLATE] = template
        config.pluginmanager.import_plugin("tests.fixtures")
        from app.core.db import engine

        stack.callback(engine.dispose)
        config.stash[DATABASES] = stack.pop_all()
        config.add_cleanup(config.stash[DATABASES].close)


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session: pytest.Session) -> None:
    # xdist may terminate workers after workerfinished, before config cleanup runs.
    if databases := session.config.stash.get(DATABASES, None):
        databases.close()
