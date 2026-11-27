"""E52 backend tests: nullable demand size, org-wide feasibility & redaction, in-window direct commit, requester view privacy, and legacy verbal reply compatibility."""

import json
from collections.abc import Generator
from datetime import date, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlmodel import Session, col, delete, select

from app.api.main import include_playwright_fixtures
from app.authz.principal import ActorKind, Principal
from app.core.config import settings
from app.domains.audit.models import AuditEvent
from app.domains.base import utc_now
from app.domains.bot import core, prompts, store
from app.domains.bot import schemas as bot_schemas
from app.domains.bot import tools as bot_tools
from app.domains.bot.models import BotSession
from app.domains.capacity import proposal
from app.domains.capacity.calendar import WeekLoad
from app.domains.capacity.demand_schemas import PlanReplyDemandInput, ProposalLineInput
from app.domains.capacity.forecast import refresh_org_forecasts
from app.domains.capacity.models import (
    AssignmentStatus,
    CapacityApproval,
    CapacityAssignment,
    CapacityDemand,
    CapacityDemandDependency,
    CapacityDemandEvent,
    CapacityProject,
    CapacityProposal,
    CapacityProposalLine,
    CapacitySetting,
    CapacityUnavailability,
    CapacityWeek,
    CapacityWeekForecast,
    DemandEventKind,
    DemandOutcome,
    DemandStatus,
    ForecastSource,
    ProposalStatus,
)
from app.domains.im.rendering import render
from app.domains.inbox.models import InboxItem, InboxKind
from app.domains.model.pi_client import TurnResult
from app.domains.org.models import OrgMembership
from app.domains.planning import feasibility
from app.domains.planning.feasibility import assess_cross_department_feasibility
from app.domains.planning.models import PlanningCase, PlanningOption, PlanningSnapshot
from app.domains.planning.schemas import (
    CrossDeptFeasibilityInput,
    ExtraCapabilityFeasibilityInput,
)
from app.domains.profile.models import ProfileVersion
from tests.api.routes.test_m7_planning_readonly import business_rows
from tests.api.routes.test_m7_planning_validator import _publish_initial_profile
from tests.api.routes.test_m8_coordination_tools import assert_no_b_people
from tests.api.routes.test_m9_proposal import (
    case as case,
)
from tests.api.routes.test_m9_proposal import (
    plan,
    proposal_row,
    propose,
    respond,
    rows,
    segments,
)
from tests.api.routes.test_m9_proposal import planning_setup as planning_setup
from tests.domains.test_bot_core import enable
from tests.domains.test_im_gateway import principal


@pytest.fixture(autouse=True)
def _e52_cleanup(case: tuple, db: Session) -> Generator[None]:
    yield
    org_id = case[3].org_id
    demand_id = case[3].id
    db.rollback()
    root_demand = db.get(CapacityDemand, demand_id)
    if root_demand is not None and root_demand.project_id is not None:
        root_demand.project_id = root_demand.role_name = None
        db.add(root_demand)
        db.flush()
    cleanup_models: tuple[Any, ...] = (
        CapacityDemandDependency,
        CapacityDemandEvent,
        CapacityAssignment,
        CapacityApproval,
        CapacityProposalLine,
        CapacityProposal,
        PlanningOption,
        PlanningSnapshot,
        PlanningCase,
        CapacityDemand,
        CapacityProject,
        CapacityUnavailability,
        CapacityWeekForecast,
        InboxItem,
        AuditEvent,
    )
    for model in cleanup_models:
        stmt = delete(model).where(col(model.org_id) == org_id)
        if model is CapacityDemand:
            stmt = stmt.where(col(CapacityDemand.id) != demand_id)
        db.exec(stmt)
    db.commit()


@pytest.mark.parametrize(
    ("start", "end", "read_weeks"),
    [
        (30, 60, 25),
        (0, 181, 42),
        (0, 182, None),
        (2200 * 7, 2200 * 7 + 6, None),
        (date.max, date.max, None),
    ],
    ids=["month", "last-supported-day", "long-span", "far-start", "date-max"],
)
def test_feasibility_window_limits_in_api_and_assistant(
    case: tuple,
    db: Session,
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    start: int | date,
    end: int | date,
    read_weeks: int | None,
) -> None:
    url, people, auth, demand = case
    current_week = demand.window_start
    window_start = (
        current_week + timedelta(days=start) if isinstance(start, int) else start
    )
    window_end = current_week + timedelta(days=end) if isinstance(end, int) else end
    _publish_initial_profile(
        client, url, auth["admin"], people["E04"], demand.capability_key
    )
    calendar_loads = feasibility.loads
    reads: list[int] = []

    def record_loads(
        session: Session,
        org_id: UUID,
        employee_ids: list[UUID],
        from_week: date,
        weeks: int,
    ) -> dict[UUID, list[WeekLoad]]:
        assert read_weeks is not None
        assert (from_week, weeks) == (current_week - timedelta(weeks=4), read_weeks)
        reads.append(weeks)
        return calendar_loads(session, org_id, employee_ids, from_week, weeks)

    monkeypatch.setattr(feasibility, "loads", record_loads)
    args = {
        "capability_key": demand.capability_key,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
    }
    response = client.post(f"{url}/planning/feasibility", headers=auth["a"], json=args)
    requester = principal(db, demand.org_id, people["E01"].id)
    session = store.create_session(db, requester, channel="web")
    bot_result = bot_tools.call(
        db,
        requester,
        session,
        [],
        "coordination",
        {"function": "assess_cross_department_feasibility", "arguments": args},
    )
    if read_weeks is None:
        assert response.status_code == 422, response.text
        detail = response.json()["detail"]
        assert "从本周起的 26 周内" in detail
        assert bot_result == {"error": detail}
        assert reads == []
    else:
        assert response.status_code == 200, response.text
        db.commit()
        after_bot_response = client.post(
            f"{url}/planning/feasibility", headers=auth["a"], json=args
        )
        assert after_bot_response.status_code == 200, after_bot_response.text
        assert bot_result == after_bot_response.json()
        assert reads == [read_weeks, read_weeks, read_weeks]
        target = next(
            row
            for row in response.json()["departments"]
            if row["department_id"] == str(demand.target_department_id)
        )
        assert target["conclusion"] == "can_do"
        assert target["suggested_start_date"] == window_start.isoformat()
        assert target["suggested_end_date"] == window_end.isoformat()


def test_nullable_demand_size_single_and_project(
    case: tuple, client: TestClient
) -> None:
    url, people, auth, demand = case
    payload = {
        "requesting_department_id": str(people["E01"].department_id),
        "target_department_id": str(demand.target_department_id),
        "capability_key": demand.capability_key,
        "window_start": demand.window_start.isoformat(),
        "window_end": demand.window_end.isoformat(),
        "description": "不填人数和投入比例的跨部门协作需求",
    }
    created = client.post(f"{url}/capacity/demands", headers=auth["a"], json=payload)
    assert created.status_code == 200, created.text
    created_data = created.json()
    assert created_data["headcount"] is None
    assert created_data["allocation_percent"] is None

    bad = client.post(
        f"{url}/capacity/demands",
        headers=auth["a"],
        json={**payload, "headcount": 0},
    )
    assert bad.status_code == 422

    project_resp = client.post(
        f"{url}/capacity/projects",
        headers=auth["a"],
        json={
            "title": "无固定人数协同项目",
            "description": "包含不填与填写人数的角色",
            "requesting_department_id": str(people["E01"].department_id),
            "roles": [
                {
                    "role_name": "前端协同",
                    "target_department_id": str(demand.target_department_id),
                    "capability_key": demand.capability_key,
                    "window_start": demand.window_start.isoformat(),
                    "window_end": demand.window_end.isoformat(),
                    "description": "无需预设人数与比例",
                },
                {
                    "role_name": "定编角色",
                    "target_department_id": str(demand.target_department_id),
                    "capability_key": demand.capability_key,
                    "headcount": 1,
                    "allocation_percent": 40,
                    "window_start": demand.window_start.isoformat(),
                    "window_end": demand.window_end.isoformat(),
                    "description": "保留历史定编字段",
                },
            ],
        },
    )
    assert project_resp.status_code == 200, project_resp.text
    project_detail = client.get(
        f"{url}/capacity/projects/{project_resp.json()['id']}", headers=auth["a"]
    )
    assert project_detail.status_code == 200, project_detail.text
    roles = project_detail.json()["roles"]
    assert roles[0]["demand"]["headcount"] is None
    assert roles[0]["demand"]["allocation_percent"] is None
    assert roles[1]["demand"]["headcount"] == 1
    assert roles[1]["demand"]["allocation_percent"] == 40


