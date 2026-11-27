from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Uuid, any_, literal
from sqlalchemy.dialects.postgresql import ARRAY
from sqlmodel import Session, col, select

from app.authz.principal import Principal
from app.domains.audit.models import ActorKind
from app.domains.capability.models import CapabilityDefinition, DepartmentCapability
from app.domains.capability.service import get_schema, list_capabilities
from app.domains.capability.stats import CapabilityStatsForbidden, latest_profiles
from app.domains.change_request.models import ChangeItem
from app.domains.evidence.models import (
    ASSIGNMENT_FEEDBACK_SOURCE,
    Evidence,
    EvidenceStatus,
)
from app.domains.org.models import Department, Employee, Organization
from app.domains.org.service import managed_scope
from app.domains.profile.models import AssessmentStatus, ProfileVersion
from app.domains.profile.schemas import (
    ProfileVersionSummary,
    PublisherPublic,
    SnapshotClaim,
)
from app.domains.profile.service import version_summaries
from app.domains.review.models import AppealStatus, ReviewAppeal

SearchStatus = Literal[
    AssessmentStatus.CONFIRMED, AssessmentStatus.TENTATIVE, AssessmentStatus.DISPUTED
]


class PeopleSearchInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capability_key: str = Field(min_length=1, max_length=200)
    minimum_level: str | None = Field(default=None, max_length=200)
    include_ungraded: bool = False
    statuses: list[SearchStatus] = Field(default_factory=list)
    evidence_from: date | None = None
    evidence_to: date | None = None
    department_id: UUID | None = None
    department_capability_only: bool = False
    job_family: str | None = Field(default=None, max_length=50)
    work_location: str | None = Field(default=None, max_length=50)
    hire_date_from: date | None = None
    hire_date_to: date | None = None
    skip: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


class PeopleSearchRow(BaseModel):
    employee_id: UUID
    display_name: str
    employee_code: str | None
    department_name: str | None
    capability_key: str
    capability_name: str
    statement: str
    level: str | None
    level_name: str | None
    status: SearchStatus
    evidence_count: int
    latest_evidence_at: datetime | None
    latest_evidence_date: date | None
    published_by: PublisherPublic
    published_at: datetime


class PeopleSearchResult(BaseModel):
    data: list[PeopleSearchRow]
    count: int
    timezone: str


class ExportedClaimRow(BaseModel):
    employee_code: str | None
    capability_key: str
    capability_name: str
    level: str | None
    level_name: str | None
    status: str
    evidence_count: int
    latest_evidence_at: datetime | None
    published_by: str
    published_at: datetime
    in_current_dictionary: bool


class PeopleSearchInvalid(HTTPException):
    def __init__(self, detail: str) -> None:
        super().__init__(422, detail)


