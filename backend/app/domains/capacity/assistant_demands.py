"""Capacity assistant demand preview checks, validation, and confirmation helpers."""

import re
from collections.abc import Callable
from typing import Literal, Protocol
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import BaseModel, Field, JsonValue, model_validator
from pydantic.json_schema import SkipJsonSchema
from sqlmodel import Session, col, select

from app.authz.policies import manages_department
from app.authz.principal import Principal
from app.domains.bot import schemas as s
from app.domains.capability.service import get_schema, list_capabilities
from app.domains.capacity import demand, proposal
from app.domains.capacity.common import (
    CapacityConflict,
    CapacityForbidden,
    CapacityNotFound,
    employee,
)
from app.domains.capacity.demand_schemas import (
    DemandInput,
    DemandPublic,
    PlanReplyDemandInput,
    ReplyInput,
    RespondDemandInput,
)
from app.domains.capacity.models import (
    DemandOutcome,
    DemandStatus,
    ProposalStatus,
)
from app.domains.capacity.schemas import REASON_LABELS, Via
from app.domains.org.models import Department, Employee
from app.domains.org.timezone import read_timezone
from app.i18n import tr

RESPONSES = {"accept": "接受", "follow_up": "追问", "withdraw": "撤回"}
DEMAND_REPLY_REASON_GUIDANCE = (
    "必需能力未知或未确认时，未知不等于不会。暂时不能承接时须用 reason_code=other（其他）"
    "并说明待核实的能力。reason_code=skill（能力不匹配）只用于已核实的等级差距足以导致"
    "符合必需能力等级的人数不足的情况；服务端会核对当前已确认画像。"
    "仅凭需求依据中没有匹配结果，不能选择 skill。"
)
DEMAND_REPLY_PLAN_GUIDANCE = (
    "普通答复请省略 option_id、outside_basis、lender_department_id 和 borrow_headcount；"
    "仅提交实际方案时使用 prepare_plan_proposal 生成确认卡"
)
SKILL_REPLY_TEXT = "根据已确认的画像等级核对，达到必需能力等级要求的人数不足。"
SKILL_REPLY_UNVERIFIED = "当前依据无法核实能力不匹配，请选择「其他」并说明待核实的能力"

DemandField = Literal[
    "requesting_department_id",
    "target_department_id",
    "capability_key",
    "minimum_level",
    "window_start",
    "window_end",
    "description",
]

STAFFING_FIELDS = {"headcount", "allocation_percent"}
STAFFING_TEXT = re.compile(
    r"人数|人头|几人|几个人|多少人|人手|每人投入|投入比|投入\s*\d|"
    r"\d+(?:\.\d+)?\s*[%％]|\d+\s*(?:名|位|个)?\s*(?:员工|人员|人)(?![工员])"
)
PRIVATE_TEXT = re.compile(
    r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
    r"|[\w.+-]+@[\w.-]+|https?://|员工编号|工号|员工\s*id|个人负荷|周负荷|其他工作占比|"
    r"平台分配|超负荷|满负荷|(?:负荷|可用容量|余量)[^。；，,\n]{0,12}\d",
    re.IGNORECASE,
)


class ChangeOnWeb(CapacityConflict):
    def __init__(self) -> None:
        super().__init__()
        self.detail = "请在网页发起或确认变更"


class DraftTextInvalid(HTTPException):
    def __init__(self, detail: str) -> None:
        super().__init__(422, detail)


class DemandDepartmentForbidden(CapacityForbidden):
    def __init__(self, departments: list[Department]) -> None:
        super().__init__()
        self.detail = tr(
            "需求方部门只能选择：{names}",
            names=tr("、").join(d.name for d in departments),
        )


def validate_draft_text(db: Session, p: Principal, text: str, error: str) -> None:
    names = db.exec(select(Employee.display_name).where(Employee.org_id == p.org_id))
    prose = text.casefold()
    if (
        STAFFING_TEXT.search(prose)
        or PRIVATE_TEXT.search(prose)
        or any(name and name.casefold() in prose for name in names)
    ):
        raise DraftTextInvalid(error)


