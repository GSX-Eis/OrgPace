from sqlmodel import Session, select

from app.authz.deps import OrgAdminRequired
from app.authz.principal import Principal
from app.domains.base import utc_now
from app.domains.capacity.common import (
    CapacityConflict as CapacityConflict,
)
from app.domains.capacity.common import (
    CapacityForbidden as CapacityForbidden,
)
from app.domains.capacity.common import (
    CapacityNotFound as CapacityNotFound,
)
from app.domains.capacity.common import (
    audit as audit,
)
from app.domains.capacity.models import CapacitySetting
from app.domains.capacity.schemas import CapacitySettingsInput, Via
from app.domains.org.service import lock_org


def read_settings(principal: Principal, session: Session) -> CapacitySettingsInput:
    row = session.exec(
        select(CapacitySetting).where(CapacitySetting.org_id == principal.org_id)
    ).one_or_none()
    return CapacitySettingsInput.model_validate(row) if row else CapacitySettingsInput()


def require_enabled(principal: Principal, session: Session) -> None:
    row = session.exec(
        select(CapacitySetting)
        .where(CapacitySetting.org_id == principal.org_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    ).one_or_none()
    if row is None or not row.enabled:
        raise CapacityNotFound("规划与负荷功能未开启")


def save_settings(
    principal: Principal,
    session: Session,
    body: CapacitySettingsInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> CapacitySettingsInput:
    if not principal.is_org_admin or principal.user_id is None:
        raise OrgAdminRequired()
    lock_org(session, principal.org_id)
    row = session.exec(
        select(CapacitySetting)
        .where(CapacitySetting.org_id == principal.org_id)
        .with_for_update()
    ).one_or_none()
    was_enabled = row.enabled if row is not None else False
    if row is None:
        row = CapacitySetting(
            org_id=principal.org_id, updated_by_user_id=principal.user_id
        )
    row.enabled, row.requester_policy = body.enabled, body.requester_policy
    row.default_allocation_cap_percent = body.default_allocation_cap_percent
    row.updated_at, row.updated_by_user_id = utc_now(), principal.user_id
    session.add(row)
    session.flush()
    audit(
        principal,
        session,
        "capacity.settings_updated",
        "capacity_setting",
        row.id,
        via,
        client_name,
        body.model_dump(mode="json"),
    )
    if row.enabled and not was_enabled:
        from app.domains.capacity.forecast import refresh_org_forecasts

        refresh_org_forecasts(session, principal.org_id)
    return body
