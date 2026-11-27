"""Model-structured materials publish profiles only after confirmation."""

from uuid import UUID

from pydantic import BaseModel, Field, RootModel
from sqlmodel import Session

from app.authz.principal import Principal
from app.domains.bot.attachments import AttachmentError, get_session_attachment
from app.domains.change_request.batch_import import (
    ImportResult,
    MaterialPerson,
    import_profiles,
)
from app.domains.change_request.import_json import InvalidImport
from app.domains.change_request.schemas import ToolInput
from app.i18n import tr


class Material(ToolInput):
    attachment_id: UUID | None = None
    label: str = Field(min_length=1, max_length=200)


class MaterialArgs(ToolInput):
    materials: list[Material] = Field(min_length=1, max_length=20)
    people: list[MaterialPerson] = Field(min_length=1, max_length=50)


def validate_attachments(
    db: Session, p: Principal, materials: list[Material], session_id: UUID
) -> None:
    for material in materials:
        if material.attachment_id is not None:
            try:
                get_session_attachment(
                    db, p, "admin", session_id, material.attachment_id
                )
            except AttachmentError:
                raise InvalidImport(
                    [tr("attachment_id：附件不属于当前会话或已过期")]
                ) from None


def preview(db: Session, p: Principal, args: MaterialArgs) -> list[ImportResult]:
    return import_profiles(
        p,
        db,
        args.people,
        confirm=False,
        commit=False,
    )


def impact(db: Session, p: Principal, args: MaterialArgs) -> BaseModel:
    from app.domains.admin_assistant.schemas import Impact

    people = preview(db, p, args)
    return Impact(
        count=len(people),
        text=tr("；").join(
            tr(
                "{name}（{department}）：{count} 条判断，{changes}，直接发布并通知本人",
                name=r.display_name,
                department=r.department_name,
                count=r.item_count,
                changes=tr("；").join(
                    tr(
                        "{capability} 等级 {before} → {after}，{statement}",
                        capability=i.capability_name,
                        before=i.before.level
                        if i.before and i.before.level
                        else tr("未知"),
                        after=i.after.level or tr("未知"),
                        statement=i.after.statement,
                    )
                    for i in r.changes
                ),
            )
            for r in people
        ),
    )


def apply(
    db: Session, p: Principal, args: MaterialArgs, *, commit: bool = True
) -> BaseModel:
    context = db.info["audit_context"]
    validate_attachments(db, p, args.materials, UUID(context["assistant_session_id"]))
    return RootModel(
        import_profiles(
            p,
            db,
            args.people,
            confirm=True,
            commit=commit,
        )
    )
