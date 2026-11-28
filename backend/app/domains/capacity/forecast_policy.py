from collections.abc import Iterable
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import Session, col, select

from app.authz.policies import can_manage_department, can_view_org_aggregates
from app.authz.principal import Principal
from app.domains.base import utc_now
from app.domains.capacity import calendar
from app.domains.capacity.common import (
    DEFAULT_RETENTION_RATE as DEFAULT_RETENTION_RATE,
)
from app.domains.capacity.common import (
    CapacityForbidden,
    CapacityNotFound,
    audit,
    require_enabled,
)
from app.domains.capacity.common import (
    build_policy_label as build_policy_label,
)
from app.domains.capacity.common import (
    build_scope_label as build_scope_label,
)
from app.domains.capacity.common import (
    retention_from_decay as retention_from_decay,
)
from app.domains.capacity.common import (
    retention_mode_label as retention_mode_label,
)
from app.domains.capacity.forecast import refresh_org_forecasts
from app.domains.capacity.models import (
    CapacityForecastEvent,
    CapacityForecastPolicy,
    CapacitySetting,
)
from app.domains.capacity.schemas import (
    ForecastConfigPublic,
    ForecastEventInput,
    ForecastEventList,
    ForecastEventMutationResult,
    ForecastEventPublic,
    ForecastPolicyInput,
    ForecastPolicyMutationResult,
    ForecastPolicyPublic,
    ForecastRefreshResult,
    Via,
)
from app.domains.org.models import Department, Employee, EmploymentStatus
from app.domains.org.service import department_ancestry, managed_scope
from app.i18n import tr


def format_retention_summary(retention_rate: float) -> str:
    if retention_rate == 0.0:
        return tr("0（脉冲波次型：干完即清零，末次确认周后回落至 0%）")
    if retention_rate == 0.5:
        return tr("0.5（常规均衡型：每周按 50% 延续，约 2 周衰减至 25%）")
    if retention_rate == 0.8:
        return tr("0.8（项目延续型：每周按 80% 延续，适合长周期项目）")
    return tr("{rate}（下周预测负荷 = 上周负荷 × {rate}）", rate=f"{retention_rate:g}")


def require_manager_or_admin(principal: Principal) -> None:
    if not can_view_org_aggregates(principal):
        raise CapacityForbidden()


def _org_departments(session: Session, org_id: UUID) -> dict[UUID, Department]:
    rows = session.exec(select(Department).where(Department.org_id == org_id)).all()
    return {row.id: row for row in rows}


def _require_department(
    session: Session, org_id: UUID, department_id: UUID
) -> Department:
    dept = session.exec(
        select(Department).where(
            Department.org_id == org_id,
            Department.id == department_id,
        )
    ).one_or_none()
    if dept is None:
        raise CapacityNotFound("未找到该部门")
    return dept


def require_write_scope(
    principal: Principal,
    session: Session,
    department_id: UUID | None,
) -> Department | None:
    require_manager_or_admin(principal)
    if principal.user_id is None:
        raise CapacityForbidden()
    if department_id is None:
        if not can_manage_department(principal, None):
            raise CapacityForbidden()
        return None
    dept = _require_department(session, principal.org_id, department_id)
    if not can_manage_department(principal, department_id):
        raise CapacityForbidden()
    return dept


def _can_edit_scope(principal: Principal, department_id: UUID | None) -> bool:
    return can_manage_department(principal, department_id)


def _visible_ancestors(
    principal: Principal, depts_by_id: dict[UUID, Department]
) -> set[UUID]:
    if principal.is_org_admin:
        return set(depts_by_id)
    ancestors: set[UUID] = set()
    for dept_id in principal.managed_department_ids:
        ancestors.update(department_ancestry(depts_by_id, dept_id))
    return ancestors


