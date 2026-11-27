from datetime import UTC, date, datetime, time, timedelta
from typing import Literal, cast
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, JsonValue
from sqlalchemy import ColumnElement, DateTime, func, or_, tuple_
from sqlalchemy import cast as sql_cast
from sqlmodel import Session, col, select

from app.authz.policies import can_view_evidence_content
from app.authz.principal import Principal
from app.domains.evidence.models import Evidence, EvidenceKind, Visibility
from app.domains.org.models import Department, Employee, ExternalIdentity
from app.domains.org.schemas import DepartmentSummary
from app.domains.org.service import managed_scope
from app.domains.org.timezone import read_timezone
from app.domains.source.models import SourceConnection, SyncRun
from app.domains.work.models import SyncRunTask, Task, WorkEvent
from app.i18n import tr


class WorkRecordPersonPublic(BaseModel):
    external_id: str
    display_name: str | None = None
    role: str
    employee_id: UUID | None = None
    employee_name: str | None = None
    employee_code: str | None = None
    department: DepartmentSummary | None = None


class WorkRecordSourceOption(BaseModel):
    value: str
    label: str


class WorkRecordPublic(BaseModel):
    id: UUID
    source: str
    source_kind: Literal["jira", "csv"]
    source_label: str
    external_key: str
    title: str
    task_type: str | None = None
    status: str | None = None
    occurred_at: datetime | None = None
    project: str | None = None
    detail: str | None = None
    url: str | None = None
    people: list[WorkRecordPersonPublic]
    redacted: bool = False


class WorkRecordsPublic(BaseModel):
    data: list[WorkRecordPublic]
    count: int
    sources: list[WorkRecordSourceOption]
    warning: str | None = None


LEGACY_JIRA_BATCH_WARNING = (
    "该历史 Jira 同步批次缺少任务关联记录，当前仅能按已生成证据匹配，"
    "未关联账号或未变更的记录可能未包含在内，结果可能不完整。"
)
PARTIAL_JIRA_BATCH_WARNING = (
    "该 Jira 同步批次部分历史页面缺少任务关联记录，"
    "未关联账号或未变更的记录可能未包含在内，结果可能不完整。"
)
UNTRACKED_JIRA_BATCH_WARNING = (
    "该 Jira 同步批次已关联的唯一任务数少于处理计数，"
    "部分历史记录可能缺少任务关联或存在重复计数，结果可能不完整。"
)


def _non_negative_int(value: JsonValue | None) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _csv_processed_count(sync_run: SyncRun, total_rows: int) -> int:
    raw_next_row = sync_run.cursor.get("next_row")
    if isinstance(raw_next_row, int) and not isinstance(raw_next_row, bool):
        return max(0, min(raw_next_row, total_rows))
    if isinstance(raw_next_row, str):
        try:
            return max(0, min(int(raw_next_row), total_rows))
        except ValueError:
            pass
    if sync_run.status == "succeeded":
        raw_records = sync_run.counts.get("records")
        if isinstance(raw_records, int) and not isinstance(raw_records, bool):
            return max(0, min(raw_records, total_rows))
        return total_rows
    return 0


def _csv_batch_task_keys(sync_run: SyncRun) -> set[tuple[str, str]]:
    raw_rows = sync_run.input.get("rows") if isinstance(sync_run.input, dict) else None
    if not isinstance(raw_rows, list) or not raw_rows:
        return set()
    processed = _csv_processed_count(sync_run, len(raw_rows))
    keys: set[tuple[str, str]] = set()
    for row in raw_rows[:processed]:
        if not isinstance(row, dict):
            continue
        src = row.get("source")
        record_id = row.get("record_id")
        if isinstance(src, str) and src and isinstance(record_id, str) and record_id:
            keys.add((f"csv:{src}", record_id))
    return keys


