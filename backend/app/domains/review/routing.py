from collections import defaultdict
from collections.abc import Collection
from dataclasses import dataclass
from uuid import UUID

from sqlmodel import Session, SQLModel, col, or_, select

from app.authz.principal import Principal
from app.domains.change_request.models import ProfileChangeRequest
from app.domains.change_request.schemas import RequestReviewer
from app.domains.inbox.models import InboxKind
from app.domains.inbox.service import notify
from app.domains.org.models import (
    Department,
    Employee,
    EmploymentStatus,
    OrgMembership,
    ReportingLine,
    Role,
    RoleGrant,
)
from app.domains.org.service import department_ancestry
from app.i18n import bilingual, tr
from app.models import User


class DirectReport(SQLModel):
    employee_name: str
    employee_code: str | None
    reviewers: list[RequestReviewer]
    is_reviewer: bool


@dataclass(frozen=True)
class _OrgReviewContext:
    active_user_by_emp_id: dict[UUID, UUID]
    active_emp_by_user_id: dict[UUID, UUID | None]
    user_info: dict[UUID, tuple[User, Employee | None]]
    admins: dict[UUID, UUID | None]
    managers: dict[UUID, dict[UUID, UUID | None]]
    reporting_lines: dict[UUID, UUID]
    departments: dict[UUID, Department]


def _load_org_review_context(session: Session, org_id: UUID) -> _OrgReviewContext:
    member_rows = session.exec(
        select(OrgMembership, User, Employee)
        .join(User, col(User.id) == OrgMembership.user_id)
        .outerjoin(
            Employee,
            (col(Employee.id) == OrgMembership.employee_id)
            & (col(Employee.org_id) == OrgMembership.org_id),
        )
        .where(
            OrgMembership.org_id == org_id,
            User.is_active,
            or_(
                col(OrgMembership.employee_id).is_(None),
                Employee.employment_status == EmploymentStatus.ACTIVE,
            ),
        )
    ).all()
    active_user_by_emp_id: dict[UUID, UUID] = {}
    active_emp_by_user_id: dict[UUID, UUID | None] = {}
    user_info: dict[UUID, tuple[User, Employee | None]] = {}
    for member, user, emp in member_rows:
        active_emp_by_user_id[member.user_id] = member.employee_id
        if member.employee_id is not None:
            active_user_by_emp_id[member.employee_id] = member.user_id
        user_info[member.user_id] = (user, emp)

    grant_rows = session.exec(
        select(OrgMembership.user_id, RoleGrant.role, RoleGrant.department_id)
        .join(
            RoleGrant,
            (col(RoleGrant.membership_id) == OrgMembership.id)
            & (col(RoleGrant.org_id) == OrgMembership.org_id),
        )
        .where(OrgMembership.org_id == org_id)
    ).all()
    admins: dict[UUID, UUID | None] = {}
    managers: dict[UUID, dict[UUID, UUID | None]] = defaultdict(dict)
    for user_id, role, department_id in grant_rows:
        if user_id not in active_emp_by_user_id:
            continue
        emp_id = active_emp_by_user_id[user_id]
        if role == Role.ORG_ADMIN:
            admins[user_id] = emp_id
        elif role == Role.DEPT_MANAGER and department_id is not None:
            managers[department_id][user_id] = emp_id

    reporting_lines = dict(
        session.exec(
            select(ReportingLine.employee_id, ReportingLine.manager_employee_id).where(
                ReportingLine.org_id == org_id,
                col(ReportingLine.valid_to).is_(None),
            )
        ).all()
    )
    departments = {
        row.id: row
        for row in session.exec(
            select(Department).where(Department.org_id == org_id)
        ).all()
    }
    return _OrgReviewContext(
        active_user_by_emp_id=active_user_by_emp_id,
        active_emp_by_user_id=active_emp_by_user_id,
        user_info=user_info,
        admins=admins,
        managers=managers,
        reporting_lines=reporting_lines,
        departments=departments,
    )


def direct_reports(session: Session, principal: Principal) -> list[DirectReport]:
    from app.domains.change_request.service import request_reviewers

    if principal.employee_id is None:
        return []
    reports = session.exec(
        select(Employee)
        .join(
            ReportingLine,
            (col(ReportingLine.org_id) == Employee.org_id)
            & (col(ReportingLine.employee_id) == Employee.id),
        )
        .where(
            Employee.org_id == principal.org_id,
            Employee.employment_status == EmploymentStatus.ACTIVE,
            ReportingLine.manager_employee_id == principal.employee_id,
            col(ReportingLine.valid_to).is_(None),
        )
        .order_by(Employee.display_name, col(Employee.employee_code), col(Employee.id))
    ).all()
    reviewable = reviewable_employees(session, principal, [r.id for r in reports])
    return [
        DirectReport(
            employee_name=report.display_name,
            employee_code=report.employee_code,
            reviewers=request_reviewers(session, principal.org_id, report.id),
            is_reviewer=reviewable.get(report.id) is not None,
        )
        for report in reports
    ]