def _policy_public(
    row: CapacityForecastPolicy,
    principal: Principal,
    depts_by_id: dict[UUID, Department],
) -> ForecastPolicyPublic:
    dept_name = (
        depts_by_id[row.department_id].name
        if row.department_id is not None and row.department_id in depts_by_id
        else None
    )
    retention_rate = retention_from_decay(row.decay_rate)
    return ForecastPolicyPublic(
        id=row.id,
        department_id=row.department_id,
        department_name=dept_name,
        job_family=row.job_family,
        retention_rate=retention_rate,
        label=retention_mode_label(retention_rate),
        note=row.note,
        updated_by_user_id=row.updated_by_user_id,
        updated_at=row.updated_at,
        can_edit=_can_edit_scope(principal, row.department_id),
    )


def _event_public(
    row: CapacityForecastEvent,
    principal: Principal,
    depts_by_id: dict[UUID, Department],
) -> ForecastEventPublic:
    dept_name = (
        depts_by_id[row.department_id].name
        if row.department_id is not None and row.department_id in depts_by_id
        else None
    )
    return ForecastEventPublic(
        id=row.id,
        department_id=row.department_id,
        department_name=dept_name,
        job_family=row.job_family,
        title=row.title,
        start_week=row.start_week,
        end_week=row.end_week,
        modifier_kind=row.modifier_kind,
        modifier_value=row.modifier_value,
        reason=row.reason,
        created_by_user_id=row.created_by_user_id,
        updated_by_user_id=row.updated_by_user_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
        can_edit=_can_edit_scope(principal, row.department_id),
    )


def scope_employee_ids(
    session: Session,
    org_id: UUID,
    department_id: UUID | None,
    job_family: str | None,
) -> list[UUID] | None:
    """Return affected active employee IDs, or None when the whole org is affected."""
    if department_id is None and job_family is None:
        return None
    query = select(Employee.id, Employee.job_family).where(
        Employee.org_id == org_id,
        Employee.employment_status == EmploymentStatus.ACTIVE,
    )
    if department_id is not None:
        dept_scope = managed_scope(session, org_id, frozenset({department_id}))
        if not dept_scope:
            return []
        query = query.where(col(Employee.department_id).in_(dept_scope))
    rows = session.exec(query).all()
    if job_family is None:
        return [emp_id for emp_id, _ in rows]
    return [
        emp_id
        for emp_id, emp_jf in rows
        if (emp_jf.strip() or None if emp_jf else None) == job_family
    ]


def _refresh_scopes(
    session: Session,
    org_id: UUID,
    scopes: Iterable[tuple[UUID | None, str | None]],
) -> int:
    collected: set[UUID] = set()
    for dept_id, job_family in scopes:
        ids = scope_employee_ids(session, org_id, dept_id, job_family)
        if ids is None:
            return refresh_org_forecasts(session, org_id)
        collected.update(ids)
    if not collected:
        return 0
    return refresh_org_forecasts(session, org_id, employee_ids=sorted(collected))


def get_forecast_config(principal: Principal, session: Session) -> ForecastConfigPublic:
    require_enabled(principal, session)
    require_manager_or_admin(principal)
    setting = session.exec(
        select(CapacitySetting).where(CapacitySetting.org_id == principal.org_id)
    ).one_or_none()
    default_cap = setting.default_allocation_cap_percent if setting else 70
    depts_by_id = _org_departments(session, principal.org_id)
    visible_depts = _visible_ancestors(principal, depts_by_id)

    policy_rows = session.exec(
        select(CapacityForecastPolicy)
        .where(CapacityForecastPolicy.org_id == principal.org_id)
        .order_by(
            col(CapacityForecastPolicy.department_id).is_not(None),
            col(CapacityForecastPolicy.job_family).is_not(None),
            col(CapacityForecastPolicy.job_family),
            col(CapacityForecastPolicy.id),
        )
    ).all()
    visible_policies = [
        _policy_public(row, principal, depts_by_id)
        for row in policy_rows
        if principal.is_org_admin
        or row.department_id is None
        or row.department_id in visible_depts
    ]
    visible_policies.sort(
        key=lambda item: (
            item.department_id is not None,
            item.department_name or "",
            item.job_family is not None,
            item.job_family or "",
            str(item.id),
        )
    )

    raw_job_families = session.exec(
        select(Employee.job_family)
        .where(
            Employee.org_id == principal.org_id,
            Employee.employment_status == EmploymentStatus.ACTIVE,
            col(Employee.job_family).is_not(None),
        )
        .distinct()
    ).all()
    job_families = sorted(
        {jf.strip() for jf in raw_job_families if isinstance(jf, str) and jf.strip()}
        | {p.job_family for p in visible_policies if p.job_family}
    )

    return ForecastConfigPublic(
        default_allocation_cap_percent=default_cap,
        default_retention_rate=DEFAULT_RETENTION_RATE,
        policies=visible_policies,
        job_families=job_families,
    )