@pytest.mark.parametrize(
    ("confirmation", "percent", "conclusion"),
    [
        ("missing", 30, "can_do"),
        ("stale", 30, "later"),
        ("confirmed", 60, "can_do"),
        ("confirmed", 61, "later"),
    ],
)
def test_feasibility_estimates_without_relaxing_formal_weekly_capacity(
    case: tuple,
    db: Session,
    client: TestClient,
    confirmation: str,
    percent: int,
    conclusion: str,
) -> None:
    url, people, auth, demand = case
    person = people["E04"]
    _publish_initial_profile(client, url, auth["admin"], person, demand.capability_key)
    manager = principal(db, demand.org_id, people["E05"].id)
    assert manager.user_id is not None
    second_week = demand.window_start + timedelta(weeks=1)
    record = db.exec(
        select(CapacityWeek).where(
            CapacityWeek.org_id == demand.org_id,
            CapacityWeek.employee_id == person.id,
            CapacityWeek.week_start == second_week,
        )
    ).one()
    if confirmation == "missing":
        db.delete(record)
    if confirmation == "stale":
        record.confirmed_at = utc_now() - timedelta(days=29)
        record.other_percent = 45
        db.add(record)
    later = demand.window_start + timedelta(weeks=2)
    for week in (later, later + timedelta(weeks=1)):
        db.add(
            CapacityWeek(
                org_id=demand.org_id,
                employee_id=person.id,
                week_start=week,
                other_percent=10,
                confirmed_by_user_id=manager.user_id,
            )
        )
    hold = CapacityProposal(
        org_id=demand.org_id,
        demand_id=demand.id,
        source_option_id=uuid4(),
        demand_revision=demand.revision,
        proposed_by_user_id=manager.user_id,
        hold_expires_at=utc_now() + timedelta(hours=1),
    )
    db.add(hold)
    db.flush()
    db.add(
        CapacityProposalLine(
            org_id=demand.org_id,
            proposal_id=hold.id,
            employee_id=person.id,
            allocation_percent=30,
            start_date=demand.window_start,
            end_date=demand.window_end,
        )
    )
    db.commit()

    lines = [
        ProposalLineInput(
            employee_id=person.id,
            allocation_percent=percent,
            start_date=demand.window_start,
            end_date=demand.window_end,
        )
    ]
    if confirmation == "confirmed" and conclusion == "can_do":
        proposal.check_lines(manager, db, demand, lines)
    else:
        with pytest.raises(proposal.ProposalConflict) as error:
            proposal.check_lines(manager, db, demand, lines)
        assert error.value.detail["message"] == (
            "请先确认这些周的容量"
            if confirmation != "confirmed"
            else "这些周的安排超过可用容量"
        )
    db.rollback()
    response = client.post(
        f"{url}/planning/feasibility",
        headers=auth["a"],
        json={
            "capability_key": demand.capability_key,
            "window_start": demand.window_start.isoformat(),
            "window_end": demand.window_end.isoformat(),
            "estimated_allocation_percent": percent,
        },
    )
    assert response.status_code == 200, response.text
    target = next(
        row
        for row in response.json()["departments"]
        if row["department_id"] == str(demand.target_department_id)
    )
    assert target["conclusion"] == conclusion
    assert target["has_likely_availability"] is (conclusion == "can_do")
    if confirmation != "confirmed":
        assert target["is_estimated"] is True
    expected_elastic = confirmation == "confirmed" and percent >= 60
    assert target["needs_elastic"] is expected_elastic
    assert target["data_source"] == "mixed"
    start = demand.window_start if conclusion == "can_do" else later
    assert (
        target["earliest_start_date"],
        target["suggested_start_date"],
        target["suggested_end_date"],
    ) == (
        start.isoformat(),
        start.isoformat(),
        (start + timedelta(days=13)).isoformat(),
    )


@pytest.mark.parametrize(
    ("confirmed_loads", "shift", "expected"),
    [
        ((70, 75, 75), 0, (61, 11, 28, "medium", False, "later", True, True, "mixed")),
        ((50, 65, 67), 0, (50, 20, 30, "low", True, "can_do", True, True, "mixed")),
        (
            (50, 65, 67),
            3,
            (10, 60, 30, "low", True, "can_do", True, False, "forecast_baseline"),
        ),
        (
            (75, 80, 85),
            4,
            (9, 61, 30, "low", True, "can_do", True, False, "forecast_baseline"),
        ),
        (
            (),
            0,
            (
                None,
                None,
                None,
                "unknown",
                None,
                "needs_confirmation",
                False,
                False,
                "unknown",
            ),
        ),
    ],
)
def test_feasibility_estimates_load_from_all_active_department_members(
    case: tuple,
    db: Session,
    client: TestClient,
    confirmed_loads: tuple[int, ...],
    shift: int,
    expected: tuple[
        int | None, int | None, int | None, str, bool | None, str, bool, bool, str
    ],
) -> None:
    url, people, auth, demand = case
    candidate = people["E07"]
    for code in ("E04", "E05", "E06", "E07"):
        people[code].department_id = demand.target_department_id
        db.add(people[code])
    db.exec(delete(CapacityWeek).where(CapacityWeek.org_id == demand.org_id))
    for code, percent in zip(("E04", "E05", "E06"), confirmed_loads, strict=False):
        db.add(
            CapacityWeek(
                org_id=demand.org_id,
                employee_id=people[code].id,
                week_start=demand.window_start - timedelta(weeks=1 if shift else 0),
                other_percent=percent,
                confirmed_by_user_id=demand.requester_user_id,
            )
        )
    db.commit()
    refresh_org_forecasts(db, demand.org_id)
    db.commit()
    _publish_initial_profile(
        client, url, auth["admin"], candidate, demand.capability_key
    )

    response = client.post(
        f"{url}/planning/feasibility",
        headers=auth["a"],
        json={
            "capability_key": demand.capability_key,
            "window_start": (demand.window_start + timedelta(weeks=shift)).isoformat(),
            "window_end": (demand.window_end + timedelta(weeks=shift)).isoformat(),
            "estimated_allocation_percent": 30,
        },
    )
    assert response.status_code == 200, response.text
    target = next(
        row
        for row in response.json()["departments"]
        if row["department_id"] == str(demand.target_department_id)
    )
    assert (
        target["department_load_percent"],
        target["regular_headroom_percent"],
        target["elastic_headroom_percent"],
        target["load_level"],
        target["has_likely_availability"],
        target["conclusion"],
        target["is_estimated"],
        target["needs_elastic"],
        target["data_source"],
    ) == expected
    if target["conclusion"] == "later":
        assert (
            target["earliest_start_date"]
            == (demand.window_start + timedelta(weeks=1)).isoformat()
        )
    elif target["conclusion"] == "can_do":
        assert (
            target["earliest_start_date"]
            == (demand.window_start + timedelta(weeks=shift)).isoformat()
        )
    if target["conclusion"] == "needs_confirmation":
        assert target["earliest_start_date"] is None
        assert target["suggested_start_date"] is None
        assert target["suggested_end_date"] is None


@pytest.mark.parametrize(
    "blocker", ["none", "assignment", "hold", "leave", "confirmed", "stale"]
)
def test_january_feasibility_respects_known_weekly_load(
    case: tuple,
    db: Session,
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    blocker: str,
) -> None:
    url, people, auth, demand = case
    current = date(2026, 11, 23)
    start = date(2027, 1, 1)
    first_week = date(2026, 12, 28)
    last_day = first_week + timedelta(weeks=12, days=6)
    monkeypatch.setattr(feasibility, "this_week", lambda *_: current)
    org_id = demand.org_id
    user_id = demand.requester_user_id
    employee_id = people["E04"].id
    _publish_initial_profile(
        client, url, auth["admin"], people["E04"], demand.capability_key
    )
    db.exec(delete(CapacityWeek).where(CapacityWeek.org_id == org_id))
    for code, percent in (("E04", 80), ("E05", 85)):
        db.add(
            CapacityWeek(
                org_id=org_id,
                employee_id=people[code].id,
                week_start=current,
                other_percent=percent,
                confirmed_by_user_id=user_id,
            )
        )
    if blocker == "assignment":
        db.add(
            CapacityAssignment(
                org_id=org_id,
                employee_id=employee_id,
                demand_id=demand.id,
                allocation_percent=100,
                start_date=first_week,
                due_date=last_day,
                assigned_by_user_id=user_id,
            )
        )
    elif blocker == "hold":
        hold = CapacityProposal(
            org_id=org_id,
            demand_id=demand.id,
            source_option_id=uuid4(),
            demand_revision=demand.revision,
            proposed_by_user_id=user_id,
            hold_expires_at=utc_now() + timedelta(hours=1),
        )
        db.add(hold)
        db.flush()
        db.add(
            CapacityProposalLine(
                org_id=org_id,
                proposal_id=hold.id,
                employee_id=employee_id,
                allocation_percent=100,
                start_date=first_week,
                end_date=last_day,
            )
        )
    elif blocker == "leave":
        db.add(
            CapacityUnavailability(
                org_id=org_id,
                employee_id=employee_id,
                start_date=first_week,
                end_date=last_day,
                created_by_user_id=user_id,
            )
        )
    elif blocker in ("confirmed", "stale"):
        for offset in range(13):
            db.add(
                CapacityWeek(
                    org_id=org_id,
                    employee_id=employee_id,
                    week_start=first_week + timedelta(weeks=offset),
                    other_percent=100,
                    confirmed_by_user_id=user_id,
                    confirmed_at=utc_now()
                    - timedelta(days=29 if blocker == "stale" else 0),
                )
            )
    db.commit()

    response = client.post(
        f"{url}/planning/feasibility",
        headers=auth["a"],
        json={
            "capability_key": demand.capability_key,
            "window_start": start.isoformat(),
            "window_end": start.isoformat(),
        },
    )
    assert response.status_code == 200, response.text
    target = next(
        row
        for row in response.json()["departments"]
        if row["department_id"] == str(demand.target_department_id)
    )
    if blocker == "none":
        assert target["conclusion"] == "can_do"
        assert target["earliest_start_date"] == "2027-01-01"
        assert target["department_load_percent"] == 83
        assert target["regular_used_percent"] == 70
        assert target["elastic_used_percent"] == 13
        assert target["regular_headroom_percent"] == 0
        assert target["elastic_headroom_percent"] == 18
        assert target["exceeds_regular_cap"] is True
        assert target["needs_elastic"] is True
        assert target["data_source"] == "forecast_baseline"
        assert target["is_estimated"] is True
    else:
        assert target["conclusion"] == "cannot_do"
        assert target["earliest_start_date"] is None
        assert target["department_load_percent"] > 0


