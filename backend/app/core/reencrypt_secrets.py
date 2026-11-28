"""Idempotent, batched CLI to re-encrypt stored database secrets under the primary key."""

import argparse
import sys
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, cast

from sqlalchemy import Column, Table, or_, select, tuple_, update
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, SQLModel

from app.core.db import engine
from app.core.secrets import SecretUnavailable, rotate_if_needed
from app.domains.access_token.models import OAuthClient
from app.domains.admin_assistant.models import (
    AdminAssistantAttachment,
    AdminAssistantMessage,
    AdminAssistantSession,
    AdminChangeSet,
)
from app.domains.bot.models import BotAttachment, BotMessage, BotSession
from app.domains.im.models import ImSetting
from app.domains.model.models import ModelSetting
from app.domains.source.models import SourceConnection

_ATTACHMENT_MAX_BATCH_SIZE = 10
_MAX_CAS_RETRIES = 2


class ReencryptDatabaseError(RuntimeError):
    """Sanitized DB failure without SQL parameters, ciphertexts, or keys."""

    def __init__(self, table_name: str, error_type: str) -> None:
        self.table_name = table_name
        self.error_type = error_type
        super().__init__(
            f"Database operation failed on table={table_name}: {error_type}"
        )


@dataclass(frozen=True, slots=True)
class EncryptedTarget:
    model: type[SQLModel]
    secret_columns: tuple[str, ...]
    max_batch_size: int | None = None


ENCRYPTED_TARGETS: tuple[EncryptedTarget, ...] = (
    EncryptedTarget(
        ModelSetting,
        ("api_key_ciphertext", "chatgpt_auth_ciphertext", "chatgpt_login_ciphertext"),
    ),
    EncryptedTarget(SourceConnection, ("secret_ciphertext",)),
    EncryptedTarget(ImSetting, ("credentials",)),
    EncryptedTarget(OAuthClient, ("client_secret_encrypted",)),
    EncryptedTarget(AdminChangeSet, ("secrets",)),
    EncryptedTarget(BotSession, ("state_ciphertext",)),
    EncryptedTarget(BotMessage, ("ciphertext",)),
    EncryptedTarget(
        BotAttachment,
        ("ciphertext", "text_ciphertext"),
        max_batch_size=_ATTACHMENT_MAX_BATCH_SIZE,
    ),
    EncryptedTarget(AdminAssistantSession, ("state_ciphertext",)),
    EncryptedTarget(AdminAssistantMessage, ("ciphertext",)),
    EncryptedTarget(
        AdminAssistantAttachment,
        ("ciphertext", "text_ciphertext"),
        max_batch_size=_ATTACHMENT_MAX_BATCH_SIZE,
    ),
)


@dataclass(slots=True)
class TableReencryptStats:
    table_name: str
    scanned_rows: int = 0
    rotated_rows: int = 0
    rotated_values: int = 0
    already_current_values: int = 0
    skipped_concurrent_values: int = 0
    unresolved_values: int = 0
    failed_values: int = 0


@dataclass(slots=True)
class ReencryptSummary:
    dry_run: bool
    tables: list[TableReencryptStats] = field(default_factory=list)
    failures: list[tuple[str, str, str]] = field(default_factory=list)
    unresolved: list[tuple[str, str, str]] = field(default_factory=list)
    scanned_rows: int = 0
    rotated_rows: int = 0
    rotated_values: int = 0
    already_current_values: int = 0
    skipped_concurrent_values: int = 0
    unresolved_values: int = 0
    failed_values: int = 0


def _format_pk(pk_cols: tuple[Column[Any], ...], pk_values: tuple[Any, ...]) -> str:
    return ",".join(f"{c.name}={v}" for c, v in zip(pk_cols, pk_values, strict=True))


def _apply_cas_with_reread(
    session: Session,
    table: Table,
    pk_pred: list[Any],
    col: Column[Any],
    initial_token: str,
    initial_new_token: str,
    pk_repr: str,
    stats: TableReencryptStats,
    failures: list[tuple[str, str, str]],
    unresolved: list[tuple[str, str, str]],
) -> bool:
    token = initial_token
    new_token = initial_new_token
    for _ in range(_MAX_CAS_RETRIES + 1):
        res = session.execute(
            update(table).where(*pk_pred, col == token).values({col.name: new_token})
        )
        if (res.rowcount or 0) == 1:  # type: ignore[attr-defined]
            stats.rotated_values += 1
            return True
        latest = session.execute(select(col).where(*pk_pred)).one_or_none()
        if latest is None or not latest[0]:
            stats.skipped_concurrent_values += 1
            return False
        token = cast(str, latest[0])
        try:
            rotated = rotate_if_needed(token)
        except SecretUnavailable:
            stats.failed_values += 1
            failures.append((table.name, pk_repr, col.name))
            return False
        if rotated is None:
            stats.already_current_values += 1
            return False
        new_token = rotated
    stats.unresolved_values += 1
    unresolved.append((table.name, pk_repr, col.name))
    return False


