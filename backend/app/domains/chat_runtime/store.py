import json
import logging
from collections.abc import Callable, Sequence
from datetime import datetime, timedelta
from typing import Literal, Protocol
from uuid import UUID

from fastapi import HTTPException
from pydantic import JsonValue
from sqlalchemy import ColumnElement, case, false, true
from sqlmodel import Session, col, delete, select, update

from app.authz.principal import Principal
from app.core.secrets import decrypt_secret, encrypt_secret
from app.domains.admin_assistant.models import (
    AdminAssistantAttachment,
    AdminAssistantMessage,
    AdminAssistantSession,
    AdminChangeSet,
)
from app.domains.base import utc_now
from app.domains.bot.models import BotAttachment, BotMessage, BotSession
from app.domains.chat_runtime.models import ConversationMessage
from app.domains.chat_runtime.schemas import (
    MessagePublic,
    SessionList,
    SessionSummary,
)
from app.domains.chat_runtime.settings import BotSettings, read_settings
from app.domains.model.service import read_setting
from app.domains.org.models import Organization

logger = logging.getLogger(__name__)

SessionKind = Literal["admin", "bot"]


class SessionNotFound(HTTPException):
    def __init__(self) -> None:
        super().__init__(404, "会话不存在")


class SessionGetter(Protocol):
    def __call__(
        self,
        db: Session,
        principal: Principal,
        session_id: UUID,
        *,
        lock: bool = False,
    ) -> BotSession | AdminAssistantSession: ...


SetupCompletionChecker = Callable[[Session, UUID], bool]

_session_getters: dict[SessionKind, SessionGetter] = {}
_setup_completion_checker: SetupCompletionChecker | None = None


def register_session_getter(kind: SessionKind, getter: SessionGetter) -> None:
    _session_getters[kind] = getter


def get_registered_session(
    db: Session,
    principal: Principal,
    kind: SessionKind,
    session_id: UUID,
    *,
    lock: bool = False,
) -> BotSession | AdminAssistantSession:
    getter = _session_getters.get(kind)
    if getter is None:
        raise RuntimeError(f"Session getter is not registered for kind={kind!r}")
    return getter(db, principal, session_id, lock=lock)


def register_setup_completion_checker(checker: SetupCompletionChecker) -> None:
    global _setup_completion_checker
    _setup_completion_checker = checker


def is_setup_completed(db: Session, org_id: UUID) -> bool:
    if _setup_completion_checker is None:
        raise RuntimeError("Setup completion checker is not registered")
    return _setup_completion_checker(db, org_id)


def setup_in_progress(db: Session, session: BotSession | AdminAssistantSession) -> bool:
    return (
        isinstance(session, AdminAssistantSession)
        and session.purpose == "setup"
        and not is_setup_completed(db, session.org_id)
    )


def list_session_summaries(
    db: Session,
    principal: Principal,
    session_type: type[BotSession] | type[AdminAssistantSession],
    message_type: type[BotMessage] | type[AdminAssistantMessage],
    owner: ColumnElement[bool],
    *,
    pinned: ColumnElement[bool] | None = None,
) -> SessionList:
    days = read_settings(db, principal.org_id).retention_days
    pin = pinned if pinned is not None else false()
    now = utc_now()
    retained = select(message_type.id).where(
        message_type.org_id == principal.org_id,
        message_type.session_id == session_type.id,
        message_type.created_at > now - timedelta(days=days) if days else True,
    )
    first_user = (
        select(message_type.ciphertext)
        .where(
            message_type.org_id == principal.org_id,
            message_type.session_id == session_type.id,
            message_type.role == "user",
            message_type.created_at > now - timedelta(days=days) if days else True,
        )
        .order_by(col(message_type.created_at), col(message_type.id))
        .limit(1)
        .scalar_subquery()
    )
    rows = db.exec(
        select(session_type, first_user)
        .where(
            col(session_type.org_id) == principal.org_id,
            owner,
            retained.exists() | pin,
            (col(session_type.last_activity_at) > now - timedelta(hours=2)) | pin
            if not days
            else True,
        )
        .order_by(
            case((pin, 0), else_=1),
            col(session_type.last_activity_at).desc(),
            col(session_type.id).desc(),
        )
        .limit(50)
    ).all()
    setting = read_setting(db, principal.org_id)
    return SessionList(
        retention_days=days,
        model_available=bool(setting and setting.enabled and setting.model),
        data=[
            SessionSummary(
                **row.model_dump(
                    include={"id", "started_at", "last_activity_at", "turn_count"}
                ),
                purpose="setup"
                if isinstance(row, AdminAssistantSession) and row.purpose == "setup"
                else None,
                preview=json.loads(decrypt_secret(ciphertext))["text"][:40]
                if ciphertext
                else "",
            )
            for row, ciphertext in rows
        ],
    )