def test_feasibility_uses_org_cap_forecast_priority_and_withholds_single_source(
    case: tuple, db: Session, client: TestClient
) -> None:
    url, people, auth, demand = case
    org_id = demand.org_id
    _publish_initial_profile(
        client, url, auth["admin"], people["E04"], demand.capability_key
    )
    setting = db.exec(
        select(CapacitySetting).where(CapacitySetting.org_id == org_id)
    ).one()
    setting.default_allocation_cap_percent = 80
    db.add(setting)
    db.exec(delete(CapacityWeek).where(CapacityWeek.org_id == org_id))
    db.add(
        CapacityWeek(
            org_id=org_id,
            employee_id=people["E04"].id,
            week_start=demand.window_start,
            other_percent=60,
            confirmed_by_user_id=demand.requester_user_id,
        )
    )
    db.commit()
    refresh_org_forecasts(db, org_id)
    db.commit()

    far_week = demand.window_start + timedelta(weeks=6)
    args = {
        "capability_key": demand.capability_key,
        "window_start": far_week.isoformat(),
        "window_end": far_week.isoformat(),
        "estimated_allocation_percent": 15,
    }
    # Only E04 has an independent CapacityWeek (no department fallback for E05/E06 with < 2 colleagues) -> withheld!
    withheld_resp = client.post(
        f"{url}/planning/feasibility", headers=auth["a"], json=args
    )
    assert withheld_resp.status_code == 200, withheld_resp.text
    assert withheld_resp.json()["allocation_cap_percent"] == 80
    withheld_target = next(
        row
        for row in withheld_resp.json()["departments"]
        if row["department_id"] == str(demand.target_department_id)
    )
    assert withheld_target["load_level"] == "withheld"
    assert withheld_target["department_load_percent"] is None
    assert withheld_target["regular_used_percent"] is None
    assert withheld_target["elastic_used_percent"] is None
    assert withheld_target["regular_headroom_percent"] is None
    assert withheld_target["elastic_headroom_percent"] is None
    assert withheld_target["data_source"] == "forecast_baseline"
    assert withheld_target["conclusion"] == "can_do"
    assert withheld_target["exceeds_regular_cap"] is False
    assert withheld_target["needs_elastic"] is False

    # manager_override on E04 (75%), E05 (65%), and E06 (70%) gives independent sources and overrides E04's agent_auto.
    for code, pct in (("E04", 75), ("E05", 65), ("E06", 70)):
        row = db.exec(
            select(CapacityWeekForecast).where(
                CapacityWeekForecast.org_id == org_id,
                CapacityWeekForecast.employee_id == people[code].id,
                CapacityWeekForecast.week_start == far_week,
            )
        ).one_or_none()
        if row is None:
            row = CapacityWeekForecast(
                org_id=org_id,
                employee_id=people[code].id,
                week_start=far_week,
                forecast_other_percent=pct,
                source=ForecastSource.MANAGER_OVERRIDE,
                basis_summary="经理手动修正",
                updated_by_user_id=demand.requester_user_id,
            )
        else:
            row.forecast_other_percent = pct
            row.source = ForecastSource.MANAGER_OVERRIDE
            row.basis_summary = "经理手动修正"
            row.updated_by_user_id = demand.requester_user_id
        db.add(row)
    db.commit()

    override_resp = client.post(
        f"{url}/planning/feasibility", headers=auth["a"], json=args
    )
    assert override_resp.status_code == 200, override_resp.text
    override_target = next(
        row
        for row in override_resp.json()["departments"]
        if row["department_id"] == str(demand.target_department_id)
    )
    assert override_target["department_load_percent"] == 70
    assert override_target["regular_used_percent"] == 70
    assert override_target["elastic_used_percent"] == 0
    assert override_target["regular_headroom_percent"] == 10  # mean(5, 15, 10)
    assert override_target["elastic_headroom_percent"] == 20
    assert override_target["load_level"] == "high"
    assert override_target["data_source"] == "forecast_baseline"
    assert override_target["exceeds_regular_cap"] is False
    assert override_target["needs_elastic"] is True

    # Confirmed CapacityWeek on E04 overrides manager_override and makes regular cap sufficient.
    db.add(
        CapacityWeek(
            org_id=org_id,
            employee_id=people["E04"].id,
            week_start=far_week,
            other_percent=50,
            confirmed_by_user_id=demand.requester_user_id,
        )
    )
    db.commit()
    confirmed_resp = client.post(
        f"{url}/planning/feasibility", headers=auth["a"], json=args
    )
    assert confirmed_resp.status_code == 200, confirmed_resp.text
    confirmed_target = next(
        row
        for row in confirmed_resp.json()["departments"]
        if row["department_id"] == str(demand.target_department_id)
    )
    assert confirmed_target["department_load_percent"] == 62  # mean(50, 65, 70)
    assert confirmed_target["regular_used_percent"] == 62
    assert confirmed_target["elastic_used_percent"] == 0
    assert confirmed_target["regular_headroom_percent"] == 18  # mean(30, 15, 10)
    assert confirmed_target["elastic_headroom_percent"] == 20
    assert confirmed_target["data_source"] == "mixed"
    assert confirmed_target["exceeds_regular_cap"] is False
    assert confirmed_target["needs_elastic"] is False


@pytest.mark.parametrize("single_member", [False, True])
def test_feasibility_withheld_suppresses_needs_elastic_even_when_elastic_needed(
    case: tuple,
    db: Session,
    client: TestClient,
    single_member: bool,
) -> None:
    url, people, auth, demand = case
    org_id = demand.org_id
    _publish_initial_profile(
        client, url, auth["admin"], people["E04"], demand.capability_key
    )
    if single_member:
        for code in ("E05", "E06"):
            if people[code].department_id == demand.target_department_id:
                people[code].employment_status = "inactive"
                db.add(people[code])
    db.exec(delete(CapacityWeek).where(CapacityWeek.org_id == org_id))
    db.exec(delete(CapacityWeekForecast).where(CapacityWeekForecast.org_id == org_id))
    # Only E04 has confirmed 60% load; 20% demand fits only in elastic space (60+20=80 > 70).
    db.add(
        CapacityWeek(
            org_id=org_id,
            employee_id=people["E04"].id,
            week_start=demand.window_start,
            other_percent=60,
            confirmed_by_user_id=demand.requester_user_id,
        )
    )
    db.commit()

    args = {
        "capability_key": demand.capability_key,
        "window_start": demand.window_start.isoformat(),
        "window_end": demand.window_start.isoformat(),
        "estimated_allocation_percent": 20,
    }
    resp = client.post(f"{url}/planning/feasibility", headers=auth["a"], json=args)
    assert resp.status_code == 200, resp.text
    target = next(
        row
        for row in resp.json()["departments"]
        if row["department_id"] == str(demand.target_department_id)
    )
    assert target["conclusion"] == "can_do"
    assert target["load_level"] == "withheld"
    assert target["department_load_percent"] is None
    assert target["regular_used_percent"] is None
    assert target["elastic_used_percent"] is None
    assert target["regular_headroom_percent"] is None
    assert target["elastic_headroom_percent"] is None
    assert target["exceeds_regular_cap"] is False
    assert target["needs_elastic"] is False

    requester = principal(db, org_id, people["E01"].id)
    bot_session = store.create_session(db, requester, channel="web")
    cards: list[bot_schemas.Message] = []
    bot_result = bot_tools.call(
        db,
        requester,
        bot_session,
        cards,
        "coordination",
        {"function": "assess_cross_department_feasibility", "arguments": args},
    )
    assert bot_result == resp.json()
    (card,) = cards
    assert isinstance(card, bot_schemas.FeasibilityCard)
    item = next(
        d for d in card.departments if d.department_name == target["department_name"]
    )
    assert item.load_level == "withheld"
    assert item.needs_elastic is False
    rendered, _ = render(card)
    assert "需动用弹性空间" not in rendered


