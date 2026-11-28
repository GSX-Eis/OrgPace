from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import Session, col, select

from app.authz.policies import can_view_employee, employee_scope_clause
from app.authz.principal import Principal
from app.domains.base import utc_now
from app.domains.capacity import calendar
from app.domains.capacity.common import (
    CapacityForbidden,
    CapacityNotFound,
    audit,
    employee,
    notify_employee,
    user_names,
)
from app.domains.capacity.forecast import refresh_org_forecasts
from app.domains.capacity.models import (
    CapacityCarryOver,
    CapacityCarryOverItem,
    CapacityWeek,
)
from app.domains.capacity.schemas import (
    CarryOverBatchItemPublic,
    CarryOverBatchPublic,
    CarryOverCommitInput,
    CarryOverPlanItem,
    CarryOverPreview,
    CarryOverRevertPreview,
    Via,
)
from app.domains.capacity.settings import require_enabled
from app.domains.org.models import Department, Employee, EmploymentStatus
from app.i18n import bilingual, tr


def _manageable_employees(
    principal: Principal, session: Session, department_id: UUID | None = None
) -> list[Employee]:
    if principal.is_org_admin or not principal.managed_department_ids:
        raise CapacityForbidden()
    if (
        department_id is not None
        and department_id not in principal.managed_department_ids
    ):
        raise CapacityNotFound()
    query = (
        select(Employee)
        .outerjoin(
            Department,
            (col(Department.org_id) == Employee.org_id)
            & (col(Department.id) == Employee.department_id),
        )
        .where(
            employee_scope_clause(principal),
            Employee.employment_status == EmploymentStatus.ACTIVE,
            Employee.id != principal.employee_id,
            col(Employee.department_id).in_(principal.managed_department_ids),
        )
    )
    if department_id is not None:
        query = query.where(Employee.department_id == department_id)
    return list(
        session.exec(
            query.order_by(
                col(Department.name), col(Employee.display_name), col(Employee.id)
            )
        ).all()
    )


def _carry_over_plan(
    session: Session,
    org_id: UUID,
    employees: list[Employee],
) -> tuple[list[CarryOverPlanItem], int]:
    if not employees:
        return [], 0
    ids = [e.id for e in employees]
    current = calendar.this_week(session, org_id)
    cutoff = utc_now() - timedelta(days=calendar.FRESH_DAYS)
    confirmed_rows = session.exec(
        select(CapacityWeek)
        .where(
            CapacityWeek.org_id == org_id,
            col(CapacityWeek.employee_id).in_(ids),
            CapacityWeek.confirmed_at >= cutoff,
        )
        .order_by(col(CapacityWeek.employee_id), col(CapacityWeek.week_start).desc())
    ).all()
    latest_by_emp: dict[UUID, CapacityWeek] = {}
    confirmed_weeks_by_emp: dict[UUID, set[date]] = defaultdict(set)
    for row in confirmed_rows:
        confirmed_weeks_by_emp[row.employee_id].add(row.week_start)
        if row.employee_id not in latest_by_emp:
            latest_by_emp[row.employee_id] = row
    plan: list[CarryOverPlanItem] = []
    skipped = 0
    for emp in employees:
        baseline = latest_by_emp.get(emp.id)
        if baseline is None:
            skipped += 1
            continue
        confirmed = confirmed_weeks_by_emp[emp.id]
        target = max(current, baseline.week_start + timedelta(weeks=1))
        steps = 0
        while target in confirmed and steps < 260:
            target += timedelta(weeks=1)
            steps += 1
        plan.append(
            CarryOverPlanItem(
                employee_id=emp.id,
                employee_name=emp.display_name,
                baseline_week_start=baseline.week_start,
                target_week_start=target,
                other_percent=baseline.other_percent,
            )
        )
    return plan, skipped


@dataclass
class ReversibleBatch:
    batch: CapacityCarryOver
    items: list[CapacityCarryOverItem]
    names: dict[UUID, str]
    created_by_name: str
    employee_departments: dict[UUID, str]