def reviewers_for(
    session: Session, org_id: UUID, subject_employee_id: UUID
) -> list[UUID]:
    return review_assignment(session, org_id, subject_employee_id)[0]


def review_assignment(
    session: Session, org_id: UUID, subject_employee_id: UUID
) -> tuple[list[UUID], str | None]:
    assignment = _review_assignments(session, org_id, {subject_employee_id}).get(
        subject_employee_id
    )
    if assignment is None:
        return [], None
    return assignment[0], assignment[1]


def _review_assignments(
    session: Session,
    org_id: UUID,
    subject_employee_ids: Collection[UUID],
    *,
    ctx: _OrgReviewContext | None = None,
) -> dict[UUID, tuple[list[UUID], str | None, UUID | None]]:
    if not subject_employee_ids:
        return {}
    subjects = session.exec(
        select(Employee.id, Employee.department_id).where(
            Employee.org_id == org_id, col(Employee.id).in_(subject_employee_ids)
        )
    ).all()
    if not subjects:
        return {}
    if ctx is None:
        ctx = _load_org_review_context(session, org_id)
    return {
        employee_id: _assignment(
            employee_id,
            department_id,
            ctx.reporting_lines.get(employee_id),
            ctx.departments,
            ctx.managers,
            ctx.admins,
        )
        for employee_id, department_id in subjects
    }


def _assignment(
    employee_id: UUID,
    department_id: UUID | None,
    direct_manager_id: UUID | None,
    departments: dict[UUID, Department],
    managers: dict[UUID, dict[UUID, UUID | None]],
    admins: dict[UUID, UUID | None],
) -> tuple[list[UUID], str, UUID | None]:
    ancestry = list(department_ancestry(departments, department_id))
    if direct_manager_id is not None:
        for ancestor in ancestry:
            for user_id, manager_id in managers.get(ancestor, {}).items():
                if manager_id == direct_manager_id and manager_id != employee_id:
                    return (
                        [user_id],
                        tr("申请人的直属上级，并且是该部门的部门经理"),
                        ancestor,
                    )
    for ancestor in ancestry:
        reviewers = sorted(
            user_id
            for user_id, manager_id in managers.get(ancestor, {}).items()
            if manager_id != employee_id
        )
        if reviewers:
            reason = (
                tr("申请人所在部门的部门经理")
                if ancestor == department_id
                else tr(
                    "申请人上级部门 {name} 的部门经理",
                    name=departments[ancestor].name,
                )
            )
            return reviewers, reason, ancestor
    return (
        sorted(
            user_id for user_id, admin_id in admins.items() if admin_id != employee_id
        ),
        tr("申请人所在部门和上级部门都没有部门经理，由企业管理员审批"),
        None,
    )


def _reporting_ancestors(
    ctx: _OrgReviewContext,
    manager_user_id: UUID,
    subject_employee_id: UUID,
    primary_set: set[UUID],
) -> set[UUID]:
    manager_emp_id = ctx.active_emp_by_user_id.get(manager_user_id)
    if manager_emp_id is None:
        return set()
    ancestors: set[UUID] = set()
    visited: set[UUID] = {manager_emp_id}
    curr = ctx.reporting_lines.get(manager_emp_id)
    while curr is not None and curr not in visited:
        visited.add(curr)
        if curr != subject_employee_id:
            uid = ctx.active_user_by_emp_id.get(curr)
            if uid is not None and uid not in primary_set:
                ancestors.add(uid)
        curr = ctx.reporting_lines.get(curr)
    return ancestors


def _strict_parent_dept_managers(
    ctx: _OrgReviewContext,
    subject_employee_id: UUID,
    matched_department_id: UUID | None,
    primary_set: set[UUID],
) -> set[UUID]:
    if matched_department_id is None or matched_department_id not in ctx.departments:
        return set()
    result: set[UUID] = set()
    visited: set[UUID] = {matched_department_id}
    dept_id = ctx.departments[matched_department_id].parent_department_id
    while dept_id is not None and dept_id not in visited:
        visited.add(dept_id)
        for uid, emp_id in ctx.managers.get(dept_id, {}).items():
            if emp_id != subject_employee_id and uid not in primary_set:
                result.add(uid)
        dept = ctx.departments.get(dept_id)
        dept_id = dept.parent_department_id if dept else None
    return result


def _auto_delegates_for_assignment(
    ctx: _OrgReviewContext,
    subject_employee_id: UUID,
    primary_reviewers: list[UUID],
    matched_department_id: UUID | None,
) -> tuple[set[UUID], dict[UUID, set[UUID]]]:
    primary_set = set(primary_reviewers)
    strict_managers = _strict_parent_dept_managers(
        ctx, subject_employee_id, matched_department_id, primary_set
    )
    all_delegates: set[UUID] = set()
    delegates_by_manager: dict[UUID, set[UUID]] = {}
    for manager_user_id in primary_reviewers:
        delegates = (
            _reporting_ancestors(ctx, manager_user_id, subject_employee_id, primary_set)
            | strict_managers
        )
        delegates_by_manager[manager_user_id] = delegates
        all_delegates.update(delegates)
    return all_delegates, delegates_by_manager