def test_feasibility_does_not_extrapolate_beyond_26_week_horizon(
    case: tuple,
    db: Session,
    client: TestClient,
) -> None:
    url, people, auth, demand = case
    org_id = demand.org_id
    current = demand.window_start
    _publish_initial_profile(
        client, url, auth["admin"], people["E04"], demand.capability_key
    )
    db.exec(delete(CapacityWeek).where(CapacityWeek.org_id == org_id))
    db.exec(delete(CapacityWeekForecast).where(CapacityWeekForecast.org_id == org_id))
    week_25 = current + timedelta(weeks=24)
    week_26 = current + timedelta(weeks=25)
    target_members = [
        p for p in people.values() if p.department_id == demand.target_department_id
    ]
    for member in target_members:
        db.add(
            CapacityWeek(
                org_id=org_id,
                employee_id=member.id,
                week_start=current,
                other_percent=10,
                confirmed_by_user_id=demand.requester_user_id,
            )
        )
        db.add(
            CapacityWeek(
                org_id=org_id,
                employee_id=member.id,
                week_start=week_25,
                other_percent=100,
                confirmed_by_user_id=demand.requester_user_id,
            )
        )
        db.add(
            CapacityWeek(
                org_id=org_id,
                employee_id=member.id,
                week_start=week_26,
                other_percent=100,
                confirmed_by_user_id=demand.requester_user_id,
            )
        )
    db.commit()

    # Target window in week 26 (offset 25) is full; shifted search lands on week 27+ (beyond 26w horizon).
    beyond_resp = client.post(
        f"{url}/planning/feasibility",
        headers=auth["a"],
        json={
            "capability_key": demand.capability_key,
            "window_start": week_26.isoformat(),
            "window_end": (week_26 + timedelta(days=6)).isoformat(),
            "estimated_allocation_percent": 30,
        },
    )
    assert beyond_resp.status_code == 200, beyond_resp.text
    beyond_target = next(
        row
        for row in beyond_resp.json()["departments"]
        if row["department_id"] == str(demand.target_department_id)
    )
    assert beyond_target["conclusion"] == "needs_confirmation"
    assert beyond_target["has_likely_availability"] is None
    assert beyond_target["earliest_start_date"] is None
    assert beyond_target["suggested_start_date"] is None
    assert beyond_target["suggested_end_date"] is None
    assert beyond_target["data_source"] == "confirmed"

    # Inside the 26-week horizon (week 25 full -> shift into week 26), recent mean fallback still applies.
    db.exec(
        delete(CapacityWeek).where(
            CapacityWeek.org_id == org_id,
            CapacityWeek.week_start == week_26,
        )
    )
    db.commit()
    within_resp = client.post(
        f"{url}/planning/feasibility",
        headers=auth["a"],
        json={
            "capability_key": demand.capability_key,
            "window_start": week_25.isoformat(),
            "window_end": (week_25 + timedelta(days=6)).isoformat(),
            "estimated_allocation_percent": 30,
        },
    )
    assert within_resp.status_code == 200, within_resp.text
    within_target = next(
        row
        for row in within_resp.json()["departments"]
        if row["department_id"] == str(demand.target_department_id)
    )
    assert within_target["conclusion"] == "later"
    assert within_target["earliest_start_date"] == week_26.isoformat()
    assert within_target["is_estimated"] is True
    assert within_target["data_source"] == "mixed"


def test_cross_dept_feasibility_and_capacity_reference_redaction(
    case: tuple, client: TestClient, db: Session
) -> None:
    url, people, auth, demand = case
    org_id = demand.org_id
    start = demand.window_start
    end = demand.window_end

    dictionary = client.get(f"{url}/capabilities", headers=auth["admin"]).json()
    capability = next(
        item for item in dictionary["data"] if item["key"] == demand.capability_key
    )
    for code in ("E04", "E05", "E07"):
        db.add(
            ProfileVersion(
                org_id=org_id,
                subject_employee_id=people[code].id,
                revision=1,
                published_at=utc_now(),
                schema_version_id=UUID(dictionary["schema_version"]["id"]),
                published_by={"actor_type": "system_worker"},
                snapshot={
                    "claims": [
                        {
                            "id": str(uuid4()),
                            "capability_definition_id": capability["id"],
                            "statement": "SYNTHETIC_CLAIM",
                            "level": "routine",
                            "assessment_status": "confirmed",
                            "confidence": None,
                            "explanation": None,
                            "generated_by": {"actor_type": "user"},
                            "evidence": [],
                        }
                    ]
                },
            )
        )

    # Overload target dept during [start, end], free starting start + 14 days
    for code in ("E04", "E05"):
        for week in (start, start + timedelta(days=7)):
            row = db.exec(
                select(CapacityWeek).where(
                    CapacityWeek.org_id == org_id,
                    CapacityWeek.employee_id == people[code].id,
                    CapacityWeek.week_start == week,
                )
            ).one()
            row.other_percent = 90
            db.add(row)
        for later_offset in (14, 21):
            db.add(
                CapacityWeek(
                    org_id=org_id,
                    employee_id=people[code].id,
                    week_start=start + timedelta(days=later_offset),
                    other_percent=0,
                    confirmed_by_user_id=demand.requester_user_id,
                )
            )
    for week in (start, start + timedelta(weeks=1)):
        db.add(
            CapacityWeek(
                org_id=org_id,
                employee_id=people["E06"].id,
                week_start=week,
                other_percent=90,
                confirmed_by_user_id=demand.requester_user_id,
            )
        )
    # Give E07 leave in first 2 weeks in external dept so we can verify unavailability too
    e07 = people["E07"]
    db.add(
        CapacityUnavailability(
            org_id=org_id,
            employee_id=e07.id,
            start_date=start,
            end_date=end,
            reason="休假",
            created_by_user_id=demand.requester_user_id,
        )
    )
    db.commit()

    before = business_rows(db, org_id)
    args = {
        "capability_key": demand.capability_key,
        "minimum_level": demand.minimum_level,
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "estimated_headcount": 1,
        "estimated_allocation_percent": 50,
    }
    feasibility_resp = client.post(
        f"{url}/planning/feasibility", headers=auth["a"], json=args
    )
    assert feasibility_resp.status_code == 200, feasibility_resp.text
    # Read-only REST feasibility endpoint must not write any capacity_* or audit tables.
    assert business_rows(db, org_id) == before

    requester = principal(db, org_id, people["E01"].id)
    bot_session = store.create_session(db, requester, channel="web")
    definitions = bot_tools.definitions(requester, db=db)
    assert len(definitions) <= 29
    tool = next(item for item in definitions if item.name == "coordination")
    assert (
        "assess_cross_department_feasibility"
        in tool.parameters["properties"]["function"]["enum"]
    )
    prompt = prompts.system_prompt(db, requester, "web")
    assert "默认跨全企业" in prompt
    assert "不问人数或投入比例" in prompt
    assert "预测基线由系统基于历史排期与在途工作自动估算参考" in prompt
    assert "需动用弹性空间" in prompt
    cards: list[bot_schemas.Message] = []
    arguments = {
        "function": "assess_cross_department_feasibility",
        "arguments": args,
    }
    bot_result = bot_tools.call(
        db, requester, bot_session, cards, "coordination", arguments
    )
    assert bot_result == feasibility_resp.json()
    after_bot = business_rows(db, org_id)
    assert {k: v for k, v in after_bot.items() if k != "capacity_week_forecast"} == {
        k: v for k, v in before.items() if k != "capacity_week_forecast"
    }
    (card,) = cards
    assert isinstance(card, bot_schemas.FeasibilityCard)
    assert card.capability_name == demand.capability_name
    assert card.allocation_cap_percent == 70
    assert (card.window_start, card.window_end) == (start, end)
    assert len(card.departments) < len(feasibility_resp.json()["departments"])
    bot_tools.call(db, requester, bot_session, cards, "coordination", arguments)
    assert cards == [card] and cards[0] is not card

    raw = feasibility_resp.text
    for forbidden in (
        *(person.display_name for person in people.values()),
        *(str(person.id) for person in people.values()),
        '"count"',
        '"available"',
        '"full"',
        '"overloaded"',
        '"unconfirmed"',
        "estimated_headcount",
        "estimated_allocation_percent",
    ):
        assert forbidden not in raw, (
            f"Leaked {forbidden} in feasibility response: {raw}"
        )

    payload = feasibility_resp.json()
    assert set(payload) == {
        "capability_key",
        "window_start",
        "window_end",
        "allocation_cap_percent",
        "departments",
    }
    assert payload["allocation_cap_percent"] == 70
    depts = {d["department_id"]: d for d in payload["departments"]}
    target_dept_result = depts[str(demand.target_department_id)]
    assert all(
        set(dept)
        == {
            "department_id",
            "department_name",
            "conclusion",
            "earliest_start_date",
            "suggested_start_date",
            "suggested_end_date",
            "department_load_percent",
            "regular_used_percent",
            "elastic_used_percent",
            "regular_headroom_percent",
            "elastic_headroom_percent",
            "load_level",
            "has_likely_availability",
            "is_estimated",
            "exceeds_regular_cap",
            "needs_elastic",
            "data_source",
        }
        for dept in depts.values()
    )
    assert target_dept_result["conclusion"] == "later"
    assert target_dept_result["department_load_percent"] == 90
    assert target_dept_result["regular_used_percent"] == 70
    assert target_dept_result["elastic_used_percent"] == 20
    assert target_dept_result["regular_headroom_percent"] == 0
    assert target_dept_result["elastic_headroom_percent"] == 10
    assert target_dept_result["load_level"] == "very_high"
    assert target_dept_result["has_likely_availability"] is False
    assert target_dept_result["is_estimated"] is False
    assert target_dept_result["exceeds_regular_cap"] is True
    assert target_dept_result["needs_elastic"] is False
    assert target_dept_result["data_source"] == "confirmed"
    assert (
        target_dept_result["earliest_start_date"]
        == (start + timedelta(days=14)).isoformat()
    )
    assert (
        target_dept_result["suggested_start_date"]
        == (start + timedelta(days=14)).isoformat()
    )
    assert (
        target_dept_result["suggested_end_date"]
        == (start + timedelta(days=27)).isoformat()
    )

    # Empty capability/level that nobody meets -> cannot_do across departments
    a_principal = Principal(
        org_id=org_id,
        user_id=demand.requester_user_id,
        employee_id=people["E01"].id,
        actor_type=ActorKind.USER,
        is_org_admin=False,
        managed_department_ids=frozenset({people["E01"].department_id}),
    )
    none_result = assess_cross_department_feasibility(
        a_principal,
        db,
        CrossDeptFeasibilityInput(
            capability_key=demand.capability_key,
            extra_capabilities=[
                ExtraCapabilityFeasibilityInput(
                    key="non_existent_extra_cap", required=True
                )
            ],
            window_start=start,
            window_end=end,
            estimated_headcount=1,
            estimated_allocation_percent=50,
        ),
    )
    assert all(d.conclusion == "cannot_do" for d in none_result.departments)
    assert all(d.earliest_start_date is None for d in none_result.departments)
    assert all(
        d.department_load_percent is None
        and d.load_level == "unknown"
        and d.has_likely_availability is False
        and not d.is_estimated
        for d in none_result.departments
    )
    arguments["arguments"]["extra_capabilities"] = [
        {"key": "non_existent_extra_cap", "required": True}
    ]
    bot_tools.call(db, requester, bot_session, cards, "coordination", arguments)
    assert not cards

    # Check GET /capacity/reference redaction vs target manager detailed view
    ref_params = {
        "target_department_id": str(demand.target_department_id),
        "capability_key": demand.capability_key,
    }
    req_ref = client.get(
        f"{url}/capacity/reference", params=ref_params, headers=auth["a"]
    )
    assert req_ref.status_code == 200, req_ref.text
    assert set(req_ref.json()) == {"department_name", "capability_name", "conclusion"}
    assert "count" not in req_ref.json()

    mgr_ref = client.get(
        f"{url}/capacity/reference", params=ref_params, headers=auth["b"]
    )
    assert mgr_ref.status_code == 200, mgr_ref.text
    assert {
        "department_name",
        "capability_name",
        "count",
        "available",
        "full",
        "overloaded",
        "unconfirmed",
    } <= set(mgr_ref.json())


