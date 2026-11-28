import uuid
from calendar import monthrange
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import DateTime, Enum, ForeignKeyConstraint
from sqlmodel import Field, SQLModel


def utc_now() -> datetime:
    return datetime.now(UTC)


def months_before(now: datetime, months: int) -> datetime:
    year, month = divmod(now.year * 12 + now.month - 1 - months, 12)
    month += 1
    return now.replace(
        year=year, month=month, day=min(now.day, monthrange(year, month)[1])
    )


def enum_type(enum: type[StrEnum]) -> Enum:
    return Enum(
        enum,
        native_enum=False,
        create_constraint=True,
        values_callable=lambda members: [member.value for member in members],
    )


def tenant_fk(column: str, table: str) -> ForeignKeyConstraint:
    return ForeignKeyConstraint(["org_id", column], [f"{table}.org_id", f"{table}.id"])


class Record(SQLModel):
    id: uuid.UUID = Field(default_factory=uuid.uuid7, primary_key=True)
    created_at: datetime = Field(
        default_factory=utc_now, sa_type=DateTime(timezone=True)
    )


class TenantRecord(Record):
    org_id: uuid.UUID = Field(foreign_key="organization.id", index=True)
