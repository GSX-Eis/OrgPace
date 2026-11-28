from typing import Literal

from fastapi import APIRouter
from sqlmodel import col, select

from app.api.deps import CurrentUser, SessionDep
from app.authz.deps import managed_scope
from app.domains.org.models import (
    Employee,
    EmploymentStatus,
    Organization,
    OrgMembership,
    ReportingLine,
    Role,
    RoleGrant,
)
from app.domains.org.schemas import MembershipPublic, OrganizationPublic

router = APIRouter(prefix="/me", tags=["me"])


@router.get("/memberships", response_model=list[MembershipPublic])
def read_memberships(
    session: SessionDep, current_user: CurrentUser
) -> list[MembershipPublic]:
    rows = session.exec(
        select(OrgMembership, Organization)
        .join(Organization, col(Organization.id) == OrgMembership.org_id)
        .where(OrgMembership.user_id == current_user.id)
        .order_by(Organization.slug)
    ).all()
    result = []
    for membership, org in rows:
        grants = session.exec(
            select(RoleGrant).where(
                RoleGrant.org_id == org.id, RoleGrant.membership_id == membership.id
            )
        ).all()
        roles: list[Role | Literal["employee"]] = sorted({g.role for g in grants})
        if membership.employee_id:
            roles.append("employee")
        has_review_role = any(
            g.role in (Role.ORG_ADMIN, Role.DEPT_MANAGER) for g in grants
        )
        can_review = has_review_role or (
            membership.employee_id is not None
            and session.exec(
                select(ReportingLine.id)
                .join(
                    Employee,
                    (col(Employee.org_id) == ReportingLine.org_id)
                    & (col(Employee.id) == ReportingLine.employee_id),
                )
                .where(
                    ReportingLine.org_id == org.id,
                    ReportingLine.manager_employee_id == membership.employee_id,
                    col(ReportingLine.valid_to).is_(None),
                    Employee.employment_status == EmploymentStatus.ACTIVE,
                )
                .limit(1)
            ).first()
            is not None
        )
        result.append(
            MembershipPublic(
                org=OrganizationPublic.model_validate(org),
                employee_id=membership.employee_id,
                roles=roles,
                managed_department_ids=sorted(
                    managed_scope(
                        session,
                        org.id,
                        frozenset(
                            g.department_id
                            for g in grants
                            if g.role == Role.DEPT_MANAGER
                            and g.department_id is not None
                        ),
                    )
                ),
                can_review=can_review,
            )
        )
    return result
