from collections import Counter, defaultdict
from collections.abc import Iterator, Mapping
from datetime import date, timedelta
from typing import Any, Literal, cast

from pydantic import BaseModel

from app.domains.capacity.calendar import WeekLoad, week_start
from app.i18n import tr

Verdict = Literal["feasible", "conditional", "infeasible", "insufficient_data"]
PHASED_APPROVAL = "需求方同意分阶段交付"
EXTRA_CAPABILITY_FINDINGS: dict[tuple[bool, bool | None], tuple[str, Verdict, str]] = {
    (True, False): ("required_capability_below", "infeasible", "必需能力未达标"),
    (True, None): (
        "required_capability_unknown",
        "insufficient_data",
        "必需能力未确认",
    ),
    (False, False): ("optional_capability_below", "feasible", "可选能力未达标"),
    (False, None): ("optional_capability_unknown", "feasible", "可选能力未确认"),
}


class Validation(BaseModel):
    verdict: Verdict
    findings: list[dict[str, Any]]
    summary: dict[str, Any]


def snapshot_caps(data: dict[str, Any]) -> tuple[int, bool]:
    """Read regular allocation cap and elastic mode from snapshot rules with legacy fallback."""
    rules = data.get("rules", {})
    default_cap = rules.get("default_allocation_cap_percent")
    return (
        int(default_cap) if default_cap is not None else 100,
        bool(rules.get("allow_elastic", False)),
    )


def extra_capability_matches(
    demand: dict[str, Any], person: dict[str, Any]
) -> Iterator[tuple[dict[str, Any], bool | None]]:
    published = person.get("extra_levels", {})
    for capability in demand.get("extra_capabilities", []):
        level = published.get(capability["key"])
        minimum = capability["minimum_level"]
        levels = capability["levels"]
        if level is None:
            yield capability, None
        else:
            yield (
                capability,
                minimum is None
                or (
                    level in levels
                    and minimum in levels
                    and levels.index(level) >= levels.index(minimum)
                ),
            )


def effective_other(
    week: Mapping[str, Any] | WeekLoad, *, allow_forecast: bool
) -> tuple[int | None, bool]:
    """Return (other_percent, used_forecast) preferring confirmed over forecast baseline."""
    if isinstance(week, Mapping):
        status = week.get("status")
        other = week.get("other_percent")
        forecast = week.get("forecast_other_percent")
    else:
        status = week.status
        other = week.other_percent
        forecast = week.forecast_other_percent
    if status == "confirmed" and other is not None:
        return int(other), False
    if allow_forecast and forecast is not None:
        return int(forecast), True
    return None, False


