"""Org-wide read-only cross-department feasibility assessment (ADR-0046)."""

from collections import defaultdict
from collections.abc import Iterable
from datetime import date, timedelta
from itertools import chain
from statistics import mean
from typing import Literal, NamedTuple
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import Session, col, select

from app.authz.policies import employee_scope_clause
from app.authz.principal import Principal
from app.domains.capability.search import PeopleSearchInput, find_people
from app.domains.capability.service import get_schema, list_capabilities
from app.domains.capacity.calendar import (
    MAX_WORKLOAD_WEEKS,
    WeekLoad,
    loads,
    this_week,
    week_start,
)
from app.domains.capacity.models import CapacitySetting, RequesterPolicy
from app.domains.capacity.settings import require_enabled
from app.domains.org.models import Department, Employee, EmploymentStatus
from app.domains.planning.schemas import (
    CrossDeptFeasibilityDepartment,
    CrossDeptFeasibilityInput,
    CrossDeptFeasibilityResult,
)
from app.i18n import tr

SEARCH_HORIZON_WEEKS = 12
RECENT_IMPUTATION_WEEKS = 4
DEFAULT_MIN_AVAILABLE_PERCENT = 10


class FeasibilityWindowOutOfRange(HTTPException):
    def __init__(self) -> None:
        super().__init__(
            422,
            tr(
                "评估时间窗须在从本周起的 {weeks} 周内，请选择更早的日期或缩短时间窗",
                weeks=MAX_WORKLOAD_WEEKS,
            ),
        )


def _require_requester(principal: Principal, session: Session) -> None:
    require_enabled(principal, session)
    if principal.user_id is None:
        raise HTTPException(403, "当前账号没有协作发起权限")
    if principal.is_org_admin or principal.managed_department_ids:
        return
    setting = session.exec(
        select(CapacitySetting).where(CapacitySetting.org_id == principal.org_id)
    ).one_or_none()
    if setting is None or setting.requester_policy != RequesterPolicy.EVERYONE:
        raise HTTPException(403, "当前企业仅允许部门经理或管理员查询跨部门排期")
    if principal.employee_id is None:
        raise HTTPException(403, "当前账号未绑定员工档案")
    emp = session.exec(
        select(Employee).where(
            Employee.org_id == principal.org_id,
            Employee.id == principal.employee_id,
            Employee.employment_status == EmploymentStatus.ACTIVE,
        )
    ).one_or_none()
    if emp is None:
        raise HTTPException(403, "当前员工档案不可用")


def _matching_employee_ids(
    session: Session,
    worker: Principal,
    capability_key: str,
    minimum_level: str | None,
) -> set[UUID]:
    ids: set[UUID] = set()
    skip = 0
    while True:
        page = find_people(
            session,
            worker,
            PeopleSearchInput(
                capability_key=capability_key,
                minimum_level=minimum_level,
                skip=skip,
                limit=100,
            ),
        )
        ids.update(r.employee_id for r in page.data if r.level is not None)
        skip += len(page.data)
        if skip >= page.count or not page.data:
            break
    return ids


class _WeekEstimate(NamedTuple):
    regular_available: float | None
    elastic_available: float | None
    regular_used: float | None
    elastic_used: float | None
    load_percent: float | None
    source: Literal["confirmed", "forecast_baseline", "unknown"]


def _other_means(weeks: Iterable[WeekLoad]) -> tuple[float | None, float | None]:
    confirmed = []
    stale = []
    for week in weeks:
        if week.other_percent is None:
            continue
        if week.status == "confirmed":
            confirmed.append(week.other_percent)
        elif week.status == "stale":
            stale.append(week.other_percent)
    return mean(confirmed) if confirmed else None, mean(stale) if stale else None