def _batch_public(info: ReversibleBatch) -> CarryOverBatchPublic:
    department_names = list(
        dict.fromkeys(
            dept
            for item in info.items
            if (dept := info.employee_departments.get(item.employee_id))
        )
    )
    employee_names = list(
        dict.fromkeys(
            name
            for item in info.items
            if (name := info.names.get(item.employee_id, ""))
        )
    )
    week_starts = sorted({item.week_start for item in info.items})
    return CarryOverBatchPublic(
        id=info.batch.id,
        created_at=info.batch.created_at,
        created_by_name=info.created_by_name,
        department_names=department_names,
        employee_names=employee_names,
        week_starts=week_starts,
        reverted_at=info.batch.reverted_at,
        items=[
            CarryOverBatchItemPublic(
                employee_id=item.employee_id,
                employee_name=info.names.get(item.employee_id, ""),
                department_name=info.employee_departments.get(item.employee_id),
                week_start=item.week_start,
                baseline_week_start=item.baseline_week_start,
                other_percent=item.after_percent,
                before_percent=item.before_percent,
            )
            for item in info.items
        ],
    )


def _department_names(
    session: Session, org_id: UUID, employees: list[Employee]
) -> dict[UUID, str]:
    dept_ids = {e.department_id for e in employees if e.department_id is not None}
    if not dept_ids:
        return {}
    by_dept = {
        d.id: d.name
        for d in session.exec(
            select(Department).where(
                Department.org_id == org_id, col(Department.id).in_(dept_ids)
            )
        ).all()
    }
    return {
        e.id: by_dept[e.department_id]
        for e in employees
        if e.department_id is not None and e.department_id in by_dept
    }


def _reversible_batches(
    principal: Principal, session: Session
) -> list[ReversibleBatch]:
    batches = list(
        session.exec(
            select(CapacityCarryOver)
            .where(
                CapacityCarryOver.org_id == principal.org_id,
                col(CapacityCarryOver.reverted_at).is_(None),
            )
            .order_by(
                col(CapacityCarryOver.created_at).desc(),
                col(CapacityCarryOver.id).desc(),
            )
        ).all()
    )
    if not batches:
        return []
    batch_ids = [b.id for b in batches]
    all_items = list(
        session.exec(
            select(CapacityCarryOverItem)
            .where(
                CapacityCarryOverItem.org_id == principal.org_id,
                col(CapacityCarryOverItem.batch_id).in_(batch_ids),
            )
            .order_by(col(CapacityCarryOverItem.id))
        ).all()
    )
    emp_ids = {i.employee_id for i in all_items}
    employees = {
        e.id: e
        for e in session.exec(
            select(Employee).where(
                Employee.org_id == principal.org_id,
                col(Employee.id).in_(emp_ids),
            )
        ).all()
    }
    emp_depts = _department_names(session, principal.org_id, list(employees.values()))
    creator_names = user_names(
        session, principal.org_id, {b.created_by_user_id for b in batches}
    )
    by_batch: dict[UUID, list[CapacityCarryOverItem]] = defaultdict(list)
    for item in all_items:
        by_batch[item.batch_id].append(item)
    visible: list[ReversibleBatch] = []
    for batch in batches:
        items = by_batch.get(batch.id, [])
        if not items:
            continue
        if all(
            (emp := employees.get(item.employee_id)) is not None
            and emp.employment_status == EmploymentStatus.ACTIVE
            and emp.id != principal.employee_id
            and emp.department_id in principal.managed_department_ids
            and can_view_employee(principal, emp)
            for item in items
        ):
            visible.append(
                ReversibleBatch(
                    batch=batch,
                    items=items,
                    names={
                        item.employee_id: employees[item.employee_id].display_name
                        for item in items
                    },
                    created_by_name=creator_names.get(
                        batch.created_by_user_id, tr("部门经理")
                    ),
                    employee_departments={
                        item.employee_id: emp_depts[item.employee_id]
                        for item in items
                        if item.employee_id in emp_depts
                    },
                )
            )
    return visible


def preview_carry_over(
    principal: Principal,
    session: Session,
    department_id: UUID | None = None,
) -> CarryOverPreview:
    require_enabled(principal, session)
    employees = _manageable_employees(principal, session, department_id)
    plan, skipped = _carry_over_plan(session, principal.org_id, employees)
    reversible = _reversible_batches(principal, session)
    latest_batch = _batch_public(reversible[0]) if reversible else None
    return CarryOverPreview(
        items=plan,
        skipped_no_baseline=skipped,
        latest_batch=latest_batch,
        reversible_count=len(reversible),
    )


