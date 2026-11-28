from collections.abc import Sequence
from typing import Protocol
from uuid import UUID

from sqlalchemy import ColumnElement, and_, true
from sqlalchemy import select as select_columns
from sqlmodel import Session, col, func, or_, select, update

from app.authz.policies import can_view_employee, can_view_evidence_content
from app.authz.principal import Principal
from app.domains.audit.service import record_audit
from app.domains.base import utc_now
from app.domains.capability.models import CapabilityDefinition
from app.domains.change_request.claim import ClaimAfter
from app.domains.change_request.models import (
    ChangeItem,
    ItemDecision,
    ProfileChangeRequest,
    RequestOrigin,
    ReviewDecision,
    ReviewVia,
)
from app.domains.evidence.models import EvidenceKind, Visibility
from app.domains.evidence.service import append_evidence
from app.domains.inbox.models import (
    InboxItem,
    InboxKind,
    PendingQuestion,
    QuestionStatus,
)
from app.domains.inbox.schemas import (
    AnswerInput,
    InboxChangeClaimSnapshot,
    InboxChangeItemDetail,
    InboxDetail,
    InboxExtensionRequestDetail,
    InboxList,
    InboxProfileRequestDetail,
    InboxPublic,
    InboxReadAllInput,
    InboxReadAllResult,
    InboxWorkloadRequestDetail,
    QuestionPublic,
    QuestionsList,
)
from app.domains.org.models import Employee, EmploymentStatus, OrgMembership
from app.domains.profile.models import ProfileClaim
from app.i18n import current_locale, tr
from app.models import User


class InboxCapacityProvider(Protocol):
    def fetch_rows(
        self,
        session: Session,
        scope: ColumnElement[bool],
        matches: ColumnElement[bool],
        skip: int,
        limit: int,
    ) -> list[tuple[InboxItem, UUID | None, UUID | None]]: ...

    def fetch_one(
        self, session: Session, scope: ColumnElement[bool], inbox_id: UUID
    ) -> tuple[InboxItem, UUID | None, UUID | None] | None: ...

    def link_for(
        self, session: Session, org_id: UUID, inbox_item_id: UUID
    ) -> tuple[UUID | None, UUID | None]: ...

    def workload_detail(
        self, principal: Principal, session: Session, workload_request_id: UUID
    ) -> InboxWorkloadRequestDetail | None: ...

    def extension_detail(
        self, principal: Principal, session: Session, extension_request_id: UUID
    ) -> InboxExtensionRequestDetail | None: ...

    def accessible_extension_ids(
        self, principal: Principal, session: Session, extension_request_ids: set[UUID]
    ) -> set[UUID]: ...


class ItemAddedHook(Protocol):
    def __call__(
        self,
        session: Session,
        item: InboxItem,
        /,
        *,
        borrow_assignment_id: UUID | None = None,
    ) -> None: ...


REDACTED_EXTENSION_RECEIPT_MESSAGE = (
    "一条延期申请已由上级代为审批，受承接部门可见范围限制，暂不展示详情"
)
_capacity_provider: InboxCapacityProvider | None = None
_item_added_hook: ItemAddedHook | None = None


def register_capacity_provider(provider: InboxCapacityProvider) -> None:
    global _capacity_provider
    _capacity_provider = provider


def on_item_added(hook: ItemAddedHook) -> None:
    global _item_added_hook
    _item_added_hook = hook


def add_item(
    session: Session, item: InboxItem, *, borrow_assignment_id: UUID | None = None
) -> None:
    session.add(item)
    session.flush()
    if _item_added_hook is not None:
        _item_added_hook(session, item, borrow_assignment_id=borrow_assignment_id)