def _estimate_weeks(
    employee_weeks: dict[UUID, list[WeekLoad]],
    near_term_end: date,
    forecast_horizon_end: date,
    default_cap: int,
) -> dict[UUID, list[_WeekEstimate]]:
    recent = {
        eid: [week for week in weeks if week.week_start < near_term_end]
        for eid, weeks in employee_weeks.items()
    }
    dept_confirmed, dept_stale = _other_means(chain.from_iterable(recent.values()))
    dept_by_week = [
        _other_means(weeks) for weeks in zip(*employee_weeks.values(), strict=True)
    ]
    estimates: dict[UUID, list[_WeekEstimate]] = {}
    for eid, weeks in employee_weeks.items():
        confirmed, stale = _other_means(recent[eid])
        estimates[eid] = []
        for week, (week_confirmed, week_stale) in zip(weeks, dept_by_week, strict=True):
            source: Literal["confirmed", "forecast_baseline", "unknown"]
            eff_other: float | None
            if week.status == "confirmed" and week.other_percent is not None:
                eff_other = float(week.other_percent)
                source = "confirmed"
            elif week.forecast_other_percent is not None:
                eff_other = float(week.forecast_other_percent)
                source = "forecast_baseline"
            elif week.week_start >= forecast_horizon_end:
                # Never extrapolate beyond the 26-week forecast horizon from recent means.
                eff_other = None
                source = "unknown"
            else:
                eff_other = next(
                    (
                        float(value)
                        for value in (
                            week.other_percent,
                            confirmed,
                            stale,
                            week_confirmed,
                            dept_confirmed,
                            week_stale,
                            dept_stale,
                        )
                        if value is not None
                    ),
                    None,
                )
                source = "forecast_baseline" if eff_other is not None else "unknown"

            if eff_other is None:
                estimates[eid].append(
                    _WeekEstimate(None, None, None, None, None, "unknown")
                )
                continue

            regular_cap = min(week.capacity_percent, default_cap)
            elastic_cap = week.capacity_percent
            occupied = eff_other + week.platform_percent
            estimates[eid].append(
                _WeekEstimate(
                    regular_cap - occupied,
                    elastic_cap - occupied,
                    float(min(occupied, regular_cap)),
                    float(max(0.0, occupied - regular_cap)),
                    min(200.0, (100 - week.capacity_percent) + occupied),
                    source,
                )
            )
    return estimates


def _window_conclusion(
    employee_weeks: list[list[_WeekEstimate]],
    start_index: int,
    end_index: int,
    need_headcount: int,
    need_percent: int,
) -> tuple[
    Literal["can_do", "needs_confirmation", "cannot_do"],
    bool,
    bool,
    set[Literal["confirmed", "forecast_baseline"]],
]:
    reg_confirmed: list[set[Literal["confirmed", "forecast_baseline"]]] = []
    reg_estimated: list[set[Literal["confirmed", "forecast_baseline"]]] = []
    el_confirmed: list[set[Literal["confirmed", "forecast_baseline"]]] = []
    el_estimated: list[set[Literal["confirmed", "forecast_baseline"]]] = []
    unknown_people = 0

    for weeks in employee_weeks:
        window = weeks[start_index:end_index]
        if any(week.regular_available is None for week in window):
            unknown_people += 1
            continue
        sources: set[Literal["confirmed", "forecast_baseline"]] = {
            week.source for week in window if week.source != "unknown"
        }
        is_est = "forecast_baseline" in sources
        if all(
            week.regular_available is not None
            and week.regular_available >= need_percent
            for week in window
        ):
            (reg_estimated if is_est else reg_confirmed).append(sources)
        elif all(
            week.elastic_available is not None
            and week.elastic_available >= need_percent
            for week in window
        ):
            (el_estimated if is_est else el_confirmed).append(sources)

    reg_all = reg_confirmed + reg_estimated
    if len(reg_all) >= need_headcount:
        used = reg_confirmed if len(reg_confirmed) >= need_headcount else reg_all
        used_sources: set[Literal["confirmed", "forecast_baseline"]] = set().union(
            *used
        )
        return "can_do", False, "forecast_baseline" in used_sources, used_sources

    el_all = reg_all + el_confirmed + el_estimated
    if len(el_all) >= need_headcount:
        confirmed_all = reg_confirmed + el_confirmed
        used = confirmed_all if len(confirmed_all) >= need_headcount else el_all
        used_sources = set().union(*used)
        return "can_do", True, "forecast_baseline" in used_sources, used_sources

    if len(el_all) + unknown_people >= need_headcount:
        return "needs_confirmation", False, False, set()
    return "cannot_do", False, False, set()