def preview_carry_over_revert(
    principal: Principal,
    session: Session,
) -> CarryOverRevertPreview:
    require_enabled(principal, session)
    if (
        principal.is_org_admin
        or principal.user_id is None
        or not principal.managed_department_ids
    ):
        raise CapacityForbidden()
    reversible = _reversible_batches(principal, session)
    latest_batch = _batch_public(reversible[0]) if reversible else None
    return CarryOverRevertPreview(
        latest_batch=latest_batch,
        reversible_count=len(reversible),
    )


def commit_carry_over(
    principal: Principal,
    session: Session,
    body: CarryOverCommitInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> CarryOverBatchPublic:
    require_enabled(principal, session)
    if (
        principal.is_org_admin
        or principal.user_id is None
        or not principal.managed_department_ids
    ):
        raise CapacityForbidden()
    subjects: list[Employee] = []
    names: dict[UUID, str] = {}
    for item in sorted(body.items, key=lambda i: i.employee_id):
        subject = employee(principal, session, item.employee_id, lock=True)
        if not can_view_employee(principal, subject):
            raise CapacityNotFound()
        if (
            subject.id == principal.employee_id
            or subject.department_id not in principal.managed_department_ids
        ):
            raise CapacityForbidden()
        subjects.append(subject)
        names[subject.id] = subject.display_name
    plan, _ = _carry_over_plan(session, principal.org_id, subjects)
    plan_by_emp = {p.employee_id: p for p in plan}
    for item in body.items:
        expected = plan_by_emp.get(item.employee_id)
        if (
            expected is None
            or expected.target_week_start != item.week_start
            or expected.baseline_week_start != item.baseline_week_start
            or expected.other_percent != item.other_percent
        ):
            raise HTTPException(409, "部分周次已被确认或变更，请刷新后重试")
    batch = CapacityCarryOver(
        org_id=principal.org_id,
        created_by_user_id=principal.user_id,
    )
    session.add(batch)
    session.flush()
    now = utc_now()
    saved_items: list[CapacityCarryOverItem] = []
    for item in body.items:
        existing = session.exec(
            select(CapacityWeek).where(
                CapacityWeek.org_id == principal.org_id,
                CapacityWeek.employee_id == item.employee_id,
                CapacityWeek.week_start == item.week_start,
            )
        ).one_or_none()
        before_percent = existing.other_percent if existing else None
        before_by = existing.confirmed_by_user_id if existing else None
        before_at = existing.confirmed_at if existing else None
        if existing is None:
            existing = CapacityWeek(
                org_id=principal.org_id,
                employee_id=item.employee_id,
                week_start=item.week_start,
                other_percent=item.other_percent,
                confirmed_by_user_id=principal.user_id,
                confirmed_at=now,
            )
        else:
            existing.other_percent = item.other_percent
            existing.confirmed_by_user_id = principal.user_id
            existing.confirmed_at = now
        session.add(existing)
        record = CapacityCarryOverItem(
            org_id=principal.org_id,
            batch_id=batch.id,
            employee_id=item.employee_id,
            week_start=item.week_start,
            baseline_week_start=item.baseline_week_start,
            after_percent=item.other_percent,
            after_confirmed_at=now,
            before_percent=before_percent,
            before_confirmed_by_user_id=before_by,
            before_confirmed_at=before_at,
        )
        session.add(record)
        saved_items.append(record)
        msg_zh, msg_en = bilingual(
            "团队负荷已更新（沿用 {baseline} 设置至 {week} 当周）。请前往「我的负荷」核对。",
            baseline=item.baseline_week_start,
            week=item.week_start,
        )
        notify_employee(
            principal,
            session,
            item.employee_id,
            msg_zh,
            message_en=msg_en,
        )
    session.flush()
    audit(
        principal,
        session,
        "capacity.workload_carried_over",
        "capacity_carry_over",
        batch.id,
        via,
        client_name,
        {
            "items": [
                {
                    "employee_id": str(i.employee_id),
                    "week_start": i.week_start.isoformat(),
                    "baseline_week_start": i.baseline_week_start.isoformat(),
                    "before_percent": i.before_percent,
                    "after_percent": i.after_percent,
                }
                for i in saved_items
            ]
        },
    )
    emp_depts = _department_names(session, principal.org_id, subjects)
    refresh_org_forecasts(
        session, principal.org_id, employee_ids=[e.id for e in subjects]
    )
    creator_name = user_names(session, principal.org_id, {principal.user_id}).get(
        principal.user_id, tr("部门经理")
    )
    return _batch_public(
        ReversibleBatch(
            batch=batch,
            items=saved_items,
            names=names,
            created_by_name=creator_name,
            employee_departments=emp_depts,
        )
    )


def revert_carry_over(
    principal: Principal,
    session: Session,
    *,
    batch_id: UUID | None = None,
    via: Via = "web",
    client_name: str | None = None,
) -> CarryOverBatchPublic:
    require_enabled(principal, session)
    if (
        principal.is_org_admin
        or principal.user_id is None
        or not principal.managed_department_ids
    ):
        raise CapacityForbidden()
    reversible = _reversible_batches(principal, session)
    if not reversible:
        if batch_id is not None:
            raise HTTPException(409, "该沿用批次已被回撤或已变化，请刷新后重新核对")
        raise CapacityNotFound("没有可回撤的沿用记录")
    target = reversible[0]
    if batch_id is not None and target.batch.id != batch_id:
        raise HTTPException(409, "可回撤的沿用批次已变化，请刷新后重新核对")
    target_batch, items = target.batch, target.items
    batch = session.exec(
        select(CapacityCarryOver)
        .where(
            CapacityCarryOver.org_id == principal.org_id,
            CapacityCarryOver.id == target_batch.id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one()
    if batch.reverted_at is not None:
        raise HTTPException(409, "该沿用批次已被回撤或已变化，请刷新后重新核对")
    for item in sorted(items, key=lambda i: i.employee_id):
        subject = employee(principal, session, item.employee_id, lock=True)
        if not can_view_employee(principal, subject):
            raise CapacityNotFound()
        if (
            subject.id == principal.employee_id
            or subject.department_id not in principal.managed_department_ids
        ):
            raise CapacityForbidden()
    for item in items:
        current = session.exec(
            select(CapacityWeek).where(
                CapacityWeek.org_id == principal.org_id,
                CapacityWeek.employee_id == item.employee_id,
                CapacityWeek.week_start == item.week_start,
            )
        ).one_or_none()
        if (
            current is None
            or current.other_percent != item.after_percent
            or current.confirmed_at != item.after_confirmed_at
        ):
            raise HTTPException(409, "沿用后该周负荷已被修改，无法直接回撤")
        if item.before_percent is None:
            session.delete(current)
        else:
            assert (
                item.before_confirmed_by_user_id is not None
                and item.before_confirmed_at is not None
            )
            current.other_percent = item.before_percent
            current.confirmed_by_user_id = item.before_confirmed_by_user_id
            current.confirmed_at = item.before_confirmed_at
            session.add(current)
        msg_zh, msg_en = bilingual(
            "已撤回沿用的周负荷设置（周次 {week}），已恢复原状态。请前往「我的负荷」核对。",
            week=item.week_start,
        )
        notify_employee(
            principal,
            session,
            item.employee_id,
            msg_zh,
            message_en=msg_en,
        )
    batch.reverted_at = utc_now()
    batch.reverted_by_user_id = principal.user_id
    session.add(batch)
    session.flush()
    refresh_org_forecasts(
        session,
        principal.org_id,
        employee_ids=list({item.employee_id for item in items}),
    )
    audit(
        principal,
        session,
        "capacity.workload_carry_over_reverted",
        "capacity_carry_over",
        batch.id,
        via,
        client_name,
        {
            "items": [
                {
                    "employee_id": str(i.employee_id),
                    "week_start": i.week_start.isoformat(),
                    "restored_percent": i.before_percent,
                    "reverted_from_percent": i.after_percent,
                }
                for i in items
            ]
        },
    )
    return _batch_public(target)