def upsert_forecast_policy(
    principal: Principal,
    session: Session,
    body: ForecastPolicyInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> ForecastPolicyMutationResult:
    require_enabled(principal, session)
    require_write_scope(principal, session, body.department_id)
    assert principal.user_id is not None
    now = utc_now()
    # Persist retention_rate in the existing decay_rate column (1 - retention_rate) with zero migration.
    rec = CapacityForecastPolicy(
        org_id=principal.org_id,
        department_id=body.department_id,
        job_family=body.job_family,
        preset=None,
        baseline_percent=0,
        near_weeks=0,
        decay_rate=round(1.0 - body.retention_rate, 4),
        bidirectional_regression=False,
        use_jira_signal=False,
        use_assignment_signal=False,
        note=body.note,
        updated_by_user_id=principal.user_id,
        updated_at=now,
    )
    stmt = pg_insert(CapacityForecastPolicy).values(
        {
            "id": rec.id,
            "created_at": rec.created_at,
            "org_id": rec.org_id,
            "department_id": rec.department_id,
            "job_family": rec.job_family,
            "preset": rec.preset,
            "baseline_percent": rec.baseline_percent,
            "near_weeks": rec.near_weeks,
            "decay_rate": rec.decay_rate,
            "bidirectional_regression": rec.bidirectional_regression,
            "use_jira_signal": rec.use_jira_signal,
            "use_assignment_signal": rec.use_assignment_signal,
            "note": rec.note,
            "updated_by_user_id": rec.updated_by_user_id,
            "updated_at": rec.updated_at,
        }
    )
    upsert = stmt.on_conflict_do_update(
        constraint="uq_forecast_policy_scope",
        set_={
            "preset": stmt.excluded.preset,
            "baseline_percent": stmt.excluded.baseline_percent,
            "near_weeks": stmt.excluded.near_weeks,
            "decay_rate": stmt.excluded.decay_rate,
            "bidirectional_regression": stmt.excluded.bidirectional_regression,
            "use_jira_signal": stmt.excluded.use_jira_signal,
            "use_assignment_signal": stmt.excluded.use_assignment_signal,
            "note": stmt.excluded.note,
            "updated_by_user_id": stmt.excluded.updated_by_user_id,
            "updated_at": stmt.excluded.updated_at,
        },
    ).returning(col(CapacityForecastPolicy.id))
    saved_id = session.connection().execute(upsert).scalar_one()
    session.flush()
    saved = session.exec(
        select(CapacityForecastPolicy).where(
            CapacityForecastPolicy.org_id == principal.org_id,
            CapacityForecastPolicy.id == saved_id,
        )
    ).one()
    audit(
        principal,
        session,
        "capacity.forecast_policy_saved",
        "capacity_forecast_policy",
        saved.id,
        via,
        client_name,
        {
            "department_id": str(saved.department_id) if saved.department_id else None,
            "job_family": saved.job_family,
            "retention_rate": retention_from_decay(saved.decay_rate),
            "decay_rate": saved.decay_rate,
            "note": saved.note,
        },
    )
    updated_rows = _refresh_scopes(
        session, principal.org_id, [(saved.department_id, saved.job_family)]
    )
    depts_by_id = _org_departments(session, principal.org_id)
    return ForecastPolicyMutationResult(
        policy=_policy_public(saved, principal, depts_by_id),
        updated_rows=updated_rows,
    )


def delete_forecast_policy(
    principal: Principal,
    session: Session,
    policy_id: UUID,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> ForecastRefreshResult:
    require_enabled(principal, session)
    require_manager_or_admin(principal)
    row = session.exec(
        select(CapacityForecastPolicy)
        .where(
            CapacityForecastPolicy.org_id == principal.org_id,
            CapacityForecastPolicy.id == policy_id,
        )
        .with_for_update()
    ).one_or_none()
    if row is None:
        raise CapacityNotFound("未找到该预测策略")
    require_write_scope(principal, session, row.department_id)
    old_scope = (row.department_id, row.job_family)
    deleted_id = row.id
    details: dict[str, JsonValue] = {
        "department_id": str(row.department_id) if row.department_id else None,
        "job_family": row.job_family,
        "retention_rate": retention_from_decay(row.decay_rate),
    }
    session.delete(row)
    session.flush()
    audit(
        principal,
        session,
        "capacity.forecast_policy_deleted",
        "capacity_forecast_policy",
        deleted_id,
        via,
        client_name,
        details,
    )
    updated_rows = _refresh_scopes(session, principal.org_id, [old_scope])
    return ForecastRefreshResult(updated_rows=updated_rows)


def list_forecast_events(
    principal: Principal,
    session: Session,
    *,
    department_id: UUID | None = None,
    include_past: bool = False,
) -> ForecastEventList:
    require_enabled(principal, session)
    require_manager_or_admin(principal)
    depts_by_id = _org_departments(session, principal.org_id)
    filter_depts: set[UUID] | None = None
    if department_id is not None:
        if department_id not in depts_by_id:
            raise CapacityNotFound("未找到该部门")
        if not can_manage_department(principal, department_id):
            raise CapacityForbidden()
        ancestors = set(department_ancestry(depts_by_id, department_id))
        descendants = managed_scope(
            session, principal.org_id, frozenset({department_id})
        )
        filter_depts = ancestors | descendants
    elif not principal.is_org_admin:
        filter_depts = _visible_ancestors(principal, depts_by_id)

    query = select(CapacityForecastEvent).where(
        CapacityForecastEvent.org_id == principal.org_id
    )
    if not include_past:
        current = calendar.this_week(session, principal.org_id)
        query = query.where(CapacityForecastEvent.end_week >= current)
    rows = session.exec(
        query.order_by(
            col(CapacityForecastEvent.start_week),
            col(CapacityForecastEvent.created_at),
            col(CapacityForecastEvent.id),
        )
    ).all()
    items = [
        _event_public(row, principal, depts_by_id)
        for row in rows
        if filter_depts is None
        or row.department_id is None
        or row.department_id in filter_depts
    ]
    return ForecastEventList(data=items, count=len(items))


def create_forecast_event(
    principal: Principal,
    session: Session,
    body: ForecastEventInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> ForecastEventMutationResult:
    require_enabled(principal, session)
    require_write_scope(principal, session, body.department_id)
    assert principal.user_id is not None
    now = utc_now()
    row = CapacityForecastEvent(
        org_id=principal.org_id,
        department_id=body.department_id,
        job_family=body.job_family,
        title=body.title,
        start_week=body.start_week,
        end_week=body.end_week,
        modifier_kind=body.modifier_kind,
        modifier_value=body.modifier_value,
        reason=body.reason,
        created_by_user_id=principal.user_id,
        updated_by_user_id=principal.user_id,
        updated_at=now,
    )
    session.add(row)
    session.flush()
    audit(
        principal,
        session,
        "capacity.forecast_event_saved",
        "capacity_forecast_event",
        row.id,
        via,
        client_name,
        {
            "department_id": str(row.department_id) if row.department_id else None,
            "job_family": row.job_family,
            "title": row.title,
            "start_week": row.start_week.isoformat(),
            "end_week": row.end_week.isoformat(),
            "modifier_kind": row.modifier_kind.value,
            "modifier_value": row.modifier_value,
            "reason": row.reason,
        },
    )
    updated_rows = _refresh_scopes(
        session, principal.org_id, [(row.department_id, row.job_family)]
    )
    depts_by_id = _org_departments(session, principal.org_id)
    return ForecastEventMutationResult(
        event=_event_public(row, principal, depts_by_id),
        updated_rows=updated_rows,
    )


def update_forecast_event(
    principal: Principal,
    session: Session,
    event_id: UUID,
    body: ForecastEventInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> ForecastEventMutationResult:
    require_enabled(principal, session)
    require_manager_or_admin(principal)
    row = session.exec(
        select(CapacityForecastEvent)
        .where(
            CapacityForecastEvent.org_id == principal.org_id,
            CapacityForecastEvent.id == event_id,
        )
        .with_for_update()
    ).one_or_none()
    if row is None:
        raise CapacityNotFound("未找到该业务波动事件")
    require_write_scope(principal, session, row.department_id)
    require_write_scope(principal, session, body.department_id)
    assert principal.user_id is not None

    old_scope = (row.department_id, row.job_family)
    row.department_id = body.department_id
    row.job_family = body.job_family
    row.title = body.title
    row.start_week = body.start_week
    row.end_week = body.end_week
    row.modifier_kind = body.modifier_kind
    row.modifier_value = body.modifier_value
    row.reason = body.reason
    row.updated_by_user_id = principal.user_id
    row.updated_at = utc_now()
    session.add(row)
    session.flush()
    audit(
        principal,
        session,
        "capacity.forecast_event_saved",
        "capacity_forecast_event",
        row.id,
        via,
        client_name,
        {
            "department_id": str(row.department_id) if row.department_id else None,
            "job_family": row.job_family,
            "title": row.title,
            "start_week": row.start_week.isoformat(),
            "end_week": row.end_week.isoformat(),
            "modifier_kind": row.modifier_kind.value,
            "modifier_value": row.modifier_value,
            "reason": row.reason,
        },
    )
    updated_rows = _refresh_scopes(
        session,
        principal.org_id,
        [old_scope, (row.department_id, row.job_family)],
    )
    depts_by_id = _org_departments(session, principal.org_id)
    return ForecastEventMutationResult(
        event=_event_public(row, principal, depts_by_id),
        updated_rows=updated_rows,
    )


def delete_forecast_event(
    principal: Principal,
    session: Session,
    event_id: UUID,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> ForecastRefreshResult:
    require_enabled(principal, session)
    require_manager_or_admin(principal)
    row = session.exec(
        select(CapacityForecastEvent)
        .where(
            CapacityForecastEvent.org_id == principal.org_id,
            CapacityForecastEvent.id == event_id,
        )
        .with_for_update()
    ).one_or_none()
    if row is None:
        raise CapacityNotFound("未找到该业务波动事件")
    require_write_scope(principal, session, row.department_id)
    old_scope = (row.department_id, row.job_family)
    deleted_id = row.id
    details: dict[str, JsonValue] = {
        "department_id": str(row.department_id) if row.department_id else None,
        "job_family": row.job_family,
        "title": row.title,
        "start_week": row.start_week.isoformat(),
        "end_week": row.end_week.isoformat(),
    }
    session.delete(row)
    session.flush()
    audit(
        principal,
        session,
        "capacity.forecast_event_deleted",
        "capacity_forecast_event",
        deleted_id,
        via,
        client_name,
        details,
    )
    updated_rows = _refresh_scopes(session, principal.org_id, [old_scope])
    return ForecastRefreshResult(updated_rows=updated_rows)
