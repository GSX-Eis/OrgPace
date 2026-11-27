from datetime import date

from app.domains.bot import schemas as s
from app.domains.im.rendering import render


def test_feasibility_card_renders_as_text_without_withheld_load() -> None:
    start = date(2026, 11, 30)
    card = s.FeasibilityCard(
        capability_key="frontend",
        capability_name="前端开发",
        window_start=start,
        window_end=date(2026, 12, 6),
        allocation_cap_percent=70,
        departments=[
            s.FeasibilityDepartmentItem(
                department_name="平台组",
                conclusion="needs_confirmation",
                load_level="withheld",
                department_load_percent=87,
                regular_used_percent=70,
                elastic_used_percent=17,
                regular_headroom_percent=12,
                elastic_headroom_percent=20,
                exceeds_regular_cap=True,
                needs_elastic=True,
            ),
            s.FeasibilityDepartmentItem(
                department_name="前端组",
                conclusion="can_do",
                earliest_start_date=start,
                load_level="high",
                department_load_percent=75,
                regular_used_percent=70,
                elastic_used_percent=5,
                regular_headroom_percent=0,
                elastic_headroom_percent=25,
                is_estimated=True,
                exceeds_regular_cap=True,
                needs_elastic=True,
                data_source="forecast_baseline",
            ),
            s.FeasibilityDepartmentItem(
                department_name="移动组",
                conclusion="can_do",
                earliest_start_date=start,
                load_level="low",
                department_load_percent=40,
                regular_used_percent=40,
                elastic_used_percent=0,
                regular_headroom_percent=30,
                elastic_headroom_percent=30,
                exceeds_regular_cap=False,
                data_source="confirmed",
            ),
        ],
    )
    assert card.departments[0].department_load_percent is None
    assert card.departments[0].regular_used_percent is None
    assert card.departments[0].elastic_used_percent is None
    assert card.departments[0].regular_headroom_percent is None
    assert card.departments[0].elastic_headroom_percent is None
    assert card.departments[0].exceeds_regular_cap is False
    assert card.departments[0].needs_elastic is False
    assert render(card) == (
        "前端开发 · 2026-11-30 至 2026-12-06 · 常规配额 70% / 弹性空间 30%\n"
        "平台组 · 整体负荷暂不展示 · 待部门确认 · 最早可能开始：待目标部门确认\n"
        "前端组 · 整体负荷 75%（常规配额已用 70%/余量 0% · 弹性空间已用 5%/余量 25%）"
        " · 有空承接（预测基线，已突破常规上限（动用弹性 5%），需动用弹性空间）"
        " · 最早可能开始：2026-11-30\n"
        "移动组 · 整体负荷 40%（常规配额已用 40%/余量 30% · 弹性空间已用 0%/余量 30%）"
        " · 有空承接（已确认排期）"
        " · 最早可能开始：2026-11-30\n"
        "提示：预测基线由系统基于历史排期与在途工作自动估算；动用弹性空间需目标部门经理最终确认。",
        [],
    )


def test_legacy_feasibility_card_json_loads_without_error() -> None:
    card = s.FeasibilityCard.model_validate(
        {
            "type": "feasibility_card",
            "capability_key": "testing",
            "capability_name": "测试验证",
            "window_start": "2027-01-01",
            "window_end": "2027-01-07",
            "departments": [
                {
                    "department_name": "测试平台组",
                    "conclusion": "can_do",
                    "load_level": "low",
                    "department_load_percent": 0,
                    "earliest_start_date": "2027-01-01",
                    "is_estimated": True,
                    "unscheduled_beyond_horizon": True,
                }
            ],
        }
    )
    assert card.allocation_cap_percent == 70
    assert card.departments[0].data_source == "unknown"
    text, _ = render(card)
    assert "估算参考" in text


def test_withheld_feasibility_card_hides_elastic_label_and_footer_notice() -> None:
    payload = {
        "type": "feasibility_card",
        "capability_key": "frontend",
        "capability_name": "前端开发",
        "window_start": "2026-11-30",
        "window_end": "2026-12-06",
        "departments": [
            {
                "department_name": "单人组",
                "conclusion": "can_do",
                "load_level": "withheld",
                "department_load_percent": 75,
                "regular_used_percent": 70,
                "elastic_used_percent": 5,
                "regular_headroom_percent": 0,
                "elastic_headroom_percent": 25,
                "earliest_start_date": "2026-11-30",
                "exceeds_regular_cap": True,
                "needs_elastic": True,
                "data_source": "confirmed",
            }
        ],
    }
    card = s.FeasibilityCard.model_validate(payload)
    assert card.departments[0].regular_used_percent is None
    assert card.departments[0].elastic_used_percent is None
    assert card.departments[0].exceeds_regular_cap is False
    assert card.departments[0].needs_elastic is False
    text, _ = render(card)
    assert "已突破常规上限" not in text
    assert "需动用弹性空间" not in text
    assert "动用弹性空间需目标部门经理最终确认" not in text

    # Also verify rendering guard when an unvalidated object still carries needs_elastic=True.
    raw_card = s.FeasibilityCard.model_construct(
        capability_key="frontend",
        capability_name="前端开发",
        window_start=date(2026, 11, 30),
        window_end=date(2026, 12, 6),
        allocation_cap_percent=70,
        departments=[
            s.FeasibilityDepartmentItem.model_construct(
                department_name="单人组",
                conclusion="can_do",
                load_level="withheld",
                earliest_start_date=date(2026, 11, 30),
                exceeds_regular_cap=True,
                needs_elastic=True,
                data_source="confirmed",
            )
        ],
    )
    raw_text, _ = render(raw_card)
    assert "已突破常规上限" not in raw_text
    assert "需动用弹性空间" not in raw_text
    assert "动用弹性空间需目标部门经理最终确认" not in raw_text
