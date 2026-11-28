import json
import logging
from collections.abc import Callable
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import false, func
from sqlmodel import Session, col, select

from app.authz.policies import employee_scope_clause
from app.authz.principal import Principal
from app.domains.bot.models import BotMessage, BotSession
from app.domains.bot.settings import read_settings as read_settings
from app.domains.capability.models import CapabilityDefinition
from app.domains.capacity.settings import read_settings as read_capacity_settings
from app.domains.change_request.models import (
    ChangeItem,
    ProfileChangeRequest,
    RequestStatus,
    ReviewDecision,
)
from app.domains.chat_runtime import store as _chat_store
from app.domains.chat_runtime.schemas import (
    MessagePublic as MessagePublic,
)
from app.domains.chat_runtime.schemas import (
    SessionList as SessionList,
)
from app.domains.chat_runtime.schemas import (
    SessionSummary as SessionSummary,
)
from app.domains.chat_runtime.store import (
    SessionNotFound,
)
from app.domains.chat_runtime.store import (
    append_message as append_message,
)
from app.domains.chat_runtime.store import (
    load_state as load_state,
)
from app.domains.chat_runtime.store import (
    messages_for as messages_for,
)
from app.domains.chat_runtime.store import (
    register_session_getter as _register_session_getter,
)
from app.domains.chat_runtime.store import (
    save_state as save_state,
)
from app.domains.chat_runtime.store import (
    setup_in_progress as setup_in_progress,
)
from app.domains.org.models import Employee, EmploymentStatus
from app.domains.org.service import visible_employee
from app.domains.profile.models import ProfileVersion
from app.domains.setup import wizard as _setup_wizard  # noqa: F401
from app.i18n import tr

BotSessionNotFound = SessionNotFound

logger = logging.getLogger(__name__)

HIDDEN_REPLY = "你的权限已变化，这条之前的回复已隐藏，请重新提问"
READ_SCOPE_FORMAT = "complete_v1"
SENSITIVE_TOOLS = {
    "coordination",
    "prepare_plan_proposal",
    "get_demand_basis",
    "list_team_members",
    "find_people",
    "get_member_profile",
    "prepare_profile_edit",
    "查看团队成员",
    "按能力找人",
    "查看下属画像",
    "预览直接修改画像",
    "调查并模拟部门协调方案",
    "预览部门方案答复",
    "查看本部门需求依据和个人负荷，仅限答复方",
    "View team members",
    "Find people by capability",
    "View team member profile",
    "Preview direct profile edit",
    "Investigate and simulate department coordination plans",
    "Preview department plan reply",
    "View department demand basis and workload (responder only)",
}


def list_sessions(db: Session, principal: Principal) -> SessionList:
    if principal.employee_id is not None:
        visible_employee(db, principal, principal.employee_id)
    elif not principal.managed_department_ids:
        raise BotSessionNotFound()
    owner = (col(BotSession.employee_id) == principal.employee_id) & (
        col(BotSession.channel) == "web"
    )
    return _chat_store.list_session_summaries(
        db, principal, BotSession, BotMessage, owner, pinned=false()
    )