class PrepareDemandInput(DemandInput):
    headcount: SkipJsonSchema[None] = None
    allocation_percent: SkipJsonSchema[None] = None
    unclear_fields: list[DemandField] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list, max_length=2)

    @model_validator(mode="before")
    @classmethod
    def discard_staffing(cls, data: dict[str, JsonValue]) -> dict[str, JsonValue]:
        if not isinstance(data, dict):
            return data
        result = {
            key: value for key, value in data.items() if key not in STAFFING_FIELDS
        }
        if isinstance(unclear := result.get("unclear_fields"), list):
            result["unclear_fields"] = [
                key
                for key in unclear
                if not isinstance(key, str) or key not in STAFFING_FIELDS
            ]
        if isinstance(questions := result.get("questions"), list):
            result["questions"] = [
                q
                for q in questions
                if not isinstance(q, str) or not STAFFING_TEXT.search(q)
            ]
        return result


def requester_departments(db: Session, p: Principal) -> list[Department]:
    try:
        demand.require_requester(p, db)
    except HTTPException:
        return []
    query = select(Department).where(Department.org_id == p.org_id)
    if not p.is_org_admin:
        ids = p.managed_department_ids
        if not ids:
            department_id = employee(p, db, p.employee_id).department_id
            ids = frozenset({department_id}) if department_id else frozenset()
        query = query.where(col(Department.id).in_(ids))
    return list(db.exec(query.order_by(Department.name, col(Department.id))).all())


def check_demand(
    db: Session, p: Principal, value: BaseModel, unclear: set[str]
) -> tuple[str, list[s.CardField]]:
    body = DemandInput.model_validate(value)
    demand.require_requester(p, db)
    source = demand.department(db, p.org_id, body.requesting_department_id)
    departments = requester_departments(db, p)
    if source.id not in {d.id for d in departments}:
        raise DemandDepartmentForbidden(departments)
    reference = demand.capacity_reference(
        p, db, body.target_department_id, body.capability_key, body.minimum_level
    )
    validate_draft_text(
        db, p, body.description, tr("需求说明只写工作目标、时间和必要条件")
    )
    dictionary = s.Dictionary.model_validate(
        {"data": list_capabilities(db, p.org_id, get_schema(db, p.org_id).id)}
    )
    level = next(
        (
            level.label
            for c in dictionary.data
            if c.key == body.capability_key and c.level_rubric
            for level in c.level_rubric.levels
            if level.key == body.minimum_level
        ),
        tr("未定级"),
    )
    content = tr(
        "需求方：{source}\n目标部门：{target}\n能力：{cap}\n最低等级：{level}\n时间：{start} 至 {end}\n说明：{desc}\n可行性参考不是承诺，以对方部门经理正式答复为准。",
        source=source.name,
        target=reference.department_name,
        cap=reference.capability_name,
        level=level,
        start=body.window_start,
        end=body.window_end,
        desc=body.description,
    )
    values = (
        ("requesting_department_id", tr("需求方"), source.name),
        ("target_department_id", tr("目标部门"), reference.department_name),
        ("capability_key", tr("能力"), reference.capability_name),
        ("minimum_level", tr("最低等级"), level),
        ("window_start", tr("开始日期"), str(body.window_start)),
        ("window_end", tr("结束日期"), str(body.window_end)),
        ("description", tr("说明"), body.description),
    )
    return content, [
        s.CardField(label=label, value=value, unclear=key in unclear)
        for key, label, value in values
    ]


