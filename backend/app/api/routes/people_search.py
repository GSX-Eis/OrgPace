import csv
import io
from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse, Response

from app.api.deps import SessionDep
from app.authz.deps import OrgPrincipalDep
from app.domains.audit.service import record_audit
from app.domains.capability.search import (
    ExportedClaimRow,
    PeopleSearchInput,
    PeopleSearchResult,
    export_published_claims,
    find_people,
)
from app.domains.org.timezone import read_timezone
from app.i18n import tr

router = APIRouter(prefix="/orgs/{org_id}", tags=["people-search"])


@router.get("/people-search", response_model=PeopleSearchResult)
def search_people(
    session: SessionDep,
    principal: OrgPrincipalDep,
    query: Annotated[PeopleSearchInput, Query()],
) -> PeopleSearchResult:
    return find_people(session, principal, query)


class ProfileExportRow(ExportedClaimRow):
    pass


@router.get(
    "/profile-export",
    response_model=list[ProfileExportRow],
    responses={
        200: {
            "content": {"text/csv": {"schema": {"type": "string", "format": "binary"}}}
        }
    },
)
def export_profiles(
    session: SessionDep,
    principal: OrgPrincipalDep,
    format: Literal["csv", "json"] = "csv",
) -> Response:
    rows = export_published_claims(session, principal)
    headers = {
        "Content-Disposition": f'attachment; filename="profile-export.{format}"',
        "Cache-Control": "no-store",
    }
    response: Response
    if format == "json":
        response = JSONResponse(
            [row.model_dump(mode="json") for row in rows], headers=headers
        )
    else:
        timezone = ZoneInfo(read_timezone(session, principal.org_id).timezone)
        status_labels = {
            "confirmed": tr("已确认"),
            "tentative": tr("暂定"),
            "disputed": tr("存在争议"),
        }

        def format_time(value: datetime | None) -> str:
            return (
                value.astimezone(timezone).strftime("%Y-%m-%d %H:%M") if value else ""
            )

        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(
            [
                tr(h)
                for h in (
                    "工号",
                    "能力",
                    "等级",
                    "判断状态",
                    "证据数",
                    "最近证据时间",
                    "批准人",
                    "批准时间",
                    "是否在当前词典",
                )
            ]
        )
        for exported in rows:
            values = [
                exported.employee_code,
                exported.capability_name,
                exported.level_name or tr("未定级"),
                status_labels[exported.status],
                exported.evidence_count,
                format_time(exported.latest_evidence_at),
                exported.published_by,
                format_time(exported.published_at),
                tr("是") if exported.in_current_dictionary else tr("否"),
            ]
            # Keep user-controlled cells from being interpreted as Excel formulas.
            writer.writerow(
                "'" + value
                if isinstance(value, str) and value.startswith(tuple("=+-@\t\r\n"))
                else value
                for value in values
            )
        response = Response(
            output.getvalue().encode("utf-8-sig"),
            media_type="text/csv",
            headers=headers,
        )
    record_audit(
        session,
        org_id=principal.org_id,
        actor_type=principal.actor_type,
        actor_id=str(principal.user_id),
        action="profile.exported",
        target_type="organization",
        target_id=str(principal.org_id),
        details={"format": format, "row_count": len(rows), "filters": {}},
    )
    session.commit()
    return response
