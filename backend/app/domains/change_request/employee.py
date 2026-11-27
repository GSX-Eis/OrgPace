from collections.abc import Sequence
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlmodel import Session, col, delete, select

from app.authz.principal import Principal
from app.domains.audit.service import record_audit
from app.domains.base import utc_now
from app.domains.capability.schemas import (
    ActiveSchemaPublic,
    CapabilitiesPublic,
    CapabilityPublic,
)
from app.domains.capability.service import get_schema, level_exists, list_capabilities
from app.domains.change_request.claim import (
    ITEMS_MAX,
    ClaimAfter,
    limit_message,
    text_limit,
)
from app.domains.change_request.models import (
    ChangeItem,
    ChangeItemEvidence,
    ChangeOp,
    ItemDecision,
    ProfileChangeRequest,
    RequestOrigin,
    RequestStatus,
    SubmissionVia,
)
from app.domains.change_request.schemas import (
    ChangeItemPublic,
    ChangeRequestPublic,
    ChangeRequestsPublic,
    ItemInput,
    PreviewItem,
    RequestPreview,
)
from app.domains.change_request.service import (
    list_requests,
    request_reviewers,
    transition,
)
from app.domains.evidence.models import (
    Evidence,
    EvidenceKind,
    EvidenceStatus,
    Visibility,
)
from app.domains.evidence.schemas import EvidenceList
from app.domains.evidence.service import (
    append_evidence,
    evidence_access,
    list_evidence,
    retract_evidence,
)
from app.domains.inbox.models import InboxKind
from app.domains.inbox.service import notify
from app.domains.org.models import Employee, Organization
from app.domains.org.service import visible_employee
from app.domains.org.timezone import read_timezone
from app.domains.profile.models import AssessmentStatus, EvidenceRelation, ProfileClaim
from app.domains.profile.schemas import ClaimPublic, ProfileView
from app.domains.profile.service import read_profile
from app.domains.review.policy import read_policy, read_policy_version, requires_manager
from app.i18n import bilingual, tr

EmployeeVia = Literal["web", "mcp", "import", "bot"]
IMMEDIATE_RETRACTION_NOTICE = "提交后立即撤回，能力状态变为未知"


class EmployeeRecordNotFound(HTTPException):
    def __init__(self) -> None:
        super().__init__(404, "记录不存在")


class RequestConflict(HTTPException):
    def __init__(self, message: str = "当前状态不允许此操作") -> None:
        super().__init__(409, message)


class InvalidItems(HTTPException):
    def __init__(self, errors: list[dict[str, int | str]]) -> None:
        self.errors = errors
        super().__init__(422, errors)


class ApprovalPolicyChanged(HTTPException):
    def __init__(self, refreshed: RequestPreview) -> None:
        self.preview = refreshed
        self.message = "审批规则已更新，请核对最新预览后再确认提交"
        super().__init__(
            409,
            {
                "code": "approval_policy_changed",
                "message": self.message,
                "preview": refreshed.model_dump(mode="json"),
            },
        )


class StaleInitialDraft(HTTPException):
    def __init__(self, items: list[PreviewItem], timezone: ZoneInfo) -> None:
        changed_items = tr("；").join(
            tr(
                "经理或管理员在 {time} 改过「{name}」",
                time=f"{item.current_changed_at.astimezone(timezone):%Y-%m-%d %H:%M}",
                name=item.after.capability.name,
            )
            for item in items
            if item.current_changed_at
        )
        self.message = tr("{items}，请先打开预览核对，再确认提交", items=changed_items)
        super().__init__(
            409,
            {
                "code": "stale_initial_draft",
                "message": self.message,
                "capabilities": [
                    {
                        "key": item.after.capability.key,
                        "name": item.after.capability.name,
                        "changed_at": item.current_changed_at.isoformat(),
                    }
                    for item in items
                    if item.current_changed_at
                ],
            },
        )


def employee_id(principal: Principal) -> UUID:
    if principal.employee_id is None:
        raise EmployeeRecordNotFound()
    return principal.employee_id


def my_profile(principal: Principal, session: Session) -> ProfileView:
    return read_profile(session, principal, employee_id(principal))


