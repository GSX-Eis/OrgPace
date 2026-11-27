"""Capacity approval detail provider registered with the inbox domain."""

from datetime import date
from uuid import UUID

from sqlalchemy import ColumnElement
from sqlmodel import Session, col, select

from app.authz.policies import can_view_employee
from app.authz.principal import Principal
from app.domains.audit.models import AuditEvent
from app.domains.capacity.assignment import assignment_lender
from app.domains.capacity.demand import represents_department
from app.domains.capacity.extension import (
    extension_department_allowed,
    user_names,
)
from app.domains.capacity.models import (
    CapacityAssignment,
    CapacityDemand,
    CapacityExtensionRequest,
    CapacityInboxLink,
    CapacityProposalLine,
    CapacityRequestStatus,
    CapacityWeek,
    CapacityWorkloadRequest,
)
from app.domains.inbox.models import InboxItem
from app.domains.inbox.schemas import (
    InboxExtensionRequestDetail,
    InboxWorkloadRequestDetail,
)
from app.domains.inbox.service import register_capacity_provider
from app.domains.org.models import Employee
from app.domains.review.routing import can_review, reviewable_employees
from app.i18n import tr


def record_capacity_inbox_link(
    session: Session,
    item: InboxItem,
    *,
    workload_request_id: UUID | None = None,
    extension_request_id: UUID | None = None,
) -> None:
    if workload_request_id is None and extension_request_id is None:
        return
    session.add(
        CapacityInboxLink(
            org_id=item.org_id,
            inbox_item_id=item.id,
            workload_request_id=workload_request_id,
            extension_request_id=extension_request_id,
        )
    )
    session.flush()