def append_message(
    db: Session,
    session: BotSession | AdminAssistantSession,
    role: Literal["user", "assistant"],
    payload: JsonValue,
) -> ConversationMessage:
    message_type: type[ConversationMessage] = (
        AdminAssistantMessage
        if isinstance(session, AdminAssistantSession)
        else BotMessage
    )
    if (
        not read_settings(db, session.org_id).retention_days
        and not setup_in_progress(db, session)
        and session.last_activity_at <= utc_now() - timedelta(hours=2)
    ):
        session.state_ciphertext = None
        attachment_type = (
            AdminAssistantAttachment
            if isinstance(session, AdminAssistantSession)
            else BotAttachment
        )
        db.exec(
            delete(attachment_type).where(
                col(attachment_type.org_id) == session.org_id,
                col(attachment_type.session_id) == session.id,
                col(attachment_type.created_at) <= utc_now() - timedelta(hours=2),
            )
        )
        db.exec(
            delete(message_type).where(
                col(message_type.org_id) == session.org_id,
                col(message_type.session_id) == session.id,
            )
        )
    row = message_type(
        org_id=session.org_id,
        session_id=session.id,
        role=role,
        ciphertext=encrypt_secret(json.dumps(payload, ensure_ascii=False)),
    )
    db.add(row)
    session.last_activity_at = utc_now()
    db.add(session)
    db.flush()
    return row


def _messages(
    db: Session,
    session: BotSession | AdminAssistantSession,
    *,
    limit: int | None = None,
) -> Sequence[ConversationMessage]:
    message_type: type[ConversationMessage] = (
        AdminAssistantMessage
        if isinstance(session, AdminAssistantSession)
        else BotMessage
    )
    days = read_settings(db, session.org_id).retention_days
    now = utc_now()
    protected = setup_in_progress(db, session)
    if (
        not days
        and not protected
        and session.last_activity_at <= now - timedelta(hours=2)
    ):
        return []
    query = (
        select(message_type)
        .where(
            message_type.org_id == session.org_id,
            message_type.session_id == session.id,
            message_type.created_at > now - timedelta(days=days)
            if days and not protected
            else True,
        )
        .order_by(col(message_type.created_at).desc(), col(message_type.id).desc())
    )
    return list(db.exec(query.limit(limit) if limit else query).all())[::-1]


def messages_for(
    db: Session,
    session: BotSession | AdminAssistantSession,
    *,
    limit: int | None = None,
) -> list[MessagePublic]:
    return [
        MessagePublic(
            id=row.id,
            role=row.role,
            payload=json.loads(decrypt_secret(row.ciphertext)),
            created_at=row.created_at,
        )
        for row in _messages(db, session, limit=limit)
    ]


def load_state(
    db: Session, session: BotSession | AdminAssistantSession, *, scoped: bool = False
) -> dict[str, JsonValue] | None:
    days = read_settings(db, session.org_id).retention_days
    protected = setup_in_progress(db, session)
    if (
        not protected
        and not days
        and session.last_activity_at <= utc_now() - timedelta(hours=2)
    ):
        return None
    message_type = (
        AdminAssistantMessage
        if isinstance(session, AdminAssistantSession)
        else BotMessage
    )
    if (
        not protected
        and days
        and db.exec(
            select(message_type.id)
            .where(
                message_type.org_id == session.org_id,
                message_type.session_id == session.id,
                message_type.created_at <= utc_now() - timedelta(days=days),
            )
            .limit(1)
        ).first()
    ):
        return None
    attachment_type = (
        AdminAssistantAttachment
        if isinstance(session, AdminAssistantSession)
        else BotAttachment
    )
    if (
        not protected
        and session.state_ciphertext
        and db.exec(
            select(attachment_type.id)
            .where(
                attachment_type.org_id == session.org_id,
                attachment_type.session_id == session.id,
                attachment_type.created_at
                <= utc_now() - (timedelta(days=days) if days else timedelta(hours=2)),
            )
            .limit(1)
        ).first()
    ):
        return None
    state = (
        json.loads(decrypt_secret(session.state_ciphertext))
        if session.state_ciphertext
        else None
    )
    if isinstance(session, BotSession) and state and "scope" in state and not scoped:
        return {key: value for key, value in state.items() if key != "scope"}
    return state