def test_nullable_demand_flexible_planning_and_in_window_direct_commit(
    case: tuple, client: TestClient, db: Session
) -> None:
    url, people, auth, base_demand = case
    created = client.post(
        f"{url}/capacity/demands",
        headers=auth["a"],
        json={
            "requesting_department_id": str(people["E01"].department_id),
            "target_department_id": str(base_demand.target_department_id),
            "capability_key": base_demand.capability_key,
            "minimum_level": base_demand.minimum_level,
            "window_start": base_demand.window_start.isoformat(),
            "window_end": base_demand.window_end.isoformat(),
            "description": "无固定人数需求走窗内直接生效",
        },
    )
    assert created.status_code == 200, created.text
    demand_id = UUID(created.json()["id"])
    demand_row = db.get(CapacityDemand, demand_id)
    assert demand_row is not None

    # Target manager creates planning case and customizes 2 people with mixed percentages inside window
    case_resp = client.post(
        f"{url}/planning/demands/{demand_id}/cases", headers=auth["b"]
    )
    assert case_resp.status_code == 200, case_resp.text
    case_json = case_resp.json()
    assert case_json["options"], (
        "Starter options must be generated even when demand size is None"
    )

    custom_option = client.post(
        f"{url}/planning/cases/{case_json['id']}/options",
        headers=auth["b"],
        json={
            "assignees": [
                {
                    "employee_id": str(people["E04"].id),
                    "allocation_percent": 30,
                    "start_date": demand_row.window_start.isoformat(),
                    "end_date": (
                        demand_row.window_start + timedelta(days=6)
                    ).isoformat(),
                },
                {
                    "employee_id": str(people["E05"].id),
                    "allocation_percent": 60,
                    "start_date": (
                        demand_row.window_start + timedelta(days=7)
                    ).isoformat(),
                    "end_date": demand_row.window_end.isoformat(),
                },
            ]
        },
    )
    assert custom_option.status_code == 200, custom_option.text
    opt_data = custom_option.json()
    assert opt_data["verdict"] in ("feasible", "conditional")
    finding_codes = {f["code"] for f in opt_data["findings"]}
    assert "headcount_gap" not in finding_codes
    assert "reduced_allocation" not in finding_codes
    assert "reduced_headcount" not in finding_codes

    # Confirming in-window internal plan directly commits in same transaction!
    reply = client.post(
        f"{url}/capacity/demands/{demand_id}/reply",
        headers=auth["b"],
        json={
            "option_id": opt_data["id"],
            "outcome": "can_do",
            "text": "本部门内部排期确认承接",
            "revision": demand_row.revision,
            "outside_basis": True,
        },
    )
    assert reply.status_code == 200, reply.text
    reply_data = reply.json()
    assert reply_data["status"] == "accepted"
    assert reply_data["committed_start_date"] == demand_row.window_start.isoformat()
    assert reply_data["committed_end_date"] == demand_row.window_end.isoformat()
    assert reply_data["proposal"]["status"] == "committed"
    assert reply_data["proposal"]["committed_at"] is not None

    # Assignments immediately active in DB
    assignments = list(
        db.exec(
            select(CapacityAssignment).where(
                CapacityAssignment.org_id == demand_row.org_id,
                CapacityAssignment.demand_id == demand_id,
                CapacityAssignment.status == AssignmentStatus.ACTIVE,
            )
        ).all()
    )
    assert len(assignments) == 2

    events = [
        e.kind
        for e in db.exec(
            select(CapacityDemandEvent)
            .where(CapacityDemandEvent.demand_id == demand_id)
            .order_by(col(CapacityDemandEvent.created_at))
        ).all()
    ]
    assert DemandEventKind.REPLIED in events
    assert DemandEventKind.COMMITTED in events

    inbox_messages = list(
        db.exec(
            select(InboxItem).where(
                InboxItem.org_id == demand_row.org_id,
                InboxItem.kind == InboxKind.CAPACITY,
            )
        ).all()
    )
    requester_msgs = [
        m.message
        for m in inbox_messages
        if m.recipient_user_id == demand_row.requester_user_id
    ]
    assert any("需求已接收并排期生效" in msg for msg in requester_msgs)
    assert not any("决定下一步" in msg for msg in requester_msgs)

    # Requester view redacts headcount, allocation_percents, participants, lines, and provides schedule_phases
    req_view = client.get(f"{url}/capacity/demands/{demand_id}", headers=auth["a"])
    assert req_view.status_code == 200, req_view.text
    req_json = req_view.json()
    req_prop = req_json["proposal"]
    assert req_prop["headcount"] is None
    assert req_prop["allocation_percents"] == []
    assert req_prop["participants"] == []
    assert "lines" not in req_prop
    assert req_prop["schedule_phases"] == [
        {
            "start_date": demand_row.window_start.isoformat(),
            "end_date": (demand_row.window_start + timedelta(days=6)).isoformat(),
        },
        {
            "start_date": (demand_row.window_start + timedelta(days=7)).isoformat(),
            "end_date": demand_row.window_end.isoformat(),
        },
    ]
    for code in ("E04", "E05"):
        assert people[code].display_name not in req_view.text
        assert str(people[code].id) not in req_view.text

    # Target manager view retains complete internal details
    mgr_view = client.get(f"{url}/capacity/demands/{demand_id}", headers=auth["b"])
    assert mgr_view.status_code == 200, mgr_view.text
    mgr_prop = mgr_view.json()["proposal"]
    assert mgr_prop["headcount"] == 2
    assert mgr_prop["allocation_percents"] == [30, 60]
    assert len(mgr_prop["lines"]) == 2
    assert len(mgr_prop["participants"]) == 2


def test_bot_confirm_plan_reply_in_window_direct_commit(
    case: tuple, client: TestClient, db: Session
) -> None:
    url, people, auth, demand = case
    case_resp = client.post(
        f"{url}/planning/demands/{demand.id}/cases", headers=auth["b"]
    )
    assert case_resp.status_code == 200
    opt = plan(client, case, segments(case, percent=40))
    mgr_member = db.exec(
        select(OrgMembership).where(
            OrgMembership.org_id == demand.org_id,
            OrgMembership.employee_id == people["E05"].id,
        )
    ).one()
    mgr_p = Principal(
        org_id=demand.org_id,
        user_id=mgr_member.user_id,
        employee_id=people["E05"].id,
        actor_type=ActorKind.USER,
        is_org_admin=False,
        managed_department_ids=frozenset({demand.target_department_id}),
    )
    session = store.create_session(db, mgr_p, channel="feishu")
    assert session is not None
    result = bot_tools.confirm_plan_reply(
        mgr_p,
        db,
        PlanReplyDemandInput(
            demand_id=demand.id,
            option_id=UUID(opt["id"]),
            outcome=DemandOutcome.CAN_DO,
            revision=demand.revision,
            text="飞书确认窗内排期",
            outside_basis=True,
            start_date=demand.window_start,
            end_date=demand.window_end,
        ),
        via="feishu",
        client_name="feishu",
    )
    db.commit()
    assert result.status == DemandStatus.ACCEPTED
    assert result.proposal is not None
    assert result.proposal.status == ProposalStatus.COMMITTED


