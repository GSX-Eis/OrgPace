from typing import Any
from uuid import UUID

from psycopg import ClientCursor, Connection, Error, sql
from sqlmodel import Session, SQLModel, col, delete, select

import app.models  # noqa: F401
from app.domains.org.models import Organization, OrgMembership, RoleGrant
from app.models import User


def derive_org_models() -> tuple[Any, ...]:
    """Derive tenant-scoped SQLModel tables in FK-safe deletion order (children first)."""
    table_to_model = {
        mapper.local_table.name: mapper.class_
        for mapper in SQLModel._sa_registry.mappers
        if issubclass(mapper.class_, SQLModel)
    }
    models = []
    for table in reversed(SQLModel.metadata.sorted_tables):
        if (
            table.name == "organization"
            or table.name.startswith("procrastinate_")
            or table.name == "alembic_version"
        ):
            continue
        if "org_id" not in table.c:
            continue
        model = table_to_model.get(table.name)
        if model is not None:
            models.append(model)
    return tuple(models)


ORG_MODELS = derive_org_models()


def cleanup_new_users(session: Session, existing_user_ids: set[UUID]) -> None:
    session.execute(
        delete(User).where(
            col(User.id).not_in(existing_user_ids),
            ~select(OrgMembership.id).where(OrgMembership.user_id == User.id).exists(),
            ~select(RoleGrant.id)
            .where(RoleGrant.granted_by_user_id == User.id)
            .exists(),
        )
    )


def delete_test_organization(session: Session, org_id: UUID, *other_ids: UUID) -> None:
    org_ids = list(dict.fromkeys((org_id, *other_ids)))
    tables = (*ORG_MODELS, Organization)
    deletes = sql.SQL("\n").join(
        sql.SQL("DELETE FROM {} WHERE {} = ANY(target_ids);").format(
            sql.Identifier(str(model.__tablename__)),
            sql.Identifier("id" if model is Organization else "org_id"),
        )
        for model in tables
    )
    # Client binding safely passes the UUID array inside the dollar-quoted block.
    block = sql.SQL("""
        DO $cleanup$
        DECLARE target_ids uuid[] := %s;
        BEGIN
            IF (SELECT count(*) FROM (
                SELECT id FROM organization
                WHERE id = ANY(target_ids) AND slug <> 'demo'
                FOR UPDATE
            ) AS owned) <> cardinality(target_ids) THEN
                RAISE EXCEPTION USING ERRCODE = 'Z0001',
                    MESSAGE = 'Only a test-owned organization may be deleted';
            END IF;
            PERFORM set_config('app.allow_evidence_delete', 'on', true);
            {}
        END
        $cleanup$
    """).format(deletes)
    session.flush()
    connection = session.connection().connection.driver_connection
    assert isinstance(connection, Connection)
    try:
        with ClientCursor(connection) as cursor:
            cursor.execute(block, (org_ids,))
    except Error as exc:
        if exc.sqlstate != "Z0001":
            raise
        session.rollback()
        raise ValueError(str(exc.diag.message_primary)) from exc
    session.commit()