def notify(
    session: Session,
    request: ProfileChangeRequest,
    kind: InboxKind,
    message: str,
    recipient_employee_id: UUID | None = None,
    recipient_user_id: UUID | None = None,
    message_en: str | None = None,
) -> None:
    if kind in (InboxKind.SUBMITTED, InboxKind.STATUS_CHANGED, InboxKind.DECIDED):
        now = utc_now()
        session.exec(
            update(InboxItem)
            .where(
                col(InboxItem.org_id) == request.org_id,
                col(InboxItem.request_id) == request.id,
                col(InboxItem.kind).in_(
                    [InboxKind.INITIAL_REVIEW, InboxKind.REVIEW_REQUESTED]
                    if kind != InboxKind.SUBMITTED
                    else [InboxKind.INITIAL_REVIEW]
                ),
                col(InboxItem.done_at).is_(None),
            )
            .values(done_at=now, read_at=func.coalesce(InboxItem.read_at, now))
        )
    add_item(
        session,
        InboxItem(
            org_id=request.org_id,
            recipient_employee_id=None
            if recipient_user_id
            else recipient_employee_id or request.subject_employee_id,
            recipient_user_id=recipient_user_id,
            request_id=request.id,
            kind=kind,
            message=message,
            message_en=message_en,
        ),
    )


def _recipient_scope(principal: Principal) -> ColumnElement[bool]:
    return and_(
        col(InboxItem.org_id) == principal.org_id,
        or_(
            col(InboxItem.recipient_employee_id) == principal.employee_id
            if principal.employee_id
            else False,
            col(InboxItem.recipient_user_id) == principal.user_id
            if principal.user_id
            else False,
        ),
    )


def _pending_item() -> ColumnElement[bool]:
    return and_(
        col(InboxItem.done_at).is_(None),
        col(InboxItem.kind).in_(
            [InboxKind.INITIAL_REVIEW, InboxKind.QUESTION, InboxKind.REVIEW_REQUESTED]
        ),
    )


def _inbox_filter(filters: InboxReadAllInput) -> ColumnElement[bool]:
    return and_(
        _pending_item() if filters.pending_only else true(),
        col(InboxItem.read_at).is_(None) if filters.unread_only else true(),
        col(InboxItem.kind) == filters.kind if filters.kind is not None else true(),
    )


def _is_unlinked_delegated_extension_receipt(item: InboxItem) -> bool:
    return (
        item.kind == InboxKind.CAPACITY
        and item.recipient_user_id is not None
        and item.message.startswith("员工 ")
        and " 的延期申请（" in item.message
        and "）已由上级 " in item.message
        and item.message.endswith(" 代为审批")
    )


def _to_inbox_public(
    item: InboxItem,
    workload_request_id: UUID | None = None,
    extension_request_id: UUID | None = None,
    *,
    redacted: bool = False,
) -> InboxPublic:
    displayed_message = (
        item.message_en
        if current_locale.get() == "en" and item.message_en
        else item.message
    )
    return InboxPublic.model_validate(
        item,
        update={
            "message": displayed_message,
            "workload_request_id": workload_request_id,
            "extension_request_id": None if redacted else extension_request_id,
            **({"message": tr(REDACTED_EXTENSION_RECEIPT_MESSAGE)} if redacted else {}),
        },
    )


def _project_inbox_items(
    principal: Principal,
    session: Session,
    rows: Sequence[tuple[InboxItem, UUID | None, UUID | None]],
) -> list[InboxPublic]:
    ext_ids = {ext_id for _, _, ext_id in rows if ext_id is not None}
    allowed_ext_ids = (
        _capacity_provider.accessible_extension_ids(principal, session, ext_ids)
        if (_capacity_provider is not None and ext_ids)
        else set()
    )
    projected: list[InboxPublic] = []
    for item, wl_id, ext_id in rows:
        redacted = (
            ext_id not in allowed_ext_ids
            if ext_id is not None
            else _is_unlinked_delegated_extension_receipt(item)
        )
        projected.append(_to_inbox_public(item, wl_id, ext_id, redacted=redacted))
    return projected