@pytest.mark.parametrize("response", [None, "accept", "follow_up"])
def test_bot_plan_card_and_requester_schedule(
    case: tuple, db: Session, response: str | None
) -> None:
    _, people, _, row = case
    manager = principal(db, row.org_id, people["E05"].id)
    requester = principal(db, row.org_id, people["E01"].id)
    proposed_end = row.window_end
    row.headcount, row.allocation_percent = None, None
    if response:
        row.window_end -= timedelta(days=1)
    project = CapacityProject(
        org_id=row.org_id,
        requesting_department_id=row.requesting_department_id,
        requester_user_id=row.requester_user_id,
        title="合成协作项目",
        description="合成项目说明",
    )
    db.add(project)
    db.flush()
    row.project_id, row.role_name = project.id, "接口开发"
    db.add(row)
    db.commit()
    manager_session = store.create_session(db, manager, channel="feishu")
    cards: list[bot_schemas.Message] = []
    plan_result = bot_tools.call(
        db,
        manager,
        manager_session,
        cards,
        "coordination",
        {"function": "simulate_plan", "arguments": {"demand_id": str(row.id)}},
    )
    assert "error" not in plan_result, plan_result
    changed = bot_tools.call(
        db,
        manager,
        manager_session,
        cards,
        "coordination",
        {
            "function": "simulate_plan",
            "arguments": {
                "demand_id": str(row.id),
                "assignees": segments(case, split=True),
            },
        },
    )
    assert "error" not in changed, changed
    prepared = bot_tools.call(
        db,
        manager,
        manager_session,
        cards,
        "prepare_plan_proposal",
        {
            "case_id": plan_result["case_id"],
            "option_id": changed["option"]["id"],
            "outside_basis": True,
            "text": "本部门可以交付",
        },
    )
    assert prepared.get("status") == "pending", prepared
    card = cards[-1]
    assert isinstance(card, bot_schemas.CapacityCard)
    assert ("预占 72 小时" if response else "直接生效") in render(card)[0]
    confirmed = confirm_bot_card(db, manager, manager_session, cards, card)
    assert confirmed.status == "confirmed", confirmed.result
    db.refresh(row)
    assert row.status == (DemandStatus.REPLIED if response else DemandStatus.ACCEPTED)

    queries = (
        ("get_demand", {"demand_id": str(row.id)}),
        (
            "coordination",
            {
                "function": "read_coordination_context",
                "arguments": {"demand_id": str(row.id)},
            },
        ),
    )
    for channel in ("feishu", "web"):
        requester_session = store.create_session(db, requester, channel=channel)
        for name, args in queries:
            reading = bot_tools.call(db, requester, requester_session, [], name, args)
            assert_no_b_people(reading, people)
            raw = json.dumps(reading, ensure_ascii=False)
            for forbidden in (
                "本部门可以交付",
                "headcount",
                "allocation_percent",
                "participants",
                "borrow_progress",
            ):
                assert forbidden not in raw
            detail = reading.get("demand", reading)
            assert detail.get("status_label", detail["status"]) == (
                "待确认替代排期" if response else "已接收"
            )
            assert detail["proposal"]["end_date"] == proposed_end.isoformat()
            assert len(detail["proposal"]["schedule_phases"]) == 2

    result = bot_tools.call(
        db,
        requester,
        requester_session,
        [],
        "coordination",
        {"function": "get_project", "arguments": {"project_id": str(project.id)}},
    )
    assert_no_b_people(result, people)
    project_detail = result["roles"][0]["demand"]
    assert len(project_detail["proposal"]["schedule_phases"]) == 2
    assert "allocation_percents" not in project_detail["proposal"]

    if response:
        cards = []
        result = bot_tools.call(
            db,
            requester,
            requester_session,
            cards,
            "prepare_demand_response",
            {
                "demand_id": str(row.id),
                "revision": row.revision,
                "action": response,
                **(
                    {"reason_code": "timing", "text": "替代排期太晚"}
                    if response == "follow_up"
                    else {}
                ),
            },
        )
        assert result.get("status") == "pending", result
        card = cards[-1]
        assert isinstance(card, bot_schemas.CapacityCard)
        text, _ = render(card)
        assert_no_b_people(text, people)
        assert "阶段排期" in text and "30%" not in text and "50%" not in text
        confirmed = confirm_bot_card(db, requester, requester_session, cards, card)
        assert confirmed.status == "confirmed", confirmed.result
        db.refresh(row)

    proposal = rows(db, CapacityProposal, row)[0]
    assert proposal.status == (
        ProposalStatus.FAILED if response == "follow_up" else ProposalStatus.COMMITTED
    )
    assert bool(rows(db, CapacityAssignment, row)) == (response != "follow_up")


def confirm_bot_card(
    db: Session,
    actor: Principal,
    session: BotSession,
    cards: list[bot_schemas.Message],
    card: bot_schemas.CapacityCard,
) -> bot_schemas.CapacityCard:
    store.append_message(
        db,
        session,
        "assistant",
        bot_schemas.TurnResponse(messages=cards).model_dump(mode="json"),
    )
    db.commit()
    result = core.act(db, actor, session.id, card.actions[0]).messages[0]
    assert isinstance(result, bot_schemas.CapacityCard)
    return result


def test_out_of_window_keeps_pending_hold(
    case: tuple, client: TestClient, db: Session
) -> None:
    url, people, auth, demand = case
    out_end = demand.window_end + timedelta(days=7)
    db.add(
        CapacityWeek(
            org_id=demand.org_id,
            employee_id=people["E04"].id,
            week_start=demand.window_start + timedelta(days=14),
            other_percent=0,
            confirmed_by_user_id=demand.requester_user_id,
        )
    )
    db.commit()

    out_lines = [
        {
            "employee_id": str(people["E04"].id),
            "allocation_percent": 50,
            "start_date": demand.window_start.isoformat(),
            "end_date": out_end.isoformat(),
        }
    ]
    option = plan(client, case, out_lines)
    reply = propose(client, case, option)
    assert reply.status_code == 200, reply.text
    reply_json = reply.json()
    assert reply_json["status"] == "replied"
    assert reply_json["proposal"]["status"] == "pending"

    # Rejecting with not_now still requires reason_code
    db.refresh(demand)
    bad_reject = client.post(
        f"{url}/capacity/demands/{demand.id}/respond",
        headers=auth["a"],
        json={"action": "follow_up", "revision": reply_json["revision"]},
    )
    assert bad_reject.status_code == 422


def test_legacy_verbal_replied_demand_compatibility(
    case: tuple, client: TestClient, db: Session
) -> None:
    url, people, auth, demand = case
    # Simulate historical Act 5 demand: status=replied, REPLIED event outcome=can_do, NO CapacityProposal
    demand.status = DemandStatus.REPLIED
    demand.revision = 2
    db.add(demand)
    db.add(
        CapacityDemandEvent(
            org_id=demand.org_id,
            demand_id=demand.id,
            actor_user_id=demand.requester_user_id,
            kind=DemandEventKind.REPLIED,
            outcome=DemandOutcome.CAN_DO,
            start_date=demand.window_start,
            end_date=demand.window_end,
            text="可以配合研发支持",
            via="web",
        )
    )
    db.commit()
    assert rows(db, CapacityProposal, demand) == []

    rejected = respond(client, case, demand.revision)
    assert rejected.status_code == 409, rejected.text
    assert "等待目标部门经理排期" in rejected.json()["detail"]
    db.refresh(demand)
    assert demand.status == DemandStatus.REPLIED and demand.revision == 2
    requester = principal(db, demand.org_id, people["E01"].id)
    for channel in ("web", "feishu"):
        session = store.create_session(db, requester, channel=channel)
        cards: list[bot_schemas.Message] = []
        result = bot_tools.call(
            db,
            requester,
            session,
            cards,
            "prepare_demand_response",
            {
                "action": "accept",
                "revision": demand.revision,
                "demand_id": str(demand.id),
            },
        )
        assert "等待目标部门经理排期" in result["error"]
        assert not cards

    actionable = client.get(
        f"{url}/capacity/demands",
        headers=auth["b"],
        params={"side": "incoming", "actionable_only": True},
    )
    assert actionable.status_code == 200, actionable.text
    assert str(demand.id) in {item["id"] for item in actionable.json()["data"]}

    # Target manager can open planning case and reply with in-window plan directly!
    case_resp = client.post(
        f"{url}/planning/demands/{demand.id}/cases", headers=auth["b"]
    )
    assert case_resp.status_code == 200, case_resp.text
    option = plan(client, case, segments(case))
    reply = propose(client, case, option)
    assert reply.status_code == 200, reply.text
    assert reply.json()["status"] == "accepted"
    assert reply.json()["proposal"]["status"] == "committed"

    # Another legacy REPLIED demand can still go back to submitted via requester follow_up
    created = client.post(
        f"{url}/capacity/demands",
        headers=auth["a"],
        json={
            "requesting_department_id": str(people["E01"].department_id),
            "target_department_id": str(demand.target_department_id),
            "capability_key": demand.capability_key,
            "window_start": demand.window_start.isoformat(),
            "window_end": demand.window_end.isoformat(),
            "description": "待追问的历史口头答复需求",
        },
    ).json()
    legacy2 = db.get(CapacityDemand, UUID(created["id"]))
    assert legacy2 is not None
    legacy2.status = DemandStatus.REPLIED
    legacy2.revision = 2
    db.add(legacy2)
    db.add(
        CapacityDemandEvent(
            org_id=legacy2.org_id,
            demand_id=legacy2.id,
            actor_user_id=legacy2.requester_user_id,
            kind=DemandEventKind.REPLIED,
            outcome=DemandOutcome.PARTIAL,
            text="可部分支持",
            via="web",
        )
    )
    db.commit()
    follow = client.post(
        f"{url}/capacity/demands/{legacy2.id}/respond",
        headers=auth["a"],
        json={"action": "follow_up", "revision": 2, "text": "请进一步确认排期"},
    )
    assert follow.status_code == 200, follow.text
    assert follow.json()["status"] == "submitted"

    # A REPLIED demand with outcome=not_now MUST NOT enter planning
    db.refresh(legacy2)
    legacy2.status = DemandStatus.REPLIED
    legacy2.revision += 1
    db.add(legacy2)
    db.add(
        CapacityDemandEvent(
            org_id=legacy2.org_id,
            demand_id=legacy2.id,
            actor_user_id=legacy2.requester_user_id,
            kind=DemandEventKind.REPLIED,
            outcome=DemandOutcome.NOT_NOW,
            reason_code="capacity",
            text="暂时没有档期",
            created_at=utc_now() + timedelta(seconds=1),
            via="web",
        )
    )
    db.commit()
    blocked_case = client.post(
        f"{url}/planning/demands/{legacy2.id}/cases", headers=auth["b"]
    )
    assert blocked_case.status_code == 404 or blocked_case.status_code == 409