def check_demand_response(
    db: Session, p: Principal, value: BaseModel
) -> tuple[str, s.CardLink | None]:
    body = RespondDemandInput.model_validate(value)
    row = demand.demand_row(p, db, body.demand_id)
    if p.user_id is None or not (
        row.requester_user_id == p.user_id
        or manages_department(p, row.requesting_department_id)
    ):
        raise CapacityNotFound(demand.DEMAND_NOT_FOUND)
    if (
        row.status == DemandStatus.ACCEPTED
        and proposal.latest(db, p.org_id, row.id, status=ProposalStatus.COMMITTED)
        is not None
    ):
        raise ChangeOnWeb()
    if row.revision != body.revision or row.status in (
        DemandStatus.ACCEPTED,
        DemandStatus.WITHDRAWN,
    ):
        raise CapacityConflict()
    if body.action != "withdraw" and row.status != DemandStatus.REPLIED:
        raise CapacityConflict()
    detail = demand.get_demand(p, db, row.id)
    pending = detail.proposal
    if body.action == "accept" and (
        pending is None or pending.status != ProposalStatus.PENDING
    ):
        raise demand.DemandAwaitingSchedule()
    proposal_text = ""
    detail_link = None
    if pending is not None and pending.status == "pending":
        if body.action == "follow_up":
            demand.require_rejection_reason(body.reason_code, body.text)
        if body.action == "follow_up" and (not body.text or len(body.text) > 500):
            raise proposal.ProposalConflict("拒绝方案时必须填写不超过 500 字的理由")
        detail_link = s.CardLink(
            label=tr("查看需求详情"), href=f"/capacity?tab=outgoing&demand={row.id}"
        )
        timezone = ZoneInfo(read_timezone(db, p.org_id).timezone)
        phases = tr("、").join(
            tr("{start} 至 {end}", start=phase.start_date, end=phase.end_date)
            for phase in pending.schedule_phases
        )
        hint_text = (
            tr("确认后记录需求方接受，原部门经理和员工本人也同意后才生成分配")
            if body.action == "accept" and pending.borrow_progress
            else tr("确认后替代排期生效并生成分配")
            if body.action == "accept"
            else tr("确认后放弃替代排期并释放预占")
            if body.action == "follow_up"
            else tr("确认后撤回需求并释放预占")
        )
        proposal_text = tr(
            "\n状态：待确认替代排期\n开始日期：{start}\n结束日期：{end}{phases}\n请前往需求详情查看状态和排期\n暂留截止：{expires}{hint}",
            start=pending.start_date,
            end=pending.end_date,
            phases=tr("\n阶段排期：{phases}", phases=phases) if phases else "",
            expires=f"{pending.hold_expires_at.astimezone(timezone):%Y-%m-%d %H:%M}",
            hint=f"\n{hint_text}",
        )
    rejecting = (
        pending is not None
        and pending.status == "pending"
        and body.action == "follow_up"
    )
    reason = (
        tr("拒绝原因：{reason}\n", reason=tr(REASON_LABELS[body.reason_code]))
        if rejecting and body.reason_code is not None
        else ""
    )
    if body.text:
        validate_draft_text(
            db, p, body.text, tr("回应说明只写工作目标、日期和必要条件")
        )
    content = (
        tr(
            "需求：{cap}\n操作：{action}\n{reason}说明：{note}\n修订：{revision}",
            cap=detail.capability_name,
            action=tr("拒绝方案") if rejecting else tr(RESPONSES[body.action]),
            reason=reason,
            note=body.text or tr("无"),
            revision=body.revision,
        )
        + proposal_text
    )
    return content, detail_link


def _is_skill_rejection(body: ReplyInput) -> bool:
    return body.outcome == DemandOutcome.NOT_NOW and body.reason_code == "skill"


def _has_proposal_arguments(arguments: dict[str, JsonValue]) -> bool:
    return (
        arguments.get("option_id") is not None
        or arguments.get("outside_basis") is True
        or "lender_department_id" in arguments
        or "borrow_headcount" in arguments
    )


