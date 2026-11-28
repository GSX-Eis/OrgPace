import hashlib
import os
import re
from collections.abc import Generator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Literal
from uuid import uuid4

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from psycopg import sql
from sqlalchemy import Engine, MetaData, Table, create_engine, inspect
from sqlalchemy.engine import URL
from sqlmodel import Session, SQLModel

MIGRATION_TEMPLATE = pytest.StashKey[str]()
SHARED_TEMPLATE_PREFIX = "orgpace_tpl_"
SHARED_TEMPLATE_STAGING_PREFIX = "orgpace_tpl_build_"
SHARED_TEMPLATE_REGEX = r"^orgpace_tpl_[0-9a-f]{16}$"
DEFAULT_MAX_SHARED_TEMPLATES = 8
_SAFE_DB_PREFIX_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_BACKEND_DIR = Path(__file__).resolve().parents[2]


def sanitize_db_prefix(raw: str | None, *, fallback: str = "app") -> str:
    """Validate an explicit PYTEST_DB_PREFIX or normalize a fallback DB prefix (<= 20 chars)."""
    if raw is not None and raw.strip():
        candidate = raw.strip()
        if not _SAFE_DB_PREFIX_RE.fullmatch(candidate):
            raise ValueError(
                f"PYTEST_DB_PREFIX must match ^[A-Za-z_][A-Za-z0-9_]*$, got: {raw!r}"
            )
        return candidate[:20]
    cleaned = re.sub(r"[^A-Za-z0-9_]", "_", fallback).lstrip("0123456789")
    return (cleaned or "app")[:20]


def run_scoped_db_name(role: str, *, fallback_prefix: str = "app") -> str:
    """Build a <= 63-byte DB name prefixed with PYTEST_DB_PREFIX when set."""
    prefix = sanitize_db_prefix(
        os.environ.get("PYTEST_DB_PREFIX"), fallback=fallback_prefix
    )
    clean_role = re.sub(r"[^A-Za-z0-9_]", "_", role)[:9] or "db"
    return f"{prefix}_{clean_role}_{uuid4().hex}"


def cleanup_run_databases(dsn: str, prefix: str) -> list[str]:
    """Drop all non-shared-template databases belonging to a run prefix (`<prefix>_*`)."""
    candidate = prefix.strip()
    if not _SAFE_DB_PREFIX_RE.fullmatch(candidate) or len(candidate) > 40:
        raise ValueError(
            f"Run cleanup prefix must match ^[A-Za-z_][A-Za-z0-9_]*$ and len <= 40, got: {prefix!r}"
        )
    dropped: list[str] = []
    with psycopg.connect(dsn, autocommit=True) as admin:
        rows = admin.execute(
            "SELECT datname, datistemplate FROM pg_database "
            "WHERE starts_with(datname, %s) AND NOT (datname ~ %s)",
            (f"{candidate}_", SHARED_TEMPLATE_REGEX),
        ).fetchall()
        for datname, is_template in rows:
            if is_template:
                admin.execute(
                    sql.SQL("ALTER DATABASE {} WITH IS_TEMPLATE false").format(
                        sql.Identifier(datname)
                    )
                )
            admin.execute(
                sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(
                    sql.Identifier(datname)
                )
            )
            dropped.append(datname)
    return dropped


def compute_migration_fingerprint(backend_dir: Path | None = None) -> str:
    """Return 16-hex SHA256 digest of Alembic config, migrations, and SQLModel definitions."""
    root = (backend_dir or _BACKEND_DIR).resolve()
    files = [
        p for p in (root / "alembic.ini", root / "app" / "models.py") if p.is_file()
    ]
    for folder, pattern in (
        (root / "app" / "alembic", "*"),
        (root / "app" / "domains", "models*.py"),
    ):
        if folder.is_dir():
            files.extend(
                p
                for p in folder.rglob(pattern)
                if p.is_file()
                and "__pycache__" not in p.parts
                and p.suffix not in {".pyc", ".pyo"}
            )
    by_rel = {p.relative_to(root).as_posix(): p for p in files}
    digest = hashlib.sha256()
    for rel in sorted(by_rel):
        data = by_rel[rel].read_bytes()
        digest.update(f"{rel}\0{len(data)}\0".encode() + data + b"\0")
    return digest.hexdigest()[:16]


def shared_template_name(backend_dir: Path | None = None) -> str:
    return f"{SHARED_TEMPLATE_PREFIX}{compute_migration_fingerprint(backend_dir)}"


def _acquire_template_lease(admin_url: URL, template: str, stack: ExitStack) -> None:
    """Hold a session-lifetime shared advisory lock (key=1) so GC never drops an in-use template."""
    lease = psycopg.connect(
        admin_url.render_as_string(hide_password=False), autocommit=True
    )
    stack.callback(lease.close)
    lease.execute(
        "SELECT pg_advisory_lock_shared(hashtextextended(%s, 1))", (template,)
    )
    stack.callback(
        lambda: lease.execute(
            "SELECT pg_advisory_unlock_shared(hashtextextended(%s, 1))", (template,)
        )
    )


