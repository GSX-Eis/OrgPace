from uuid import UUID

from pydantic import BaseModel
from sqlmodel import Session

from app.authz.principal import Principal
from app.domains.org.service import visible_employee
from app.domains.review.direct import (
    DirectEditInput,
    DirectEditResult,
    direct_edit,
    preview_direct_edit,
)
from app.i18n import tr


class EditArgs(DirectEditInput):
    employee_id: UUID


def impact(db: Session, p: Principal, args: EditArgs) -> BaseModel:
    from app.domains.admin_assistant.schemas import Impact

    result = preview_direct_edit(p, db, args.employee_id, args)
    subject = visible_employee(db, p, args.employee_id)
    changes = tr("；").join(
        tr(
            "{capability} 等级 {before} → {after}，{statement}",
            capability=i.capability_name,
            before=i.before.level if i.before and i.before.level else tr("未知"),
            after=i.after.level or tr("未知"),
            statement=i.after.statement,
        )
        for i in result.items
    )
    return Impact(
        count=1,
        text=tr(
            "{name}：{changes}，直接发布并通知本人",
            name=subject.display_name,
            changes=changes,
        ),
    )


def apply(
    db: Session, p: Principal, args: EditArgs, *, commit: bool = True
) -> DirectEditResult:
    return direct_edit(
        p, db, args.employee_id, args, via="web", client_name="管理助手", commit=commit
    )
