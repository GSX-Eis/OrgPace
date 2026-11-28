"""Proposal line validation, conflict detection, and forecast confirmation."""

from collections import defaultdict
from collections.abc import Sequence
from datetime import date, timedelta
from uuid import UUID

from fastapi import HTTPException
from pydantic import JsonValue
from sqlmodel import Session, col, select

from app.authz.policies import can_view_employee
from app.authz.principal import Principal
from app.domains.base import utc_now
from app.domains.capacity import calendar
from app.domains.capacity.common import (
    DEMAND_NOT_FOUND,
    CapacityNotFound,
    audit,
    qualified_people,
    represents_department,
    require_enabled,
    set_week,
)
from app.domains.capacity.demand_schemas import (
    BorrowLineInput,
    ChangeProposalInput,
    PlanReplyInput,
    ProposalLineInput,
)
from app.domains.capacity.models import (
    AssignmentStatus,
    CapacityAssignment,
    CapacityDemand,
    CapacityProposal,
    CapacityProposalLine,
    ProposalStatus,
)
from app.domains.capacity.schemas import Via
from app.domains.org.models import Employee, EmploymentStatus
from app.domains.org.service import managed_scope
from app.i18n import tr


class ProposalConflict(HTTPException):
    def __init__(self, message: str, **details: JsonValue) -> None:
        super().__init__(409, {"message": message, **details})


def conflict_sources(
    principal: Principal,
    session: Session,
    employee_id: UUID,
    week: date,
    exclude: UUID | None,
    replace_demand: UUID | None,
) -> list[str]:
    end = week + timedelta(days=6)
    assigned = session.exec(
        select(CapacityAssignment.demand_id).where(
            CapacityAssignment.org_id == principal.org_id,
            CapacityAssignment.employee_id == employee_id,
            CapacityAssignment.status == AssignmentStatus.ACTIVE,
            CapacityAssignment.due_date >= week,
            col(CapacityAssignment.start_date).is_(None)
            | (col(CapacityAssignment.start_date) <= end),
        )
    ).all()
    held = session.exec(
        select(CapacityProposal.demand_id)
        .join(
            CapacityProposalLine,
            (col(CapacityProposalLine.org_id) == CapacityProposal.org_id)
            & (col(CapacityProposalLine.proposal_id) == CapacityProposal.id),
        )
        .where(
            CapacityProposal.org_id == principal.org_id,
            CapacityProposalLine.employee_id == employee_id,
            CapacityProposal.status == ProposalStatus.PENDING,
            CapacityProposal.hold_expires_at > utc_now(),
            CapacityProposalLine.start_date <= end,
            CapacityProposalLine.end_date >= week,
            *([CapacityProposal.id != exclude] if exclude else []),
        )
    ).all()
    demands = session.exec(
        select(CapacityDemand).where(
            CapacityDemand.org_id == principal.org_id,
            col(CapacityDemand.id).in_(set(assigned) | set(held)),
        )
    ).all()
    return sorted(
        {
            d.description
            if (
                d.requester_user_id == principal.user_id
                or d.requesting_department_id in principal.managed_department_ids
                or represents_department(principal, d.target_department_id)
            )
            else tr("其他需求")
            for d in demands
            if d.id != replace_demand
        }
    )


def _over_week_entry(
    principal: Principal,
    session: Session,
    employee_id: UUID,
    week_start: date,
    excess: int,
    exclude: UUID | None,
    replace_demand: UUID | None,
) -> JsonValue:
    return {
        "week_start": week_start.isoformat(),
        "over_percent": excess,
        "sources": list[JsonValue](
            conflict_sources(
                principal,
                session,
                employee_id,
                week_start,
                exclude,
                replace_demand,
            )
        ),
    }


