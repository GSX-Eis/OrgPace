"""Idempotent, batched CLI to re-encrypt stored database secrets under the primary key."""

import argparse
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, cast

from sqlalchemy import Column, Table, or_, select, tuple_, update
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


@dataclass(frozen=True, slots=True)
class EncryptedTarget:
    model: type[SQLModel]
    secret_columns: tuple[str, ...]


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
    EncryptedTarget(BotAttachment, ("ciphertext", "text_ciphertext")),
    EncryptedTarget(AdminAssistantSession, ("state_ciphertext",)),
    EncryptedTarget(AdminAssistantMessage, ("ciphertext",)),
    EncryptedTarget(AdminAssistantAttachment, ("ciphertext", "text_ciphertext")),
)


@dataclass(slots=True)
class TableReencryptStats:
    table_name: str
    scanned_rows: int = 0
    rotated_rows: int = 0
    rotated_values: int = 0
    already_current_values: int = 0
    failed_values: int = 0


@dataclass(slots=True)
class ReencryptSummary:
    dry_run: bool
    tables: list[TableReencryptStats] = field(default_factory=list)
    failures: list[tuple[str, str, str]] = field(default_factory=list)
    scanned_rows: int = 0
    rotated_rows: int = 0
    rotated_values: int = 0
    already_current_values: int = 0
    failed_values: int = 0


def _format_pk(pk_cols: tuple[Column[Any], ...], pk_values: tuple[Any, ...]) -> str:
    return ",".join(f"{c.name}={v}" for c, v in zip(pk_cols, pk_values, strict=True))


def _reencrypt_table(
    session: Session, target: EncryptedTarget, *, dry_run: bool, batch_size: int
) -> tuple[TableReencryptStats, list[tuple[str, str, str]]]:
    table = cast(Table, target.model.__table__)  # type: ignore[attr-defined]
    pk_cols = tuple(table.primary_key.columns)
    secret_cols = tuple(table.c[col] for col in target.secret_columns)
    non_empty = or_(*(col.is_not(None) & (col != "") for col in secret_cols))

    stats = TableReencryptStats(table_name=table.name)
    failures: list[tuple[str, str, str]] = []
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
        rows = session.execute(stmt.order_by(*pk_cols).limit(batch_size)).all()
        if not rows:
            break

        pk_count = len(pk_cols)
        for row in rows:
            stats.scanned_rows += 1
            pk_values = tuple(row[:pk_count])
            pk_repr = _format_pk(pk_cols, pk_values)
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
                stats.rotated_values += 1
                row_rotated = True
                if not dry_run:
                    pk_pred = [c == v for c, v in zip(pk_cols, pk_values, strict=True)]
                    session.execute(
                        update(table)
                        .where(*pk_pred, col == token)
                        .values({col.name: new_token})
                    )
            if row_rotated:
                stats.rotated_rows += 1

        if not dry_run:
            session.commit()
        last_pk = tuple(rows[-1][:pk_count])
        if len(rows) < batch_size:
            break

    return stats, failures


def reencrypt_secrets(
    session: Session, *, dry_run: bool = False, batch_size: int = 500
) -> ReencryptSummary:
    """Re-encrypt all stored secret columns across every encrypted table."""
    if batch_size <= 0:
        raise ValueError("batch_size must be a positive integer")
    summary = ReencryptSummary(dry_run=dry_run)
    for target in ENCRYPTED_TARGETS:
        stats, table_failures = _reencrypt_table(
            session, target, dry_run=dry_run, batch_size=batch_size
        )
        summary.tables.append(stats)
        summary.failures.extend(table_failures)
        summary.scanned_rows += stats.scanned_rows
        summary.rotated_rows += stats.rotated_rows
        summary.rotated_values += stats.rotated_values
        summary.already_current_values += stats.already_current_values
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
        help="Verify decryption and count rows needing re-encryption without writing to the database.",
    )
    parser.add_argument(
        "--batch-size",
        type=_positive_int,
        default=500,
        help="Rows processed and committed per batch (default: 500).",
    )
    args = parser.parse_args(argv)

    with Session(engine) as session:
        summary = reencrypt_secrets(
            session, dry_run=args.dry_run, batch_size=args.batch_size
        )

    mode = "dry-run" if summary.dry_run else "apply"
    label = "pending_values" if summary.dry_run else "rotated_values"
    for t in summary.tables:
        sys.stdout.write(
            f"[{mode}] {t.table_name}: scanned_rows={t.scanned_rows} "
            f"{label}={t.rotated_values} already_current={t.already_current_values} "
            f"failed={t.failed_values}\n"
        )
    sys.stdout.write(
        f"[{mode}] summary: scanned_rows={summary.scanned_rows} rotated_rows={summary.rotated_rows} "
        f"{label}={summary.rotated_values} already_current={summary.already_current_values} "
        f"failed={summary.failed_values}\n"
    )
    for table_name, pk_repr, col_name in summary.failures:
        sys.stderr.write(
            f"ERROR: unable to decrypt table={table_name} pk={pk_repr} column={col_name}\n"
        )
    return 1 if summary.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