def my_inbox(
    principal: Principal,
    session: Session,
    skip: int = 0,
    limit: int = 50,
    *,
    pending_only: bool = False,
    unread_only: bool = False,
    kind: InboxKind | None = None,
) -> InboxList:
    scope = _recipient_scope(principal)
    matches = _inbox_filter(
        InboxReadAllInput(pending_only=pending_only, unread_only=unread_only, kind=kind)
    )
    rows = (
        _capacity_provider.fetch_rows(session, scope, matches, skip, limit)
        if _capacity_provider is not None
        else [
            (row, None, None)
            for row in session.exec(
                select(InboxItem)
                .where(scope, matches)
                .order_by(col(InboxItem.created_at).desc(), col(InboxItem.id))
                .offset(skip)
                .limit(limit)
            ).all()
        ]
    )
    unread = col(InboxItem.read_at).is_(None)
    total, unread_count, pending_count, count, filtered_unread = (
        session.connection()
        .execute(
            select_columns(
                func.count(),
                func.count().filter(unread),
                func.count().filter(_pending_item()),
                func.count().filter(matches),
                func.count().filter(matches, unread),
            )
            .select_from(InboxItem)
            .where(scope)
        )
        .one()
    )
    return InboxList(
        data=_project_inbox_items(principal, session, rows),
        count=count,
        total_count=total,
        unread_count=unread_count,
        pending_count=pending_count,
        filtered_unread_count=filtered_unread,
    )


def mark_all_read(
    principal: Principal, session: Session, filters: InboxReadAllInput
) -> InboxReadAllResult:
    result = session.exec(
        update(InboxItem)
        .where(
            _recipient_scope(principal),
            _inbox_filter(filters),
            col(InboxItem.read_at).is_(None),
        )
        .values(read_at=utc_now())
    )
    return InboxReadAllResult(updated_count=result.rowcount)