def _reencrypt_table(
    session: Session, target: EncryptedTarget, *, dry_run: bool, batch_size: int
) -> tuple[TableReencryptStats, list[tuple[str, str, str]], list[tuple[str, str, str]]]:
    table = cast(Table, target.model.__table__)  # type: ignore[attr-defined]
    pk_cols = tuple(table.primary_key.columns)
    secret_cols = tuple(table.c[col] for col in target.secret_columns)
    non_empty = or_(*(col.is_not(None) & (col != "") for col in secret_cols))
    effective_batch = (
        min(batch_size, target.max_batch_size)
        if target.max_batch_size is not None
        else batch_size
    )

    stats = TableReencryptStats(table_name=table.name)
    failures: list[tuple[str, str, str]] = []
    unresolved: list[tuple[str, str, str]] = []
    last_pk: tuple[Any, ...] | None = None

    while True:
        stmt = select(*pk_cols, *secret_cols).where(non_empty)
        if last_pk is not None:
            cursor = (
                pk_cols[0] > last_pk[0]
                if len(pk_cols) == 1
                else tuple_(*pk_cols) > last_pk
            )
            stmt = stmt.where(cursor)
        try:
            rows = session.execute(stmt.order_by(*pk_cols).limit(effective_batch)).all()
        except SQLAlchemyError as exc:
            with suppress(SQLAlchemyError):
                session.rollback()
            raise ReencryptDatabaseError(table.name, type(exc).__name__) from None
        if not rows:
            break

        pk_count = len(pk_cols)
        try:
            for row in rows:
                stats.scanned_rows += 1
                pk_values = tuple(row[:pk_count])
                pk_repr = _format_pk(pk_cols, pk_values)
                pk_pred = [c == v for c, v in zip(pk_cols, pk_values, strict=True)]
                row_rotated = False
                for col, token in zip(secret_cols, row[pk_count:], strict=True):
                    if not token:
                        continue
                    try:
                        new_token = rotate_if_needed(token)
                    except SecretUnavailable:
                        stats.failed_values += 1
                        failures.append((table.name, pk_repr, col.name))
                        continue
                    if new_token is None:
                        stats.already_current_values += 1
                        continue
                    if dry_run:
                        stats.rotated_values += 1
                        row_rotated = True
                    elif _apply_cas_with_reread(
                        session,
                        table,
                        pk_pred,
                        col,
                        token,
                        new_token,
                        pk_repr,
                        stats,
                        failures,
                        unresolved,
                    ):
                        row_rotated = True
                if row_rotated:
                    stats.rotated_rows += 1

            if not dry_run:
                session.commit()
        except SQLAlchemyError as exc:
            with suppress(SQLAlchemyError):
                session.rollback()
            raise ReencryptDatabaseError(table.name, type(exc).__name__) from None

        last_pk = tuple(rows[-1][:pk_count])
        if len(rows) < effective_batch:
            break

    return stats, failures, unresolved


def reencrypt_secrets(
    session: Session, *, dry_run: bool = False, batch_size: int = 500
) -> ReencryptSummary:
    """Re-encrypt all stored secret columns across every encrypted table."""
    if batch_size <= 0:
        raise ValueError("batch_size must be a positive integer")
    summary = ReencryptSummary(dry_run=dry_run)
    for target in ENCRYPTED_TARGETS:
        stats, table_failures, table_unresolved = _reencrypt_table(
            session, target, dry_run=dry_run, batch_size=batch_size
        )
        summary.tables.append(stats)
        summary.failures.extend(table_failures)
        summary.unresolved.extend(table_unresolved)
        summary.scanned_rows += stats.scanned_rows
        summary.rotated_rows += stats.rotated_rows
        summary.rotated_values += stats.rotated_values
        summary.already_current_values += stats.already_current_values
        summary.skipped_concurrent_values += stats.skipped_concurrent_values
        summary.unresolved_values += stats.unresolved_values
        summary.failed_values += stats.failed_values
    return summary


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("batch-size must be a positive integer")
    return parsed


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Re-encrypt stored database secrets using the primary ENCRYPTION_KEYS key."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Verify decryption and count values needing re-encryption without writing to the database.",
    )
    parser.add_argument(
        "--batch-size",
        type=_positive_int,
        default=500,
        help="Rows processed and committed per batch (attachment tables capped at 10; default: 500).",
    )
    args = parser.parse_args(argv)

    try:
        with Session(engine) as session:
            summary = reencrypt_secrets(
                session, dry_run=args.dry_run, batch_size=args.batch_size
            )
    except ReencryptDatabaseError as exc:
        sys.stderr.write(
            f"ERROR: database failure table={exc.table_name} error={exc.error_type}\n"
        )
        return 1
    except SQLAlchemyError as exc:
        sys.stderr.write(
            f"ERROR: database session failure error={type(exc).__name__}\n"
        )
        return 1

    mode = "dry-run" if summary.dry_run else "apply"
    label = "pending_values" if summary.dry_run else "rotated_values"
    for t in summary.tables:
        sys.stdout.write(
            f"[{mode}] {t.table_name}: scanned_rows={t.scanned_rows} "
            f"{label}={t.rotated_values} already_current={t.already_current_values} "
            f"skipped_concurrent={t.skipped_concurrent_values} "
            f"unresolved={t.unresolved_values} failed={t.failed_values}\n"
        )
    sys.stdout.write(
        f"[{mode}] summary: scanned_rows={summary.scanned_rows} rotated_rows={summary.rotated_rows} "
        f"{label}={summary.rotated_values} already_current={summary.already_current_values} "
        f"skipped_concurrent={summary.skipped_concurrent_values} "
        f"unresolved={summary.unresolved_values} failed={summary.failed_values}\n"
    )
    for table_name, pk_repr, col_name in summary.failures:
        sys.stderr.write(
            f"ERROR: unable to decrypt table={table_name} pk={pk_repr} column={col_name}\n"
        )
    for table_name, pk_repr, col_name in summary.unresolved:
        sys.stderr.write(
            f"ERROR: unresolved concurrent update table={table_name} pk={pk_repr} column={col_name}\n"
        )
    return 1 if (summary.failures or summary.unresolved) else 0


if __name__ == "__main__":
    raise SystemExit(main())