def _verify_employee_weeks(
    principal: Principal,
    session: Session,
    demand: CapacityDemand,
    requested: dict[UUID, dict[date, int]],
    *,
    exclude: UUID | None,
    replace: bool,
    conflict_viewer: Principal | None,
    can_forecast_for: dict[UUID, bool] | None = None,
    to_confirm: list[tuple[UUID, calendar.WeekLoad]] | None = None,
) -> None:
    viewer = conflict_viewer or principal
    replace_demand = demand.id if replace else None
    for employee_id, amounts in requested.items():
        start, end = min(amounts), max(amounts)
        weekly = calendar.loads(
            session,
            principal.org_id,
            [employee_id],
            start,
            (end - start).days // 7 + 1,
            exclude_proposal_id=exclude,
            exclude_committed_demand_id=replace_demand,
        )[employee_id]
        unconfirmed: list[JsonValue] = []
        over: list[JsonValue] = []
        allow_forecast = bool(can_forecast_for and can_forecast_for.get(employee_id))
        for load in weekly:
            if load.week_start not in amounts:
                continue
            if load.status != "confirmed":
                if allow_forecast and load.forecast_other_percent is not None:
                    excess = (
                        load.forecast_other_percent
                        + load.platform_percent
                        + amounts[load.week_start]
                        - load.capacity_percent
                    )
                    if excess > 0:
                        over.append(
                            _over_week_entry(
                                viewer,
                                session,
                                employee_id,
                                load.week_start,
                                excess,
                                exclude,
                                replace_demand,
                            )
                        )
                    elif to_confirm is not None:
                        to_confirm.append((employee_id, load))
                    continue
                unconfirmed.append(
                    {"week_start": load.week_start.isoformat(), "status": load.status}
                )
            excess = (
                (load.other_percent or 0)
                + load.platform_percent
                + amounts[load.week_start]
                - load.capacity_percent
            )
            if excess > 0:
                over.append(
                    _over_week_entry(
                        viewer,
                        session,
                        employee_id,
                        load.week_start,
                        excess,
                        exclude,
                        replace_demand,
                    )
                )
        if unconfirmed or over:
            raise ProposalConflict(
                "请先确认这些周的容量" if unconfirmed else "这些周的安排超过可用容量",
                weeks=unconfirmed,
                over_weeks=over,
            )