def _prune_old_shared_templates(
    admin: psycopg.Connection[object],
    *,
    keep: str,
    max_templates: int,
    name_regex: str = SHARED_TEMPLATE_REGEX,
) -> None:
    if max_templates <= 0:
        return
    rows = admin.execute(
        "SELECT datname FROM pg_database "
        "WHERE datistemplate AND NOT datallowconn AND datname ~ %s ORDER BY oid ASC",
        (name_regex,),
    ).fetchall()
    excess = len(rows) - max_templates
    if excess <= 0:
        return
    for (old_tpl,) in [r for r in rows if r[0] != keep][:excess]:
        lease_lock = admin.execute(
            "SELECT pg_try_advisory_lock(hashtextextended(%s, 1))", (old_tpl,)
        ).fetchone()
        if not (lease_lock and lease_lock[0]):
            continue
        try:
            clone_lock = admin.execute(
                "SELECT pg_try_advisory_lock(hashtextextended(%s, 0))", (old_tpl,)
            ).fetchone()
            if not (clone_lock and clone_lock[0]):
                continue
            try:
                try:
                    admin.execute(
                        sql.SQL("ALTER DATABASE {} WITH IS_TEMPLATE false").format(
                            sql.Identifier(old_tpl)
                        )
                    )
                    admin.execute(
                        sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(
                            sql.Identifier(old_tpl)
                        )
                    )
                except psycopg.Error:
                    pass
            finally:
                admin.execute(
                    "SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (old_tpl,)
                )
        finally:
            admin.execute(
                "SELECT pg_advisory_unlock(hashtextextended(%s, 1))", (old_tpl,)
            )


def _rename_database(
    admin: psycopg.Connection[object], source: str, target: str
) -> None:
    admin.execute(
        sql.SQL("ALTER DATABASE {} RENAME TO {}").format(
            sql.Identifier(source), sql.Identifier(target)
        )
    )


def ensure_shared_template(
    url: URL,
    *,
    template_name: str | None = None,
    backend_dir: Path | None = None,
    max_templates: int = DEFAULT_MAX_SHARED_TEMPLATES,
    lease_stack: ExitStack | None = None,
) -> str:
    """Return an existing migrated template DB or atomically build one under advisory lock."""
    template = template_name or shared_template_name(backend_dir)
    if len(template) > 63 or not _SAFE_DB_PREFIX_RE.fullmatch(template):
        raise ValueError(f"Invalid shared template database name: {template!r}")

    admin_url = url.set(drivername="postgresql", database="postgres")
    # Acquire session lease (key=1) before releasing/pruning so an active session's
    # template can never be evicted by another fingerprint build.
    if lease_stack is not None:
        _acquire_template_lease(admin_url, template, lease_stack)

    with psycopg.connect(
        admin_url.render_as_string(hide_password=False), autocommit=True
    ) as admin:
        admin.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", (template,))
        try:
            row = admin.execute(
                "SELECT datistemplate, datallowconn FROM pg_database WHERE datname = %s",
                (template,),
            ).fetchone()
            if row is None:
                staging = f"{SHARED_TEMPLATE_STAGING_PREFIX}{uuid4().hex[:12]}"
                published = False
                admin.execute(
                    sql.SQL("CREATE DATABASE {}").format(sql.Identifier(staging))
                )
                try:
                    staging_engine = create_engine(url.set(database=staging))
                    try:
                        migrate(staging_engine, "upgrade", "head")
                    finally:
                        staging_engine.dispose()
                    admin.execute(
                        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                        "WHERE datname = %s AND pid <> pg_backend_pid()",
                        (staging,),
                    )
                    admin.execute(
                        sql.SQL(
                            "ALTER DATABASE {} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false"
                        ).format(sql.Identifier(staging))
                    )
                    _rename_database(admin, staging, template)
                    published = True
                finally:
                    if not published:
                        try:
                            if admin.execute(
                                "SELECT 1 FROM pg_database WHERE datname = %s",
                                (staging,),
                            ).fetchone():
                                admin.execute(
                                    sql.SQL(
                                        "ALTER DATABASE {} WITH IS_TEMPLATE false"
                                    ).format(sql.Identifier(staging))
                                )
                                admin.execute(
                                    sql.SQL(
                                        "DROP DATABASE IF EXISTS {} WITH (FORCE)"
                                    ).format(sql.Identifier(staging))
                                )
                        except psycopg.Error:
                            pass
            elif not row[0] or row[1]:
                admin.execute(
                    sql.SQL(
                        "ALTER DATABASE {} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false"
                    ).format(sql.Identifier(template))
                )
            _prune_old_shared_templates(
                admin, keep=template, max_templates=max_templates
            )
        finally:
            admin.execute(
                "SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (template,)
            )
    return template


@contextmanager
def isolated_database(
    url: URL, database: str, *, template: str | None = None
) -> Generator[Engine]:
    admin_url = url.set(drivername="postgresql", database="postgres")
    with psycopg.connect(
        admin_url.render_as_string(hide_password=False), autocommit=True
    ) as admin:
        statement = sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database))
        if template is None:
            admin.execute(statement)
        else:
            statement += sql.SQL(" TEMPLATE {}").format(sql.Identifier(template))
            # CREATE DATABASE needs autocommit, so use a session lock and release it
            # before handing the cloned database to the caller.
            admin.execute(
                "SELECT pg_advisory_lock(hashtextextended(%s, 0))", (template,)
            )
            try:
                admin.execute(statement)
            finally:
                admin.execute(
                    "SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (template,)
                )
        isolated = create_engine(url.set(database=database))
        try:
            yield isolated
        finally:
            isolated.dispose()
            admin.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    sql.Identifier(database)
                )
            )


def migrate(
    engine: Engine, action: Literal["upgrade", "downgrade"], revision: str
) -> None:
    backend = Path(__file__).resolve().parents[2]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "app/alembic"))
    config.attributes["configure_logger"] = False
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        if action == "upgrade":
            command.upgrade(config, revision)
        else:
            command.downgrade(config, revision)


def insert_historical_rows(session: Session, *rows: SQLModel) -> None:
    """Seed an older migration using only columns that existed at that revision."""
    for row in rows:
        table = Table(
            inspect(type(row)).local_table.name,
            MetaData(),
            autoload_with=session.connection(),
        )
        session.execute(
            table.insert().values(
                {
                    key: value
                    for key, value in row.model_dump().items()
                    if key in table.c
                }
            )
        )
