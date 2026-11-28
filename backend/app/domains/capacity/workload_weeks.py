from datetime import date, timedelta
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import Session, col, select

from app.authz.policies import can_view_employee, employee_scope_clause
from app.authz.principal import Principal
from app.domains.capacity import calendar
from app.domains.capacity.common import (
    CapacityForbidden,
    CapacityNotFound,
    audit,
    employee,
    notify_employee,
)
from app.domains.capacity.common import (
    set_week as set_week,
)
from app.domains.capacity.forecast import refresh_org_forecasts
from app.domains.capacity.models import CapacityUnavailability
from app.domains.capacity.schemas import (
    UnavailabilityInput,
    UnavailabilityList,
    UnavailabilityPublic,
    Via,
    WorkloadList,
    WorkloadWeeksInput,
)
from app.domains.capacity.settings import require_enabled
from app.domains.capacity.tracking import notify_unavailability
from app.domains.capacity.workload_views import views, workload_reviewers
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.inbox.service import add_item
from app.domains.org.models import Employee
from app.i18n import bilingual


def _group_dates(days: list[date]) -> list[tuple[date, date]]:
    if not days:
        return []
    ordered = sorted(days)
    ranges: list[tuple[date, date]] = []
    start = end = ordered[0]
    for day in ordered[1:]:
        if day == end + timedelta(days=1):
            end = day
        else:
            ranges.append((start, end))
            start = end = day
    ranges.append((start, end))
    return ranges


def _audit_and_notify_unavailability_removed(
    principal: Principal,
    session: Session,
    subject: Employee,
    target_id: UUID,
    start_date: date,
    end_date: date,
    *,
    via: Via,
    client_name: str | None,
) -> None:
    audit(
        principal,
        session,
        "capacity.unavailability_deleted",
        "capacity_unavailability",
        target_id,
        via,
        client_name,
        {
            "employee_id": str(subject.id),
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
        },
    )
    if subject.id != principal.employee_id:
        msg_zh, msg_en = bilingual(
            "你的不可用时段已撤销（{start} 至 {end}）。请前往「我的负荷」核对。",
            start=start_date,
            end=end_date,
        )
        notify_employee(
            principal,
            session,
            subject.id,
            msg_zh,
            message_en=msg_en,
        )


def _remove_unavailability_dates(
    principal: Principal,
    session: Session,
    subject: Employee,
    overlapping: list[CapacityUnavailability],
    remove_days: set[date],
    *,
    via: Via,
    client_name: str | None,
) -> None:
    for row in overlapping:
        matched = sorted(d for d in remove_days if row.start_date <= d <= row.end_date)
        if not matched:
            continue
        kept_days: list[date] = []
        cursor = row.start_date
        while cursor <= row.end_date:
            if cursor not in remove_days:
                kept_days.append(cursor)
            cursor += timedelta(days=1)
        kept_ranges = _group_dates(kept_days)
        removed_ranges = _group_dates(matched)
        row_id = row.id
        created_by = row.created_by_user_id
        if not kept_ranges:
            session.delete(row)
            session.flush()
        else:
            row.start_date, row.end_date = kept_ranges[0]
            session.add(row)
            for ks, ke in kept_ranges[1:]:
                session.add(
                    CapacityUnavailability(
                        org_id=principal.org_id,
                        employee_id=subject.id,
                        start_date=ks,
                        end_date=ke,
                        created_by_user_id=created_by,
                    )
                )
            session.flush()
        for rs, re in removed_ranges:
            _audit_and_notify_unavailability_removed(
                principal,
                session,
                subject,
                row_id,
                rs,
                re,
                via=via,
                client_name=client_name,
            )


