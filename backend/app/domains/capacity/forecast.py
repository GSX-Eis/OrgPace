from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import Session, col, delete, or_, select

from app.authz.policies import (
    can_manage_department,
    can_view_employee,
    can_view_org_aggregates,
    employee_scope_clause,
    manages_department,
)
from app.authz.principal import Principal
from app.domains.base import utc_now
from app.domains.capacity import calendar
from app.domains.capacity.common import (
    CapacityForbidden,
    CapacityNotFound,
    audit,
)
from app.domains.capacity.common import (
    employee as load_employee,
)
from app.domains.capacity.common import (
    open_jira_task_counts as open_jira_task_counts,
)
from app.domains.capacity.forecast_policy import (
    DEFAULT_RETENTION_RATE,
    build_policy_label,
    build_scope_label,
    retention_from_decay,
)
from app.domains.capacity.models import (
    CapacityForecastEvent,
    CapacityForecastPolicy,
    CapacitySetting,
    CapacityWeek,
    CapacityWeekForecast,
    ForecastModifierKind,
    ForecastSource,
)
from app.domains.capacity.schemas import (
    ForecastOverrideInput,
    ForecastRefreshResult,
    ForecastResetQuery,
    Via,
    WorkloadList,
)
from app.domains.capacity.settings import require_enabled
from app.domains.capacity.workload_views import views
from app.domains.org.models import (
    Department,
    Employee,
    EmploymentStatus,
)
from app.domains.org.service import department_ancestry
from app.i18n import tr

FORECAST_HORIZON_WEEKS = calendar.MAX_WORKLOAD_WEEKS
_INSERT_CHUNK_SIZE = 500


