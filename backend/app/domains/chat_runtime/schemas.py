from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, JsonValue, field_validator

from app.domains.change_request.schemas import ToolInput


class AttachmentPublic(BaseModel):
    id: UUID
    kind: Literal["image", "file"]
    filename: str
    size: int
    mime_type: str
    notice: str | None = None


class CardLink(BaseModel):
    label: str
    href: str


class TextMessage(BaseModel):
    type: Literal["text"] = "text"
    text: str
    review_link: Literal["/reviews"] | None = None
    capacity_links: list[CardLink] = Field(
        default_factory=list, exclude_if=lambda links: not links
    )


class ToolStep(BaseModel):
    name: str
    ok: bool


class TurnInput(ToolInput):
    text: str = Field(min_length=1, max_length=10000, pattern=r"\S")
    attachment_ids: list[UUID] = Field(default_factory=list, max_length=5)

    @field_validator("attachment_ids", mode="before")
    @classmethod
    def limit_attachments(cls, value: object) -> object:
        if isinstance(value, list) and len(value) > 5:
            raise ValueError("每轮最多 5 个附件")
        return value


class UserMessage(TurnInput):
    attachments: list[AttachmentPublic] = Field(default_factory=list)


class SessionCreated(BaseModel):
    session_id: UUID


class MessagePublic(BaseModel):
    id: UUID
    role: Literal["user", "assistant"]
    payload: JsonValue
    created_at: datetime


class SessionSummary(BaseModel):
    id: UUID
    started_at: datetime
    last_activity_at: datetime
    turn_count: int
    preview: str
    purpose: Literal["setup"] | None = None


class SessionList(BaseModel):
    data: list[SessionSummary]
    retention_days: int
    model_available: bool = True