def check_demand_reply(
    db: Session,
    p: Principal,
    value: BaseModel,
    *,
    lock: bool = False,
    direct_commit: bool = False,
) -> str:
    body = PlanReplyDemandInput.model_validate(value)
    row = demand.demand_row(p, db, body.demand_id, lock=lock)
    if not demand.represents_department(p, row.target_department_id):
        raise CapacityNotFound(demand.DEMAND_NOT_FOUND)
    if p.user_id is None or p.user_id == row.requester_user_id:
        raise CapacityForbidden()
    if (
        row.status == DemandStatus.ACCEPTED
        and proposal.latest(db, p.org_id, row.id, status=ProposalStatus.COMMITTED)
        is not None
    ):
        raise ChangeOnWeb()
    if row.revision != body.revision or (
        row.status != DemandStatus.SUBMITTED
        and not (body.option_id and demand.is_legacy_verbal_reply(db, row))
    ):
        raise CapacityConflict()
    if (
        body.option_id is None
        and body.outcome != DemandOutcome.NOT_NOW
        and (row.headcount is None or row.allocation_percent is None)
    ):
        raise proposal.ProposalConflict("请先模拟内部排期，再为可行方案生成确认卡")
    reason = ""
    if body.outcome == DemandOutcome.NOT_NOW:
        demand.require_rejection_reason(body.reason_code, body.text)
        if _is_skill_rejection(body) and not demand.verified_skill_shortage(p, db, row):
            raise demand.RejectionReasonInvalid(tr(SKILL_REPLY_UNVERIFIED))
        if body.reason_code is not None:
            reason = tr(
                "暂不能承接的原因：{reason}\n",
                reason=tr(REASON_LABELS[body.reason_code]),
            )
    description, _, conditions = body.text.partition("\n条件：")
    outcome_label = tr(
        {
            "can_do": "能做",
            "partial": "能做一部分：请核对以下条件",
            "not_now": "暂时不能",
        }[body.outcome]
    )
    content = tr(
        "需求：{cap}\n结论：{outcome}\n承诺日期：{start} 至 {end}\n{reason}条件：{conditions}\n说明：{description}\n修订：{revision}\n",
        cap=row.capability_name,
        outcome=outcome_label,
        start=body.start_date or tr("未定"),
        end=body.end_date or tr("未定"),
        reason=reason,
        conditions=conditions.strip() or tr("无"),
        description=description,
        revision=body.revision,
    )
    if body.lender_department_id is not None:
        lender = demand.department(db, p.org_id, body.lender_department_id)
        content += tr(
            "\n借出部门：{lender} · 借调 {headcount} 人\n确认后通知原部门经理选人，选人后才开始预占。",
            lender=lender.name,
            headcount=body.borrow_headcount,
        )
    elif body.option_id is not None:
        content += tr(
            "排期在需求方窗口内，确认后将直接生效并生成正式分配。"
            if direct_commit
            else "排期超出需求方窗口，确认后将预占 72 小时等待需求方确认。"
        )
        if body.outside_basis:
            content += tr("\n本次明确同意安排需求依据以外的人员")
    else:
        content += tr("确认后把答复发给需求方，不分配人员，不改其他承诺。")
    demand.validate_department_text(p, db, row.target_department_id, content)
    demand.validate_reply_text(p, db, row, body.text)
    return content


class PlanReplyHandler(Protocol):
    def __call__(
        self,
        p: Principal,
        db: Session,
        body: PlanReplyDemandInput,
        *,
        via: Via,
        client_name: str,
    ) -> DemandPublic: ...


def prepare_demand_preview(
    db: Session, p: Principal, arguments: dict[str, JsonValue]
) -> tuple[str, list[s.CardField], list[str], dict[str, JsonValue], s.CardLink | None]:
    preview = PrepareDemandInput.model_validate(arguments)
    body = DemandInput.model_validate(
        preview.model_dump(exclude={"unclear_fields", "questions"})
    )
    content, fields = check_demand(db, p, body, set(preview.unclear_fields))
    validate_draft_text(
        db, p, "\n".join(preview.questions), tr("核对问题只写工作目标、部门或时间")
    )
    return (
        content,
        fields,
        preview.questions,
        body.model_dump(mode="json", exclude=STAFFING_FIELDS),
        None,
    )