def _sync_week_unavailability(
    principal: Principal,
    session: Session,
    subject: Employee,
    week_start: date,
    requested_capacity: int | None,
    on_leave: bool | None,
    leave_dates: list[date] | None,
    *,
    via: Via,
    client_name: str | None,
) -> None:
    if requested_capacity is None and on_leave is None and leave_dates is None:
        return
    if principal.user_id is None:
        raise CapacityForbidden()
    mon = week_start
    sun = mon + timedelta(days=6)
    overlapping = list(
        session.exec(
            select(CapacityUnavailability)
            .where(
                CapacityUnavailability.org_id == principal.org_id,
                CapacityUnavailability.employee_id == subject.id,
                CapacityUnavailability.start_date <= sun,
                CapacityUnavailability.end_date >= mon,
            )
            .order_by(
                col(CapacityUnavailability.start_date), col(CapacityUnavailability.id)
            )
        ).all()
    )
    weekdays = [mon + timedelta(days=d) for d in range(5)]
    covered = [
        day
        for day in weekdays
        if any(r.start_date <= day <= r.end_date for r in overlapping)
    ]
    covered_set = set(covered)
    if leave_dates is None:
        if requested_capacity is not None:
            target_unavail = (100 - requested_capacity) // 20
        elif on_leave is True:
            target_unavail = len(covered) or 1
        else:
            target_unavail = 0
        if target_unavail != len(covered):
            raise HTTPException(
                422,
                "调整可用上限或请假状态会改变请假天数，请在周详情中选定具体请假日期",
            )
        return

    week_set = set(weekdays)
    if any(day not in week_set for day in leave_dates):
        raise HTTPException(422, "请假日期须在当前周的工作日（周一至周五）内")
    target_set = set(leave_dates)
    if (
        requested_capacity is not None
        and len(target_set) != (100 - requested_capacity) // 20
    ):
        raise HTTPException(422, "所选请假日期天数与可用上限不匹配，请核对具体日期")
    if on_leave is True and not target_set:
        raise HTTPException(422, "标记请假时请选定具体请假日期")
    if on_leave is False and target_set:
        raise HTTPException(422, "未标记请假时不能保留请假日期")

    to_add = [day for day in weekdays if day in target_set and day not in covered_set]
    to_remove = {day for day in covered_set if day not in target_set}
    if to_remove:
        _remove_unavailability_dates(
            principal,
            session,
            subject,
            overlapping,
            to_remove,
            via=via,
            client_name=client_name,
        )
    for rs, re in _group_dates(to_add):
        row = CapacityUnavailability(
            org_id=principal.org_id,
            employee_id=subject.id,
            start_date=rs,
            end_date=re,
            created_by_user_id=principal.user_id,
        )
        session.add(row)
        session.flush()
        audit(
            principal,
            session,
            "capacity.unavailability_registered",
            "capacity_unavailability",
            row.id,
            via,
            client_name,
            {
                "employee_id": str(subject.id),
                "start_date": rs.isoformat(),
                "end_date": re.isoformat(),
            },
        )
        msg_zh, msg_en = bilingual(
            "你的不可用时段已登记（{start} 至 {end}）。请前往「我的负荷」核对。",
            start=row.start_date,
            end=row.end_date,
        )
        notify_employee(
            principal,
            session,
            subject.id,
            msg_zh,
            message_en=msg_en,
        )
        notify_unavailability(session, row)