def find_people(
    session: Session, principal: Principal, args: PeopleSearchInput
) -> PeopleSearchResult:
    if (
        principal.actor_type != ActorKind.SYSTEM_WORKER
        and not principal.is_org_admin
        and not principal.managed_department_ids
    ):
        raise CapabilityStatsForbidden()
    for start, end in (
        (args.evidence_from, args.evidence_to),
        (args.hire_date_from, args.hire_date_to),
    ):
        if start and end and start > end:
            raise PeopleSearchInvalid("起始日期不能晚于结束日期")
    schema = get_schema(session, principal.org_id)
    capability = next(
        (
            c
            for c in list_capabilities(session, principal.org_id, schema.id)
            if c.key == args.capability_key
        ),
        None,
    )
    if capability is None:
        raise PeopleSearchInvalid("能力不在当前启用的词典中")
    labels = _level_labels(capability)
    ranks = {level: i for i, level in enumerate(labels)}
    if args.minimum_level is not None and args.minimum_level not in ranks:
        raise PeopleSearchInvalid("最低等级不在当前能力的等级描述中")
    if (
        args.department_id
        and principal.actor_type != ActorKind.SYSTEM_WORKER
        and not principal.is_org_admin
        and args.department_id not in principal.managed_department_ids
    ):
        raise CapabilityStatsForbidden()
    department_ids = (
        managed_scope(session, principal.org_id, frozenset({args.department_id}))
        if args.department_id
        else None
    )
    configured = None
    if args.department_capability_only:
        assigned = session.exec(
            select(DepartmentCapability.department_id).where(
                DepartmentCapability.org_id == principal.org_id,
                DepartmentCapability.capability_key == args.capability_key,
            )
        ).all()
        configured = managed_scope(session, principal.org_id, frozenset(assigned))
    fields, org_timezone = session.exec(
        select(Organization.employee_fields, Organization.timezone).where(
            Organization.id == principal.org_id
        )
    ).one()
    tz = ZoneInfo(org_timezone)
    definition_ids = set(
        session.exec(
            select(CapabilityDefinition.id).where(
                CapabilityDefinition.org_id == principal.org_id,
                CapabilityDefinition.key == args.capability_key,
            )
        ).all()
    )
    departments = dict(
        session.exec(
            select(Department.id, Department.name).where(
                Department.org_id == principal.org_id
            )
        ).all()
    )
    # shortcut: scan latest snapshots for a few thousand employees; index claims at larger scale.
    candidates: list[_ClaimCandidate] = []
    for employee, version in latest_profiles(session, principal):
        if department_ids is not None and employee.department_id not in department_ids:
            continue
        if configured is not None and employee.department_id not in configured:
            continue
        if any(
            field in fields and value is not None and getattr(employee, field) != value
            for field, value in (
                ("job_family", args.job_family),
                ("work_location", args.work_location),
            )
        ):
            continue
        if "hire_date" in fields and (
            (
                args.hire_date_from
                and (not employee.hire_date or employee.hire_date < args.hire_date_from)
            )
            or (
                args.hire_date_to
                and (not employee.hire_date or employee.hire_date > args.hire_date_to)
            )
        ):
            continue
        for claim in snapshot_claims(version):
            if claim.capability_definition_id not in definition_ids:
                continue
            if args.minimum_level is not None and (
                (claim.level is None and not args.include_ungraded)
                or (
                    claim.level is not None
                    and ranks.get(claim.level, -1) < ranks[args.minimum_level]
                )
            ):
                continue
            candidates.append((employee, claim, capability.key))
    rows = []
    for (employee, claim, _), details in _published_claim_details(
        session, principal, candidates
    ):
        if args.statuses and details.status not in args.statuses:
            continue
        latest = details.latest_evidence_at
        local_date = latest.astimezone(tz).date() if latest else None
        if (
            args.evidence_from
            and (local_date is None or local_date < args.evidence_from)
        ) or (
            args.evidence_to and (local_date is None or local_date > args.evidence_to)
        ):
            continue
        rows.append(
            PeopleSearchRow(
                employee_id=employee.id,
                display_name=employee.display_name,
                employee_code=employee.employee_code,
                department_name=departments.get(employee.department_id)
                if employee.department_id
                else None,
                capability_key=capability.key,
                capability_name=capability.name,
                statement=claim.statement,
                level=claim.level,
                level_name=labels.get(claim.level, claim.level)
                if claim.level
                else None,
                status=details.status,
                evidence_count=details.evidence_count,
                latest_evidence_at=latest,
                latest_evidence_date=local_date,
                published_by=details.publisher.published_by,
                published_at=details.publisher.published_at,
            )
        )
    rows.sort(
        key=lambda row: _row_sort_key(
            ranks.get(row.level, -1) if row.level else -1,
            row.latest_evidence_at,
            row.employee_id,
        )
    )
    return PeopleSearchResult(
        data=rows[args.skip : args.skip + args.limit],
        count=len(rows),
        timezone=org_timezone,
    )


def export_published_claims(
    session: Session, principal: Principal
) -> list[ExportedClaimRow]:
    if not principal.is_org_admin and not principal.managed_department_ids:
        raise CapabilityStatsForbidden()
    org_id = principal.org_id
    schema = get_schema(session, org_id)
    current_by_key = {c.key: c for c in list_capabilities(session, org_id, schema.id)}
    order = {key: i for i, key in enumerate(current_by_key)}
    claims = [
        (employee, claim)
        for employee, version in latest_profiles(session, principal)
        if principal.is_org_admin
        or employee.department_id in principal.managed_department_ids
        for claim in snapshot_claims(version)
        if claim.assessment_status != AssessmentStatus.UNKNOWN
    ]
    definitions = {
        c.id: c
        for c in session.exec(
            select(CapabilityDefinition).where(
                CapabilityDefinition.org_id == org_id,
                col(CapabilityDefinition.id).in_(
                    {claim.capability_definition_id for _, claim in claims}
                ),
            )
        ).all()
    }
    candidates = [
        (employee, claim, definition.key)
        for employee, claim in claims
        if (definition := definitions.get(claim.capability_definition_id)) is not None
    ]
    rows = []
    for (employee, claim, key), details in _published_claim_details(
        session, principal, candidates
    ):
        current = current_by_key.get(key)
        capability = current or definitions[claim.capability_definition_id]
        labels = _level_labels(capability)
        level_name = labels.get(claim.level, claim.level) if claim.level else None
        rank = (
            list(labels).index(claim.level)
            if claim.level and claim.level in labels
            else -1
        )
        sort_key = (
            order.get(key, len(order)),
            key,
            _row_sort_key(rank, details.latest_evidence_at, employee.id),
        )
        rows.append(
            (
                sort_key,
                ExportedClaimRow(
                    employee_code=employee.employee_code,
                    capability_key=key,
                    capability_name=capability.name,
                    level=claim.level,
                    level_name=level_name,
                    status=details.status,
                    evidence_count=details.evidence_count,
                    latest_evidence_at=details.latest_evidence_at,
                    published_by=details.publisher.published_by.display_name
                    or details.publisher.published_by.actor_type,
                    published_at=details.publisher.published_at,
                    in_current_dictionary=current is not None,
                ),
            )
        )
    rows.sort(key=lambda entry: entry[0])
    return [row for _, row in rows]


