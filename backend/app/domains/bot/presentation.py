from datetime import datetime
from math import ceil
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlmodel import Session

from app.authz.principal import Principal
from app.domains.base import utc_now
from app.domains.bot import schemas as s
from app.domains.capacity import demand
from app.domains.capacity.settings import read_settings as read_capacity_settings
from app.domains.review.routing import can_review_any
from app.i18n import current_locale, tr

DEADLINE_MESSAGE = (
    "这次处理超过 3 分钟没完成，已经停止，没有保存任何改动。"
    "材料较多时请分批，例如名单每次 10–20 人、词典每次 20 项左右。"
    "已经上传的附件不用重新上传，直接说『用刚才的名单先建前 10 人』。"
)

_CAPACITY_KEYWORDS = (
    "提需求",
    "新需求",
    "新建需求",
    "发起需求",
    "我提的需求",
    "需求进度",
    "协作需求",
    "跨部门",
    "协调",
    "项目需求",
    "项目草稿",
    "排期",
    "答复需求",
    "借调",
    "人手",
    "能不能接",
    "能不能做",
    "需求",
    "demand",
    "demands",
    "collaboration",
    "cross-department",
    "cross department",
    "feasibility",
    "feasible",
    "project draft",
    "borrow",
    "staffing",
    "schedule",
    "scheduling",
    "capacity",
    "resource",
    "headcount",
)
_REVIEW_KEYWORDS = (
    "待审批",
    "审批",
    "待办",
    "审核",
    "批准",
    "拒绝",
    "驳回",
    "pending review",
    "pending approval",
    "review",
    "reviews",
    "approval",
    "approve",
    "reject",
    "rejection",
)
_WORKLOAD_KEYWORDS = (
    "请假",
    "休假",
    "年假",
    "病假",
    "调休",
    "不可用",
    "负荷",
    "饱和",
    "工时",
    "工作占比",
    "平台外工作",
    "延期",
    "leave",
    "pto",
    "vacation",
    "annual leave",
    "sick leave",
    "time off",
    "unavailable",
    "unavailability",
    "workload",
    "hours",
    "allocation",
    "outside work",
    "off-platform",
    "extension",
    "extend",
    "deadline",
)
_PROFILE_KEYWORDS = (
    "画像",
    "能力",
    "等级",
    "技能",
    "经历",
    "自述",
    "申诉",
    "证据",
    "依据",
    "草稿",
    "修改请求",
    "提交请求",
    "profile",
    "capability",
    "capabilities",
    "skill",
    "skills",
    "level",
    "experience",
    "self-report",
    "self report",
    "appeal",
    "evidence",
    "basis",
    "draft",
    "change request",
    "update request",
    "submit request",
)


def _capacity_links_message(
    db: Session, principal: Principal, message: str, *, reply_only: bool
) -> s.TextMessage:
    links: list[s.CardLink] = []
    if not reply_only:
        try:
            demand.require_requester(principal, db)
        except HTTPException:
            pass
        else:
            links.append(
                s.CardLink(label=tr("我提的需求"), href="/capacity?tab=outgoing")
            )
    if principal.is_org_admin or principal.managed_department_ids:
        links.append(s.CardLink(label=tr("待审批"), href="/reviews?type=demand"))
    lines = [
        message,
        *(
            tr(
                "可以在「规划 → {label}」新建需求：{href}",
                label=link.label,
                href=link.href,
            )
            if link.href.startswith("/capacity")
            else tr("可以在「协同 → 待审批」生成方案和答复：{href}", href=link.href)
            for link in links
        ),
    ]
    return s.TextMessage(text="\n".join(lines), capacity_links=links)


def manual_failure(
    db: Session,
    principal: Principal,
    message: str,
    *,
    intent_text: str = "",
) -> s.TextMessage:
    query = intent_text.strip()
    if not query:
        return s.TextMessage(text=message)
    lowered = query.casefold()
    capacity_enabled = read_capacity_settings(principal, db).enabled
    reply_only = "模拟方案" in query or any(
        k in lowered
        for k in (
            "simulate plan",
            "plan simulation",
            "simulated plan",
            "simulation option",
        )
    )
    if capacity_enabled and (
        reply_only or any(k in lowered for k in _CAPACITY_KEYWORDS)
    ):
        return _capacity_links_message(db, principal, message, reply_only=reply_only)
    if any(k in lowered for k in _REVIEW_KEYWORDS) and can_review_any(db, principal):
        return s.TextMessage(
            text=tr(
                "{message}\n可以在「协同 → 待审批」手动处理：/reviews", message=message
            ),
            review_link="/reviews",
        )
    if capacity_enabled and any(k in lowered for k in _WORKLOAD_KEYWORDS):
        manages = principal.is_org_admin or bool(principal.managed_department_ids)
        if manages and (
            "团队" in query
            or "下属" in query
            or "部门" in query
            or "team" in lowered
            or "subordinate" in lowered
            or "report" in lowered
            or "department" in lowered
            or "member" in lowered
            or principal.employee_id is None
        ):
            link = s.CardLink(label=tr("团队负荷"), href="/capacity?tab=team")
            return s.TextMessage(
                text=tr(
                    "{message}\n可以在「规划 → 团队负荷」手动操作：{href}",
                    message=message,
                    href=link.href,
                ),
                capacity_links=[link],
            )
        if principal.employee_id is not None:
            link = s.CardLink(label=tr("我的负荷"), href="/capacity?tab=mine")
            return s.TextMessage(
                text=tr(
                    "{message}\n可以在「规划 → 我的负荷」手动操作：{href}",
                    message=message,
                    href=link.href,
                ),
                capacity_links=[link],
            )
    if principal.employee_id is not None and any(
        k in lowered for k in _PROFILE_KEYWORDS
    ):
        return s.TextMessage(
            text=tr(
                "{message}\n可以在「组织 → 我的画像」手动操作：/employees/{employee_id}",
                message=message,
                employee_id=principal.employee_id,
            )
        )
    return s.TextMessage(text=message)


def retry_time(retry_at: datetime) -> str:
    now = utc_now()
    local = retry_at.astimezone(ZoneInfo("Asia/Shanghai"))
    if local.date() == now.astimezone(local.tzinfo).date():
        day = ""
    elif current_locale.get() == "en":
        day = f"{local:%b %d} "
    else:
        day = f"{local.month} 月 {local.day} 日 "
    minutes = max(1, ceil((retry_at - now).total_seconds() / 60))
    return tr(
        "北京时间 {day}{time}（约 {minutes} 分钟后）",
        day=day,
        time=f"{local:%H:%M}",
        minutes=minutes,
    )