def assess_cross_department_feasibility(
    principal: Principal,
    session: Session,
    body: CrossDeptFeasibilityInput,
) -> CrossDeptFeasibilityResult:
    """Assess org-wide cross-department feasibility without leaking headcounts or personal data."""
    _require_requester(principal, session)
    org_id = principal.org_id
    setting = session.exec(
        select(CapacitySetting).where(CapacitySetting.org_id == org_id)
    ).one_or_none()
    default_cap = setting.default_allocation_cap_percent if setting is not None else 70
    duration = body.window_end - body.window_start
    current_week = this_week(session, org_id)
    first_start = max(body.window_start, current_week)
    if (first_start - current_week).days + duration.days >= MAX_WORKLOAD_WEEKS * 7:
        raise FeasibilityWindowOutOfRange()

    schema = get_schema(session, org_id)
    valid_keys = {c.key for c in list_capabilities(session, org_id, schema.id)}
    if body.capability_key not in valid_keys:
        raise HTTPException(404, "未找到对应的能力定义")

    worker = Principal.system_worker(org_id)
    candidate_ids = _matching_employee_ids(
        session, worker, body.capability_key, body.minimum_level
    )
    for extra in body.extra_capabilities:
        if not extra.required:
            continue
        if extra.key not in valid_keys:
            candidate_ids = set()
            break
        candidate_ids &= _matching_employee_ids(
            session, worker, extra.key, extra.minimum_level
        )
        if not candidate_ids:
            break

    departments = list(
        session.exec(
            select(Department)
            .where(Department.org_id == org_id)
            .order_by(Department.name, col(Department.id))
        ).all()
    )

    need_headcount = body.estimated_headcount or 1
    need_percent = (
        body.estimated_allocation_percent
        if body.estimated_allocation_percent is not None
        else DEFAULT_MIN_AVAILABLE_PERCENT
    )
    eval_start = week_start(first_start)
    imputation_span = timedelta(weeks=RECENT_IMPUTATION_WEEKS)
    baseline_start = current_week - imputation_span
    near_term_end = current_week + imputation_span
    forecast_horizon_end = current_week + timedelta(weeks=MAX_WORKLOAD_WEEKS)
    baseline_weeks = (eval_start - baseline_start).days // 7
    window_weeks = (first_start.weekday() + duration.days) // 7 + 1
    total_weeks = window_weeks + SEARCH_HORIZON_WEEKS
    target_slice = slice(baseline_weeks, baseline_weeks + window_weeks)

    candidates_by_dept: dict[UUID, list[UUID]] = defaultdict(list)
    members_by_dept: dict[UUID, list[UUID]] = defaultdict(list)
    if candidate_ids:
        active_in_org = (
            employee_scope_clause(worker),
            Employee.employment_status == EmploymentStatus.ACTIVE,
        )
        matched_departments = select(Employee.department_id).where(
            *active_in_org, col(Employee.id).in_(candidate_ids)
        )
        members = session.exec(
            select(Employee.id, Employee.department_id).where(
                *active_in_org, col(Employee.department_id).in_(matched_departments)
            )
        ).all()
        for eid, department_id in members:
            if department_id is None:
                continue
            members_by_dept[department_id].append(eid)
            if eid in candidate_ids:
                candidates_by_dept[department_id].append(eid)
    all_ids = [eid for ids in members_by_dept.values() for eid in ids]
    weekly_loads = (
        loads(session, org_id, all_ids, baseline_start, baseline_weeks + total_weeks)
        if all_ids
        else {}
    )

    dept_results: list[CrossDeptFeasibilityDepartment] = []
    for dept in departments:
        result = CrossDeptFeasibilityDepartment(
            department_id=dept.id,
            department_name=dept.name,
            conclusion="cannot_do",
            has_likely_availability=False,
        )
        dept_results.append(result)
        if dept.id not in candidates_by_dept:
            continue

        member_weeks = {eid: weekly_loads[eid] for eid in members_by_dept[dept.id]}
        estimates = _estimate_weeks(
            member_weeks, near_term_end, forecast_horizon_end, default_cap
        )
        target_weeks = [
            week for weeks in estimates.values() for week in weeks[target_slice]
        ]
        known_target = [week for week in target_weeks if week.load_percent is not None]
        target_sources: set[Literal["confirmed", "forecast_baseline"]] = {
            week.source for week in known_target if week.source != "unknown"
        }
        if known_target:
            result.is_estimated = "forecast_baseline" in target_sources
            # Imputed weeks, agent_auto forecasts, and repeat records from one person are not independent sources.
            source_count = sum(
                any(
                    week.other_percent is not None
                    or week.forecast_source == "manager_override"
                    for week in chain(
                        weeks[: RECENT_IMPUTATION_WEEKS * 2], weeks[target_slice]
                    )
                )
                for weeks in member_weeks.values()
            )
            if len(member_weeks) < 2 or source_count < 2:
                result.load_level = "withheld"
            else:
                percent = int(
                    mean(
                        w.load_percent
                        for w in known_target
                        if w.load_percent is not None
                    )
                    + 0.5
                )
                result.department_load_percent = percent
                result.regular_used_percent = int(
                    mean(
                        w.regular_used
                        for w in known_target
                        if w.regular_used is not None
                    )
                    + 0.5
                )
                elastic_used = int(
                    mean(
                        w.elastic_used
                        for w in known_target
                        if w.elastic_used is not None
                    )
                    + 0.5
                )
                result.elastic_used_percent = elastic_used
                result.exceeds_regular_cap = elastic_used > 0
                result.regular_headroom_percent = int(
                    mean(
                        max(0.0, w.regular_available)
                        for w in known_target
                        if w.regular_available is not None
                    )
                    + 0.5
                )
                result.elastic_headroom_percent = int(
                    mean(
                        max(0.0, w.elastic_available) - max(0.0, w.regular_available)
                        for w in known_target
                        if w.elastic_available is not None
                        and w.regular_available is not None
                    )
                    + 0.5
                )
                if percent < 60:
                    result.load_level = "low"
                elif percent < 70:
                    result.load_level = "medium"
                elif percent < 90:
                    result.load_level = "high"
                else:
                    result.load_level = "very_high"

        window_sources: set[Literal["confirmed", "forecast_baseline"]] = set()
        candidate_weeks = [estimates[eid] for eid in candidates_by_dept[dept.id]]
        if len(candidate_weeks) >= need_headcount:
            for shift in range(SEARCH_HORIZON_WEEKS + 1):
                start = (
                    first_start if shift == 0 else eval_start + timedelta(weeks=shift)
                )
                end = start + duration
                conclusion, needs_elastic, is_estimated, used_sources = (
                    _window_conclusion(
                        candidate_weeks,
                        baseline_weeks + shift,
                        (end - baseline_start).days // 7 + 1,
                        need_headcount,
                        need_percent,
                    )
                )
                if conclusion == "cannot_do":
                    continue
                if conclusion == "needs_confirmation":
                    result.conclusion = conclusion
                    result.has_likely_availability = None
                else:
                    result.conclusion = "can_do" if shift == 0 else "later"
                    result.has_likely_availability = shift == 0
                    result.needs_elastic = (
                        needs_elastic and result.load_level != "withheld"
                    )
                    result.is_estimated |= is_estimated
                    window_sources = used_sources
                    result.earliest_start_date = result.suggested_start_date = start
                    result.suggested_end_date = end
                break

        if result.load_level == "withheld":
            result.exceeds_regular_cap = False
            result.needs_elastic = False

        all_sources = target_sources | window_sources
        if all_sources == {"confirmed"}:
            result.data_source = "confirmed"
        elif all_sources == {"forecast_baseline"}:
            result.data_source = "forecast_baseline"
        elif all_sources == {"confirmed", "forecast_baseline"}:
            result.data_source = "mixed"
        else:
            result.data_source = "unknown"

    return CrossDeptFeasibilityResult(
        capability_key=body.capability_key,
        window_start=body.window_start,
        window_end=body.window_end,
        allocation_cap_percent=default_cap,
        departments=dept_results,
    )