def validate(
    data: dict[str, Any],
    params: dict[str, Any],
    *,
    kind: str = "custom",
    phased: bool = False,
    actor_employee_id: str | None = None,
) -> Validation:
    """Validate saved inputs only; no database reads or writes."""
    demand = data["demand"]
    has_extra_capabilities = bool(demand.get("extra_capabilities"))
    primary_name = demand.get("capability_name", tr("主能力"))
    candidates = {p["employee_id"]: p for p in data["candidates"]}
    levels = data["rules"]["levels"]
    current_week = date.fromisoformat(data["rules"]["current_week"])
    default_cap, allow_elastic = snapshot_caps(data)
    effective_actor_id = (
        actor_employee_id
        if actor_employee_id is not None
        else data.get("rules", {}).get("actor_employee_id")
    )
    max_elastic_used = 0
    findings: list[dict[str, Any]] = []
    assignees = params["assignees"]
    conditions: list[str] = []
    newcomer_ids: set[str] = set()
    finish: date | None = None
    allocations: dict[tuple[str, date], int] = {}
    matched_extras: dict[str, list[str]] = {}

    def add(
        code: str,
        level: Verdict,
        message: str,
        *,
        employee_id: str | None = None,
        week: date | None = None,
    ) -> None:
        row: dict[str, Any] = {"code": code, "level": level, "message": message}
        if employee_id is not None:
            row["employee_id"] = employee_id
        if week is not None:
            row["week_start"] = week.isoformat()
        findings.append(row)
        if level == "conditional" and message not in conditions:
            conditions.append(message)

    for assignee in assignees:
        employee_id = assignee["employee_id"]
        start = date.fromisoformat(assignee["start_date"])
        end = date.fromisoformat(assignee["end_date"])
        percent = assignee["allocation_percent"]
        if start > end:
            add(
                "invalid_dates",
                "infeasible",
                tr("开始日期不能晚于结束日期"),
                employee_id=employee_id,
            )
            continue
        finish = max(finish, end) if finish else end
        if (
            start < date.fromisoformat(demand["window_start"])
            or end > date.fromisoformat(demand["window_end"])
            or (
                demand.get("committed_start_date")
                and start < date.fromisoformat(demand["committed_start_date"])
            )
            or (
                demand["committed_end_date"]
                and end > date.fromisoformat(demand["committed_end_date"])
            )
        ):
            add(
                "outside_window",
                "conditional",
                tr("需求方要接受新日期"),
                employee_id=employee_id,
            )
        target_percent = demand.get("allocation_percent")
        if target_percent is not None and percent < target_percent:
            add(
                "reduced_allocation",
                "conditional",
                tr("需求方要同意缩小投入比例"),
                employee_id=employee_id,
            )
        week = week_start(start)
        while week <= week_start(end):
            allocations[(employee_id, week)] = (
                allocations.get((employee_id, week), 0) + percent
            )
            week += timedelta(days=7)
        person = candidates.get(employee_id)
        if has_extra_capabilities and employee_id not in matched_extras:
            matched_extras[employee_id] = []
            unmet: dict[tuple[bool, bool | None], list[str]] = defaultdict(list)
            if person is None or person["level"] is None:
                unmet[True, None].append(primary_name)
            for capability, matches in extra_capability_matches(demand, person or {}):
                name = capability["name"]
                if matches:
                    matched_extras[employee_id].append(name)
                else:
                    unmet[capability["required"], matches].append(name)
            for status, (
                code,
                finding_level,
                message,
            ) in EXTRA_CAPABILITY_FINDINGS.items():
                if names := unmet.get(status):
                    add(
                        code,
                        finding_level,
                        tr(
                            "{message}：{names}",
                            message=tr(message),
                            names=tr("、").join(names),
                        ),
                        employee_id=employee_id,
                    )
        if person is None:
            add(
                "borrow",
                "conditional",
                tr("借调需原部门经理和本人同意"),
                employee_id=employee_id,
            )
            continue
        if person["newcomer"]:
            newcomer_ids.add(employee_id)
        if person["employment_status"] != "active":
            add("inactive", "infeasible", tr("员工已离职"), employee_id=employee_id)
        level = person["level"]
        minimum = demand["minimum_level"]
        if (
            level is not None
            and minimum is not None
            and (
                level not in levels
                or minimum not in levels
                or levels.index(level) < levels.index(minimum)
            )
        ):
            add(
                "level_too_low",
                "infeasible",
                tr("主能力等级低于需求：{name}", name=primary_name)
                if has_extra_capabilities
                else tr("能力等级低于需求"),
                employee_id=employee_id,
            )
        elif not person["in_basis"] and (
            level is not None or not has_extra_capabilities
        ):
            add(
                "outside_basis",
                "conditional",
                tr("画像未记录这项能力，按经理判断"),
                employee_id=employee_id,
            )
    for employee_id, person in candidates.items():
        selected_weeks = [
            WeekLoad.model_validate(w)
            for w in person["weeks"]
            if date.fromisoformat(w["week_start"]) >= current_week
            and (employee_id, date.fromisoformat(w["week_start"])) in allocations
        ]
        allow_forecast = effective_actor_id is None or employee_id != effective_actor_id
        for load in selected_weeks:
            percent = allocations[(employee_id, load.week_start)]
            other, used_forecast = effective_other(load, allow_forecast=allow_forecast)
            if other is None:
                add(
                    "unconfirmed",
                    "insufficient_data",
                    tr("该周容量未确认或需重新确认"),
                    employee_id=employee_id,
                    week=load.week_start,
                )
            elif used_forecast:
                add(
                    "forecast_week",
                    "feasible",
                    tr("该周使用预测基线 {other}%，确认方案后将自动确认", other=other),
                    employee_id=employee_id,
                    week=load.week_start,
                )
            check_other = other if other is not None else load.other_percent
            if check_other is not None:
                regular_cap = min(load.capacity_percent, default_cap)
                elastic_cap = load.capacity_percent
                after = check_other + load.platform_percent + percent
                if after > elastic_cap:
                    add(
                        "over_capacity",
                        "infeasible",
                        tr("该周超出可用容量 {over}%", over=after - elastic_cap),
                        employee_id=employee_id,
                        week=load.week_start,
                    )
                elif after > regular_cap:
                    elastic_over = after - regular_cap
                    if not allow_elastic:
                        add(
                            "over_regular_cap",
                            "infeasible",
                            tr(
                                "该周超出常规配额上限（{cap}%）{over}%，需允许动用弹性空间",
                                cap=regular_cap,
                                over=elastic_over,
                            ),
                            employee_id=employee_id,
                            week=load.week_start,
                        )
                    else:
                        max_elastic_used = max(max_elastic_used, elastic_over)
                        add(
                            "elastic_used",
                            "feasible",
                            tr("已占用弹性配额 {over}%", over=elastic_over),
                            employee_id=employee_id,
                            week=load.week_start,
                        )
        known = {w.week_start for w in selected_weeks}
        for eid, week in allocations:
            if eid == employee_id and week >= current_week and week not in known:
                add(
                    "unconfirmed",
                    "insufficient_data",
                    tr("该周容量没有快照数据"),
                    employee_id=employee_id,
                    week=week,
                )

    gap_person_weeks = 0.0
    target_headcount = demand.get("headcount")
    target_percent = demand.get("allocation_percent")
    if not assignees:
        add("headcount_gap", "infeasible", tr("请至少选择一位员工"))
    if target_headcount is not None:
        covered_headcount = target_headcount
        week = week_start(date.fromisoformat(demand["window_start"]))
        last_week = week_start(date.fromisoformat(demand["window_end"]))
        required = target_headcount
        if demand.get("change") and finish is not None:
            committed_end = date.fromisoformat(
                demand["committed_end_date"] or demand["window_end"]
            )
            if finish < committed_end:
                add("early_finish", "conditional", tr("需求方同意提前结束"))
            last_week = week_start(finish)
            maximum = max(
                Counter(start for _, start in allocations).values(), default=0
            )
            if 0 < maximum < required:
                required = maximum
                add("reduced_headcount", "conditional", tr("需求方同意减少人数"))
        while week <= last_week:
            active = {
                employee_id: percent
                for (employee_id, start), percent in allocations.items()
                if start == week
            }
            covered_headcount = min(covered_headcount, len(active))
            if len(active) < required:
                add(
                    "headcount_gap", "infeasible", tr("该周覆盖人数少于需求"), week=week
                )
            if target_percent is not None:
                gap_person_weeks += (
                    max(
                        target_headcount * target_percent
                        - sum(
                            min(percent, target_percent) for percent in active.values()
                        ),
                        0,
                    )
                    / 100
                )
            week += timedelta(days=7)
    else:
        covered_headcount = len({a["employee_id"] for a in assignees})
        if demand.get("change") and finish is not None:
            committed_end = date.fromisoformat(
                demand["committed_end_date"] or demand["window_end"]
            )
            if finish < committed_end:
                add("early_finish", "conditional", tr("需求方同意提前结束"))
    segments: dict[str, set[tuple[str, str]]] = {}
    for assignee in assignees:
        segments.setdefault(assignee["employee_id"], set()).add(
            (assignee["start_date"], assignee["end_date"])
        )
    periods = sorted({period for parts in segments.values() for period in parts})
    coverage_end = (
        finish.isoformat() if demand.get("change") and finish else demand["window_end"]
    )
    reachable_ends: set[int] = set()
    relay = False
    # Keep all reachable phase ends; parallel work must not hide a relay chain.
    for start_text, end_text in periods:
        start, end = date.fromisoformat(start_text), date.fromisoformat(end_text)
        if start > end:
            continue
        handoff = start.toordinal() - 1 in reachable_ends
        if handoff or start_text <= demand["window_start"]:
            reachable_ends.add(end.toordinal())
            relay = relay or (handoff and end_text >= coverage_end)
    phased = phased or relay or any(len(parts) > 1 for parts in segments.values())
    # The simulator adds its condition after checking the individual phases.
    if phased and kind != "phased":
        add("phased", "conditional", tr(PHASED_APPROVAL))
    if any(f["code"] == "over_capacity" for f in findings):
        max_elastic_used = 0
        findings[:] = [f for f in findings if f["code"] != "elastic_used"]
    severity = {
        "feasible": 0,
        "conditional": 1,
        "insufficient_data": 2,
        "infeasible": 3,
    }
    verdict = cast(
        Verdict,
        max(
            (f["level"] for f in findings), key=severity.__getitem__, default="feasible"
        ),
    )
    affected = [
        assignment["assignment_id"]
        for assignment in data.get("assignments", [])
        if any(
            assignee["employee_id"] == assignment["employee_id"]
            and week_start(date.fromisoformat(assignee["start_date"]))
            <= week_start(date.fromisoformat(assignment["due_date"]))
            and week_start(date.fromisoformat(assignee["end_date"]))
            >= week_start(date.fromisoformat(assignment["counted_from"]))
            for assignee in assignees
        )
    ]
    codes = {finding["code"] for finding in findings}
    approvers = [tr("本部门经理确认答复")]
    if "reduced_headcount" in codes:
        approvers.append(tr("需求方同意减少人数"))
    if "early_finish" in codes:
        approvers.append(tr("需求方同意提前结束"))
    if "outside_window" in codes or kind == "delay":
        approvers.append(tr("需求方接受新日期"))
    if kind == "reduce_scope" or "reduced_allocation" in codes:
        approvers.append(tr("需求方接受缩小范围"))
    if kind == "phased" or phased:
        approvers.append(tr(PHASED_APPROVAL))
    if "borrow" in codes or kind == "borrow":
        approvers.append(tr("原部门经理和被借调员工本人同意"))
    if "outside_basis" in codes:
        approvers.append(tr("经理确认安排依据外人员"))
    return Validation(
        verdict=verdict,
        findings=findings,
        summary={
            "finish_date": finish.isoformat() if finish else None,
            "covered_headcount": covered_headcount,
            "gap_person_weeks": round(gap_person_weeks, 2),
            "conditions": conditions,
            "newcomer_count": len(newcomer_ids),
            "affected_assignment_ids": affected,
            "approvers": approvers,
            "regular_cap_percent": default_cap,
            "uses_elastic": max_elastic_used > 0,
            "elastic_used_percent": max_elastic_used,
            **(
                {"matched_extra_capabilities": matched_extras} if matched_extras else {}
            ),
        },
    )
