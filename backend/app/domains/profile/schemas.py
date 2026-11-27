from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import AliasChoices, Field
from sqlmodel import SQLModel

from app.domains.capability.schemas import CapabilityPublic, SchemaVersionPublic
from app.domains.change_request.models import ChangeOp
from app.domains.evidence.models import EvidenceKind, EvidenceStatus
from app.domains.org.schemas import EmployeeSummary, PublishedSummary
from app.domains.profile.models import (
    AssessmentStatus,
    Confidence,
    EvidenceRelation,
)


class GeneratedBy(SQLModel):
    actor_type: str
    model: str | None = None
    model_version: str | None = None


class ClaimEvidencePublic(SQLModel):
    evidence_id: UUID = Field(validation_alias=AliasChoices("evidence_id", "id"))
    kind: EvidenceKind
    status: EvidenceStatus = EvidenceStatus.ACTIVE
    title: str
    occurred_at: datetime | None = None
    relation: EvidenceRelation
    redacted: bool = True


class ClaimPublic(SQLModel):
    id: UUID
    statement: str
    level: str | None
    assessment_status: AssessmentStatus
    confidence: Confidence | None
    explanation: str | None
    generated_by: GeneratedBy
    created_at: datetime | None = None
    evidence: list[ClaimEvidencePublic] = Field(default_factory=list)


class PendingProfileChange(SQLModel):
    request_id: UUID
    op: ChangeOp
    statement: str | None = None
    level: str | None = None
    submitted_at: datetime | None = None


class ProfileCapabilityReview(SQLModel):
    request_id: UUID
    decision: Literal["changes_requested", "rejected"]
    reason: str | None = None
    decided_at: datetime | None = None


class ProfileItem(SQLModel):
    capability: CapabilityPublic
    status: AssessmentStatus
    claim: ClaimPublic | None
    in_department: bool = False
    evidence_stale: bool = False
    retired: bool = False
    level_adjusted: bool = False
    original_level_description: str | None = None
    pending_change: PendingProfileChange | None = None
    latest_review: ProfileCapabilityReview | None = None


class ProfileCounts(SQLModel):
    confirmed: int = 0
    tentative: int = 0
    unknown: int = 0
    disputed: int = 0


class ProfileView(SQLModel):
    employee: EmployeeSummary
    schema_version: SchemaVersionPublic | None
    latest_published: PublishedSummary | None
    counts: ProfileCounts
    items: list[ProfileItem]
    department_capabilities_configured: bool = False


class PublisherPublic(SQLModel):
    actor_type: str
    display_name: str | None


class ProfileVersionSummary(PublishedSummary):
    published_by: PublisherPublic
    schema_version: SchemaVersionPublic
    via: str | None = None
    request_id: UUID | None = None


class ProfileVersionsPublic(SQLModel):
    data: list[ProfileVersionSummary]
    count: int


class ProfileVersionView(ProfileVersionSummary):
    counts: ProfileCounts
    items: list[ProfileItem]


class SnapshotClaim(ClaimPublic):
    capability_definition_id: UUID