def my_evidence(
    principal: Principal,
    session: Session,
    kind: EvidenceKind | None = None,
    include_inactive: bool = False,
    skip: int = 0,
    limit: int = 50,
) -> EvidenceList:
    return list_evidence(
        session,
        principal,
        employee_id(principal),
        kind=kind,
        include_inactive=include_inactive,
        skip=skip,
        limit=limit,
    )


def my_requests(
    principal: Principal, session: Session, status: Literal["open", "all"] = "open"
) -> ChangeRequestsPublic:
    return list_requests(session, principal, employee_id(principal), status)


def capability_dictionary(principal: Principal, session: Session) -> CapabilitiesPublic:
    visible_employee(session, principal, employee_id(principal))
    schema = get_schema(session, principal.org_id)
    return CapabilitiesPublic(
        schema_version=ActiveSchemaPublic.model_validate(schema),
        data=[
            CapabilityPublic.model_validate(c)
            for c in list_capabilities(session, principal.org_id, schema.id)
        ],
    )


def _request(
    principal: Principal, session: Session, request_id: UUID
) -> ProfileChangeRequest:
    row = session.exec(
        select(ProfileChangeRequest)
        .where(
            ProfileChangeRequest.org_id == principal.org_id,
            ProfileChangeRequest.subject_employee_id == employee_id(principal),
            ProfileChangeRequest.id == request_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one_or_none()
    if row is None:
        raise EmployeeRecordNotFound()
    return row


def _public(
    principal: Principal, session: Session, request_id: UUID
) -> ChangeRequestPublic:
    session.flush()
    return list_requests(
        session, principal, employee_id(principal), "all", request_id
    ).data[0]


def _has_extra_change(
    owner_statement: str | None,
    objection: str | None,
    uncertainty: str | None,
    evidence_ids: Sequence[UUID],
    target: ClaimPublic | None,
) -> bool:
    if any((text or "").strip() for text in (owner_statement, objection, uncertainty)):
        return True
    existing = {e.evidence_id for e in target.evidence} if target else set()
    return bool(set(evidence_ids) - existing)


def is_unchanged_item(
    item: ItemInput, target: ClaimPublic | None, *, check_attach: bool = True
) -> bool:
    if target is None:
        return False
    if item.op == ChangeOp.MODIFY:
        return (
            item.statement == target.statement
            and item.level == target.level
            and not _has_extra_change(
                item.owner_statement,
                item.objection,
                item.uncertainty,
                item.evidence_ids,
                target,
            )
        )
    if check_attach and item.op == ChangeOp.ATTACH_EVIDENCE:
        return not _has_extra_change(
            item.owner_statement,
            item.objection,
            item.uncertainty,
            item.evidence_ids,
            target,
        )
    return False


def _is_preview_unchanged(item: ChangeItemPublic, before: ClaimPublic | None) -> bool:
    if before is None or item.op != ChangeOp.MODIFY or item.after is None:
        return False
    return (
        item.after.statement == before.statement
        and item.after.level == before.level
        and not _has_extra_change(
            item.owner_statement,
            item.objection,
            item.uncertainty,
            [e.evidence_id for e in item.evidence],
            before,
        )
    )


def _effective_items(
    public: ChangeRequestPublic,
    claims: dict[str, ClaimPublic],
    *,
    align_initial: bool,
) -> list[tuple[ChangeItemPublic, ClaimPublic | None]]:
    effective: list[tuple[ChangeItemPublic, ClaimPublic | None]] = []
    for item in public.items:
        current = claims.get(item.capability.key)
        before = (
            current
            if align_initial or (current and current.id == item.target_claim_id)
            else None
        )
        if align_initial:
            if item.op in (ChangeOp.ADD, ChangeOp.MODIFY):
                item.op = ChangeOp.MODIFY if current else ChangeOp.ADD
            item.target_claim_id = current.id if current else None
        if _is_preview_unchanged(item, before):
            continue
        effective.append((item, before))
    return effective


def _validate(
    principal: Principal,
    session: Session,
    items: list[ItemInput],
    *,
    align_initial: bool = False,
    request_id: UUID | None = None,
    submitting: bool = False,
) -> tuple[dict[str, CapabilityPublic], dict[str, ClaimPublic]]:
    capabilities = {c.key: c for c in capability_dictionary(principal, session).data}
    current = {
        i.capability.key: i.claim
        for i in my_profile(principal, session).items
        if i.claim
    }
    access = evidence_access(
        session, principal, {id_ for i in items for id_ in i.evidence_ids}
    )
    errors: list[dict[str, int | str]] = []
    if len(items) > ITEMS_MAX:
        errors.append({"index": 0, "message": limit_message("items", len(items))})
    stored = (
        {
            row.capability_definition_id: row
            for row in session.exec(
                select(ChangeItem).where(
                    ChangeItem.org_id == principal.org_id,
                    ChangeItem.request_id == request_id,
                )
            ).all()
        }
        if request_id
        else {}
    )
    seen: set[str] = set()
    for index, item in enumerate(items):
        if align_initial and item.op in (ChangeOp.ADD, ChangeOp.MODIFY):
            item.op = (
                ChangeOp.MODIFY if item.capability_key in current else ChangeOp.ADD
            )
        messages = []
        capability = capabilities.get(item.capability_key)
        old = stored.get(capability.id) if capability else None
        target = current.get(item.capability_key)
        if item.op in (ChangeOp.ADD, ChangeOp.MODIFY):
            previous = target.statement if target else None
            if item.statement != previous and not submitting and old and old.after:
                previous = ClaimAfter.model_validate(old.after).statement
            message = text_limit("statement", item.statement, index, previous)
            if message:
                messages.append(message)
        for field in ("owner_statement", "objection", "uncertainty", "explanation"):
            value = (
                getattr(old, field)
                if submitting and old
                else getattr(item, field, None)
            )
            previous_text = getattr(old, field) if old and not submitting else None
            message = text_limit(field, value, index, previous_text)
            if message:
                messages.append(message)
        if capability is None:
            messages.append(tr("能力编码不在当前启用的词典中"))
        elif item.level is not None:
            levels = (capability.level_rubric or {}).get("levels", [])
            if not isinstance(levels, list) or item.level not in {
                v.get("key") for v in levels if isinstance(v, dict)
            }:
                messages.append(tr("等级编码不在该能力的等级中"))
        if item.capability_key in seen:
            messages.append(tr("同一能力不能重复修改"))
        seen.add(item.capability_key)
        if item.op != ChangeOp.ADD and item.capability_key not in current:
            messages.append(tr("目标不是本人当前判断"))
        if item.op == ChangeOp.ADD and item.capability_key in current:
            messages.append(tr("该能力已有判断，请使用修改"))
        elif (
            target is not None
            and (
                not submitting
                or align_initial
                or old is None
                or old.target_claim_id == target.id
            )
            and is_unchanged_item(item, target, check_attach=submitting)
        ):
            messages.append(tr("内容与当前画像一致，没有实际改动"))
        if any(
            id_ not in access
            or not access[id_][1]
            or access[id_][0].subject_employee_id != principal.employee_id
            for id_ in item.evidence_ids
        ):
            messages.append(tr("依据必须是本人可见的证据"))
        elif not submitting and any(
            access[id_][0].status != EvidenceStatus.ACTIVE for id_ in item.evidence_ids
        ):
            messages.append(tr("不能引用已撤销或已更正的证据"))
        errors.extend({"index": index, "message": message} for message in messages)
    if errors:
        raise InvalidItems(errors)
    return capabilities, current


def _lock_organization(principal: Principal, session: Session) -> None:
    session.exec(
        select(Organization)
        .where(Organization.id == principal.org_id)
        .with_for_update(read=True)
    ).one()


def _can_clone_source(
    session: Session, principal: Principal, source: ProfileChangeRequest
) -> bool:
    if source.status in (
        RequestStatus.WITHDRAWN,
        RequestStatus.REJECTED,
        RequestStatus.CHANGES_REQUESTED,
    ):
        return True
    if source.status == RequestStatus.APPROVED:
        return (
            session.exec(
                select(ChangeItem.id)
                .where(
                    ChangeItem.org_id == principal.org_id,
                    ChangeItem.request_id == source.id,
                    col(ChangeItem.decision).in_(
                        [ItemDecision.REJECTED, ItemDecision.CHANGES_REQUESTED]
                    ),
                )
                .limit(1)
            ).first()
            is not None
        )
    return False


def save_draft(
    principal: Principal,
    session: Session,
    request_id: UUID | None,
    items: list[ItemInput],
    via: EmployeeVia,
    client_name: str | None = None,
    *,
    withdrawn_request_id: UUID | None = None,
) -> ChangeRequestPublic:
    _lock_organization(principal, session)
    request = _request(principal, session, request_id) if request_id else None
    if request and request.status not in (
        RequestStatus.DRAFT,
        RequestStatus.PENDING_OWNER,
    ):
        raise RequestConflict()
    source = request
    resubmit_parent_id: UUID | None = None
    if withdrawn_request_id is not None:
        source = _request(principal, session, withdrawn_request_id)
        if not _can_clone_source(session, principal, source):
            raise RequestConflict()
        if source.status != RequestStatus.WITHDRAWN:
            resubmit_parent_id = source.id
            if request is None:
                existing_child = session.exec(
                    select(ProfileChangeRequest)
                    .where(
                        ProfileChangeRequest.org_id == principal.org_id,
                        ProfileChangeRequest.subject_employee_id
                        == employee_id(principal),
                        ProfileChangeRequest.parent_request_id == source.id,
                        ProfileChangeRequest.status != RequestStatus.WITHDRAWN,
                    )
                    .order_by(
                        col(ProfileChangeRequest.created_at).desc(),
                        col(ProfileChangeRequest.id),
                    )
                    .with_for_update()
                ).first()
                if existing_child is not None:
                    if existing_child.status in (
                        RequestStatus.DRAFT,
                        RequestStatus.PENDING_OWNER,
                    ):
                        request = existing_child
                    else:
                        raise RequestConflict("该请求已重提，请从最新一单继续修改")
    capabilities, current = _validate(
        principal,
        session,
        items,
        align_initial=request is not None
        and request.origin == RequestOrigin.INITIAL_SYNC,
        request_id=request.id if request else None,
    )
    relations = (
        {
            (item.capability.key, evidence.evidence_id): evidence.relation
            for item in _public(principal, session, source.id).items
            if item.decision != ItemDecision.APPROVED
            for evidence in item.evidence
        }
        if source
        else {}
    )
    if request is None:
        request = ProfileChangeRequest(
            org_id=principal.org_id,
            subject_employee_id=employee_id(principal),
            parent_request_id=resubmit_parent_id,
            origin={
                "web": RequestOrigin.MANUAL,
                "mcp": RequestOrigin.CONVERSATION,
                "bot": RequestOrigin.CONVERSATION,
                "import": RequestOrigin.IMPORT,
            }[via],
            status=RequestStatus.DRAFT,
            author={
                "actor_type": principal.actor_type,
                "user_id": str(principal.user_id),
            },
            client_name=client_name,
        )
        session.add(request)
        session.flush()
    else:
        request.status = RequestStatus.DRAFT
        request.revision += 1
    request.updated_at = utc_now()
    old = select(ChangeItem.id).where(
        ChangeItem.org_id == principal.org_id, ChangeItem.request_id == request.id
    )
    session.exec(
        delete(ChangeItemEvidence).where(
            col(ChangeItemEvidence.org_id) == principal.org_id,
            col(ChangeItemEvidence.item_id).in_(old),
        )
    )
    session.exec(
        delete(ChangeItem).where(
            col(ChangeItem.org_id) == principal.org_id,
            col(ChangeItem.request_id) == request.id,
        )
    )
    rows = [
        ChangeItem(
            org_id=principal.org_id,
            request_id=request.id,
            position=position,
            op=item.op,
            capability_definition_id=capabilities[item.capability_key].id,
            target_claim_id=current[item.capability_key].id
            if item.op != ChangeOp.ADD
            else None,
            after=ClaimAfter(
                statement=item.statement,
                level=item.level,
                assessment_status=AssessmentStatus.TENTATIVE,
            ).model_dump(mode="json")
            if item.op in (ChangeOp.ADD, ChangeOp.MODIFY)
            else None,
            owner_statement=item.owner_statement,
            objection=item.objection,
            uncertainty=item.uncertainty,
        )
        for position, item in enumerate(items)
    ]
    session.add_all(rows)
    session.flush()
    session.add_all(
        [
            ChangeItemEvidence(
                org_id=principal.org_id,
                item_id=row.id,
                evidence_id=id_,
                relation=relations.get(
                    (item.capability_key, id_), EvidenceRelation.SUPPORTS
                ),
            )
            for row, item in zip(rows, items, strict=True)
            for id_ in set(item.evidence_ids)
        ]
    )
    return _public(principal, session, request.id)


def preview(
    principal: Principal,
    session: Session,
    request_id: UUID,
    *,
    for_submission: bool = False,
) -> RequestPreview:
    _lock_organization(principal, session)
    request = _request(principal, session, request_id)
    if for_submission and request.status not in (
        RequestStatus.DRAFT,
        RequestStatus.PENDING_OWNER,
    ):
        raise RequestConflict()
    public = _public(principal, session, request.id)
    profile = my_profile(principal, session)
    claims = {i.capability.key: i.claim for i in profile.items if i.claim}
    initial = request.origin == RequestOrigin.INITIAL_SYNC and request.status in (
        RequestStatus.PENDING_OWNER,
        RequestStatus.DRAFT,
    )
    changed = (
        {
            row.id: row.created_at
            for row in session.exec(
                select(ProfileClaim).where(
                    ProfileClaim.org_id == principal.org_id,
                    ProfileClaim.subject_employee_id == employee_id(principal),
                    col(ProfileClaim.id).in_([c.id for c in claims.values()]),
                    col(ProfileClaim.generated_by)["via"].astext == "direct",
                    ProfileClaim.created_at > request.created_at,
                )
            ).all()
        }
        if initial
        else {}
    )
    policy = read_policy(session, principal.org_id)
    auto_publish_count = 0
    previews = []
    for item, before in _effective_items(public, claims, align_initial=initial):
        if requires_manager(policy, item.capability.category):
            submission_notice = tr("提交后需经理确认")
        else:
            auto_publish_count += 1
            submission_notice = (
                tr(IMMEDIATE_RETRACTION_NOTICE)
                if item.op == ChangeOp.RETRACT
                else tr("本能力无需经理确认，提交后将直接发布为暂定")
            )
        previews.append(
            PreviewItem(
                before=before,
                after=item,
                submission_notice=submission_notice,
                current_changed_at=changed.get(before.id) if before else None,
                warning=tr("等级已调整，请重新选择或清空")
                if item.after
                and not level_exists(item.capability.level_rubric, item.after.level)
                else tr("请选择等级")
                if request.origin == RequestOrigin.ASSIGNMENT_FEEDBACK
                and item.op == ChangeOp.ADD
                and item.after
                and item.after.level is None
                and (item.capability.level_rubric or {}).get("levels")
                else None,
            )
        )
    return RequestPreview(
        request_id=request.id,
        revision=request.revision,
        policy_version=policy.version,
        base_revision=profile.latest_published.revision
        if profile.latest_published
        else None,
        reviewers=request_reviewers(session, principal.org_id, employee_id(principal)),
        items=previews,
        requires_manager=not previews or auto_publish_count < len(previews),
        partial_auto_publish=0 < auto_publish_count < len(previews),
    )


def submit(
    principal: Principal,
    session: Session,
    request_id: UUID,
    revision: int,
    via: EmployeeVia,
    client_name: str | None = None,
    base_revision: int | None = None,
    policy_version: int | None = None,
) -> ChangeRequestPublic:
    # Match the lock order used by manager publishing and dictionary changes.
    _lock_organization(principal, session)
    request = _request(principal, session, request_id)
    session.exec(
        select(Employee)
        .where(
            Employee.org_id == principal.org_id, Employee.id == employee_id(principal)
        )
        .with_for_update()
    ).one()
    if request.revision != revision:
        raise RequestConflict("内容已更新，请重新预览")
    if request.status not in (RequestStatus.DRAFT, RequestStatus.PENDING_OWNER):
        raise RequestConflict()
    if request.origin == RequestOrigin.INITIAL_SYNC:
        confirmation = preview(principal, session, request_id)
        changed = [i for i in confirmation.items if i.current_changed_at]
        if changed and base_revision != confirmation.base_revision:
            raise StaleInitialDraft(
                changed, ZoneInfo(read_timezone(session, principal.org_id).timezone)
            )
    items = session.exec(
        select(ChangeItem)
        .where(
            ChangeItem.org_id == principal.org_id, ChangeItem.request_id == request.id
        )
        .order_by(col(ChangeItem.position))
    ).all()
    if not items:
        raise InvalidItems([{"index": 0, "message": tr("至少需要一项改动")}])
    public = _public(principal, session, request.id)
    initial = request.origin == RequestOrigin.INITIAL_SYNC
    claims = {
        i.capability.key: i.claim
        for i in my_profile(principal, session).items
        if i.claim
    }
    effective_public = [
        item for item, _ in _effective_items(public, claims, align_initial=initial)
    ]
    if not effective_public:
        raise InvalidItems(
            [{"index": 0, "message": tr("内容与当前画像一致，没有实际改动")}]
        )
    if request.origin == RequestOrigin.ASSIGNMENT_FEEDBACK:
        missing_levels: list[dict[str, int | str]] = [
            {"index": index, "message": tr("请选择等级")}
            for index, item in enumerate(effective_public)
            if item.op == ChangeOp.ADD
            and item.after
            and item.after.level is None
            and (item.capability.level_rubric or {}).get("levels")
        ]
        if missing_levels:
            raise InvalidItems(missing_levels)
    inputs = [
        ItemInput(
            op=i.op,
            capability_key=i.capability.key,
            statement=i.after.statement if i.after else "撤回或补充依据",
            level=i.after.level if i.after else None,
            owner_statement=i.owner_statement,
            objection=i.objection,
            uncertainty=i.uncertainty,
            evidence_ids=[e.evidence_id for e in i.evidence],
        )
        for i in effective_public
    ]
    _, current = _validate(
        principal,
        session,
        inputs,
        align_initial=initial,
        request_id=request.id,
        submitting=True,
    )
    if policy_version is not None:
        current_policy = read_policy(session, principal.org_id)
        if policy_version != current_policy.version:
            preview_policy = read_policy_version(
                session, principal.org_id, policy_version
            )
            if preview_policy is None or any(
                requires_manager(preview_policy, item.capability.category)
                != requires_manager(current_policy, item.capability.category)
                for item in effective_public
            ):
                raise ApprovalPolicyChanged(
                    preview(principal, session, request_id, for_submission=True)
                )
    effective_ids = {item.id for item in effective_public}
    dropped_ids = [row.id for row in items if row.id not in effective_ids]
    if dropped_ids:
        session.exec(
            delete(ChangeItemEvidence).where(
                col(ChangeItemEvidence.org_id) == principal.org_id,
                col(ChangeItemEvidence.item_id).in_(dropped_ids),
            )
        )
        session.exec(
            delete(ChangeItem).where(
                col(ChangeItem.org_id) == principal.org_id,
                col(ChangeItem.id).in_(dropped_ids),
            )
        )
        items = [row for row in items if row.id in effective_ids]
    if initial:
        for item, value in zip(items, inputs, strict=True):
            item.op = value.op
            target = current.get(value.capability_key)
            item.target_claim_id = target.id if target else None
    transition(request, RequestStatus.PENDING_REVIEW)
    request.submitted_via, request.client_name, request.submitted_at = (
        SubmissionVia(via),
        client_name,
        utc_now(),
    )
    for item in items:
        for statement, relation in (
            (item.owner_statement, EvidenceRelation.SUPPORTS),
            (item.objection, EvidenceRelation.CONTRADICTS),
        ):
            if not statement:
                continue
            evidence, _ = append_evidence(
                session,
                org_id=principal.org_id,
                subject_employee_id=employee_id(principal),
                kind=EvidenceKind.SELF_REPORT,
                source=f"self_report:{via}",
                source_ref=str(item.id),
                title="员工依据说明"
                if relation == EvidenceRelation.SUPPORTS
                else "员工异议",
                content={"statement": statement, "relation": relation},
                visibility=Visibility.RESTRICTED,
                provenance={
                    "via": via,
                    "client_name": client_name,
                    "request_id": str(request.id),
                    **(
                        {"imported_by": request.author["user_id"]}
                        if request.origin == RequestOrigin.IMPORT
                        and request.author.get("user_id")
                        and request.author["user_id"] != str(principal.user_id)
                        else {}
                    ),
                },
            )
            session.add(
                ChangeItemEvidence(
                    org_id=principal.org_id,
                    item_id=item.id,
                    evidence_id=evidence.id,
                    relation=relation,
                )
            )
    record_audit(
        session,
        org_id=principal.org_id,
        actor_type=principal.actor_type,
        actor_id=str(principal.user_id),
        action="change_request.submitted",
        target_type="profile_change_request",
        target_id=str(request.id),
        details={"via": via, "client_name": client_name, "revision": revision},
    )
    from app.domains.review.policy import apply_policy

    session.flush()
    apply_policy(session, principal, request, list(items))
    if all(i.decision == ItemDecision.APPROVED for i in items):
        msg_zh, msg_en = bilingual("请求已按审批规则发布为暂定，请查看逐项结果")
    elif any(i.decision == ItemDecision.APPROVED for i in items):
        msg_zh, msg_en = bilingual(
            "部分改动已按审批规则发布为暂定，其余改动等待经理审批"
        )
    elif via in ("mcp", "import"):
        msg_zh, msg_en = bilingual(
            "你通过 {source} 提交了一个请求，经理批准前可以撤回",
            source=client_name or via,
        )
    else:
        msg_zh, msg_en = bilingual("请求已提交，经理批准前可以撤回")
    notify(session, request, InboxKind.SUBMITTED, msg_zh, message_en=msg_en)
    from app.domains.review.routing import notify_reviewers

    if any(i.decision is None for i in items):
        notify_reviewers(session, request)
    return _public(principal, session, request.id)


def withdraw(
    principal: Principal, session: Session, request_id: UUID
) -> ChangeRequestPublic:
    request = _request(principal, session, request_id)
    if request.status not in (RequestStatus.DRAFT, RequestStatus.PENDING_REVIEW):
        raise RequestConflict()
    transition(request, RequestStatus.WITHDRAWN)
    published_items = {
        str(id_)
        for id_ in session.exec(
            select(ChangeItem.id).where(
                ChangeItem.org_id == principal.org_id,
                ChangeItem.request_id == request.id,
                ChangeItem.decision == ItemDecision.APPROVED,
            )
        ).all()
    }
    records = session.exec(
        select(Evidence)
        .where(
            Evidence.org_id == principal.org_id,
            Evidence.subject_employee_id == employee_id(principal),
            Evidence.kind == EvidenceKind.SELF_REPORT,
            Evidence.source == f"self_report:{request.submitted_via}",
            col(Evidence.provenance)["request_id"].astext == str(request.id),
            Evidence.status == EvidenceStatus.ACTIVE,
        )
        .order_by(col(Evidence.id))
    ).all()
    for evidence in records:
        if evidence.source_ref in published_items:
            continue
        retract_evidence(
            session,
            evidence=evidence,
            reason="员工撤回请求",
            actor_type=principal.actor_type,
            actor_id=str(principal.user_id),
        )
    record_audit(
        session,
        org_id=principal.org_id,
        actor_type=principal.actor_type,
        actor_id=str(principal.user_id),
        action="change_request.withdrawn",
        target_type="profile_change_request",
        target_id=str(request.id),
        details={},
    )
    msg_zh, msg_en = bilingual("请求已撤回")
    notify(session, request, InboxKind.STATUS_CHANGED, msg_zh, message_en=msg_en)
    return _public(principal, session, request.id)