def _verbal_reply(
    db: Session, demand: CapacityDemand, outcome: DemandOutcome, *, seconds: int = 0
) -> None:
    demand.status = DemandStatus.REPLIED
    demand.committed_start_date = demand.window_start
    demand.committed_end_date = demand.window_end
    db.add(demand)
    db.add(
        CapacityDemandEvent(
            org_id=demand.org_id,
            demand_id=demand.id,
            actor_user_id=demand.requester_user_id,
            kind=DemandEventKind.REPLIED,
            outcome=outcome,
            reason_code="capacity" if outcome == DemandOutcome.NOT_NOW else None,
            start_date=demand.window_start,
            end_date=demand.window_end,
            text="合成口头答复",
            created_at=utc_now() + timedelta(seconds=seconds),
            via="web",
        )
    )


def test_legacy_accepted_fixture_requires_test_mode_and_tenant_admin(
    case: tuple, client: TestClient, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    url, _, auth, demand = case
    _verbal_reply(db, demand, DemandOutcome.CAN_DO)
    db.commit()
    path = f"/api/v1/private/orgs/{demand.org_id}/legacy-accepted-demands/{demand.id}"

    def fixture_client() -> TestClient:
        router = APIRouter(prefix="/api/v1")
        include_playwright_fixtures(router)
        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    monkeypatch.setattr(settings, "FASTAPI_ENV", "development")
    monkeypatch.setattr(settings, "PLAYWRIGHT_FIXTURES_ENABLED", False)
    assert fixture_client().post(path, headers=auth["admin"]).status_code == 404

    monkeypatch.setattr(settings, "PLAYWRIGHT_FIXTURES_ENABLED", True)
    monkeypatch.setattr(settings, "FASTAPI_ENV", "production")
    assert fixture_client().post(path, headers=auth["admin"]).status_code == 404

    monkeypatch.setattr(settings, "FASTAPI_ENV", "development")
    with fixture_client() as fixtures:
        assert fixtures.post(path, headers=auth["b"]).status_code == 403
        assert fixtures.post(path, headers=auth["foreign"]).status_code == 404
        db.refresh(demand)
        assert demand.status == DemandStatus.REPLIED and demand.revision == 1
        assert fixtures.post(path, headers=auth["admin"]).status_code == 204
        assert fixtures.post(path, headers=auth["admin"]).status_code == 409
    after = client.get(f"{url}/capacity/demands/{demand.id}", headers=auth["a"])
    assert after.status_code == 200, after.text
    assert after.json()["status"] == "accepted"
    assert after.json()["committed_start_date"] == demand.window_start.isoformat()
    assert after.json()["committed_end_date"] == demand.window_end.isoformat()
    assert after.json()["proposal"] is None
    assert rows(db, CapacityProposal, demand) == []


def test_requester_project_roles_and_demand_list_show_public_schedules(
    case: tuple, client: TestClient, db: Session
) -> None:
    url, people, auth, base = case
    end = base.window_end - timedelta(days=1)
    shared_role = {
        "target_department_id": str(base.target_department_id),
        "capability_key": base.capability_key,
        "window_start": base.window_start.isoformat(),
        "window_end": end.isoformat(),
        "description": "合成排期角色",
    }
    project = client.post(
        f"{url}/capacity/projects",
        headers=auth["a"],
        json={
            "title": "合成排期项目",
            "description": "合成排期项目说明",
            "requesting_department_id": str(base.requesting_department_id),
            "roles": [
                {**shared_role, "role_name": name} for name in ("方案", "口头答复")
            ],
        },
    )
    assert project.status_code == 200, project.text
    project_url = f"{url}/capacity/projects/{project.json()['id']}"
    project_detail = client.get(project_url, headers=auth["a"])
    assert project_detail.status_code == 200, project_detail.text
    role_ids = {row["role_name"]: row["id"] for row in project_detail.json()["roles"]}
    planned_id, verbal_id = role_ids["方案"], role_ids["口头答复"]
    planned = db.get_one(CapacityDemand, UUID(planned_id))
    verbal = db.get_one(CapacityDemand, UUID(verbal_id))
    verbal.window_end = base.window_end
    _verbal_reply(db, verbal, DemandOutcome.CAN_DO)
    db.commit()

    planned_case = url, people, auth, planned
    option = plan(client, planned_case, segments(planned_case, split=True))
    private = "需要协调一人，投入 50%"
    pending = propose(client, planned_case, option, text=private)
    assert pending.status_code == 200, pending.text
    db.refresh(planned)
    row = proposal_row(db, planned)
    expected = {
        "status": "pending",
        "start_date": base.window_start.isoformat(),
        "end_date": base.window_end.isoformat(),
        "schedule_phases": [
            {
                "start_date": segment["start_date"],
                "end_date": segment["end_date"],
            }
            for segment in segments(planned_case, split=True)
        ],
        "hold_expires_at": pending.json()["proposal"]["hold_expires_at"],
    }
    assert pending.json()["status"] == "replied"
    assert pending.json()["events"][-1]["end_date"] == verbal.window_end.isoformat()
    assert pending.json()["events"][-1]["start_date"] == verbal.window_start.isoformat()

    assert pending.json()["proposal"]["conditions"] == private
    assert pending.json()["proposal"]["allocation_percents"] == [30, 50]
    assert pending.json()["proposal"]["headcount"] == 1
    assert pending.json()["events"][-1]["text"] == private

    detail = client.get(f"{url}/capacity/demands/{planned_id}", headers=auth["a"])
    assert detail.status_code == 200, detail.text
    assert private not in json.dumps(detail.json(), ensure_ascii=False)
    summary = detail.json()["proposal"]
    assert summary["conditions"] == "" and summary["allocation_percents"] == []
    assert summary["headcount"] is None
    assert summary["schedule_phases"] == expected["schedule_phases"]

    queries: list[str] = []

    def record_query(*args: Any) -> None:
        if "FROM capacity_proposal" in args[2]:
            queries.append(args[2])

    def read(path: str, viewer: str = "a") -> dict:
        queries.clear()
        event.listen(db.get_bind(), "before_cursor_execute", record_query)
        try:
            response = client.get(path, headers=auth[viewer])
        finally:
            event.remove(db.get_bind(), "before_cursor_execute", record_query)
        assert response.status_code == 200, response.text
        assert len(queries) <= 2, queries
        assert str(people["E04"].id) not in response.text
        assert people["E04"].display_name not in response.text
        assert private not in json.dumps(response.json(), ensure_ascii=False)
        return response.json()

    def check_schedules() -> None:
        listed = {item["id"]: item for item in read(f"{url}/capacity/demands")["data"]}
        assert listed[planned_id]["proposal_schedule"] == expected
        assert listed[verbal_id]["proposal_schedule"] is None
        for field in ("committed_start_date", "committed_end_date"):
            assert listed[planned_id][field] == listed[verbal_id][field]
        for viewer in ("a", "b"):
            roles = {role["id"]: role for role in read(project_url, viewer)["roles"]}
            assert roles[planned_id]["proposal_schedule"] == expected
            assert roles[verbal_id]["proposal_schedule"] is None
            if viewer == "a":
                assert roles[planned_id]["demand"]["proposal_schedule"] == expected
            else:
                assert roles[planned_id]["demand"] is None

    check_schedules()
    assert client.get(project_url, headers=auth["employee"]).status_code == 404
    assert client.get(project_url, headers=auth["foreign"]).status_code == 404

    accepted = respond(client, planned_case, pending.json()["revision"])
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "accepted"
    expected.update(status="committed", hold_expires_at=None)
    check_schedules()

    # A subsequent reply supersedes an ended initial proposal in the detail view.
    db.refresh(planned)
    db.refresh(row)
    row.status = ProposalStatus.WITHDRAWN
    planned.revision = row.demand_revision + 2
    _verbal_reply(db, planned, DemandOutcome.PARTIAL)
    db.add(row)
    db.commit()
    detail = client.get(f"{url}/capacity/demands/{planned_id}", headers=auth["a"])
    assert detail.status_code == 200, detail.text
    assert detail.json()["proposal"] is None
    assert detail.json()["proposal_schedule"] is None
    roles = {role["id"]: role for role in read(project_url)["roles"]}
    assert roles[planned_id]["proposal_schedule"] is None
    listed = {item["id"]: item for item in read(f"{url}/capacity/demands")["data"]}
    assert listed[planned_id]["proposal_schedule"] is None


def test_actionable_demands_include_only_eligible_verbal_replies(
    case: tuple, client: TestClient, db: Session
) -> None:
    url, people, auth, demand = case
    manager = db.exec(
        select(OrgMembership).where(
            OrgMembership.org_id == demand.org_id,
            OrgMembership.employee_id == people["E05"].id,
        )
    ).one()

    def add(**changes: Any) -> CapacityDemand:
        row = CapacityDemand(
            **(
                demand.model_dump(exclude={"id", "created_at"})
                | {"status": DemandStatus.REPLIED}
                | changes
            )
        )
        db.add(row)
        return row

    legacy = add()
    _verbal_reply(db, legacy, DemandOutcome.NOT_NOW)
    _verbal_reply(db, legacy, DemandOutcome.PARTIAL, seconds=1)
    rejected = add()
    _verbal_reply(db, rejected, DemandOutcome.CAN_DO)
    _verbal_reply(db, rejected, DemandOutcome.NOT_NOW, seconds=1)
    no_reply = add()
    own = add(requester_user_id=manager.user_id)
    _verbal_reply(db, own, DemandOutcome.CAN_DO)
    outside = add(target_department_id=people["E07"].department_id)
    _verbal_reply(db, outside, DemandOutcome.CAN_DO)
    attached = add(status=DemandStatus.SUBMITTED)
    attached.window_end -= timedelta(days=1)
    db.commit()
    pending = propose(client, (url, people, auth, attached))
    assert pending.status_code == 200, pending.text
    assert pending.json()["proposal"]["status"] == "pending"

    path = f"{url}/capacity/demands"
    incoming = {"side": "incoming"}
    actionable = {**incoming, "actionable_only": "true"}
    visible = client.get(path, params=incoming, headers=auth["b"])
    assert visible.status_code == 200, visible.text
    by_id = {item["id"]: item for item in visible.json()["data"]}
    assert str(outside.id) not in by_id
    for row in (rejected, no_reply, own, attached):
        assert by_id[str(row.id)]["can_reply"] is False
    assert by_id[str(legacy.id)]["can_reply"] is True
    assert by_id[str(demand.id)]["can_reply"] is True
    for skip, expected_rows in enumerate(([str(legacy.id)], [str(demand.id)], [])):
        response = client.get(
            path, params={**actionable, "skip": skip, "limit": 1}, headers=auth["b"]
        )
        assert response.status_code == 200, response.text
        assert response.json() == {
            "count": 2,
            "data": [by_id[row_id] for row_id in expected_rows],
        }
    for row in (legacy, rejected, no_reply, own, attached):
        detail = client.get(f"{path}/{row.id}", headers=auth["b"])
        assert detail.status_code == 200, detail.text
        assert detail.json()["can_reply"] == by_id[str(row.id)]["can_reply"]
    for viewer in ("a", "employee"):
        assert client.get(path, params=actionable, headers=auth[viewer]).json() == {
            "count": 0,
            "data": [],
        }
    assert (
        client.get(path, params=actionable, headers=auth["foreign"]).status_code == 404
    )


def test_bot_turn_refreshes_forecast_once_and_protects_override(
    case: tuple,
    db: Session,
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url, people, auth, demand = case
    org_id = demand.org_id
    current_week = demand.window_start
    target_week = current_week + timedelta(weeks=4)
    override_week = current_week + timedelta(weeks=5)
    _publish_initial_profile(
        client, url, auth["admin"], people["E04"], demand.capability_key
    )
    # Seed confirmed load (85%) and initial forecast, plus a manager_override on E05 at override_week.
    for code in ("E04", "E05", "E06"):
        row = db.exec(
            select(CapacityWeek).where(
                CapacityWeek.org_id == org_id,
                CapacityWeek.employee_id == people[code].id,
                CapacityWeek.week_start == current_week,
            )
        ).first()
        if row is None:
            db.add(
                CapacityWeek(
                    org_id=org_id,
                    employee_id=people[code].id,
                    week_start=current_week,
                    other_percent=85,
                    confirmed_by_user_id=demand.requester_user_id,
                )
            )
        else:
            row.other_percent = 85
            db.add(row)
    db.commit()
    refresh_org_forecasts(db, org_id)
    db.commit()

    # Manager overrides E05 at override_week and confirms E04 at target_week; agent refresh must preserve both.
    db.add(
        CapacityWeek(
            org_id=org_id,
            employee_id=people["E04"].id,
            week_start=target_week,
            other_percent=20,
            confirmed_by_user_id=demand.requester_user_id,
        )
    )
    ov = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == people["E05"].id,
            CapacityWeekForecast.week_start == override_week,
        )
    ).one()
    ov.forecast_other_percent = 65
    ov.source = ForecastSource.MANAGER_OVERRIDE
    ov.basis_summary = "经理锁定修正"
    db.add(ov)
    db.commit()

    # Manager lowers current_week workload to 20% via direct DB update (without manual forecast refresh).
    for row in db.exec(
        select(CapacityWeek).where(
            CapacityWeek.org_id == org_id,
            col(CapacityWeek.employee_id).in_(
                [people["E04"].id, people["E05"].id, people["E06"].id]
            ),
            CapacityWeek.week_start == current_week,
        )
    ).all():
        row.other_percent = 20
        db.add(row)
    db.commit()

    refresh_calls = 0
    real_refresh = bot_tools.capacity_forecast.refresh_org_forecasts

    def spy_refresh(session: Session, target_org_id: UUID, **kwargs: Any) -> int:
        nonlocal refresh_calls
        refresh_calls += 1
        return real_refresh(session, target_org_id, **kwargs)

    monkeypatch.setattr(
        bot_tools.capacity_forecast, "refresh_org_forecasts", spy_refresh
    )

    args = {
        "capability_key": demand.capability_key,
        "window_start": target_week.isoformat(),
        "window_end": target_week.isoformat(),
        "estimated_allocation_percent": 30,
    }

    def model(*_args: Any, **kwargs: Any) -> TurnResult:
        # Simulate multi-role assessment within one turn (two sequential calls).
        first = kwargs["on_tool_call"](
            "coordination",
            {"function": "assess_cross_department_feasibility", "arguments": args},
        )
        second = kwargs["on_tool_call"](
            "coordination",
            {"function": "assess_cross_department_feasibility", "arguments": args},
        )
        assert first == second
        return TurnResult(
            text="已完成多角色评估。",
            stop_reason="stop",
            model_calls=1,
            tool_calls=2,
        )

    requester = principal(db, org_id, people["E01"].id)
    enable(db, org_id)
    monkeypatch.setattr(core.pi_client, "run_turn", model)
    bot_session = store.create_session(db, requester, channel="web")
    reply = core.turn(db, requester, bot_session.id, "多角色评估下个月档期")
    assert refresh_calls == 1
    card = next(m for m in reply.messages if isinstance(m, bot_schemas.FeasibilityCard))
    target_item = next(
        d
        for d in card.departments
        if d.department_name == "合成目标部" or d.regular_used_percent is not None
    )
    # 20% at w0 decays at w4 to round_5(20*0.65^4)=5% (plus E04 confirmed 20%), well below stale 55%.
    assert (
        target_item.department_load_percent is not None
        and target_item.department_load_percent <= 20
    )
    assert target_item.exceeds_regular_cap is False

    db.expire_all()
    e05_ov = db.exec(
        select(CapacityWeekForecast).where(
            CapacityWeekForecast.org_id == org_id,
            CapacityWeekForecast.employee_id == people["E05"].id,
            CapacityWeekForecast.week_start == override_week,
        )
    ).one()
    assert e05_ov.source == ForecastSource.MANAGER_OVERRIDE
    assert e05_ov.forecast_other_percent == 65
    e04_conf = db.exec(
        select(CapacityWeek).where(
            CapacityWeek.org_id == org_id,
            CapacityWeek.employee_id == people["E04"].id,
            CapacityWeek.week_start == target_week,
        )
    ).one()
    assert e04_conf.other_percent == 20
