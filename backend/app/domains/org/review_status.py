"""Shared review-status queries derived from profile, change-request, and appeal models."""

from uuid import UUID

from sqlalchemy import and_, case, func, literal, or_, union_all
from sqlalchemy.orm import aliased
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.sql.selectable import Subquery
from sqlmodel import Session, col, select

from app.domains.change_request.models import (
    ProfileChangeRequest,
    RequestOrigin,
    RequestStatus,
)
from app.domains.org.models import Employee, EmploymentStatus
from app.domains.profile.models import (
    AssessmentStatus,
    ProfileClaim,
    ProfileVersion,
    ProgressReviewStatus,
)
from app.domains.review.models import AppealStatus, ReviewAppeal

# Keep the coverage precedence: open appeals outrank requests and disputed claims.
_STATUS_BY_PRIORITY = {
    1: ProgressReviewStatus.DISPUTED,
    2: ProgressReviewStatus.PENDING_MANAGER,
    3: ProgressReviewStatus.PENDING_EMPLOYEE,
    4: ProgressReviewStatus.DISPUTED,
}


def _review_status_overrides(
    org_id: UUID, employee_ids: list[UUID] | None = None
) -> Subquery:
    successor = aliased(ProfileClaim)
    current = (
        select(ProfileClaim.subject_employee_id, ProfileClaim.assessment_status)
        .where(
            ProfileClaim.org_id == org_id,
            True
            if employee_ids is None
            else col(ProfileClaim.subject_employee_id).in_(employee_ids),
            ~select(successor.id)
            .where(
                successor.org_id == org_id,
                successor.supersedes_claim_id == ProfileClaim.id,
            )
            .exists(),
        )
        .distinct(
            col(ProfileClaim.subject_employee_id),
            col(ProfileClaim.capability_definition_id),
        )
        .order_by(
            col(ProfileClaim.subject_employee_id),
            col(ProfileClaim.capability_definition_id),
            col(ProfileClaim.created_at).desc(),
            col(ProfileClaim.id).desc(),
        )
    ).subquery()
    disputed = select(
        current.c.subject_employee_id, literal(1).label("priority")
    ).where(current.c.assessment_status == AssessmentStatus.DISPUTED)
    pending = select(
        ProfileChangeRequest.subject_employee_id,
        case(
            (
                col(ProfileChangeRequest.status).in_(
                    [RequestStatus.PENDING_OWNER, RequestStatus.DRAFT]
                ),
                3,
            ),
            else_=2,
        ),
    ).where(
        ProfileChangeRequest.org_id == org_id,
        True
        if employee_ids is None
        else col(ProfileChangeRequest.subject_employee_id).in_(employee_ids),
        or_(
            col(ProfileChangeRequest.status).in_(
                [RequestStatus.PENDING_OWNER, RequestStatus.PENDING_REVIEW]
            ),
            and_(
                col(ProfileChangeRequest.status) == RequestStatus.DRAFT,
                col(ProfileChangeRequest.origin) == RequestOrigin.INITIAL_SYNC,
            ),
        ),
    )
    appeals = select(ReviewAppeal.employee_id, literal(4)).where(
        ReviewAppeal.org_id == org_id,
        True
        if employee_ids is None
        else col(ReviewAppeal.employee_id).in_(employee_ids),
        ReviewAppeal.status == AppealStatus.OPEN,
    )
    combined = union_all(disputed, pending, appeals).subquery()
    return (
        select(
            combined.c.subject_employee_id,
            func.max(combined.c.priority).label("priority"),
        )
        .group_by(combined.c.subject_employee_id)
        .subquery()
    )


def review_statuses(
    session: Session, org_id: UUID, employee_ids: list[UUID], published_ids: set[UUID]
) -> dict[UUID, ProgressReviewStatus]:
    statuses = {
        employee_id: ProgressReviewStatus.PUBLISHED
        if employee_id in published_ids
        else ProgressReviewStatus.NONE
        for employee_id in employee_ids
    }
    overrides = _review_status_overrides(org_id, employee_ids)
    for employee_id, priority in session.exec(
        select(overrides.c.subject_employee_id, overrides.c.priority)
    ).all():
        statuses[employee_id] = _STATUS_BY_PRIORITY[priority]
    return statuses


def coverage_status_clause(
    org_id: UUID, status: ProgressReviewStatus
) -> ColumnElement[bool]:
    overrides = _review_status_overrides(org_id)
    overridden_ids = select(overrides.c.subject_employee_id)
    active = col(Employee.employment_status) == EmploymentStatus.ACTIVE
    priorities = [
        rank for rank, value in _STATUS_BY_PRIORITY.items() if value == status
    ]
    if priorities:
        return active & col(Employee.id).in_(
            overridden_ids.where(overrides.c.priority.in_(priorities))
        )
    published = (
        select(ProfileVersion.id)
        .where(
            ProfileVersion.org_id == org_id,
            ProfileVersion.subject_employee_id == Employee.id,
        )
        .exists()
    )
    return (
        active
        & col(Employee.id).not_in(overridden_ids)
        & (published if status == ProgressReviewStatus.PUBLISHED else ~published)
    )