def set_weeks(
    principal: Principal,
    session: Session,
    body: WorkloadWeeksInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> WorkloadList:
    require_enabled(principal, session)
    subjects: list[Employee] = []
    by_id: dict[UUID, Employee] = {}
    for item in sorted(body.items, key=lambda item: item.employee_id):
        if item.leave_dates is not None and body.start_week != body.end_week:
            raise HTTPException(422, "修改具体请假日期请按单周操作")
        subject = employee(principal, session, item.employee_id, lock=True)
        if not can_view_employee(principal, subject):
            raise CapacityNotFound()
        if (
            subject.id == principal.employee_id
            or subject.department_id not in principal.managed_department_ids
        ):
            raise CapacityForbidden()
        subjects.append(subject)
        by_id[subject.id] = subject
    for item in body.items:
        subject = by_id[item.employee_id]
        for offset in range((body.end_week - body.start_week).days // 7 + 1):
            week = body.start_week + timedelta(weeks=offset)
            before = set_week(
                principal,
                session,
                item.employee_id,
                item.other_percent,
                week,
            )
            audit(
                principal,
                session,
                "capacity.workload_adjusted",
                "employee",
                item.employee_id,
                via,
                client_name,
                {
                    "before_percent": before,
                    "after_percent": item.other_percent,
                    "week_start": week.isoformat(),
                },
            )
            _sync_week_unavailability(
                principal,
                session,
                subject,
                week,
                item.capacity_percent,
                item.on_leave,
                item.leave_dates,
                via=via,
                client_name=client_name,
            )
        msg_zh, msg_en = bilingual(
            "团队负荷已更新（周次 {start} 至 {end}）。请前往「我的负荷」核对。",
            start=body.start_week,
            end=body.end_week,
        )
        notify_employee(
            principal,
            session,
            item.employee_id,
            msg_zh,
            message_en=msg_en,
        )
    session.flush()
    refresh_org_forecasts(session, principal.org_id, employee_ids=list(by_id))
    data = views(principal, session, subjects)
    return WorkloadList(data=data, count=len(data))


def unavailability_public(
    principal: Principal,
    session: Session,
    row: CapacityUnavailability,
    subject: Employee,
) -> UnavailabilityPublic:
    start = calendar.week_start(row.start_date)
    weekly = calendar.loads(
        session,
        principal.org_id,
        [subject.id],
        start,
        (calendar.week_start(row.end_date) - start).days // 7 + 1,
    )[subject.id]
    return UnavailabilityPublic(
        **row.model_dump(exclude={"org_id"}),
        can_delete=not principal.is_org_admin
        and (
            row.created_by_user_id == principal.user_id
            or subject.department_id in principal.managed_department_ids
        ),
        over_weeks=[week for week, _ in calendar.shortfalls(weekly, 0)[1]],
    )


def list_unavailability(
    principal: Principal,
    session: Session,
    employee_id: UUID,
    from_date: date,
    to_date: date,
) -> UnavailabilityList:
    require_enabled(principal, session)
    subject = session.exec(
        select(Employee).where(
            employee_scope_clause(principal),
            Employee.id == employee_id,
        )
    ).one_or_none()
    if subject is None:
        raise CapacityNotFound()
    rows = session.exec(
        select(CapacityUnavailability)
        .where(
            CapacityUnavailability.org_id == principal.org_id,
            CapacityUnavailability.employee_id == employee_id,
            CapacityUnavailability.start_date <= to_date,
            CapacityUnavailability.end_date >= from_date,
        )
        .order_by(
            col(CapacityUnavailability.start_date), col(CapacityUnavailability.id)
        )
    ).all()
    data = [unavailability_public(principal, session, row, subject) for row in rows]
    return UnavailabilityList(data=data, count=len(data))


def register_unavailability(
    principal: Principal,
    session: Session,
    body: UnavailabilityInput,
    *,
    via: Via = "web",
    client_name: str | None = None,
) -> UnavailabilityPublic:
    require_enabled(principal, session)
    subject = employee(principal, session, body.employee_id, lock=True)
    if not can_view_employee(principal, subject):
        raise CapacityNotFound()
    if principal.is_org_admin:
        raise CapacityForbidden()
    if principal.user_id is None or (
        subject.id != principal.employee_id
        and subject.department_id not in principal.managed_department_ids
    ):
        raise CapacityForbidden()
    payload = body.model_dump()
    row = CapacityUnavailability(
        org_id=principal.org_id,
        created_by_user_id=principal.user_id,
        **payload,
    )
    session.add(row)
    session.flush()
    audit(
        principal,
        session,
        "capacity.unavailability_registered",
        "capacity_unavailability",
        row.id,
        via,
        client_name,
        body.model_dump(mode="json"),
    )
    if subject.id != principal.employee_id:
        msg_zh, msg_en = bilingual(
            "你的不可用时段已登记（{start} 至 {end}）。请前往「我的负荷」核对。",
            start=row.start_date,
            end=row.end_date,
        )
        notify_employee(
            principal,
            session,
            subject.id,
            msg_zh,
            message_en=msg_en,
        )
    affected_recipients = notify_unavailability(session, row)
    if subject.id == principal.employee_id:
        for user in workload_reviewers(principal, session, subject.id):
            if user.id in affected_recipients:
                continue
            msg_zh, msg_en = bilingual(
                "{name} 已登记请假（{start} 至 {end}）。已直接生效，请前往「团队负荷」查看。",
                name=subject.display_name,
                start=row.start_date,
                end=row.end_date,
            )
            add_item(
                session,
                InboxItem(
                    org_id=principal.org_id,
                    recipient_user_id=user.id,
                    kind=InboxKind.CAPACITY,
                    message=msg_zh,
                    message_en=msg_en,
                ),
            )
    return unavailability_public(principal, session, row, subject)


def delete_unavailability(
    principal: Principal,
    session: Session,
    unavailability_id: UUID,
) -> UnavailabilityPublic:
    require_enabled(principal, session)
    query = select(CapacityUnavailability).where(
        CapacityUnavailability.org_id == principal.org_id,
        CapacityUnavailability.id == unavailability_id,
    )
    row = session.exec(query).one_or_none()
    if row is None:
        raise CapacityNotFound()
    subject = employee(principal, session, row.employee_id, lock=True)
    row = session.exec(query.execution_options(populate_existing=True)).one_or_none()
    if row is None or not can_view_employee(principal, subject):
        raise CapacityNotFound()
    if principal.is_org_admin:
        raise CapacityForbidden()
    if (
        row.created_by_user_id != principal.user_id
        and subject.department_id not in principal.managed_department_ids
    ):
        raise CapacityForbidden()
    session.delete(row)
    session.flush()
    audit(
        principal,
        session,
        "capacity.unavailability_deleted",
        "capacity_unavailability",
        row.id,
        "web",
        None,
        {
            "employee_id": str(subject.id),
            "start_date": row.start_date.isoformat(),
            "end_date": row.end_date.isoformat(),
        },
    )
    if subject.id != principal.employee_id:
        msg_zh, msg_en = bilingual(
            "你的不可用时段已撤销（{start} 至 {end}）。请前往「我的负荷」核对。",
            start=row.start_date,
            end=row.end_date,
        )
        notify_employee(
            principal,
            session,
            subject.id,
            msg_zh,
            message_en=msg_en,
        )
    return unavailability_public(principal, session, row, subject)