def _level_labels(capability: CapabilityDefinition) -> dict[str, str]:
    raw_levels = (capability.level_rubric or {}).get("levels", [])
    levels = (
        [v for v in raw_levels if isinstance(v, dict)]
        if isinstance(raw_levels, list)
        else []
    )
    return {str(v["key"]): str(v.get("label") or v["key"]) for v in levels}


def _row_sort_key(
    rank: int, latest: datetime | None, employee_id: UUID
) -> tuple[int, float, str]:
    return -rank, -(latest.timestamp() if latest else float("-inf")), str(employee_id)


type _ClaimCandidate = tuple[Employee, SnapshotClaim, str]


@dataclass
class _ClaimDetails:
    status: SearchStatus
    evidence_count: int
    latest_evidence_at: datetime | None
    publisher: ProfileVersionSummary


def _published_claim_details(
    session: Session, principal: Principal, candidates: list[_ClaimCandidate]
) -> Iterator[tuple[_ClaimCandidate, _ClaimDetails]]:
    if not candidates:
        return
    employee_ids = {e.id for e, _, _ in candidates}
    # Same open-appeal source and capability-key matching as profile/service.py.
    disputes = set(
        session.exec(
            select(ReviewAppeal.employee_id, CapabilityDefinition.key)
            .join(
                ChangeItem,
                (col(ChangeItem.id) == ReviewAppeal.item_id)
                & (col(ChangeItem.org_id) == ReviewAppeal.org_id),
            )
            .join(
                CapabilityDefinition,
                (col(CapabilityDefinition.id) == ChangeItem.capability_definition_id)
                & (col(CapabilityDefinition.org_id) == ChangeItem.org_id),
            )
            .where(
                ReviewAppeal.org_id == principal.org_id,
                col(ReviewAppeal.employee_id).in_(employee_ids),
                ReviewAppeal.status == AppealStatus.OPEN,
            )
        ).all()
    )
    evidence_ids = {ref.evidence_id for _, c, _ in candidates for ref in c.evidence}
    evidence = {
        id: (
            subject,
            occurred.replace(tzinfo=UTC)
            if occurred and not occurred.tzinfo
            else occurred,
        )
        for id, subject, occurred in session.exec(
            select(
                Evidence.id, Evidence.subject_employee_id, Evidence.occurred_at
            ).where(
                Evidence.org_id == principal.org_id,
                col(Evidence.id) == any_(literal(list(evidence_ids), ARRAY(Uuid))),
                Evidence.status == EvidenceStatus.ACTIVE,
                Evidence.source != ASSIGNMENT_FEEDBACK_SOURCE,
            )
        ).all()
    }
    versions = list(
        session.exec(
            select(ProfileVersion)
            .where(
                ProfileVersion.org_id == principal.org_id,
                col(ProfileVersion.subject_employee_id).in_(employee_ids),
            )
            .order_by(col(ProfileVersion.revision))
        ).all()
    )
    first: dict[tuple[UUID, UUID], UUID] = {}
    for version in versions:
        for claim in snapshot_claims(version):
            first.setdefault((version.subject_employee_id, claim.id), version.id)
    publishers = {
        v.id: summary
        for v, summary in zip(
            versions, version_summaries(session, principal, versions), strict=True
        )
    }
    for candidate in candidates:
        employee, claim, key = candidate
        status = (
            AssessmentStatus.DISPUTED
            if (employee.id, key) in disputes
            else claim.assessment_status
        )
        if status == AssessmentStatus.UNKNOWN:
            continue
        active = {
            ref.evidence_id
            for ref in claim.evidence
            if ref.evidence_id in evidence
            and evidence[ref.evidence_id][0] == employee.id
        }
        latest = max(
            (occurred for id in active if (occurred := evidence[id][1]) is not None),
            default=None,
        )
        yield (
            candidate,
            _ClaimDetails(
                status=status,
                evidence_count=len(active),
                latest_evidence_at=latest,
                publisher=publishers[first[(employee.id, claim.id)]],
            ),
        )


def snapshot_claims(version: ProfileVersion) -> list[SnapshotClaim]:
    raw = version.snapshot.get("claims", [])
    return (
        [SnapshotClaim.model_validate(c) for c in raw] if isinstance(raw, list) else []
    )
