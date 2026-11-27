import asyncio
import json
import re
from copy import deepcopy
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, col, delete, select

from app.domains.bot import core, store, tools
from app.domains.bot import schemas as s
from app.domains.capacity import assistant
from app.domains.capacity.calendar import this_week
from app.domains.capacity.models import (
    CapacityDemandEvent,
    CapacitySetting,
    CapacityWeek,
)
from app.domains.im import rendering
from app.domains.im.adapters.feishu import Feishu
from app.domains.model.pi_client import TurnResult
from app.domains.profile.models import ProfileVersion
from tests.api.routes.test_m6_capacity_demand import demand as demand
from tests.api.routes.test_mcp import call, initialize, token_for
from tests.domains.test_bot_core import enable
from tests.domains.test_im_gateway import principal

LIMITED = "该部门具备这项能力的人较少，能否承接请提交需求，由对方部门经理答复"
COUNTS = {"count", "available", "full", "overloaded", "unconfirmed"}


def set_matches(db: Session, case: tuple, count: int) -> None:
    people = case[1]
    for i, code in enumerate(("E04", "E05", "E06", "E07")):
        previous = db.exec(
            select(ProfileVersion).where(
                ProfileVersion.org_id == people[code].org_id,
                ProfileVersion.subject_employee_id == people[code].id,
                ProfileVersion.revision == 99,
            )
        ).one()
        snapshot = deepcopy(previous.snapshot) if i < count else {"claims": []}
        db.add(
            ProfileVersion(
                **previous.model_dump(exclude={"id", "revision", "snapshot"}),
                revision=100,
                snapshot=snapshot,
            )
        )
    db.commit()


def assert_reference(value: dict, count: int, *, own: bool = False) -> None:
    if own:
        assert value["count"] == count
        assert COUNTS.issubset(value)
    else:
        assert set(value) == {"department_name", "capability_name", "conclusion"}
        assert value["conclusion"] == ("cannot_do" if count == 0 else "can_do")
        assert not COUNTS.intersection(value)


