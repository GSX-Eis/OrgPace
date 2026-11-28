"""Capacity assistant workload, leave, team workload, and extension card helpers."""

from dataclasses import replace

from pydantic import BaseModel
from sqlmodel import Session, select

from app.authz.policies import can_view_employee, manages_department
from app.authz.principal import Principal
from app.domains.capacity.assignment import assignment_rows
from app.domains.capacity.common import (
    CapacityConflict,
    CapacityForbidden,
    CapacityNotFound,
    employee,
)
from app.domains.capacity.extension_schemas import RequestExtensionInput
from app.domains.capacity.models import (
    AssignmentStatus,
    CapacityExtensionRequest,
    CapacityRequestStatus,
)
from app.domains.capacity.schemas import (
    LeaveInput,
    TeamWorkloadInput,
    UnavailabilityInput,
    Via,
    WorkloadRequestInput,
    WorkloadRequestPublic,
    WorkloadWeekItem,
    WorkloadWeeksInput,
)
from app.domains.capacity.workload import (
    get_my_workload,
    register_unavailability,
    set_weeks,
    workload_reviewer_names,
    workload_reviewers,
)
from app.i18n import tr


def check_workload_request(db: Session, p: Principal, value: BaseModel) -> str:
    from app.domains.capacity.workload import validate_request_week

    body = WorkloadRequestInput.model_validate(value)
    if p.user_id is None:
        raise CapacityForbidden()
    current = get_my_workload(p, db)
    validate_request_week(body.end_week, current.weeks[0].week_start)
    if any(r.status == CapacityRequestStatus.PENDING for r in current.requests):
        raise CapacityConflict()
    reviewers = tr("、").join(current.reviewer_names)
    waiting = (
        tr("提交后等待 {reviewers} 审批", reviewers=reviewers)
        if reviewers
        else tr("提交后等待经理审批")
    )
    return tr(
        "申请调整本人负荷\n其他工作占比：{percent}%\n周范围：{start} 至 {end}\n原因：{reason}\n{waiting}",
        percent=body.requested_percent,
        start=body.start_week,
        end=body.end_week,
        reason=body.reason,
        waiting=waiting,
    )


def check_leave(db: Session, p: Principal, value: BaseModel) -> str:
    body = LeaveInput.model_validate(value)
    if p.user_id is None or p.employee_id is None or p.is_org_admin:
        raise CapacityForbidden()
    subject = employee(p, db, p.employee_id)
    reviewers = workload_reviewer_names(p, db, workload_reviewers(p, db, subject.id))
    notify_text = (
        tr("并通知 {reviewers}", reviewers=tr("、").join(reviewers))
        if reviewers
        else tr("并通知部门经理")
    )
    return tr(
        "请假（登记不可用日期）\n日期：{start} 至 {end}\n确认后直接生效，{notify_text}（通知仅含日期）",
        start=body.start_date,
        end=body.end_date,
        notify_text=notify_text,
    )


def check_team_workload(db: Session, p: Principal, value: BaseModel) -> str:
    body = TeamWorkloadInput.model_validate(value)
    if p.user_id is None or not p.managed_department_ids:
        raise CapacityForbidden()
    scoped = replace(p, is_org_admin=False)
    subject = employee(scoped, db, body.employee_id)
    if not can_view_employee(scoped, subject):
        raise CapacityNotFound()
    if subject.id == scoped.employee_id or not manages_department(
        scoped, subject.department_id
    ):
        raise CapacityForbidden()
    return tr(
        "调整下属周负荷\n员工：{name}\n平台外工作占比：{percent}%\n周范围：{start} 至 {end}\n确认后立即生效并通知本人",
        name=subject.display_name,
        percent=body.other_percent,
        start=body.start_week,
        end=body.end_week,
    )


def check_extension_request(db: Session, p: Principal, value: BaseModel) -> str:
    body = RequestExtensionInput.model_validate(value)
    row, _ = assignment_rows(p, db, body.assignment_id)
    if p.user_id is None or row.employee_id != p.employee_id:
        raise CapacityNotFound()
    if row.status != AssignmentStatus.ACTIVE or body.requested_due_date <= row.due_date:
        raise CapacityConflict()
    pending = db.exec(
        select(CapacityExtensionRequest.id).where(
            CapacityExtensionRequest.org_id == p.org_id,
            CapacityExtensionRequest.assignment_id == row.id,
            CapacityExtensionRequest.status == CapacityRequestStatus.PENDING,
        )
    ).first()
    if pending:
        raise CapacityConflict()
    return tr(
        "申请延期\n分配编号：{id}\n原完成日期：{due}\n申请完成日期：{requested}\n原因：{reason}\n提交后等待经理审批",
        id=row.id,
        due=row.due_date,
        requested=body.requested_due_date,
        reason=body.reason,
    )


def execute_leave(
    p: Principal,
    db: Session,
    body: BaseModel,
    *,
    via: Via,
    client_name: str,
    result_title: str,
) -> str:
    assert isinstance(body, LeaveInput)
    if p.employee_id is None:
        raise CapacityForbidden()
    leave_result = register_unavailability(
        p,
        db,
        UnavailabilityInput(employee_id=p.employee_id, **body.model_dump()),
        via=via,
        client_name=client_name,
    )
    over = (
        tr(
            "（以下周次已有任务超出可用负荷：{weeks}）",
            weeks=tr("、").join(w.isoformat() for w in leave_result.over_weeks),
        )
        if leave_result.over_weeks
        else ""
    )
    return tr(
        "{result}{over}，编号：{id}",
        result=tr(result_title),
        over=over,
        id=leave_result.id,
    )


def execute_team_workload(
    p: Principal,
    db: Session,
    body: BaseModel,
    *,
    via: Via,
    client_name: str,
    result_title: str,
) -> str:
    assert isinstance(body, TeamWorkloadInput)
    team_result = set_weeks(
        replace(p, is_org_admin=False),
        db,
        WorkloadWeeksInput(
            items=[
                WorkloadWeekItem(
                    employee_id=body.employee_id,
                    other_percent=body.other_percent,
                )
            ],
            start_week=body.start_week,
            end_week=body.end_week,
        ),
        via=via,
        client_name=client_name,
    )
    return tr(
        "{result}，员工：{name}",
        result=tr(result_title),
        name=team_result.data[0].employee_name,
    )


def format_workload_request_result(result: BaseModel, result_title: str) -> str:
    if isinstance(result, WorkloadRequestPublic) and result.reviewer_names:
        return tr(
            "{result}（审批人：{reviewers}），编号：{id}",
            result=tr(result_title),
            reviewers=tr("、").join(result.reviewer_names),
            id=result.id,
        )
    return tr(
        "{result}{over}，编号：{id}",
        result=tr(result_title),
        over="",
        id=result.model_dump(mode="json")["id"],
    )
