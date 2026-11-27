from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, JsonValue
from sqlmodel import SQLModel

from app.domains.change_request.models import (
    ChangeOp,
    ItemDecision,
    RequestOrigin,
    RequestStatus,
)
from app.domains.change_request.schemas import ToolInput
from app.domains.inbox.models import InboxKind, QuestionStatus
from app.domains.profile.models import AssessmentStatus

CapacityRequestResultStatus = Literal["pending", "approved", "returned"]


class InboxPublic(SQLModel):
    id: UUID
    kind: InboxKind
    request_id: UUID | None
    question_id: UUID | None
    workload_request_id: UUID | None = None
    extension_request_id: UUID | None = None
    message: str
    created_at: datetime
    read_at: datetime | None
    done_at: datetime | None


class InboxChangeClaimSnapshot(SQLModel):
    level: str | None = None
    statement: str | None = None
    assessment_status: AssessmentStatus | None = None


class InboxChangeItemDetail(SQLModel):
    id: UUID
    op: ChangeOp
    capability_name: str
    capability_level_rubric: dict[str, JsonValue] = Field(default_factory=dict)
    before: InboxChangeClaimSnapshot | None = None
    after: InboxChangeClaimSnapshot | None = None
    decision: ItemDecision | None = None
    decision_reason: str | None = None


class InboxProfileRequestDetail(SQLModel):
    request_id: UUID
    status: RequestStatus
    origin: RequestOrigin
    decided_at: datetime | None = None
    reviewer_name: str | None = None
    decision_comment: str | None = None
    items: list[InboxChangeItemDetail] = Field(default_factory=list)


class InboxWorkloadRequestDetail(SQLModel):
    request_id: UUID
    status: CapacityRequestResultStatus
    before_percent: int | None = None
    requested_percent: int
    start_week: date | None = None
    end_week: date | None = None
    reason: str
    decision_note: str | None = None
    decided_at: datetime | None = None
    reviewer_name: str | None = None


class InboxExtensionRequestDetail(SQLModel):
    request_id: UUID
    status: CapacityRequestResultStatus
    capability_name: str
    before_due_date: date | None = None
    requested_due_date: date
    new_due_date: date | None = None
    reason: str
    decision_note: str | None = None
    decided_at: datetime | None = None
    reviewer_name: str | None = None


class InboxDetail(SQLModel):
    item: InboxPublic
    profile_request: InboxProfileRequestDetail | None = None
    workload_request: InboxWorkloadRequestDetail | None = None
    extension_request: InboxExtensionRequestDetail | None = None


class InboxList(SQLModel):
    data: list[InboxPublic]
    count: int
    total_count: int
    unread_count: int
    pending_count: int
    filtered_unread_count: int


class InboxReadAllInput(ToolInput):
    pending_only: bool = False
    unread_only: bool = False
    kind: InboxKind | None = None


class InboxReadAllResult(SQLModel):
    updated_count: int


class QuestionsInput(ToolInput):
    skip: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


class AnswerInput(ToolInput):
    answer: str = Field(min_length=1, max_length=10000, pattern=r"\S")


class AnswerQuestionInput(AnswerInput):
    question_id: UUID


class QuestionPublic(SQLModel):
    id: UUID
    capability_definition_id: UUID | None
    question: str
    reason: str
    status: QuestionStatus
    answer_evidence_id: UUID | None
    created_at: datetime
    answered_at: datetime | None


class QuestionsList(SQLModel):
    data: list[QuestionPublic]
    count: int