def _round_5(value: float) -> int:
    return min(200, max(0, int((value + 2.5) // 5) * 5))


def _forecast_row_values(rec: CapacityWeekForecast) -> dict[str, object]:
    return {
        "id": rec.id,
        "created_at": rec.created_at,
        "org_id": rec.org_id,
        "employee_id": rec.employee_id,
        "week_start": rec.week_start,
        "forecast_other_percent": rec.forecast_other_percent,
        "source": rec.source,
        "basis_summary": rec.basis_summary,
        "signals": rec.signals,
        "generated_at": rec.generated_at,
        "updated_by_user_id": rec.updated_by_user_id,
    }


@dataclass(frozen=True)
class _ResolvedPolicy:
    policy_id: UUID | None
    policy_scope: str
    policy_label: str | None
    scope_label: str
    retention_rate: float
    is_implicit_default: bool


def _policy_scope_name(policy: CapacityForecastPolicy) -> str:
    if policy.department_id is not None and policy.job_family is not None:
        return "department_job_family"
    if policy.department_id is not None:
        return "department"
    if policy.job_family is not None:
        return "org_job_family"
    return "org_default"


def _resolve_policy(
    ancestors: list[UUID],
    job_family: str | None,
    policies_by_scope: dict[tuple[UUID | None, str | None], CapacityForecastPolicy],
    departments_by_id: dict[UUID, Department],
) -> _ResolvedPolicy:
    matched: CapacityForecastPolicy | None = None
    for dept_id in ancestors:
        if job_family is not None:
            matched = policies_by_scope.get((dept_id, job_family))
            if matched is not None:
                break
        matched = policies_by_scope.get((dept_id, None))
        if matched is not None:
            break
    if matched is None and job_family is not None:
        matched = policies_by_scope.get((None, job_family))
    if matched is None:
        matched = policies_by_scope.get((None, None))
    if matched is None:
        return _ResolvedPolicy(
            policy_id=None,
            policy_scope="implicit_default",
            policy_label=None,
            scope_label=tr("系统默认"),
            retention_rate=DEFAULT_RETENTION_RATE,
            is_implicit_default=True,
        )
    dept_name = (
        departments_by_id[matched.department_id].name
        if matched.department_id is not None
        and matched.department_id in departments_by_id
        else None
    )
    retention_rate = retention_from_decay(matched.decay_rate)
    return _ResolvedPolicy(
        policy_id=matched.id,
        policy_scope=_policy_scope_name(matched),
        policy_label=build_policy_label(retention_rate, dept_name, matched.job_family),
        scope_label=build_scope_label(dept_name, matched.job_family),
        retention_rate=retention_rate,
        is_implicit_default=False,
    )


def _basis_summary(
    *,
    policy: _ResolvedPolicy,
    hist_scope: str,
    hist_weeks: int,
    hist_mean: float,
    applied_events: list[CapacityForecastEvent],
) -> str:
    hist_part = (
        tr(
            "基于近 {weeks} 周已确认均值 {mean}%",
            weeks=hist_weeks,
            mean=round(hist_mean),
        )
        if hist_scope == "employee"
        else tr("基于同部门近期均值 {mean}%", mean=round(hist_mean))
    )
    tail = tr("，末次确认周后归零") if policy.retention_rate == 0.0 else tr("逐周衰减")
    summary = tr(
        "周延续系数 {rate}（{scope}）：{hist_part}{tail}",
        rate=f"{policy.retention_rate:g}",
        scope=policy.scope_label,
        hist_part=hist_part,
        tail=tail,
    )
    if applied_events:
        event_labels = [
            calendar.format_forecast_event_label(
                ev.title, ev.modifier_kind.value, ev.modifier_value
            )
            for ev in applied_events
        ]
        summary += tr("；业务事件：{events}", events=tr("、").join(event_labels))
    return summary[:300]


def _apply_events(
    raw: float,
    matched_events: list[CapacityForecastEvent],
) -> float:
    for ev in matched_events:
        if ev.modifier_kind == ForecastModifierKind.MULTIPLIER:
            raw *= ev.modifier_value
    for ev in matched_events:
        if ev.modifier_kind == ForecastModifierKind.DELTA:
            raw += ev.modifier_value
    return raw


def refresh_org_forecasts(
    session: Session,
    org_id: UUID,
    *,
    employee_ids: list[UUID] | None = None,
) -> int:
    """Recompute rolling 26-week agent_auto forecast baselines without touching manager_override."""
    setting = session.exec(
        select(CapacitySetting).where(CapacitySetting.org_id == org_id)
    ).one_or_none()
    if setting is None or not setting.enabled:
        return 0
    now = utc_now()
    current = calendar.this_week(session, org_id)
    horizon_end = current + timedelta(weeks=FORECAST_HORIZON_WEEKS)
    expire_before = current - timedelta(weeks=4)
    session.exec(
        delete(CapacityWeekForecast).where(
            col(CapacityWeekForecast.org_id) == org_id,
            col(CapacityWeekForecast.week_start) < expire_before,
        )
    )

    emp_query = select(Employee).where(
        Employee.org_id == org_id,
        Employee.employment_status == EmploymentStatus.ACTIVE,
    )
    if employee_ids is not None:
        if not employee_ids:
            return 0
        emp_query = emp_query.where(col(Employee.id).in_(employee_ids))
    target_employees = list(session.exec(emp_query).all())
    if not target_employees:
        return 0

    departments_by_id = {
        dept.id: dept
        for dept in session.exec(
            select(Department).where(Department.org_id == org_id)
        ).all()
    }
    policies_by_scope = {
        (policy.department_id, policy.job_family): policy
        for policy in session.exec(
            select(CapacityForecastPolicy).where(
                CapacityForecastPolicy.org_id == org_id
            )
        ).all()
    }
    org_events = list(
        session.exec(
            select(CapacityForecastEvent)
            .where(
                CapacityForecastEvent.org_id == org_id,
                CapacityForecastEvent.end_week >= current,
                CapacityForecastEvent.start_week < horizon_end,
            )
            .order_by(
                col(CapacityForecastEvent.created_at),
                col(CapacityForecastEvent.id),
            )
        ).all()
    )

    target_ids = [e.id for e in target_employees]
    dept_ids = {
        e.department_id for e in target_employees if e.department_id is not None
    }
    if employee_ids is None:
        scope_employees = target_employees
    elif dept_ids:
        scope_employees = list(
            session.exec(
                select(Employee).where(
                    Employee.org_id == org_id,
                    Employee.employment_status == EmploymentStatus.ACTIVE,
                    or_(
                        col(Employee.id).in_(target_ids),
                        col(Employee.department_id).in_(dept_ids),
                    ),
                )
            ).all()
        )
    else:
        scope_employees = target_employees

    scope_ids = [e.id for e in scope_employees]
    dept_by_emp = {e.id: e.department_id for e in scope_employees}

    hist_start = current - timedelta(weeks=8)
    hist_end = current + timedelta(weeks=4)
    cutoff = now - timedelta(days=calendar.FRESH_DAYS)
    emp_fresh: dict[UUID, list[CapacityWeek]] = defaultdict(list)
    emp_stale: dict[UUID, list[CapacityWeek]] = defaultdict(list)
    dept_fresh: dict[UUID, list[CapacityWeek]] = defaultdict(list)
    dept_stale: dict[UUID, list[CapacityWeek]] = defaultdict(list)
    dept_fresh_emps: dict[UUID, set[UUID]] = defaultdict(set)
    dept_stale_emps: dict[UUID, set[UUID]] = defaultdict(set)

    for week_row in session.exec(
        select(CapacityWeek).where(
            CapacityWeek.org_id == org_id,
            col(CapacityWeek.employee_id).in_(scope_ids),
            CapacityWeek.week_start >= hist_start,
            CapacityWeek.week_start < hist_end,
        )
    ).all():
        dept_id = dept_by_emp.get(week_row.employee_id)
        if week_row.confirmed_at >= cutoff:
            emp_fresh[week_row.employee_id].append(week_row)
            if dept_id is not None:
                dept_fresh[dept_id].append(week_row)
                dept_fresh_emps[dept_id].add(week_row.employee_id)
        else:
            emp_stale[week_row.employee_id].append(week_row)
            if dept_id is not None:
                dept_stale[dept_id].append(week_row)
                dept_stale_emps[dept_id].add(week_row.employee_id)

    records_to_upsert: list[CapacityWeekForecast] = []
    no_history_ids: list[UUID] = []

    for emp in target_employees:
        if emp_fresh[emp.id]:
            hist_records = emp_fresh[emp.id]
            hist_scope, hist_freshness = "employee", "fresh"
        elif emp_stale[emp.id]:
            hist_records = emp_stale[emp.id]
            hist_scope, hist_freshness = "employee", "stale"
        elif emp.department_id and len(dept_fresh_emps[emp.department_id]) >= 2:
            # Require >= 2 distinct colleagues so department fallback never exposes a single colleague's workload.
            hist_records = dept_fresh[emp.department_id]
            hist_scope, hist_freshness = "department", "fresh"
        elif emp.department_id and len(dept_stale_emps[emp.department_id]) >= 2:
            hist_records = dept_stale[emp.department_id]
            hist_scope, hist_freshness = "department", "stale"
        else:
            no_history_ids.append(emp.id)
            continue

        ancestors = list(department_ancestry(departments_by_id, emp.department_id))
        ancestor_set = set(ancestors)
        emp_job_family = emp.job_family.strip() or None if emp.job_family else None
        policy = _resolve_policy(
            ancestors, emp_job_family, policies_by_scope, departments_by_id
        )

        hist_mean = sum(r.other_percent for r in hist_records) / len(hist_records)
        hist_weeks = len(hist_records)
        anchor_week = (
            max(r.week_start for r in hist_records)
            if hist_scope == "employee"
            else current
        )

        emp_events = [
            ev
            for ev in org_events
            if (ev.department_id is None or ev.department_id in ancestor_set)
            and (ev.job_family is None or ev.job_family == emp_job_family)
        ]

        base_signals: dict[str, JsonValue] = {
            "forecast_version": 3,
            "history_mean": round(hist_mean, 1),
            "history_weeks": hist_weeks,
            "history_scope": hist_scope,
            "history_freshness": hist_freshness,
            "anchor_week": anchor_week.isoformat(),
            "policy_id": str(policy.policy_id) if policy.policy_id else None,
            "policy_scope": policy.policy_scope,
            "policy_label": policy.policy_label,
            "retention_rate": policy.retention_rate,
        }

        for offset in range(FORECAST_HORIZON_WEEKS):
            week_date: date = current + timedelta(weeks=offset)
            if week_date <= anchor_week:
                raw = hist_mean
            else:
                steps = (week_date - anchor_week).days // 7
                raw = hist_mean * (policy.retention_rate**steps)

            applied_events = [
                ev for ev in emp_events if ev.start_week <= week_date <= ev.end_week
            ]
            adjusted = _apply_events(raw, applied_events) if applied_events else raw
            forecast_val = _round_5(adjusted)
            applied_payload: list[JsonValue] = [
                {
                    "id": str(ev.id),
                    "title": ev.title,
                    "modifier_kind": ev.modifier_kind.value,
                    "modifier_value": ev.modifier_value,
                    "reason": ev.reason,
                }
                for ev in applied_events
            ]
            records_to_upsert.append(
                CapacityWeekForecast(
                    org_id=org_id,
                    employee_id=emp.id,
                    week_start=week_date,
                    forecast_other_percent=forecast_val,
                    source=ForecastSource.AGENT_AUTO,
                    basis_summary=_basis_summary(
                        policy=policy,
                        hist_scope=hist_scope,
                        hist_weeks=hist_weeks,
                        hist_mean=hist_mean,
                        applied_events=applied_events,
                    ),
                    signals={
                        **base_signals,
                        "applied_events": applied_payload,
                    },
                    generated_at=now,
                    updated_by_user_id=None,
                )
            )

    if no_history_ids:
        session.exec(
            delete(CapacityWeekForecast).where(
                col(CapacityWeekForecast.org_id) == org_id,
                col(CapacityWeekForecast.employee_id).in_(no_history_ids),
                col(CapacityWeekForecast.source) == ForecastSource.AGENT_AUTO,
                col(CapacityWeekForecast.week_start) >= current,
                col(CapacityWeekForecast.week_start) < horizon_end,
            )
        )

    if not records_to_upsert:
        return 0

    session.flush()
    updated = 0
    for idx in range(0, len(records_to_upsert), _INSERT_CHUNK_SIZE):
        chunk = records_to_upsert[idx : idx + _INSERT_CHUNK_SIZE]
        values = [_forecast_row_values(rec) for rec in chunk]
        stmt = pg_insert(CapacityWeekForecast).values(values)
        upsert = stmt.on_conflict_do_update(
            index_elements=["org_id", "employee_id", "week_start"],
            set_={
                "forecast_other_percent": stmt.excluded.forecast_other_percent,
                "basis_summary": stmt.excluded.basis_summary,
                "signals": stmt.excluded.signals,
                "generated_at": stmt.excluded.generated_at,
                "updated_by_user_id": None,
            },
            where=col(CapacityWeekForecast.source) == ForecastSource.AGENT_AUTO,
        ).returning(col(CapacityWeekForecast.id))
        updated += len(session.connection().execute(upsert).scalars().all())
    return updated


def _managed_subject(
    principal: Principal, session: Session, employee_id: UUID
) -> Employee:
    subject = load_employee(principal, session, employee_id, lock=True)
    if not can_view_employee(principal, subject):
        raise CapacityNotFound()
    if (
        principal.user_id is None
        or principal.is_org_admin
        or subject.id == principal.employee_id
        or not manages_department(principal, subject.department_id)
    ):
        raise CapacityForbidden()
    return subject


def override_forecasts(
    principal: Principal,
    session: Session,
    body: ForecastOverrideInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> WorkloadList:
    require_enabled(principal, session)
    subject = _managed_subject(principal, session, body.employee_id)
    assert principal.user_id is not None
    now = utc_now()
    weeks_count = (body.end_week - body.start_week).days // 7 + 1
    summary = (
        tr("经理手动修正：{note}", note=body.note)[:300]
        if body.note
        else tr("经理手动修正预测基线")
    )
    signals: dict[str, JsonValue] = {"manual_override": True}
    if body.note:
        signals["note"] = body.note

    values = [
        _forecast_row_values(
            CapacityWeekForecast(
                org_id=principal.org_id,
                employee_id=subject.id,
                week_start=body.start_week + timedelta(weeks=offset),
                forecast_other_percent=body.forecast_other_percent,
                source=ForecastSource.MANAGER_OVERRIDE,
                basis_summary=summary,
                signals=signals,
                generated_at=now,
                updated_by_user_id=principal.user_id,
            )
        )
        for offset in range(weeks_count)
    ]
    session.flush()
    stmt = pg_insert(CapacityWeekForecast).values(values)
    upsert = stmt.on_conflict_do_update(
        index_elements=["org_id", "employee_id", "week_start"],
        set_={
            "forecast_other_percent": stmt.excluded.forecast_other_percent,
            "source": stmt.excluded.source,
            "basis_summary": stmt.excluded.basis_summary,
            "signals": stmt.excluded.signals,
            "generated_at": stmt.excluded.generated_at,
            "updated_by_user_id": stmt.excluded.updated_by_user_id,
        },
    ).returning(col(CapacityWeekForecast.id))
    affected_ids = list(session.connection().execute(upsert).scalars().all())
    session.flush()
    audit(
        principal,
        session,
        "capacity.forecast_overridden",
        "capacity_week_forecast",
        affected_ids[0],
        via,
        client_name,
        {
            "employee_id": str(subject.id),
            "start_week": body.start_week.isoformat(),
            "end_week": body.end_week.isoformat(),
            "forecast_other_percent": body.forecast_other_percent,
            "note": body.note,
        },
    )
    data = views(principal, session, [subject], body.start_week, weeks_count)
    return WorkloadList(data=data, count=len(data))


def reset_forecasts(
    principal: Principal,
    session: Session,
    query: ForecastResetQuery,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> WorkloadList:
    require_enabled(principal, session)
    subject = _managed_subject(principal, session, query.employee_id)
    weeks_count = (query.end_week - query.start_week).days // 7 + 1
    existing_ids = list(
        session.exec(
            select(CapacityWeekForecast.id).where(
                CapacityWeekForecast.org_id == principal.org_id,
                CapacityWeekForecast.employee_id == subject.id,
                CapacityWeekForecast.week_start >= query.start_week,
                CapacityWeekForecast.week_start <= query.end_week,
                CapacityWeekForecast.source == ForecastSource.MANAGER_OVERRIDE,
            )
        ).all()
    )
    if existing_ids:
        session.exec(
            delete(CapacityWeekForecast).where(
                col(CapacityWeekForecast.org_id) == principal.org_id,
                col(CapacityWeekForecast.id).in_(existing_ids),
            )
        )
        session.flush()
    refresh_org_forecasts(session, principal.org_id, employee_ids=[subject.id])
    audit(
        principal,
        session,
        "capacity.forecast_reset",
        "capacity_week_forecast",
        existing_ids[0] if existing_ids else subject.id,
        via,
        client_name,
        {
            "employee_id": str(subject.id),
            "start_week": query.start_week.isoformat(),
            "end_week": query.end_week.isoformat(),
            "deleted_count": len(existing_ids),
        },
    )
    data = views(principal, session, [subject], query.start_week, weeks_count)
    return WorkloadList(data=data, count=len(data))


def refresh_forecasts_for_actor(
    principal: Principal,
    session: Session,
    department_id: UUID | None = None,
) -> ForecastRefreshResult:
    require_enabled(principal, session)
    if not can_view_org_aggregates(principal):
        raise CapacityForbidden()
    if department_id is not None:
        dept = session.exec(
            select(Department).where(
                Department.org_id == principal.org_id,
                Department.id == department_id,
            )
        ).one_or_none()
        if dept is None or not can_manage_department(principal, department_id):
            raise CapacityNotFound("未找到该部门")
    emp_query = select(Employee.id).where(
        employee_scope_clause(principal),
        Employee.employment_status == EmploymentStatus.ACTIVE,
    )
    if department_id is not None:
        emp_query = emp_query.where(Employee.department_id == department_id)
    elif not principal.is_org_admin:
        emp_query = emp_query.where(
            col(Employee.department_id).in_(principal.managed_department_ids)
        )
    employee_ids = list(session.exec(emp_query).all())
    if not employee_ids:
        return ForecastRefreshResult(updated_rows=0)
    if principal.is_org_admin and department_id is None:
        updated_rows = refresh_org_forecasts(session, principal.org_id)
    else:
        updated_rows = refresh_org_forecasts(
            session, principal.org_id, employee_ids=employee_ids
        )
    return ForecastRefreshResult(updated_rows=updated_rows)
