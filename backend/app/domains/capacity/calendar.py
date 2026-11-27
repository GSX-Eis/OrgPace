from collections import defaultdict
from collections.abc import Mapping
from datetime import date, datetime, timedelta
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field
from sqlmodel import Session, col, select

from app.domains.base import utc_now
from app.domains.capacity.models import (
    AssignmentStatus,
    CapacityAssignment,
    CapacityProposal,
    CapacityProposalLine,
    CapacityUnavailability,
    CapacityWeek,
    CapacityWeekForecast,
    ForecastSource,
    ProposalStatus,
)
from app.domains.org.timezone import read_timezone

FRESH_DAYS = 28
MAX_WORKLOAD_WEEKS = 26


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def this_week(session: Session, org_id: UUID) -> date:
    return week_start(
        utc_now().astimezone(ZoneInfo(read_timezone(session, org_id).timezone)).date()
    )


class HoldLoad(BaseModel):
    allocation_percent: int
    expires_at: datetime


class WeekLoad(BaseModel):
    week_start: date
    capacity_percent: int
    other_percent: int | None
    platform_percent: int
    hold_percent: int = 0
    holds: list[HoldLoad] = Field(default_factory=list)
    status: Literal["unconfirmed", "confirmed", "stale"]
    confirmed_at: datetime | None
    legacy_start: bool
    forecast_other_percent: int | None = None
    forecast_source: Literal["agent_auto", "manager_override"] | None = None
    forecast_basis: str | None = None
    forecast_policy_label: str | None = None
    forecast_events: list[str] = Field(default_factory=list)


def format_forecast_event_label(
    title: str, modifier_kind: str, modifier_value: float
) -> str:
    """Format a forecast event badge label consistently across engine and calendar."""
    if modifier_kind == "multiplier":
        return f"{title}（×{modifier_value:g}）"
    return f"{title}（{modifier_value:+g}%）"


def _extract_forecast_events(signals: Mapping[str, object]) -> list[str]:
    raw_events = signals.get("applied_events")
    if not isinstance(raw_events, list):
        return []
    labels: list[str] = []
    for item in raw_events:
        if not isinstance(item, dict):
            continue
        title = item.get("title")
        kind = item.get("modifier_kind")
        value = item.get("modifier_value")
        if (
            isinstance(title, str)
            and isinstance(kind, str)
            and isinstance(value, (int, float))
            and not isinstance(value, bool)
        ):
            labels.append(format_forecast_event_label(title, kind, float(value)))
    return labels


