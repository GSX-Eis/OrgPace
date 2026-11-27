from collections import defaultdict
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import Session, SQLModel, col, select

from app.authz.principal import Principal
from app.domains.org.models import OrgMembership, Role, RoleGrant
from app.domains.review.routing import _load_org_review_context
from app.i18n import tr


class DelegationDisabled(HTTPException):
    def __init__(self) -> None:
        super().__init__(410, "代理审批已改为按组织架构自动设置，无需手动添加或撤销")


class AutoDelegatePublic(SQLModel):
    user_id: UUID
    name: str
    department_name: str | None = None
    title: str | None = None
    relations: list[str]


class DelegationView(SQLModel):
    is_reviewer_role: bool
    auto_delegates: list[AutoDelegatePublic]


def delegation_view(session: Session, principal: Principal) -> DelegationView:
    is_reviewer_role = principal.is_org_admin or bool(principal.managed_department_ids)
    if principal.user_id is None or not is_reviewer_role:
        return DelegationView(is_reviewer_role=is_reviewer_role, auto_delegates=[])

    ctx = _load_org_review_context(session, principal.org_id)
    relations_by_user: dict[UUID, list[str]] = defaultdict(list)

    def add_relation(uid: UUID, label: str) -> None:
        if uid == principal.user_id:
            return
        if label not in relations_by_user[uid]:
            relations_by_user[uid].append(label)

    # Path A: full reporting-line ancestry from the current user's employee node.
    if principal.employee_id is not None:
        visited_emps: set[UUID] = {principal.employee_id}
        curr = ctx.reporting_lines.get(principal.employee_id)
        depth = 1
        while curr is not None and curr not in visited_emps:
            visited_emps.add(curr)
            uid = ctx.active_user_by_emp_id.get(curr)
            if uid is not None:
                add_relation(uid, tr("直属上级") if depth == 1 else tr("汇报线上级"))
            curr = ctx.reporting_lines.get(curr)
            depth += 1

    # Path B: managers of all departments strictly above directly granted departments.
    direct_dept_ids = session.exec(
        select(RoleGrant.department_id)
        .join(
            OrgMembership,
            (col(OrgMembership.id) == RoleGrant.membership_id)
            & (col(OrgMembership.org_id) == RoleGrant.org_id),
        )
        .where(
            RoleGrant.org_id == principal.org_id,
            OrgMembership.user_id == principal.user_id,
            RoleGrant.role == Role.DEPT_MANAGER,
            col(RoleGrant.department_id).is_not(None),
        )
    ).all()
    for dept_id in direct_dept_ids:
        if dept_id is None or dept_id not in ctx.departments:
            continue
        visited_depts: set[UUID] = {dept_id}
        ancestor_dept_id = ctx.departments[dept_id].parent_department_id
        while ancestor_dept_id is not None and ancestor_dept_id not in visited_depts:
            visited_depts.add(ancestor_dept_id)
            dept = ctx.departments.get(ancestor_dept_id)
            if dept is None:
                break
            label = tr("上级部门经理（{name}）", name=dept.name)

            def _sort_key(u: UUID) -> tuple[str, UUID]:
                user, emp = ctx.user_info[u]
                return (
                    emp.display_name
                    if emp is not None
                    else (user.full_name or user.username),
                    u,
                )

            manager_uids = sorted(ctx.managers.get(ancestor_dept_id, {}), key=_sort_key)
            for uid in manager_uids:
                add_relation(uid, label)
            ancestor_dept_id = dept.parent_department_id

    auto_delegates: list[AutoDelegatePublic] = []
    for uid, relations in relations_by_user.items():
        user, emp = ctx.user_info[uid]
        department_name = (
            ctx.departments[emp.department_id].name
            if emp and emp.department_id and emp.department_id in ctx.departments
            else None
        )
        auto_delegates.append(
            AutoDelegatePublic(
                user_id=uid,
                name=emp.display_name if emp else (user.full_name or user.username),
                department_name=department_name,
                title=emp.title if emp else None,
                relations=relations,
            )
        )
    return DelegationView(
        is_reviewer_role=True,
        auto_delegates=auto_delegates,
    )