def review_participants(
    session: Session, org_id: UUID, subject_employee_id: UUID
) -> tuple[list[UUID], set[UUID]]:
    ctx = _load_org_review_context(session, org_id)
    assignment = _review_assignments(
        session, org_id, {subject_employee_id}, ctx=ctx
    ).get(subject_employee_id)
    if assignment is None:
        return [], set()
    reviewers, _, matched_department_id = assignment
    all_delegates, _ = _auto_delegates_for_assignment(
        ctx, subject_employee_id, reviewers, matched_department_id
    )
    return reviewers, all_delegates


def can_review(
    session: Session, principal: Principal, subject_employee_id: UUID
) -> UUID | None:
    """Return the original reviewer represented by this actor via org hierarchy."""
    return reviewable_employees(session, principal, {subject_employee_id}).get(
        subject_employee_id
    )


def reviewable_employees(
    session: Session, principal: Principal, subject_employee_ids: Collection[UUID]
) -> dict[UUID, UUID | None]:
    user_id = principal.user_id
    if user_id is None:
        return {}
    subject_ids = set(subject_employee_ids) - {principal.employee_id}
    if not subject_ids:
        return {}
    ctx = _load_org_review_context(session, principal.org_id)
    if user_id not in ctx.active_emp_by_user_id:
        return {}
    assignments = _review_assignments(session, principal.org_id, subject_ids, ctx=ctx)
    return _reviewable_assignments(principal, ctx, assignments)


def inbox_review_access(
    session: Session, principal: Principal, subject_employee_ids: Collection[UUID]
) -> dict[UUID, tuple[bool, bool]]:
    """Return (has primary reviewers, can decide) from one routing context."""
    if not subject_employee_ids:
        return {}
    ctx = _load_org_review_context(session, principal.org_id)
    assignments = _review_assignments(
        session, principal.org_id, subject_employee_ids, ctx=ctx
    )
    reviewable = _reviewable_assignments(principal, ctx, assignments)
    return {
        employee_id: (bool(reviewers), reviewable.get(employee_id) is not None)
        for employee_id, (reviewers, _, _) in assignments.items()
    }


def _reviewable_assignments(
    principal: Principal,
    ctx: _OrgReviewContext,
    assignments: dict[UUID, tuple[list[UUID], str | None, UUID | None]],
) -> dict[UUID, UUID | None]:
    user_id = principal.user_id
    if user_id is None or user_id not in ctx.active_emp_by_user_id:
        return {}
    result: dict[UUID, UUID | None] = {}
    for employee_id, (reviewers, _, matched_department_id) in assignments.items():
        if employee_id == principal.employee_id:
            continue
        if user_id in reviewers:
            result[employee_id] = user_id
        else:
            _, delegates_by_manager = _auto_delegates_for_assignment(
                ctx, employee_id, reviewers, matched_department_id
            )
            result[employee_id] = next(
                (
                    manager
                    for manager in sorted(reviewers)
                    if user_id in delegates_by_manager[manager]
                ),
                None,
            )
    return result


def can_review_any(session: Session, principal: Principal) -> bool:
    if principal.user_id is None:
        return False
    if principal.is_org_admin or bool(principal.managed_department_ids):
        return True
    if principal.employee_id is None:
        return False
    has_subordinate = (
        session.exec(
            select(ReportingLine.id)
            .where(
                ReportingLine.org_id == principal.org_id,
                ReportingLine.manager_employee_id == principal.employee_id,
                col(ReportingLine.valid_to).is_(None),
            )
            .limit(1)
        ).first()
        is not None
    )
    if not has_subordinate:
        return False
    active_ids = session.exec(
        select(Employee.id).where(
            Employee.org_id == principal.org_id,
            Employee.employment_status == EmploymentStatus.ACTIVE,
            Employee.id != principal.employee_id,
        )
    ).all()
    return any(
        reviewer is not None
        for reviewer in reviewable_employees(session, principal, active_ids).values()
    )


def notify_reviewers(session: Session, request: ProfileChangeRequest) -> None:
    reviewers = reviewers_for(session, request.org_id, request.subject_employee_id)
    for user_id in sorted(set(reviewers)):
        member = session.exec(
            select(OrgMembership).where(
                OrgMembership.org_id == request.org_id, OrgMembership.user_id == user_id
            )
        ).one()
        if member.employee_id == request.subject_employee_id:
            continue
        msg_zh, msg_en = bilingual("有新的画像请求待审批")
        notify(
            session,
            request,
            InboxKind.REVIEW_REQUESTED,
            msg_zh,
            recipient_user_id=user_id,
            message_en=msg_en,
        )