def prepare_demand_response_preview(
    db: Session,
    p: Principal,
    arguments: dict[str, JsonValue],
    input_model: type[BaseModel],
) -> tuple[str, list[s.CardField], list[str], dict[str, JsonValue], s.CardLink | None]:
    body = input_model.model_validate(arguments)
    content, detail_link = check_demand_response(db, p, body)
    return content, [], [], body.model_dump(mode="json"), detail_link


def prepare_demand_reply_preview(
    db: Session,
    p: Principal,
    arguments: dict[str, JsonValue],
    input_model: type[BaseModel],
    *,
    plan_reply: bool,
    direct_commit: bool,
) -> tuple[str, list[s.CardField], list[str], dict[str, JsonValue], s.CardLink | None]:
    model = PlanReplyDemandInput if plan_reply else input_model
    body = model.model_validate(arguments)
    if isinstance(body, ReplyInput) and _is_skill_rejection(body):
        body.text = SKILL_REPLY_TEXT
    content = (
        check_demand_reply(db, p, body, direct_commit=direct_commit)
        if plan_reply
        else check_demand_reply(db, p, body)
    )
    return content, [], [], body.model_dump(mode="json"), None


def execute_demand_reply(
    db: Session,
    p: Principal,
    body: BaseModel,
    *,
    plan_reply: bool,
    via: Via,
    client_name: str,
    write_handler: Callable[..., BaseModel],
    on_plan_reply: PlanReplyHandler | None,
    result_title: str,
) -> str:
    if isinstance(body, ReplyInput) and body.outcome == DemandOutcome.NOT_NOW:
        demand.require_rejection_reason(body.reason_code, body.text)
        if _is_skill_rejection(body):
            check_demand_reply(db, p, body, lock=True)
            if body.text != SKILL_REPLY_TEXT:
                raise demand.RejectionReasonInvalid(tr("能力核实说明已更新"))
    if plan_reply:
        if on_plan_reply is None:
            raise RuntimeError("on_plan_reply callback is required")
        result = on_plan_reply(
            p,
            db,
            PlanReplyDemandInput.model_validate(body),
            via=via,
            client_name=client_name,
        )
        if result.proposal is not None:
            status = tr(
                "排期已生效，已生成正式分配"
                if result.proposal.status == ProposalStatus.COMMITTED
                else "替代排期已预占，等待需求方确认"
                if result.proposal.borrow_progress is None
                else "借调方案已发出，请查看审批进度"
            )
            return tr("{status}，编号：{id}", status=status, id=result.id)
        return tr(
            "{result}{over}，编号：{id}",
            result=tr(result_title),
            over="",
            id=result.model_dump(mode="json")["id"],
        )
    write_result = write_handler(
        p, db, **body.model_dump(), via=via, client_name=client_name
    )
    return tr(
        "{result}{over}，编号：{id}",
        result=tr(result_title),
        over="",
        id=write_result.model_dump(mode="json")["id"],
    )


def format_demand_response_result(
    body: BaseModel, result: BaseModel, result_title: str
) -> str:
    if (
        isinstance(body, RespondDemandInput)
        and body.action == "accept"
        and isinstance(result, DemandPublic)
        and result.proposal is not None
        and result.proposal.borrow_progress
    ):
        status = tr(
            proposal.BORROW_COMMITTED
            if result.proposal.status == ProposalStatus.COMMITTED
            else proposal.BORROW_ACCEPTED_PENDING
        )
        return tr("{status}，编号：{id}", status=status, id=result.id)
    return tr(
        "{result}{over}，编号：{id}",
        result=tr(result_title),
        over="",
        id=result.model_dump(mode="json")["id"],
    )