def _task_key_filter(keys: set[tuple[str, str]]) -> ColumnElement[bool]:
    sorted_keys = sorted(keys)
    chunk_size = 5000
    clauses = [
        tuple_(col(Task.source), col(Task.external_key)).in_(
            sorted_keys[i : i + chunk_size]
        )
        for i in range(0, len(sorted_keys), chunk_size)
    ]
    return clauses[0] if len(clauses) == 1 else or_(*clauses)


def _source_label(source: str) -> str:
    return "Jira" if source == "jira" else source.removeprefix("csv:")


def _source_kind(source: str) -> Literal["jira", "csv"]:
    return "jira" if source == "jira" else "csv"


def _parse_occurred_at(task: Task) -> datetime | None:
    raw = task.attributes.get("occurred_at")
    if isinstance(raw, str) and raw:
        try:
            return datetime.fromisoformat(raw)
        except ValueError:
            pass
    return task.source_updated_at or task.source_created_at


def _as_str(value: JsonValue | None) -> str | None:
    return value if isinstance(value, str) and value else None


def list_work_records(
    session: Session,
    principal: Principal,
    *,
    source: str | None = None,
    employee_id: UUID | None = None,
    department_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    sync_run_id: UUID | None = None,
    skip: int = 0,
    limit: int = 50,
) -> WorkRecordsPublic:
    org_id = principal.org_id
    source_values = session.exec(
        select(Task.source)
        .where(Task.org_id == org_id)
        .distinct()
        .order_by(col(Task.source))
    ).all()
    sources = [
        WorkRecordSourceOption(value=value, label=_source_label(value))
        for value in source_values
    ]

    occurred_expr = func.coalesce(
        sql_cast(
            func.nullif(col(Task.attributes)["occurred_at"].astext, ""),
            DateTime(timezone=True),
        ),
        col(Task.source_updated_at),
        col(Task.source_created_at),
    )
    filters = [col(Task.org_id) == org_id]
    if source:
        if source == "csv":
            filters.append(col(Task.source).startswith("csv:"))
        else:
            filters.append(col(Task.source) == source)
    if employee_id is not None:
        filters.append(
            select(WorkEvent.id)
            .where(
                WorkEvent.org_id == org_id,
                WorkEvent.task_id == Task.id,
                WorkEvent.actor_employee_id == employee_id,
            )
            .exists()
        )
    warning: str | None = None
    if sync_run_id is not None:
        sync_run_row = session.exec(
            select(SyncRun, SourceConnection.kind)
            .join(
                SourceConnection,
                (col(SourceConnection.org_id) == SyncRun.org_id)
                & (col(SourceConnection.id) == SyncRun.connection_id),
            )
            .where(SyncRun.org_id == org_id, SyncRun.id == sync_run_id)
        ).one_or_none()
        if sync_run_row is None:
            return WorkRecordsPublic(data=[], count=0, sources=sources)
        sync_run, run_kind = sync_run_row
        run_clauses: list[ColumnElement[bool]] = [
            select(SyncRunTask.id)
            .where(
                SyncRunTask.org_id == org_id,
                SyncRunTask.sync_run_id == sync_run_id,
                SyncRunTask.task_id == Task.id,
            )
            .exists(),
            select(Evidence.id)
            .where(
                Evidence.org_id == org_id,
                Evidence.source == Task.source,
                Evidence.source_ref == Task.external_key,
                col(Evidence.provenance)["sync_run_id"].astext == str(sync_run_id),
            )
            .exists(),
        ]
        if run_kind == "csv":
            csv_keys = _csv_batch_task_keys(sync_run)
            if csv_keys:
                run_clauses.append(_task_key_filter(csv_keys))
        elif run_kind == "jira":
            sync_run_task_count = session.exec(
                select(func.count())
                .select_from(SyncRunTask)
                .where(
                    SyncRunTask.org_id == org_id,
                    SyncRunTask.sync_run_id == sync_run_id,
                )
            ).one()
            if sync_run_task_count == 0:
                has_processed_counts = any(
                    isinstance(v, int) and not isinstance(v, bool) and v > 0
                    for v in sync_run.counts.values()
                )
                has_run_evidence = (
                    session.exec(
                        select(Evidence.id)
                        .where(
                            Evidence.org_id == org_id,
                            col(Evidence.provenance)["sync_run_id"].astext
                            == str(sync_run_id),
                        )
                        .limit(1)
                    ).first()
                    is not None
                )
                if has_processed_counts or has_run_evidence:
                    warning = LEGACY_JIRA_BATCH_WARNING
            else:
                records_count = _non_negative_int(sync_run.counts.get("records"))
                if records_count is not None and sync_run_task_count < records_count:
                    task_link_records = _non_negative_int(
                        sync_run.cursor.get("task_link_records")
                    )
                    if task_link_records is None:
                        warning = UNTRACKED_JIRA_BATCH_WARNING
                    elif task_link_records < records_count:
                        warning = PARTIAL_JIRA_BATCH_WARNING
        filters.append(or_(*run_clauses))

    if department_id is not None:
        dept_ids = managed_scope(session, org_id, frozenset({department_id}))
        if not dept_ids:
            return WorkRecordsPublic(data=[], count=0, sources=sources, warning=warning)
        filters.append(
            select(WorkEvent.id)
            .join(
                Employee,
                (col(Employee.org_id) == WorkEvent.org_id)
                & (col(Employee.id) == WorkEvent.actor_employee_id),
            )
            .where(
                WorkEvent.org_id == org_id,
                WorkEvent.task_id == Task.id,
                col(Employee.department_id).in_(dept_ids),
            )
            .exists()
        )
    if date_from is not None or date_to is not None:
        timezone = ZoneInfo(read_timezone(session, org_id).timezone)
        if date_from is not None:
            start_utc = datetime.combine(date_from, time.min, timezone).astimezone(UTC)
            filters.append(occurred_expr >= start_utc)
        if date_to is not None:
            end_utc = datetime.combine(
                date_to + timedelta(days=1), time.min, timezone
            ).astimezone(UTC)
            filters.append(occurred_expr < end_utc)

    count = session.exec(select(func.count()).select_from(Task).where(*filters)).one()
    tasks = session.exec(
        select(Task)
        .where(*filters)
        .order_by(occurred_expr.desc().nulls_last(), col(Task.id).desc())
        .offset(skip)
        .limit(limit)
    ).all()
    if not tasks:
        return WorkRecordsPublic(data=[], count=count, sources=sources, warning=warning)

    task_ids = [task.id for task in tasks]
    task_keys = {(task.source, task.external_key) for task in tasks}

    event_rows = session.exec(
        select(WorkEvent, Employee, Department)
        .join(
            Employee,
            (col(Employee.org_id) == WorkEvent.org_id)
            & (col(Employee.id) == WorkEvent.actor_employee_id),
        )
        .outerjoin(
            Department,
            (col(Department.org_id) == Employee.org_id)
            & (col(Department.id) == Employee.department_id),
        )
        .where(WorkEvent.org_id == org_id, col(WorkEvent.task_id).in_(task_ids))
        .order_by(col(WorkEvent.id))
    ).all()
    events_by_task: dict[UUID, list[tuple[WorkEvent, Employee, Department | None]]] = {}
    for event, employee, department in event_rows:
        if event.task_id is not None:
            events_by_task.setdefault(event.task_id, []).append(
                (event, employee, department)
            )

    raw_people_keys = {
        (task.source, str(person["id"]))
        for task in tasks
        for person in cast(
            list[dict[str, JsonValue]], task.attributes.get("people") or []
        )
        if isinstance(person, dict) and isinstance(person.get("id"), str)
    }
    identity_lookup: dict[tuple[str, str], tuple[Employee, Department | None]] = {}
    if raw_people_keys:
        identity_rows = session.exec(
            select(ExternalIdentity, Employee, Department)
            .join(
                Employee,
                (col(Employee.org_id) == ExternalIdentity.org_id)
                & (col(Employee.id) == ExternalIdentity.employee_id),
            )
            .outerjoin(
                Department,
                (col(Department.org_id) == Employee.org_id)
                & (col(Department.id) == Employee.department_id),
            )
            .where(
                ExternalIdentity.org_id == org_id,
                tuple_(
                    col(ExternalIdentity.source), col(ExternalIdentity.external_id)
                ).in_(raw_people_keys),
            )
        ).all()
        for identity, employee, department in identity_rows:
            identity_lookup[(identity.source, identity.external_id)] = (
                employee,
                department,
            )

    restricted_rows = session.exec(
        select(Evidence, Employee)
        .join(
            Employee,
            (col(Employee.org_id) == Evidence.org_id)
            & (col(Employee.id) == Evidence.subject_employee_id),
        )
        .where(
            Evidence.org_id == org_id,
            Evidence.kind == EvidenceKind.WORK_RECORD,
            Evidence.visibility == Visibility.RESTRICTED,
            tuple_(col(Evidence.source), col(Evidence.source_ref)).in_(task_keys),
        )
    ).all()
    redacted_tasks: set[tuple[str, str]] = set()
    for evidence, employee in restricted_rows:
        if not can_view_evidence_content(
            principal, subject_employee=employee, visibility=evidence.visibility
        ):
            redacted_tasks.add((evidence.source, evidence.source_ref))

    items: list[WorkRecordPublic] = []
    for task in tasks:
        redacted = (task.source, task.external_key) in redacted_tasks
        raw_people = task.attributes.get("people")
        people: list[WorkRecordPersonPublic] = []
        if isinstance(raw_people, list) and raw_people:
            for raw_person in raw_people:
                if not isinstance(raw_person, dict):
                    continue
                ext_id = _as_str(raw_person.get("id")) or ""
                role = _as_str(raw_person.get("role")) or ""
                name = _as_str(raw_person.get("name"))
                linked = identity_lookup.get((task.source, ext_id))
                emp: Employee | None = linked[0] if linked else None
                dept: Department | None = linked[1] if linked else None
                people.append(
                    WorkRecordPersonPublic(
                        external_id=ext_id,
                        display_name=name,
                        role=role,
                        employee_id=emp.id if emp else None,
                        employee_name=emp.display_name if emp else None,
                        employee_code=emp.employee_code if emp else None,
                        department=DepartmentSummary.model_validate(dept)
                        if dept
                        else None,
                    )
                )
        else:
            for event, event_emp, event_dept in events_by_task.get(task.id, []):
                people.append(
                    WorkRecordPersonPublic(
                        external_id=event.source_ref,
                        display_name=event_emp.display_name,
                        role=event.action,
                        employee_id=event_emp.id,
                        employee_name=event_emp.display_name,
                        employee_code=event_emp.employee_code,
                        department=DepartmentSummary.model_validate(event_dept)
                        if event_dept
                        else None,
                    )
                )
        items.append(
            WorkRecordPublic(
                id=task.id,
                source=task.source,
                source_kind=_source_kind(task.source),
                source_label=_source_label(task.source),
                external_key=task.external_key,
                title=tr("工作记录（受限）") if redacted else task.title,
                task_type=None if redacted else task.task_type,
                status=None if redacted else task.status,
                occurred_at=_parse_occurred_at(task),
                project=None if redacted else _as_str(task.attributes.get("project")),
                detail=None if redacted else _as_str(task.attributes.get("detail")),
                url=None if redacted else task.url,
                people=people,
                redacted=redacted,
            )
        )
    return WorkRecordsPublic(
        data=items,
        count=count,
        sources=sources,
        warning=tr(warning) if warning else None,
    )
