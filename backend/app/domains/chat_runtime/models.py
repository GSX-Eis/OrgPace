from typing import Literal
from uuid import UUID

from sqlalchemy import String
from sqlmodel import Field

from app.domains.base import TenantRecord


class ConversationMessage(TenantRecord):
    session_id: UUID
    role: Literal["user", "assistant"] = Field(sa_type=String)
    ciphertext: str = Field(repr=False)


class ChatAttachment(TenantRecord):
    session_id: UUID
    kind: Literal["image", "file"] = Field(sa_type=String)
    filename: str
    mime_type: str
    size: int
    ciphertext: str = Field(repr=False)
    text_ciphertext: str | None = Field(default=None, repr=False)
    notice: str | None = None