@pytest.mark.parametrize(
    ("count", "single_source", "single_member"),
    [(1, False, False), (2, False, False), (1, True, False), (1, True, True)],
)
def test_cross_department_assessment_only_shows_department_information(
    demand: tuple,
    db: Session,
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    count: int,
    single_source: bool,
    single_member: bool,
) -> None:
    url, people, auth, body, _ = demand
    requester = principal(db, people["E01"].org_id, people["E01"].id)
    if single_member:
        for code in ("E06", "E08"):
            people[code].employment_status = "inactive"
            db.add(people[code])
    else:
        people["E05"].department_id = people["E04"].department_id
        db.add(people["E05"])
    current_week = this_week(db, requester.org_id)
    if single_source:
        if not single_member:
            db.exec(
                delete(CapacityWeek).where(
                    CapacityWeek.org_id == requester.org_id,
                    col(CapacityWeek.employee_id).in_(
                        [people["E05"].id, people["E06"].id]
                    ),
                )
            )
        load = db.exec(
            select(CapacityWeek).where(
                CapacityWeek.org_id == requester.org_id,
                CapacityWeek.employee_id == people["E04"].id,
                CapacityWeek.week_start == current_week,
            )
        ).one()
        load.other_percent = 73
        db.add(load)
        db.add(
            CapacityWeek(
                org_id=requester.org_id,
                employee_id=people["E04"].id,
                week_start=current_week - timedelta(weeks=1),
                other_percent=73,
                confirmed_by_user_id=load.confirmed_by_user_id,
            )
        )
    set_matches(db, demand, count)
    week = current_week.isoformat()
    args = {
        "capability_key": body["capability_key"],
        "minimum_level": body["minimum_level"],
        "window_start": week,
        "window_end": week,
        "estimated_headcount": count,
        "estimated_allocation_percent": 20,
    }
    response = client.post(
        f"{url}/planning/feasibility", headers=auth["manager"], json=args
    )
    assert response.status_code == 200, response.text
    assert (
        client.post(
            f"{url}/planning/feasibility", headers=auth["foreign"], json=args
        ).status_code
        == 404
    )
    result = response.json()
    assert set(result) == {
        "capability_key",
        "window_start",
        "window_end",
        "allocation_cap_percent",
        "departments",
    }
    assert result["allocation_cap_percent"] == 70
    for department in result["departments"]:
        assert set(department) == {
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
    target = next(
        row
        for row in result["departments"]
        if row["department_id"] == body["target_department_id"]
    )
    # D-070 allows a department conclusion and date even when exactly one person matches.
    assert target["conclusion"] == "can_do"
    assert target["earliest_start_date"] == week
    assert target["suggested_start_date"] == target["suggested_end_date"] == week
    assert target["department_load_percent"] == (None if single_source else 87)
    assert target["regular_used_percent"] == (None if single_source else 70)
    assert target["elastic_used_percent"] == (None if single_source else 17)
    assert target["regular_headroom_percent"] == (None if single_source else 0)
    assert target["elastic_headroom_percent"] == (None if single_source else 14)
    assert target["load_level"] == ("withheld" if single_source else "high")
    assert target["has_likely_availability"] is True
    assert target["is_estimated"] is (not single_member)
    assert target["exceeds_regular_cap"] is (not single_source)
    assert target["needs_elastic"] is (not single_source)
    assert target["data_source"] == ("confirmed" if single_member else "mixed")
    future = (current_week + timedelta(weeks=4)).isoformat()
    far_response = client.post(
        f"{url}/planning/feasibility",
        headers=auth["manager"],
        json={**args, "window_start": future, "window_end": future},
    )
    assert far_response.status_code == 200, far_response.text
    far_target = next(
        row
        for row in far_response.json()["departments"]
        if row["department_id"] == body["target_department_id"]
    )
    assert far_target["conclusion"] == "can_do"
    assert far_target["earliest_start_date"] == future
    assert far_target["is_estimated"] is True
    assert far_target["exceeds_regular_cap"] is (not single_source)
    assert far_target["needs_elastic"] is (not single_source)
    assert far_target["data_source"] == "forecast_baseline"
    assert far_target["load_level"] == ("withheld" if single_source else "high")
    assert far_target["department_load_percent"] == (None if single_source else 87)
    assert far_target["regular_used_percent"] == (None if single_source else 70)
    assert far_target["elastic_used_percent"] == (None if single_source else 17)
    assert far_target["regular_headroom_percent"] == (None if single_source else 0)
    assert far_target["elastic_headroom_percent"] == (None if single_source else 14)
    private_values = [
        value
        for person in people.values()
        for value in (person.display_name, str(person.id))
    ]
    assert not any(value in response.text for value in private_values)

    def model(*_args: Any, **kwargs: Any) -> TurnResult:
        prompt = kwargs["system_prompt"]
        assert "整体负荷百分比与忙闲程度" in prompt
        assert "load_level 为 withheld 时说明整体负荷暂不展示" in prompt
        assert "目标时段是否可能有人有空" in prompt
        assert (
            "员工 ID、工号、匹配人数、个人负荷明细和估算人数或投入比例均保密" in prompt
        )
        assert "预测基线由系统基于历史排期与在途工作自动估算参考" in prompt
        assert "需动用弹性空间" in prompt
        assessment = kwargs["on_tool_call"](
            "coordination",
            {"function": "assess_cross_department_feasibility", "arguments": args},
        )
        if not single_source:
            # core.turn refreshes agent_auto forecasts (giving E08 a dept fallback of 85% vs unrounded 86.67%).
            assert assessment["departments"]
        else:
            assert assessment == result
        row = next(
            item
            for item in assessment["departments"]
            if item["department_id"] == body["target_department_id"]
        )
        load_summary = (
            "整体负荷暂不展示"
            if row["load_level"] == "withheld"
            else f"整体负荷 {row['department_load_percent']}%（负荷偏高）"
        )
        estimate_note = (
            "预测基线由系统基于历史排期与在途工作自动估算参考，最终以目标部门经理排期为准。"
            if row["is_estimated"]
            else ""
        )
        elastic_note = "需动用弹性空间。" if row["needs_elastic"] else ""
        return TurnResult(
            text=(
                f"{row['department_name']}{load_summary}，"
                f"目标时段可能有人有空，可承接，最早 {row['earliest_start_date']} 开始。"
                f"{elastic_note}{estimate_note}"
            ),
            stop_reason="stop",
            model_calls=1,
            tool_calls=1,
        )

    enable(db, requester.org_id)
    monkeypatch.setattr(core.pi_client, "run_turn", model)
    sessions = []
    for channel in ("web", "feishu"):
        session = store.create_session(db, requester, channel=channel)
        sessions.append(session.id)
        reply = core.turn(db, requester, session.id, "这项工作哪个部门能做？")
        assert len(reply.steps) == 1 and reply.steps[0].ok
        message, card = reply.messages
        assert isinstance(message, s.TextMessage) and isinstance(
            card, s.FeasibilityCard
        )
        text = message.text
        item = next(
            d
            for d in card.departments
            if d.department_name == target["department_name"]
        )
        expected_load = None if single_source else 86
        expected_reg_used = None if single_source else 70
        expected_el_used = None if single_source else 16
        assert item.model_dump(mode="json") == {
            **{key: target[key] for key in s.FeasibilityDepartmentItem.model_fields},
            "department_load_percent": expected_load,
            "regular_used_percent": expected_reg_used,
            "elastic_used_percent": expected_el_used,
        }
        assert not any(value in card.model_dump_json() for value in private_values)
        saved = store.list_messages(db, requester, session.id)[-1].payload
        assert saved == reply.model_dump(mode="json")
        assert target["department_name"] in text and week in text and "可承接" in text
        assert not any(value in text for value in private_values)
        assert "可能有人有空" in text
        if single_source:
            assert "整体负荷暂不展示" in text
            assert "暂无负荷数据" not in text
        else:
            assert "整体负荷 86%（负荷偏高）" in text
        assert ("预测基线由系统基于历史排期与在途工作自动估算参考" in text) is (
            not single_member
        )
        assert ("需动用弹性空间" in text) is (not single_source)
        assert not re.search(r"人数|个人负荷|投入|[0-9一二两]+\s*人", text)
        assert re.findall(r"\d+\s*[%％]", text) == ([] if single_source else ["86%"])

    setting = db.exec(
        select(CapacitySetting).where(CapacitySetting.org_id == requester.org_id)
    ).one()
    setting.enabled = False
    db.commit()
    for session_id in sessions:
        assert store.list_messages(db, requester, session_id)[-1].payload == {
            "messages": [{"type": "text", "text": store.HIDDEN_REPLY}]
        }


@pytest.mark.usefixtures("enable_external_mcp")
@pytest.mark.parametrize("count", [0, 1, 2, 3])
@pytest.mark.parametrize("role,code", [("employee", "E02"), ("manager", "E01")])
def test_references_and_preview_across_channels(
    demand: tuple,
    db: Session,
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    count: int,
    role: str,
    code: str,
) -> None:
    url, people, auth, body, _ = demand
    set_matches(db, demand, count)
    args = {
        k: body[k] for k in ("target_department_id", "capability_key", "minimum_level")
    }
    web = client.get(f"{url}/capacity/reference", params=args, headers=auth[role])
    assert web.status_code == 200, web.text
    p = principal(db, people[code].org_id, people[code].id)
    headers = initialize(client, token_for(db, people[code])[0])
    mcp = call(client, headers, "capacity_reference", args)
    assert not mcp.get("isError"), mcp
    for result in (
        web.json(),
        mcp["structuredContent"],
        assistant.call(db, p, [], "capacity_reference", args),
    ):
        assert_reference(result, count)
    for channel in ("web", "feishu"):
        session = store.create_session(db, p, channel=channel)
        cards = []
        result = tools.call(db, p, session, cards, "prepare_demand", body)
        assert "error" not in result, result
        assert len(cards) == 1 and isinstance(cards[0], s.CapacityCard)
        text, _ = rendering.render(cards[0])
        assert "可行性参考不是承诺" in text
        assert "人数" not in text and "每人投入" not in text
        assert not re.search(r"\d+\s*人", text)
        assert not any(
            word in text for word in ("有余量", "基本满", "超负荷", "未确认")
        )
        if channel == "feishu":

            async def send(preview_text: str) -> list[dict]:
                sent = []
                adapter = Feishu(
                    p.org_id, {"app_id": "synthetic", "app_secret": "synthetic"}
                )

                async def request(_method: str, _path: str, payload: dict) -> dict:
                    sent.append(payload)
                    return {"data": {"message_id": "synthetic"}}

                monkeypatch.setattr(adapter, "_request", request)
                try:
                    await adapter.render("synthetic-chat", preview_text, [])
                finally:
                    await adapter.close()
                return sent

            sent = asyncio.run(send(text))
            assert (
                text == json.loads(sent[0]["content"])["elements"][0]["text"]["content"]
            )
    for own_role in ("b", "admin"):
        own = client.get(
            f"{url}/capacity/reference", params=args, headers=auth[own_role]
        )
        assert own.status_code == 200, own.text
        assert_reference(own.json(), count, own=True)
    assert (
        client.get(
            f"{url}/capacity/reference", params=args, headers=auth["foreign"]
        ).status_code
        == 404
    )


@pytest.mark.usefixtures("enable_external_mcp")
@pytest.mark.parametrize("count", [0, 1, 2, 3])
def test_reply_snapshots_are_filtered_only_on_output(
    demand: tuple,
    db: Session,
    client: TestClient,
    count: int,
) -> None:
    url, people, auth, body, _ = demand
    set_matches(db, demand, count)
    created = client.post(
        f"{url}/capacity/demands", headers=auth["employee"], json=body
    )
    assert created.status_code == 200, created.text
    path = f"{url}/capacity/demands/{created.json()['id']}"
    reply = client.post(
        f"{path}/reply",
        headers=auth["b"],
        json={
            "outcome": "not_now",
            "reason_code": "capacity",
            "text": "合成答复",
            "revision": 1,
        },
    )
    assert reply.status_code == 200, reply.text
    assert_reference(reply.json()["events"][-1]["basis"], count, own=True)
    for role, code in (("employee", "E02"), ("manager", "E01"), ("b", "E05")):
        headers = initialize(client, token_for(db, people[code])[0])
        p = principal(db, people[code].org_id, people[code].id)
        side = "incoming" if role == "b" else "outgoing"
        for name, args, endpoint in (
            ("get_demand", {"demand_id": created.json()["id"]}, path),
            ("list_demands", {"side": side}, f"{url}/capacity/demands?side={side}"),
        ):
            web = client.get(endpoint, headers=auth[role])
            assert web.status_code == 200, web.text
            mcp = call(client, headers, name, args)
            assert not mcp.get("isError"), mcp
            for result in (web.json(), mcp["structuredContent"]):
                row = result["data"][0] if name == "list_demands" else result
                assert_reference(row["events"][-1]["basis"], count, own=role == "b")
            bot = assistant.call(db, p, [], name, args)
            row = bot["data"][0] if name == "list_demands" else bot
            if role == "b":
                assert_reference(row["events"][-1]["basis"], count, own=True)
            else:
                assert "basis" not in row["events"][-1]
                assert row["events"][-1]["outcome"] == "not_now"
    stored = db.exec(
        select(CapacityDemandEvent).where(
            CapacityDemandEvent.org_id == people["E02"].org_id,
            CapacityDemandEvent.kind == "replied",
        )
    ).one()
    assert_reference(stored.basis, count, own=True)