def mark_read(principal: Principal, session: Session, inbox_id: UUID) -> InboxPublic:
    from app.domains.change_request.employee import EmployeeRecordNotFound

    item = session.exec(
        select(InboxItem)
        .where(_recipient_scope(principal), InboxItem.id == inbox_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one_or_none()
    if item is None:
        raise EmployeeRecordNotFound()
    item.read_at = item.read_at or utc_now()
    session.flush()
    wl_id, ext_id = (
        _capacity_provider.link_for(session, item.org_id, item.id)
        if _capacity_provider is not None
        else (None, None)
    )
    return _project_inbox_items(principal, session, [(item, wl_id, ext_id)])[0]


def _reviewer_display_name(session: Session, org_id: UUID, user_id: UUID) -> str | None:
    row = session.exec(
        select(Employee.display_name, User.full_name)
        .join(OrgMembership, col(OrgMembership.user_id) == User.id)
        .outerjoin(
            Employee,
            (col(Employee.org_id) == OrgMembership.org_id)
            & (col(Employee.id) == OrgMembership.employee_id),
        )
        .where(OrgMembership.org_id == org_id, OrgMembership.user_id == user_id)
    ).first()
    if row is None:
        return None
    employee_name, full_name = row
    return employee_name or full_name or tr("企业管理员")


def _profile_request_detail(
    principal: Principal, session: Session, request_id: UUID
) -> InboxProfileRequestDetail | None:
    from app.authz.review import review_access

    request = session.exec(
        select(ProfileChangeRequest).where(
            ProfileChangeRequest.org_id == principal.org_id,
            ProfileChangeRequest.id == request_id,
        )
    ).one_or_none()
    if request is None:
        return None
    subject = session.exec(
        select(Employee).where(
            Employee.org_id == principal.org_id,
            Employee.id == request.subject_employee_id,
        )
    ).one_or_none()
    if subject is None:
        return None
    has_review_access = (
        subject.employment_status == EmploymentStatus.ACTIVE
        and review_access(session, principal, request)
    )
    if not has_review_access and not can_view_employee(principal, subject):
        return None
    can_view_restricted = has_review_access or can_view_evidence_content(
        principal, subject_employee=subject, visibility=Visibility.RESTRICTED
    )
    parent_request = None
    if (
        request.parent_request_id is not None
        and request.origin == RequestOrigin.CORRECTION
    ):
        parent_request = session.exec(
            select(ProfileChangeRequest).where(
                ProfileChangeRequest.org_id == principal.org_id,
                ProfileChangeRequest.id == request.parent_request_id,
            )
        ).one_or_none()

    def latest_decision(target_request_id: UUID) -> ReviewDecision | None:
        return session.exec(
            select(ReviewDecision)
            .where(
                ReviewDecision.org_id == principal.org_id,
                ReviewDecision.request_id == target_request_id,
            )
            .order_by(col(ReviewDecision.created_at).desc(), col(ReviewDecision.id))
        ).first()

    decision = latest_decision(request.id)
    if decision is None and parent_request is not None:
        decision = latest_decision(parent_request.id)

    parent_decisions: dict[UUID, ItemDecision] = {}
    if parent_request is not None:
        for parent_item in session.exec(
            select(ChangeItem).where(
                ChangeItem.org_id == principal.org_id,
                ChangeItem.request_id == parent_request.id,
            )
        ).all():
            if parent_item.decision is not None:
                parent_decisions[parent_item.capability_definition_id] = (
                    parent_item.decision
                )

    rows = session.exec(
        select(ChangeItem, CapabilityDefinition)
        .join(
            CapabilityDefinition,
            (col(CapabilityDefinition.id) == ChangeItem.capability_definition_id)
            & (col(CapabilityDefinition.org_id) == ChangeItem.org_id),
        )
        .where(
            ChangeItem.org_id == principal.org_id,
            ChangeItem.request_id == request.id,
        )
        .order_by(col(ChangeItem.position))
    ).all()
    if not can_view_restricted:
        # Callers outside restricted scope can only view already-published items.
        rows = [
            (row, capability)
            for row, capability in rows
            if row.decision == ItemDecision.APPROVED
            and row.published_claim_id is not None
        ]
        if not rows:
            return None
    claim_ids = {row.target_claim_id for row, _ in rows if row.target_claim_id} | {
        row.published_claim_id for row, _ in rows if row.published_claim_id
    }
    claims = (
        {
            claim.id: claim
            for claim in session.exec(
                select(ProfileClaim).where(
                    ProfileClaim.org_id == principal.org_id,
                    col(ProfileClaim.id).in_(claim_ids),
                )
            ).all()
        }
        if claim_ids
        else {}
    )
    reviewer_name: str | None = None
    if decision is not None:
        if decision.via == ReviewVia.POLICY:
            reviewer_name = tr("按规则自动生效")
        elif decision.via == ReviewVia.SYNC:
            reviewer_name = tr("系统同步")
        elif can_view_restricted and decision.reviewer_user_id is not None:
            reviewer_name = _reviewer_display_name(
                session, principal.org_id, decision.reviewer_user_id
            )

    items: list[InboxChangeItemDetail] = []
    for row, capability in rows:
        item_decision = row.decision or parent_decisions.get(
            row.capability_definition_id
        )
        before_claim = claims.get(row.target_claim_id) if row.target_claim_id else None
        before = (
            InboxChangeClaimSnapshot(
                level=before_claim.level,
                statement=before_claim.statement,
                assessment_status=before_claim.assessment_status,
            )
            if before_claim is not None
            else None
        )
        after: InboxChangeClaimSnapshot | None = None
        if row.after is not None:
            parsed_after = ClaimAfter.model_validate(row.after)
            published_claim = (
                claims.get(row.published_claim_id) if row.published_claim_id else None
            )
            after = InboxChangeClaimSnapshot(
                level=parsed_after.level,
                statement=(
                    parsed_after.statement
                    if (can_view_restricted or item_decision == ItemDecision.APPROVED)
                    else tr("未发布的陈述仅本人、管辖经理和审批人可见")
                ),
                assessment_status=(
                    published_claim.assessment_status
                    if published_claim is not None
                    else parsed_after.assessment_status
                ),
            )
        items.append(
            InboxChangeItemDetail(
                id=row.id,
                op=row.op,
                capability_name=capability.name,
                capability_level_rubric=capability.level_rubric or {},
                before=before,
                after=after,
                decision=item_decision,
                decision_reason=row.decision_reason if can_view_restricted else None,
            )
        )
    decided_at = (
        decision.created_at
        if decision is not None
        else (
            parent_request.decided_at
            if parent_request is not None and request.decided_at is None
            else request.decided_at
        )
    )
    return InboxProfileRequestDetail(
        request_id=request.id,
        status=request.status,
        origin=request.origin,
        decided_at=decided_at,
        reviewer_name=reviewer_name,
        decision_comment=(
            decision.comment if (decision is not None and can_view_restricted) else None
        ),
        items=items,
    )


def read_inbox_detail(
    principal: Principal, session: Session, inbox_id: UUID
) -> InboxDetail:
    from app.domains.change_request.employee import EmployeeRecordNotFound

    scope = _recipient_scope(principal)
    if _capacity_provider is not None:
        found = _capacity_provider.fetch_one(session, scope, inbox_id)
    else:
        item_only = session.exec(
            select(InboxItem).where(scope, InboxItem.id == inbox_id)
        ).one_or_none()
        found = (item_only, None, None) if item_only is not None else None
    if found is None:
        raise EmployeeRecordNotFound()
    item, workload_request_id, extension_request_id = found
    projected = _project_inbox_items(
        principal, session, [(item, workload_request_id, extension_request_id)]
    )[0]
    return InboxDetail(
        item=projected,
        profile_request=(
            _profile_request_detail(principal, session, item.request_id)
            if item.request_id is not None
            else None
        ),
        workload_request=(
            _capacity_provider.workload_detail(principal, session, workload_request_id)
            if (_capacity_provider is not None and workload_request_id is not None)
            else None
        ),
        extension_request=(
            _capacity_provider.extension_detail(
                principal, session, projected.extension_request_id
            )
            if (
                _capacity_provider is not None
                and projected.extension_request_id is not None
            )
            else None
        ),
    )


def get_pending_questions(
    principal: Principal, session: Session, skip: int = 0, limit: int = 50
) -> QuestionsList:
    from app.domains.change_request.employee import employee_id

    query = select(PendingQuestion).where(
        PendingQuestion.org_id == principal.org_id,
        PendingQuestion.target_employee_id == employee_id(principal),
        PendingQuestion.status == QuestionStatus.OPEN,
    )
    count = session.exec(select(func.count()).select_from(query.subquery())).one()
    rows = session.exec(
        query.order_by(col(PendingQuestion.created_at).desc(), col(PendingQuestion.id))
        .offset(skip)
        .limit(limit)
    ).all()
    return QuestionsList(
        data=[QuestionPublic.model_validate(row) for row in rows], count=count
    )


def read_question(
    principal: Principal, session: Session, question_id: UUID
) -> QuestionPublic:
    return QuestionPublic.model_validate(_question(principal, session, question_id))


def _question(
    principal: Principal, session: Session, question_id: UUID
) -> PendingQuestion:
    from app.domains.change_request.employee import EmployeeRecordNotFound, employee_id

    question = session.exec(
        select(PendingQuestion)
        .where(
            PendingQuestion.org_id == principal.org_id,
            PendingQuestion.target_employee_id == employee_id(principal),
            PendingQuestion.id == question_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one_or_none()
    if question is None:
        raise EmployeeRecordNotFound()
    return question


def answer_question(
    principal: Principal, session: Session, question_id: UUID, answer: str
) -> QuestionPublic:
    from app.domains.change_request.employee import RequestConflict

    answer = AnswerInput(answer=answer).answer.strip()
    question = _question(principal, session, question_id)
    if question.status != QuestionStatus.OPEN:
        raise RequestConflict("问题已回答或已关闭")
    now = utc_now()
    evidence, _ = append_evidence(
        session,
        org_id=principal.org_id,
        subject_employee_id=question.target_employee_id,
        kind=EvidenceKind.SELF_REPORT,
        source="self_report:question",
        source_ref=str(question.id),
        title="员工补充回答",
        content={"question": question.question, "text": answer},
        visibility=Visibility.RESTRICTED,
        provenance={"question_id": str(question.id), "user_id": str(principal.user_id)},
        occurred_at=now,
    )
    question.answer_evidence_id = evidence.id
    question.status = QuestionStatus.ANSWERED
    question.answered_at = now
    session.exec(
        update(InboxItem)
        .where(
            col(InboxItem.org_id) == principal.org_id,
            col(InboxItem.recipient_employee_id) == question.target_employee_id,
            col(InboxItem.question_id) == question.id,
        )
        .values(done_at=now, read_at=func.coalesce(InboxItem.read_at, now))
    )
    record_audit(
        session,
        org_id=principal.org_id,
        actor_type=principal.actor_type,
        actor_id=str(principal.user_id),
        action="question.answered",
        target_type="pending_question",
        target_id=str(question.id),
        details={"evidence_id": str(evidence.id)},
    )
    session.flush()
    return QuestionPublic.model_validate(question)