def save_state(
    db: Session,
    session: BotSession | AdminAssistantSession,
    state: dict[str, JsonValue] | None,
) -> None:
    session.state_ciphertext = (
        encrypt_secret(json.dumps(state, ensure_ascii=False))
        if state is not None
        else None
    )
    db.add(session)


def cleanup_messages(
    db: Session,
    now: datetime,
    *,
    read_settings_fn: Callable[[Session, UUID], BotSettings] | None = None,
) -> None:
    get_settings = read_settings_fn or read_settings
    org_ids = db.exec(select(Organization.id)).all()
    db.commit()
    for org_id in org_ids:
        try:
            days = get_settings(db, org_id).retention_days
            pending_setup = not is_setup_completed(db, org_id)
            protected = select(AdminAssistantSession.id).where(
                AdminAssistantSession.org_id == org_id,
                AdminAssistantSession.purpose == "setup",
                pending_setup,
            )
            for session_type, message_type, attachment_type in (
                (BotSession, BotMessage, BotAttachment),
                (
                    AdminAssistantSession,
                    AdminAssistantMessage,
                    AdminAssistantAttachment,
                ),
            ):
                eligible = select(session_type.id).where(
                    session_type.org_id == org_id,
                    ~col(session_type.id).in_(protected)
                    if session_type is AdminAssistantSession
                    else true(),
                )
                # Extracted file text can also exist in encrypted model context.
                db.exec(
                    update(session_type)
                    .where(
                        col(session_type.org_id) == org_id,
                        col(session_type.id).in_(eligible),
                        col(session_type.id).in_(
                            select(attachment_type.session_id).where(
                                attachment_type.org_id == org_id,
                                attachment_type.created_at
                                <= now
                                - (
                                    timedelta(days=days) if days else timedelta(hours=2)
                                ),
                            )
                        ),
                    )
                    .values(state_ciphertext=None)
                )
                db.exec(
                    delete(attachment_type).where(
                        col(attachment_type.org_id) == org_id,
                        col(attachment_type.session_id).in_(eligible),
                        col(attachment_type.created_at)
                        <= now - (timedelta(days=days) if days else timedelta(hours=2)),
                    )
                )
                expired = eligible.where(
                    session_type.last_activity_at <= now - timedelta(hours=2),
                )
                expired_messages = select(message_type.session_id).where(
                    message_type.org_id == org_id,
                    message_type.created_at <= now - timedelta(days=days),
                )
                db.exec(
                    update(session_type)
                    .where(
                        col(session_type.org_id) == org_id,
                        col(session_type.id).in_(eligible),
                        col(session_type.id).in_(expired_messages if days else expired),
                    )
                    .values(state_ciphertext=None)
                )
                if session_type is AdminAssistantSession:
                    db.exec(
                        update(AdminChangeSet)
                        .where(
                            col(AdminChangeSet.org_id) == org_id,
                            col(AdminChangeSet.session_id).in_(
                                eligible.where(
                                    AdminAssistantSession.last_activity_at
                                    <= now
                                    - (
                                        timedelta(days=days)
                                        if days
                                        else timedelta(hours=2)
                                    ),
                                )
                            ),
                            col(AdminChangeSet.status) == "draft",
                        )
                        .values(
                            secrets=None,
                            status="stale",
                            confirmed_once_at=None,
                            updated_at=now,
                        )
                    )
                db.exec(
                    delete(message_type).where(
                        col(message_type.session_id).in_(eligible),
                        col(message_type.org_id) == org_id,
                        col(message_type.created_at) <= now - timedelta(days=days)
                        if days
                        else col(message_type.session_id).in_(expired),
                    )
                )
            db.commit()
        except Exception as error:
            db.rollback()
            logger.error("org_id=%s error_type=%s", org_id, type(error).__name__)