def create_session(
    db: Session,
    principal: Principal,
    channel: Literal["web", "telegram", "feishu", "wecom"] = "web",
    external_chat_id: str | None = None,
    bot_identity: str | None = None,
) -> BotSession:
    if principal.employee_id is None:
        raise BotSessionNotFound()
    visible_employee(db, principal, principal.employee_id)
    row = BotSession(
        org_id=principal.org_id,
        employee_id=principal.employee_id,
        channel=channel,
        external_chat_id=external_chat_id,
        bot_identity=bot_identity,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_session(
    db: Session, principal: Principal, session_id: UUID, *, lock: bool = False
) -> BotSession:
    query = (
        select(BotSession)
        .where(
            BotSession.org_id == principal.org_id,
            col(BotSession.employee_id) == principal.employee_id,
            BotSession.id == session_id,
        )
        .execution_options(populate_existing=True)
    )
    row = db.exec(query.with_for_update() if lock else query).one_or_none()
    if row is None:
        raise BotSessionNotFound()
    visible_employee(db, principal, row.employee_id)
    return row


_register_session_getter("bot", get_session)


def list_messages(
    db: Session, principal: Principal, session_id: UUID
) -> list[MessagePublic]:
    session = get_session(db, principal, session_id)
    messages = messages_for(db, session)
    current = session_scope(db, principal)
    # Evaluate the session-wide fallback before hiding any messages, but only
    # when a legacy scope can actually depend on it.
    legacy_sensitive = False
    if any(
        message.role == "assistant"
        and isinstance(message.payload, dict)
        and _needs_legacy_scope(message.payload.get("scope"), current)
        for message in messages
    ):
        legacy_sensitive = _legacy_sensitive(messages, None) or _legacy_sensitive(
            [], load_state(db, session)
        )
    confirmed_card_ids: set[str] = set()
    for message in messages:
        if message.role != "assistant" or not isinstance(message.payload, dict):
            continue
        previous = message.payload.get("scope")
        if scope_shrank(previous, current, legacy_sensitive=legacy_sensitive):
            message.payload = {"messages": [{"type": "text", "text": tr(HIDDEN_REPLY)}]}
        else:
            message.payload.pop("scope", None)
            confirmed_id = message.payload.pop("confirmed_card_id", None)
            if isinstance(confirmed_id, str):
                confirmed_card_ids.add(confirmed_id)
    _refresh_request_cards(db, principal, messages, confirmed_card_ids)
    return messages


def _refresh_request_cards(
    db: Session,
    principal: Principal,
    messages: list[MessagePublic],
    confirmed_card_ids: set[str] | None = None,
) -> None:
    confirmed = confirmed_card_ids or set()
    cards: list[tuple[UUID, dict[str, JsonValue]]] = []
    review_cards: list[tuple[UUID, dict[str, JsonValue]]] = []
    edit_cards: list[tuple[UUID, dict[str, JsonValue]]] = []
    for message in messages:
        if message.role != "assistant" or not isinstance(message.payload, dict):
            continue
        contents = message.payload.get("messages")
        if not isinstance(contents, list):
            continue
        for card in contents:
            if not isinstance(card, dict):
                continue
            match card.get("type"):
                case "preview_card":
                    id_value = card.get("request_id")
                    if isinstance(id_value, str):
                        cards.append((UUID(id_value), card))
                case "status_card":
                    id_value = card.get("id")
                    if isinstance(id_value, str):
                        cards.append((UUID(id_value), card))
                case "review_card":
                    id_value = card.get("id")
                    if isinstance(id_value, str):
                        review_cards.append((UUID(id_value), card))
                case "profile_edit_card":
                    id_value = card.get("employee_id")
                    if isinstance(id_value, str):
                        edit_cards.append((UUID(id_value), card))
                case _:
                    continue
    if cards:
        request = ProfileChangeRequest
        current: dict[UUID, tuple[RequestStatus, int]] = {}
        decisions: dict[tuple[UUID, str], str | None] = {}
        for row, key, decision in db.exec(
            select(
                request,
                CapabilityDefinition.key,
                ChangeItem.decision,
            )
            .outerjoin(
                ChangeItem,
                (col(ChangeItem.org_id) == request.org_id)
                & (col(ChangeItem.request_id) == request.id),
            )
            .outerjoin(
                CapabilityDefinition,
                (col(CapabilityDefinition.org_id) == ChangeItem.org_id)
                & (col(CapabilityDefinition.id) == ChangeItem.capability_definition_id),
            )
            .where(
                request.org_id == principal.org_id,
                request.subject_employee_id == principal.employee_id,
                col(request.id).in_({id_ for id_, _ in cards}),
            )
        ).all():
            current[row.id] = (row.status, row.revision)
            if key is not None:
                decisions[row.id, key] = str(decision) if decision is not None else None
        seen_status: set[UUID] = set()
        for id_, card in reversed(cards):
            status, revision = current.get(id_, (None, None))
            if card["type"] == "preview_card":
                active = status in (RequestStatus.DRAFT, RequestStatus.PENDING_OWNER)
            else:
                active = (
                    status == RequestStatus.PENDING_REVIEW and id_ not in seen_status
                )
                seen_status.add(id_)
                if status is not None:
                    card["status"] = status.value
                items = card.get("items")
                if isinstance(items, list):
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        capability = item.get("capability")
                        item_key = (
                            capability.get("key")
                            if isinstance(capability, dict)
                            else None
                        )
                        if isinstance(item_key, str) and (id_, item_key) in decisions:
                            item["decision"] = decisions[id_, item_key]
            if not active or card.get("revision") != revision:
                card["actions"] = []
    if review_cards:
        from app.domains.review.routing import can_review

        review_ids = {id_ for id_, _ in review_cards}
        review_rows = {
            r.id: r
            for r in db.exec(
                select(ProfileChangeRequest).where(
                    ProfileChangeRequest.org_id == principal.org_id,
                    col(ProfileChangeRequest.id).in_(review_ids),
                )
            ).all()
        }
        allowed_subjects = {
            subject_id: can_review(db, principal, subject_id) is not None
            for subject_id in {r.subject_employee_id for r in review_rows.values()}
        }
        decided_revisions = set(
            db.exec(
                select(
                    ReviewDecision.request_id, ReviewDecision.request_revision
                ).where(
                    ReviewDecision.org_id == principal.org_id,
                    col(ReviewDecision.request_id).in_(review_ids),
                )
            ).all()
        )
        seen_review: set[UUID] = set()
        for id_, card in reversed(review_cards):
            card_id = str(card.get("card_id", ""))
            review_row = review_rows.get(id_)
            allowed = bool(
                review_row and allowed_subjects.get(review_row.subject_employee_id)
            )
            if card_id in confirmed:
                card["actions"] = []
                card["status"] = "confirmed"
                card["result"] = tr("审批决定已保存，请在网页查看结果")
            elif (
                review_row is None
                or not allowed
                or review_row.status != RequestStatus.PENDING_REVIEW
                or review_row.revision != card.get("revision")
            ):
                card["actions"] = []
                if (
                    review_row is not None
                    and allowed
                    and review_row.status != RequestStatus.PENDING_REVIEW
                    and (review_row.id, card.get("revision")) in decided_revisions
                ):
                    card["status"] = "confirmed"
                    card["result"] = tr("该请求已完成审批")
                else:
                    card["status"] = "stale"
                    card["result"] = tr("内容已更新，请重新查看待审批请求")
            elif id_ in seen_review:
                card["actions"] = []
                card["status"] = "stale"
                card["result"] = tr("已生成新的审批预览")
            else:
                seen_review.add(id_)
                card.setdefault("status", "pending")
    if edit_cards:
        employee_ids = {id_ for id_, _ in edit_cards}
        active_managed = set(
            db.exec(
                select(Employee.id).where(
                    Employee.org_id == principal.org_id,
                    col(Employee.id).in_(employee_ids),
                    col(Employee.department_id).in_(principal.managed_department_ids),
                    Employee.employment_status == EmploymentStatus.ACTIVE,
                )
            ).all()
        )
        latest_revisions = dict(
            db.exec(
                select(
                    ProfileVersion.subject_employee_id,
                    func.max(ProfileVersion.revision),
                )
                .where(
                    ProfileVersion.org_id == principal.org_id,
                    col(ProfileVersion.subject_employee_id).in_(employee_ids),
                )
                .group_by(col(ProfileVersion.subject_employee_id))
            ).all()
        )
        seen_edit: set[UUID] = set()
        for emp_id, card in reversed(edit_cards):
            card_id = str(card.get("card_id", ""))
            if card_id in confirmed:
                card["actions"] = []
                card["status"] = "confirmed"
                card["result"] = tr("画像已发布，已通知员工")
            elif emp_id not in active_managed or latest_revisions.get(
                emp_id
            ) != card.get("revision"):
                card["actions"] = []
                card["status"] = "stale"
                card["result"] = tr("员工画像已更新，请重新查看后再修改")
            elif emp_id in seen_edit:
                card["actions"] = []
                card["status"] = "stale"
                card["result"] = tr("已生成新的修改预览")
            else:
                seen_edit.add(emp_id)
                card.setdefault("status", "pending")


def session_scope(db: Session, principal: Principal) -> dict[str, JsonValue]:
    departments: list[JsonValue] = []
    departments.extend(sorted(str(id) for id in principal.managed_department_ids))
    return {
        "is_org_admin": principal.is_org_admin,
        "managed_department_ids": departments,
        "capacity_enabled": read_capacity_settings(principal, db).enabled,
        # Role grants alone cannot detect a team member's transfer or departure.
        "visible_employee_ids": [
            str(id)
            for id in db.exec(
                select(Employee.id)
                .where(employee_scope_clause(principal))
                .order_by(col(Employee.id))
            ).all()
        ],
    }


def scope_shrank(
    previous: JsonValue | None,
    current: dict[str, JsonValue],
    *,
    legacy_sensitive: bool = False,
) -> bool:
    if not isinstance(previous, dict):
        return legacy_sensitive
    # Older partial read sets could miss employees mentioned in coordination prose.
    if (
        "read_employee_ids" in previous
        and previous.get("read_scope_format") != READ_SCOPE_FORMAT
    ):
        return True
    old_departments = previous.get("managed_department_ids")
    new_departments = current["managed_department_ids"]
    old_employees = previous.get(
        "read_employee_ids", previous.get("visible_employee_ids")
    )
    new_employees = current["visible_employee_ids"]
    return bool(
        (previous.get("is_org_admin") and not current["is_org_admin"])
        or (previous.get("capacity_enabled") and not current["capacity_enabled"])
        or (
            isinstance(old_departments, list)
            and isinstance(new_departments, list)
            and not {str(id) for id in old_departments}.issubset(new_departments)
        )
        or (
            isinstance(old_employees, list)
            and isinstance(new_employees, list)
            and not {str(id) for id in old_employees}.issubset(new_employees)
        )
        or (not isinstance(old_employees, list) and legacy_sensitive)
    )


def _needs_legacy_scope(previous: JsonValue, current: dict[str, JsonValue]) -> bool:
    if not isinstance(previous, dict):
        return True
    if isinstance(
        previous.get("read_employee_ids", previous.get("visible_employee_ids")), list
    ):
        return False
    return not scope_shrank(previous, current)


def _legacy_sensitive(
    messages: list[MessagePublic], state: dict[str, JsonValue] | None
) -> bool:
    for message in messages:
        if message.role == "assistant" and isinstance(message.payload, dict):
            cards = message.payload.get("messages")
            if isinstance(cards, list) and any(
                isinstance(item, dict) and item.get("type") == "plan_card"
                for item in cards
            ):
                return True
            steps = message.payload.get("steps")
            if isinstance(steps, list) and any(
                isinstance(step, dict) and step.get("name") in SENSITIVE_TOOLS
                for step in steps
            ):
                return True
    serialized = json.dumps(state, ensure_ascii=False) if state else ""
    return any(f'"{name}"' in serialized for name in SENSITIVE_TOOLS)


def state_for_turn(
    db: Session,
    principal: Principal,
    session: BotSession,
    *,
    scope: dict[str, JsonValue] | None = None,
    on_read: Callable[[set[str]], None] | None = None,
) -> dict[str, JsonValue] | None:
    saved = load_state(db, session, scoped=True)
    if saved is None:
        return None
    if "scope" in saved:
        previous = saved["scope"]
        state = {key: value for key, value in saved.items() if key != "scope"}
        legacy_sensitive = (
            _legacy_sensitive(messages_for(db, session), state)
            if not isinstance(previous, dict)
            or not ({"visible_employee_ids", "read_employee_ids"} & previous.keys())
            else False
        )
    else:
        previous = None
        state = saved
        legacy_sensitive = _legacy_sensitive(messages_for(db, session), saved)
    current = scope if scope is not None else session_scope(db, principal)
    if scope_shrank(
        previous,
        current,
        legacy_sensitive=legacy_sensitive,
    ):
        save_state(db, session, None)
        db.commit()
        return None
    if on_read:
        ids = (
            previous.get("read_employee_ids", previous.get("visible_employee_ids"))
            if isinstance(previous, dict)
            else None
        )
        if not isinstance(ids, list):
            ids = current["visible_employee_ids"]
        if isinstance(ids, list):
            on_read({str(id) for id in ids})
    return state if isinstance(state, dict) else None


def save_scoped_state(
    db: Session,
    principal: Principal,
    session: BotSession,
    state: dict[str, JsonValue] | None,
    *,
    scope: dict[str, JsonValue] | None = None,
) -> None:
    save_state(
        db,
        session,
        {**state, "scope": scope if scope is not None else session_scope(db, principal)}
        if state is not None
        else None,
    )


def cleanup_messages(db: Session, now: datetime) -> None:
    _chat_store.cleanup_messages(db, now, read_settings_fn=read_settings)