class CapacityInboxProvider:
    def fetch_rows(
        self,
        session: Session,
        scope: ColumnElement[bool],
        matches: ColumnElement[bool],
        skip: int,
        limit: int,
    ) -> list[tuple[InboxItem, UUID | None, UUID | None]]:
        rows = session.exec(
            select(InboxItem, CapacityInboxLink)
            .outerjoin(
                CapacityInboxLink,
                (col(CapacityInboxLink.org_id) == InboxItem.org_id)
                & (col(CapacityInboxLink.inbox_item_id) == InboxItem.id),
            )
            .where(scope, matches)
            .order_by(col(InboxItem.created_at).desc(), col(InboxItem.id))
            .offset(skip)
            .limit(limit)
        ).all()
        return [
            (
                item,
                link.workload_request_id if link else None,
                link.extension_request_id if link else None,
            )
            for item, link in rows
        ]

    def fetch_one(
        self, session: Session, scope: ColumnElement[bool], inbox_id: UUID
    ) -> tuple[InboxItem, UUID | None, UUID | None] | None:
        found = session.exec(
            select(InboxItem, CapacityInboxLink)
            .outerjoin(
                CapacityInboxLink,
                (col(CapacityInboxLink.org_id) == InboxItem.org_id)
                & (col(CapacityInboxLink.inbox_item_id) == InboxItem.id),
            )
            .where(scope, InboxItem.id == inbox_id)
        ).one_or_none()
        if found is None:
            return None
        item, link = found
        return (
            item,
            link.workload_request_id if link else None,
            link.extension_request_id if link else None,
        )

    def link_for(
        self, session: Session, org_id: UUID, inbox_item_id: UUID
    ) -> tuple[UUID | None, UUID | None]:
        link = session.exec(
            select(CapacityInboxLink).where(
                CapacityInboxLink.org_id == org_id,
                CapacityInboxLink.inbox_item_id == inbox_item_id,
            )
        ).one_or_none()
        if link is None:
            return None, None
        return link.workload_request_id, link.extension_request_id

    def workload_detail(
        self, principal: Principal, session: Session, workload_request_id: UUID
    ) -> InboxWorkloadRequestDetail | None:
        row = session.exec(
            select(CapacityWorkloadRequest).where(
                CapacityWorkloadRequest.org_id == principal.org_id,
                CapacityWorkloadRequest.id == workload_request_id,
            )
        ).one_or_none()
        if row is None:
            return None
        subject = session.exec(
            select(Employee).where(
                Employee.org_id == principal.org_id,
                Employee.id == row.employee_id,
            )
        ).one_or_none()
        if subject is None or not can_view_employee(principal, subject):
            return None
        if not (
            principal.employee_id == row.employee_id
            or can_review(session, principal, row.employee_id) is not None
            or row.decided_by_user_id == principal.user_id
            or row.decided_for_user_id == principal.user_id
        ):
            return None

        before_percent: int | None = None
        event = session.exec(
            select(AuditEvent)
            .where(
                AuditEvent.org_id == principal.org_id,
                AuditEvent.target_type == "capacity_workload_request",
                AuditEvent.target_id == str(row.id),
                col(AuditEvent.action).in_(
                    [
                        "capacity.workload_request_approved",
                        "capacity.workload_request_returned",
                    ]
                ),
            )
            .order_by(col(AuditEvent.created_at).desc(), col(AuditEvent.id))
        ).first()
        if event is not None and isinstance(event.details, dict):
            raw_before = event.details.get("before_percent")
            if isinstance(raw_before, int):
                before_percent = raw_before
        if (
            before_percent is None
            and row.status != CapacityRequestStatus.APPROVED
            and row.start_week is not None
        ):
            before_percent = session.exec(
                select(CapacityWeek.other_percent).where(
                    CapacityWeek.org_id == principal.org_id,
                    CapacityWeek.employee_id == row.employee_id,
                    CapacityWeek.week_start == row.start_week,
                )
            ).one_or_none()

        reviewer_name = (
            user_names(session, principal.org_id, {row.decided_by_user_id}).get(
                row.decided_by_user_id
            )
            if row.decided_by_user_id is not None
            else None
        )
        return InboxWorkloadRequestDetail(
            request_id=row.id,
            status=row.status.value,
            before_percent=before_percent,
            requested_percent=row.requested_percent,
            start_week=row.start_week,
            end_week=row.end_week,
            reason=row.reason,
            decision_note=row.decision_note,
            decided_at=row.decided_at,
            reviewer_name=reviewer_name,
        )

    def _can_access_extension(
        self,
        principal: Principal,
        session: Session,
        request: CapacityExtensionRequest,
        assignment: CapacityAssignment,
        demand: CapacityDemand,
        subject: Employee | None,
        *,
        is_borrowed: bool,
        reviewable_map: dict[UUID, UUID | None] | None = None,
        dept_allowed_cache: dict[UUID, bool] | None = None,
    ) -> bool:
        if subject is None or not can_view_employee(principal, subject):
            return False
        if principal.employee_id == assignment.employee_id:
            return True
        if is_borrowed:
            return represents_department(principal, demand.target_department_id)
        target_dept_id = demand.target_department_id
        if dept_allowed_cache is not None and target_dept_id in dept_allowed_cache:
            allowed_dept = dept_allowed_cache[target_dept_id]
        else:
            allowed_dept = extension_department_allowed(
                principal, session, target_dept_id
            )
            if dept_allowed_cache is not None:
                dept_allowed_cache[target_dept_id] = allowed_dept
        if not allowed_dept:
            return False
        if request.decided_by_user_id == principal.user_id:
            return True
        if reviewable_map is not None:
            return reviewable_map.get(assignment.employee_id) is not None
        return can_review(session, principal, assignment.employee_id) is not None

    def accessible_extension_ids(
        self, principal: Principal, session: Session, extension_request_ids: set[UUID]
    ) -> set[UUID]:
        if not extension_request_ids:
            return set()
        rows = session.exec(
            select(
                CapacityExtensionRequest, CapacityAssignment, CapacityDemand, Employee
            )
            .join(
                CapacityAssignment,
                (col(CapacityAssignment.org_id) == CapacityExtensionRequest.org_id)
                & (
                    col(CapacityAssignment.id) == CapacityExtensionRequest.assignment_id
                ),
            )
            .join(
                CapacityDemand,
                (col(CapacityDemand.org_id) == CapacityAssignment.org_id)
                & (col(CapacityDemand.id) == CapacityAssignment.demand_id),
            )
            .outerjoin(
                Employee,
                (col(Employee.org_id) == CapacityAssignment.org_id)
                & (col(Employee.id) == CapacityAssignment.employee_id),
            )
            .where(
                CapacityExtensionRequest.org_id == principal.org_id,
                col(CapacityExtensionRequest.id).in_(extension_request_ids),
            )
        ).all()
        if not rows:
            return set()
        line_ids = {
            assignment.proposal_line_id
            for _, assignment, _, _ in rows
            if assignment.proposal_line_id is not None
        }
        borrowed_lines = (
            set(
                session.exec(
                    select(CapacityProposalLine.id).where(
                        CapacityProposalLine.org_id == principal.org_id,
                        col(CapacityProposalLine.id).in_(line_ids),
                        col(CapacityProposalLine.lender_department_id).is_not(None),
                    )
                ).all()
            )
            if line_ids
            else set()
        )
        candidate_employees = {
            assignment.employee_id
            for request, assignment, _, subject in rows
            if subject is not None
            and can_view_employee(principal, subject)
            and principal.employee_id != assignment.employee_id
            and assignment.proposal_line_id not in borrowed_lines
            and request.decided_by_user_id != principal.user_id
        }
        reviewable_map = (
            reviewable_employees(session, principal, candidate_employees)
            if candidate_employees
            else {}
        )
        dept_allowed_cache: dict[UUID, bool] = {}
        return {
            request.id
            for request, assignment, demand, subject in rows
            if self._can_access_extension(
                principal,
                session,
                request,
                assignment,
                demand,
                subject,
                is_borrowed=assignment.proposal_line_id in borrowed_lines,
                reviewable_map=reviewable_map,
                dept_allowed_cache=dept_allowed_cache,
            )
        }

    def extension_detail(
        self, principal: Principal, session: Session, extension_request_id: UUID
    ) -> InboxExtensionRequestDetail | None:
        found = session.exec(
            select(CapacityExtensionRequest, CapacityAssignment, CapacityDemand)
            .join(
                CapacityAssignment,
                (col(CapacityAssignment.org_id) == CapacityExtensionRequest.org_id)
                & (
                    col(CapacityAssignment.id) == CapacityExtensionRequest.assignment_id
                ),
            )
            .join(
                CapacityDemand,
                (col(CapacityDemand.org_id) == CapacityAssignment.org_id)
                & (col(CapacityDemand.id) == CapacityAssignment.demand_id),
            )
            .where(
                CapacityExtensionRequest.org_id == principal.org_id,
                CapacityExtensionRequest.id == extension_request_id,
            )
        ).one_or_none()
        if found is None:
            return None
        request, assignment, demand = found
        subject = session.exec(
            select(Employee).where(
                Employee.org_id == principal.org_id,
                Employee.id == assignment.employee_id,
            )
        ).one_or_none()
        is_owner = principal.employee_id == assignment.employee_id
        lender = assignment_lender(session, assignment)
        if not self._can_access_extension(
            principal,
            session,
            request,
            assignment,
            demand,
            subject,
            is_borrowed=lender is not None,
        ):
            return None

        before_due_date: date | None = None
        new_due_date: date | None = None
        event = session.exec(
            select(AuditEvent)
            .where(
                AuditEvent.org_id == principal.org_id,
                AuditEvent.target_type == "capacity_extension_request",
                AuditEvent.target_id == str(request.id),
                col(AuditEvent.action).in_(
                    ["capacity.extension_approved", "capacity.extension_returned"]
                ),
            )
            .order_by(col(AuditEvent.created_at).desc(), col(AuditEvent.id))
        ).first()
        if event is not None and isinstance(event.details, dict):
            raw_before = event.details.get("before_date")
            raw_after = event.details.get("after_date")
            if isinstance(raw_before, str):
                before_due_date = date.fromisoformat(raw_before)
            if (
                isinstance(raw_after, str)
                and request.status == CapacityRequestStatus.APPROVED
            ):
                new_due_date = date.fromisoformat(raw_after)
        if before_due_date is None and request.status != CapacityRequestStatus.APPROVED:
            before_due_date = assignment.due_date
        if new_due_date is None and request.status == CapacityRequestStatus.APPROVED:
            new_due_date = assignment.due_date

        reviewer_name = (
            user_names(session, principal.org_id, {request.decided_by_user_id}).get(
                request.decided_by_user_id
            )
            if request.decided_by_user_id is not None
            else None
        )
        return InboxExtensionRequestDetail(
            request_id=request.id,
            status=request.status.value,
            capability_name=demand.capability_name,
            before_due_date=before_due_date,
            requested_due_date=request.requested_due_date,
            new_due_date=new_due_date,
            reason=(
                tr("借调员工申请调整完成日期")
                if (not is_owner and lender is not None)
                else request.reason
            ),
            decision_note=request.decision_note,
            decided_at=request.decided_at,
            reviewer_name=reviewer_name,
        )


register_capacity_provider(CapacityInboxProvider())