def loads(
    session: Session,
    org_id: UUID,
    employee_ids: list[UUID],
    from_week: date,
    weeks: int,
    *,
    exclude_assignment_id: UUID | None = None,
    exclude_proposal_id: UUID | None = None,
    exclude_demand_id: UUID | None = None,
    exclude_committed_demand_id: UUID | None = None,
) -> dict[UUID, list[WeekLoad]]:
    end = from_week + timedelta(weeks=weeks)
    records = {
        (r.employee_id, r.week_start): r
        for r in session.exec(
            select(CapacityWeek).where(
                CapacityWeek.org_id == org_id,
                col(CapacityWeek.employee_id).in_(employee_ids),
                CapacityWeek.week_start >= from_week,
                CapacityWeek.week_start < end,
            )
        ).all()
    }
    assignments = session.exec(
        select(CapacityAssignment).where(
            CapacityAssignment.org_id == org_id,
            col(CapacityAssignment.employee_id).in_(employee_ids),
            CapacityAssignment.status == AssignmentStatus.ACTIVE,
            CapacityAssignment.due_date >= from_week,
        )
    ).all()
    holds = session.exec(
        select(CapacityProposalLine, CapacityProposal)
        .join(
            CapacityProposal,
            (col(CapacityProposal.org_id) == CapacityProposalLine.org_id)
            & (col(CapacityProposal.id) == CapacityProposalLine.proposal_id),
        )
        .where(
            CapacityProposalLine.org_id == org_id,
            col(CapacityProposalLine.employee_id).in_(employee_ids),
            CapacityProposal.status == ProposalStatus.PENDING,
            CapacityProposal.hold_expires_at > utc_now(),
            CapacityProposalLine.end_date >= from_week,
            CapacityProposalLine.start_date < end,
            *(
                [CapacityProposal.id != exclude_proposal_id]
                if exclude_proposal_id
                else []
            ),
            *(
                [CapacityProposal.demand_id != exclude_demand_id]
                if exclude_demand_id
                else []
            ),
        )
    ).all()
    unavailable = session.exec(
        select(CapacityUnavailability).where(
            CapacityUnavailability.org_id == org_id,
            col(CapacityUnavailability.employee_id).in_(employee_ids),
            CapacityUnavailability.end_date >= from_week,
            CapacityUnavailability.start_date < end,
        )
    ).all()
    forecasts = {
        (f.employee_id, f.week_start): f
        for f in session.exec(
            select(CapacityWeekForecast).where(
                CapacityWeekForecast.org_id == org_id,
                col(CapacityWeekForecast.employee_id).in_(employee_ids),
                CapacityWeekForecast.week_start >= from_week,
                CapacityWeekForecast.week_start < end,
            )
        ).all()
    }
    cutoff = utc_now() - timedelta(days=FRESH_DAYS)
    result: dict[UUID, list[WeekLoad]] = {}
    for employee_id in employee_ids:
        result[employee_id] = []
        for offset in range(weeks):
            start = from_week + timedelta(weeks=offset)
            record = records.get((employee_id, start))
            overlapping = [
                a
                for a in assignments
                if a.employee_id == employee_id
                and (a.start_date or week_start(a.created_at.date()))
                <= start + timedelta(days=6)
                and a.due_date >= start
            ]
            days = sum(
                not any(
                    u.employee_id == employee_id
                    and u.start_date <= start + timedelta(days=d) <= u.end_date
                    for u in unavailable
                )
                for d in range(5)
            )
            amounts: dict[UUID, int] = defaultdict(int)
            proposals: dict[UUID, CapacityProposal] = {}
            details: list[HoldLoad] = []
            for line, proposal in holds:
                if (
                    line.employee_id == employee_id
                    and line.start_date <= start + timedelta(days=6)
                    and line.end_date >= start
                ):
                    if proposal.kind == "change":
                        amounts[proposal.id] += line.allocation_percent
                        proposals[proposal.id] = proposal
                    else:
                        details.append(
                            HoldLoad(
                                allocation_percent=line.allocation_percent,
                                expires_at=proposal.hold_expires_at,
                            )
                        )
            for proposal_id, amount in amounts.items():
                proposal = proposals[proposal_id]
                amount -= sum(
                    a.allocation_percent
                    for a in overlapping
                    if a.demand_id == proposal.demand_id
                    and a.proposal_line_id is not None
                )
                if amount > 0:
                    details.append(
                        HoldLoad(
                            allocation_percent=amount,
                            expires_at=proposal.hold_expires_at,
                        )
                    )
            overlapping = [
                a
                for a in overlapping
                if a.id != exclude_assignment_id
                and not (
                    a.demand_id == exclude_committed_demand_id
                    and a.proposal_line_id is not None
                )
            ]
            held = sum(hold.allocation_percent for hold in details)
            status: Literal["unconfirmed", "confirmed", "stale"] = (
                "unconfirmed"
                if record is None
                else "stale"
                if record.confirmed_at < cutoff
                else "confirmed"
            )
            forecast = (
                forecasts.get((employee_id, start)) if status != "confirmed" else None
            )
            forecast_source: Literal["agent_auto", "manager_override"] | None = (
                None
                if forecast is None
                else "manager_override"
                if forecast.source == ForecastSource.MANAGER_OVERRIDE
                else "agent_auto"
            )
            forecast_policy_label = (
                raw_label
                if forecast is not None
                and isinstance(raw_label := forecast.signals.get("policy_label"), str)
                else None
            )
            forecast_events = (
                _extract_forecast_events(forecast.signals)
                if forecast is not None
                else []
            )
            result[employee_id].append(
                WeekLoad(
                    week_start=start,
                    capacity_percent=100 * days // 5,
                    other_percent=record.other_percent if record else None,
                    platform_percent=sum(a.allocation_percent for a in overlapping)
                    + held,
                    hold_percent=held,
                    holds=details,
                    status=status,
                    confirmed_at=record.confirmed_at if record else None,
                    legacy_start=any(a.start_date is None for a in overlapping),
                    forecast_other_percent=(
                        forecast.forecast_other_percent if forecast else None
                    ),
                    forecast_source=forecast_source,
                    forecast_basis=forecast.basis_summary if forecast else None,
                    forecast_policy_label=forecast_policy_label,
                    forecast_events=forecast_events,
                )
            )
    return result


def shortfalls(
    week_loads: list[WeekLoad], allocation_percent: int
) -> tuple[list[date], list[tuple[date, int]]]:
    unconfirmed = [w.week_start for w in week_loads if w.status != "confirmed"]
    over = [
        (
            w.week_start,
            w.other_percent
            + w.platform_percent
            + allocation_percent
            - w.capacity_percent,
        )
        for w in week_loads
        if w.other_percent is not None
        and w.other_percent + w.platform_percent + allocation_percent
        > w.capacity_percent
    ]
    return unconfirmed, over