def check_lines(
    principal: Principal,
    session: Session,
    demand: CapacityDemand,
    lines: list[ProposalLineInput],
    *,
    exclude: UUID | None = None,
    replace: bool = False,
    conflict_viewer: Principal | None = None,
    lender_department_id: UUID | None = None,
    lenders: dict[UUID, Principal] | None = None,
    preview_forecast: bool = False,
    confirm_forecasts: bool = False,
    via: Via = "web",
) -> None:
    if not lines:
        raise ProposalConflict("方案没有可安排的人员")
    # Every commitment writer takes these locks in UUID order, after its demand.
    people: dict[UUID, Employee] = {}
    for employee_id in sorted({line.employee_id for line in lines}):
        person = session.exec(
            select(Employee)
            .where(
                Employee.org_id == principal.org_id,
                Employee.id == employee_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        ).one_or_none()
        if person is None or person.employment_status != EmploymentStatus.ACTIVE:
            raise ProposalConflict("方案人员已不在职，请重新规划")
        people[employee_id] = person
    target_id = lender_department_id or demand.target_department_id
    target = managed_scope(session, principal.org_id, frozenset({target_id}))
    if lender_department_id is None:
        require_enabled(principal, session)
        if not represents_department(principal, demand.target_department_id):
            raise CapacityNotFound(DEMAND_NOT_FOUND)
    basis = set(qualified_people(principal, session, demand, target_id))
    requested: dict[UUID, dict[date, int]] = defaultdict(lambda: defaultdict(int))
    for line in lines:
        person = people[line.employee_id]
        if (
            not can_view_employee(
                lenders[line.employee_id] if lenders else principal, person
            )
            or person.department_id not in target
        ):
            raise ProposalConflict("方案人员已不在目标部门管辖范围内，请重新规划")
        if line.employee_id not in basis and not line.outside_basis:
            raise ProposalConflict("方案人员不在能力依据中，请确认按经理判断安排")
        week = max(
            calendar.week_start(line.start_date),
            calendar.this_week(session, principal.org_id),
        )
        while week <= calendar.week_start(line.end_date):
            requested[line.employee_id][week] += line.allocation_percent
            week += timedelta(weeks=1)
    if preview_forecast or confirm_forecasts:
        manager_scope = (
            managed_scope(session, principal.org_id, principal.managed_department_ids)
            if lender_department_id is None and principal.managed_department_ids
            else set()
        )
        can_forecast_for = {
            employee_id: (
                lender_department_id is None
                and principal.user_id is not None
                and employee_id != principal.employee_id
                and people[employee_id].department_id in manager_scope
            )
            for employee_id in requested
        }
        to_confirm: list[tuple[UUID, calendar.WeekLoad]] = []
        _verify_employee_weeks(
            principal,
            session,
            demand,
            requested,
            exclude=exclude,
            replace=replace,
            conflict_viewer=conflict_viewer,
            can_forecast_for=can_forecast_for,
            to_confirm=to_confirm if confirm_forecasts else None,
        )
        if not confirm_forecasts:
            return
        for employee_id, load in to_confirm:
            assert load.forecast_other_percent is not None
            before = set_week(
                principal,
                session,
                employee_id,
                load.forecast_other_percent,
                load.week_start,
            )
            audit(
                principal,
                session,
                "capacity.workload_confirmed_from_forecast",
                "employee",
                employee_id,
                via,
                None,
                {
                    "demand_id": str(demand.id),
                    "week_start": load.week_start.isoformat(),
                    "before_percent": before,
                    "after_percent": load.forecast_other_percent,
                    "forecast_source": load.forecast_source,
                },
            )
    _verify_employee_weeks(
        principal,
        session,
        demand,
        requested,
        exclude=exclude,
        replace=replace,
        conflict_viewer=conflict_viewer,
    )


def plan_lines(
    principal: Principal,
    session: Session,
    demand: CapacityDemand,
    body: PlanReplyInput | ChangeProposalInput,
    params: dict[str, JsonValue],
    *,
    borrow: bool,
) -> list[ProposalLineInput | BorrowLineInput]:
    if borrow:
        departments = params.get("departments")
        if (
            body.lender_department_id is None
            or body.borrow_headcount is None
            or (
                demand.headcount is not None
                and body.borrow_headcount > demand.headcount
            )
            or not isinstance(departments, list)
            or not any(
                isinstance(entry, dict)
                and entry.get("department_id") == str(body.lender_department_id)
                for entry in departments
            )
        ):
            raise ProposalConflict(
                "请从保存的借调方案选择借出部门和人数，人数不能超过需求"
            )
        return [
            BorrowLineInput(
                lender_department_id=body.lender_department_id,
                allocation_percent=(
                    demand.allocation_percent
                    if demand.allocation_percent is not None
                    else 100
                ),
                start_date=demand.window_start,
                end_date=demand.window_end,
            )
            for _ in range(body.borrow_headcount)
        ]
    if body.lender_department_id is not None or body.borrow_headcount is not None:
        raise ProposalConflict("只有借调方案可以指定借出部门和人数")
    raw = params.get("assignees")
    if (
        not isinstance(raw, list)
        or not raw
        or not all(isinstance(item, dict) for item in raw)
    ):
        raise ProposalConflict("方案尚无可安排的人员，请重新规划")
    lines = [
        ProposalLineInput.model_validate({**item, "outside_basis": body.outside_basis})
        for item in raw
        if isinstance(item, dict)
    ]
    check_lines(
        principal,
        session,
        demand,
        lines,
        replace=isinstance(body, ChangeProposalInput),
        preview_forecast=True,
    )
    return list(lines)


def is_direct_commit(
    demand: CapacityDemand,
    lines: Sequence[ProposalLineInput | BorrowLineInput],
    *,
    is_borrow: bool,
) -> bool:
    """In-window internal plans without borrow commit immediately."""
    return (
        not is_borrow
        and bool(lines)
        and all(isinstance(line, ProposalLineInput) for line in lines)
        and min(line.start_date for line in lines) >= demand.window_start
        and max(line.end_date for line in lines) <= demand.window_end
    )
