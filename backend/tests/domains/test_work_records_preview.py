from collections.abc import Mapping
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID, uuid7

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlmodel import Session, col, delete, select

from app.authz.principal import Principal
from app.connectors.jira.client import (
    JiraIssue,
    JiraPage,
    JiraPerson,
    jira_client_for,
)
from app.domains.evidence.models import EvidenceKind, Visibility
from app.domains.evidence.service import append_evidence
from app.domains.org.models import (
    Department,
    Employee,
    ExternalIdentity,
    OrgMembership,
)
from app.domains.source import sync
from app.domains.source.models import SourceConnection, SyncRun
from app.domains.work.models import SyncRunTask, Task
from app.models import User
from tests.api.routes.test_sources import BODY
from tests.authz.test_tenant_access import headers, tenant_data  # noqa: F401
from tests.connectors.test_mock_jira import jira  # noqa: F401


def _cleanup_jobs(db: Session, org_id: UUID) -> None:
    db.execute(
        text(
            "DELETE FROM procrastinate_jobs WHERE task_name IN ('sources.sync_run', 'profiles.draft_incremental') AND args->>'org_id' = :org"
        ),
        {"org": str(org_id)},
    )
    db.commit()


def test_work_records_unified_preview_filters_and_redaction(
    request: pytest.FixtureRequest,
    client: TestClient,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    orgs, depts, employees, users = request.getfixturevalue("tenant_data")
    http = request.getfixturevalue("jira")
    org = orgs[0]
    admin = users[0]
    dept_manager = users[1]
    other_org_user = users[3]

    # Create a child department under depts[0] and an employee in it to verify dept tree filtering
    child_dept = Department(
        org_id=org.id, name="子部门", parent_department_id=depts[0].id
    )
    db.add(child_dept)
    db.flush()
    sub_emp = Employee(
        org_id=org.id,
        department_id=child_dept.id,
        employee_code="SUB-01",
        display_name="子部门成员",
        work_email="sub01@example.com",
    )
    db.add(sub_emp)
    db.flush()

    # Non-admin employee in same org for 403 check
    non_admin_user = User(
        username=f"member-{uuid7()}@example.com",
        email=f"member-{uuid7()}@example.com",
        hashed_password="unused",
    )
    db.add(non_admin_user)
    db.flush()
    db.add(
        OrgMembership(
            org_id=org.id, user_id=non_admin_user.id, employee_id=employees[0].id
        )
    )
    db.add(
        ExternalIdentity(
            org_id=org.id,
            employee_id=sub_emp.id,
            source="csv:Git",
            external_id="git.sub",
            linked_at=datetime.now(UTC),
        )
    )
    db.add(
        ExternalIdentity(
            org_id=org.id,
            employee_id=employees[0].id,
            source="jira",
            external_id="jira-lin",
            linked_at=datetime.now(UTC),
        )
    )
    # Give dept_manager role on depts[0] to a different user? No, admin[0] is org_admin ONLY.
    # Let's verify non-admin role cannot access work-records.
    db.commit()

    # Configure and run Jira sync (with mock jira)
    monkeypatch.setattr(sync, "jira_client_for", lambda c: jira_client_for(c, http))
    base = f"/api/v1/orgs/{org.id}"
    auth = headers(admin)
    assert (
        client.put(
            f"{base}/sources/jira",
            headers=auth,
            json={**BODY, "start_date": "2000-01-01", "project_keys": ["PLAT"]},
        ).status_code
        == 200
    )
    jira_run_resp = client.post(f"{base}/sources/jira/sync", headers=auth)
    assert jira_run_resp.status_code == 202
    jira_run_id = jira_run_resp.json()["id"]
    sync.execute_sync(Principal.system_worker(org.id), UUID(jira_run_id), page_size=50)

    # Import CSV records (multiple people, including unlinked person and sub_emp)
    csv_body = (
        "记录编号,来源,发生时间,执行人账号,执行人姓名,状态,标题,说明\n"
        "GIT-1,Git,2026-06-15T10:00:00+08:00,git.sub,子部门成员,已合并,实现工作记录接口,详情文本\n"
        "GIT-2,Git,2026-06-10T10:00:00+08:00,git.unlinked,未关联外部人,进行中,外部未关联任务,待关联\n"
    ).encode()
    csv_resp = client.post(
        f"{base}/sources/csv/imports",
        headers=auth,
        files={"file": ("git.csv", csv_body, "text/csv")},
    )
    assert csv_resp.status_code == 202
    csv_run_id = csv_resp.json()["run"]["id"]
    sync.execute_sync(Principal.system_worker(org.id), UUID(csv_run_id), page_size=50)
    db.expire_all()

    # Inject forbidden keys into Task.attributes on one task to ensure allowlist never leaks comments/worklogs/attachments
    sample_task = db.exec(
        select(Task).where(Task.org_id == org.id, Task.source == "jira")
    ).first()
    assert sample_task is not None
    sample_task.attributes = {
        **sample_task.attributes,
        "comments": ["secret comment"],
        "worklog": [{"timeSpent": "2h"}],
        "attachments": [{"filename": "secret.pdf"}],
    }
    db.add(sample_task)
    db.commit()

    # 1. Unified list returns both Jira and CSV records
    all_resp = client.get(f"{base}/work-records", headers=auth)
    assert all_resp.status_code == 200
    body = all_resp.json()
    assert body["count"] >= 3
    sources = {item["source"] for item in body["data"]}
    assert "jira" in sources
    assert "csv:Git" in sources
    assert any(
        opt["value"] == "jira" and opt["label"] == "Jira" for opt in body["sources"]
    )
    assert any(
        opt["value"] == "csv:Git" and opt["label"] == "Git" for opt in body["sources"]
    )
    # Ensure no comments/worklogs/attachments fields leaked anywhere in payload
    serialized = all_resp.text
    assert "secret comment" not in serialized
    assert "secret.pdf" not in serialized
    assert "timeSpent" not in serialized

    # 2. Filter by source
    jira_only = client.get(f"{base}/work-records?source=jira", headers=auth).json()
    assert jira_only["count"] > 0
    assert all(item["source"] == "jira" for item in jira_only["data"])

    csv_only = client.get(f"{base}/work-records?source=csv:Git", headers=auth).json()
    assert csv_only["count"] == 2
    assert {item["external_key"] for item in csv_only["data"]} == {"GIT-1", "GIT-2"}

    # 3. Filter by sync_run_id
    batch_csv = client.get(
        f"{base}/work-records?sync_run_id={csv_run_id}", headers=auth
    ).json()
    assert batch_csv["count"] == 2
    assert {item["external_key"] for item in batch_csv["data"]} == {"GIT-1", "GIT-2"}

    batch_jira = client.get(
        f"{base}/work-records?sync_run_id={jira_run_id}", headers=auth
    ).json()
    assert batch_jira["count"] == jira_only["count"]
    assert all(item["source"] == "jira" for item in batch_jira["data"])

    # 4. Filter by employee_id and parent department_id (includes child_dept!)
    by_emp = client.get(
        f"{base}/work-records?employee_id={sub_emp.id}", headers=auth
    ).json()
    assert by_emp["count"] == 1
    assert by_emp["data"][0]["external_key"] == "GIT-1"
    assert by_emp["data"][0]["people"][0]["employee_code"] == "SUB-01"
    assert by_emp["data"][0]["people"][0]["department"]["id"] == str(child_dept.id)

    by_parent_dept = client.get(
        f"{base}/work-records?department_id={depts[0].id}", headers=auth
    ).json()
    assert any(item["external_key"] == "GIT-1" for item in by_parent_dept["data"])

    # 5. Filter by date range (date_from / date_to)
    by_date = client.get(
        f"{base}/work-records?source=csv:Git&date_from=2026-06-14&date_to=2026-06-15",
        headers=auth,
    ).json()
    assert by_date["count"] == 1
    assert by_date["data"][0]["external_key"] == "GIT-1"

    # 6. Restricted visibility handling: append a RESTRICTED work_record evidence for GIT-1
    # admin is NOT dept_manager of sub_emp, so GIT-1 must be redacted for admin!
    append_evidence(
        db,
        org_id=org.id,
        subject_employee_id=sub_emp.id,
        kind=EvidenceKind.WORK_RECORD,
        source="csv:Git",
        source_ref="GIT-1",
        title="受限工作记录",
        content={"detail": "敏感正文"},
        visibility=Visibility.RESTRICTED,
        provenance={"test": True},
    )
    db.commit()
    redacted_resp = client.get(
        f"{base}/work-records?employee_id={sub_emp.id}", headers=auth
    ).json()
    item = redacted_resp["data"][0]
    assert item["redacted"] is True
    assert item["title"] == "工作记录（受限）"
    assert item["detail"] is None
    assert "敏感正文" not in str(redacted_resp)

    # 7. Access control: non-admin (employee or dept_manager) 403, cross-tenant 404
    assert (
        client.get(f"{base}/work-records", headers=headers(non_admin_user)).status_code
        == 403
    )
    assert (
        client.get(f"{base}/work-records", headers=headers(dept_manager)).status_code
        == 403
    )
    assert (
        client.get(f"{base}/work-records", headers=headers(other_org_user)).status_code
        == 404
    )

    _cleanup_jobs(db, org.id)


def test_historical_csv_batch_backfill_and_boundaries(
    request: pytest.FixtureRequest,
    client: TestClient,
    db: Session,
) -> None:
    orgs, _depts, employees, users = request.getfixturevalue("tenant_data")
    org = orgs[0]
    other_org = orgs[1]
    admin = users[0]
    other_org_user = users[3]
    base = f"/api/v1/orgs/{org.id}"
    auth = headers(admin)

    # 1. Simulate legacy CSV import with ONLY an unlinked external account:
    #    SyncRun + Task exist, but no SyncRunTask and no Evidence rows.
    legacy_csv = (
        "记录编号,来源,发生时间,执行人账号,执行人姓名,状态,标题,说明\n"
        "LEG-1,Git,2026-06-01T10:00:00+08:00,git.legacy.unlinked,旧版未关联,已完成,历史未关联记录,详情\n"
    ).encode()
    legacy_resp = client.post(
        f"{base}/sources/csv/imports",
        headers=auth,
        files={"file": ("legacy.csv", legacy_csv, "text/csv")},
    )
    assert legacy_resp.status_code == 202
    legacy_run_id = UUID(legacy_resp.json()["run"]["id"])
    sync.execute_sync(Principal.system_worker(org.id), legacy_run_id, page_size=50)
    db.execute(
        text("DELETE FROM sync_run_task WHERE sync_run_id = :run_id"),
        {"run_id": str(legacy_run_id)},
    )
    db.commit()

    by_source = client.get(f"{base}/work-records?source=csv:Git", headers=auth).json()
    assert by_source["count"] == 1
    assert by_source["data"][0]["external_key"] == "LEG-1"

    by_legacy_run = client.get(
        f"{base}/work-records?sync_run_id={legacy_run_id}", headers=auth
    ).json()
    assert by_legacy_run["count"] == 1
    assert [item["external_key"] for item in by_legacy_run["data"]] == ["LEG-1"]
    assert by_legacy_run["warning"] is None

    # 2. Another succeeded CSV batch imports LEG-OTHER (must not leak into legacy_run_id,
    #    and must not be matched by a failed batch's unprocessed rows).
    other_csv = (
        "记录编号,来源,发生时间,执行人账号,执行人姓名,状态,标题,说明\n"
        "LEG-OTHER,Git,2026-06-02T10:00:00+08:00,git.other,其他批次人,已完成,另一批记录,详情\n"
    ).encode()
    other_resp = client.post(
        f"{base}/sources/csv/imports",
        headers=auth,
        files={"file": ("other.csv", other_csv, "text/csv")},
    )
    assert other_resp.status_code == 202
    other_run_id = UUID(other_resp.json()["run"]["id"])
    sync.execute_sync(Principal.system_worker(org.id), other_run_id, page_size=50)
    db.expire_all()

    csv_conn = db.exec(
        select(SourceConnection).where(
            SourceConnection.org_id == org.id, SourceConnection.kind == "csv"
        )
    ).one()

    # Partial failed batch: row 0 (LEG-1) was processed, row 1 (LEG-OTHER) was NOT processed.
    partial_failed_run = SyncRun(
        org_id=org.id,
        connection_id=csv_conn.id,
        status="failed",
        requested_by_user_id=admin.id,
        cursor={"next_row": 1},
        counts={"records": 1},
        input={
            "filename": "partial-failed.csv",
            "rows": [
                {"source": "Git", "record_id": "LEG-1"},
                {"source": "Git", "record_id": "LEG-OTHER"},
            ],
        },
    )
    # Zero-processed failed batch: LEG-OTHER exists in DB from other_run,
    # but this failed batch never committed any row.
    zero_failed_run = SyncRun(
        org_id=org.id,
        connection_id=csv_conn.id,
        status="failed",
        requested_by_user_id=admin.id,
        cursor={},
        counts={"records": 0},
        input={
            "filename": "zero-failed.csv",
            "rows": [
                {"source": "Git", "record_id": "LEG-OTHER"},
            ],
        },
    )
    db.add_all([partial_failed_run, zero_failed_run])
    db.commit()

    partial_resp = client.get(
        f"{base}/work-records?sync_run_id={partial_failed_run.id}", headers=auth
    ).json()
    assert partial_resp["count"] == 1
    assert [item["external_key"] for item in partial_resp["data"]] == ["LEG-1"]

    zero_resp = client.get(
        f"{base}/work-records?sync_run_id={zero_failed_run.id}", headers=auth
    ).json()
    assert zero_resp["count"] == 0
    assert zero_resp["data"] == []

    # 3. Cross-tenant isolation: another org's SyncRun and Tasks never mix in.
    other_org_conn = SourceConnection(
        org_id=other_org.id, kind="csv", updated_by_user_id=other_org_user.id
    )
    db.add(other_org_conn)
    db.flush()
    other_org_task = Task(
        org_id=other_org.id,
        source="csv:Git",
        external_key="FOREIGN-1",
        title="跨企业记录",
    )
    other_org_matching_task = Task(
        org_id=other_org.id,
        source="csv:Git",
        external_key="LEG-1",
        title="跨企业同编号记录",
    )
    other_org_run = SyncRun(
        org_id=other_org.id,
        connection_id=other_org_conn.id,
        status="succeeded",
        requested_by_user_id=other_org_user.id,
        cursor={"next_row": 2},
        counts={"records": 2},
        input={
            "filename": "foreign.csv",
            "rows": [
                {"source": "Git", "record_id": "FOREIGN-1"},
                {"source": "Git", "record_id": "LEG-1"},
            ],
        },
    )
    db.add_all([other_org_task, other_org_matching_task, other_org_run])
    db.commit()

    cross_run_resp = client.get(
        f"{base}/work-records?sync_run_id={other_org_run.id}", headers=auth
    ).json()
    assert cross_run_resp["count"] == 0
    assert cross_run_resp["data"] == []

    # Verify legacy_run_id still only returns org[0]'s LEG-1 and never org[1]'s
    recheck_legacy = client.get(
        f"{base}/work-records?sync_run_id={legacy_run_id}", headers=auth
    ).json()
    assert recheck_legacy["count"] == 1
    assert recheck_legacy["data"][0]["title"] == "历史未关联记录"

    # 4. Restricted visibility and read-only permission remain enforced for legacy CSV batches.
    append_evidence(
        db,
        org_id=org.id,
        subject_employee_id=employees[0].id,
        kind=EvidenceKind.WORK_RECORD,
        source="csv:Git",
        source_ref="LEG-1",
        title="受限历史记录",
        content={"detail": "机密内容"},
        visibility=Visibility.RESTRICTED,
        provenance={"test": True},
    )
    db.commit()
    redacted_legacy = client.get(
        f"{base}/work-records?sync_run_id={legacy_run_id}", headers=auth
    ).json()
    assert redacted_legacy["count"] == 1
    assert redacted_legacy["data"][0]["redacted"] is True
    assert redacted_legacy["data"][0]["title"] == "工作记录（受限）"
    assert redacted_legacy["data"][0]["detail"] is None
    assert "机密内容" not in str(redacted_legacy)

    assert (
        client.get(
            f"{base}/work-records?sync_run_id={legacy_run_id}",
            headers=headers(other_org_user),
        ).status_code
        == 404
    )

    _cleanup_jobs(db, org.id)


def test_historical_jira_batch_warns_incomplete(
    request: pytest.FixtureRequest,
    client: TestClient,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    orgs, _depts, employees, users = request.getfixturevalue("tenant_data")
    http = request.getfixturevalue("jira")
    org = orgs[0]
    other_org = orgs[1]
    admin = users[0]
    other_org_user = users[3]
    base = f"/api/v1/orgs/{org.id}"
    auth = headers(admin)

    monkeypatch.setattr(sync, "jira_client_for", lambda c: jira_client_for(c, http))
    assert (
        client.put(
            f"{base}/sources/jira",
            headers=auth,
            json={**BODY, "start_date": "2000-01-01", "project_keys": ["PLAT"]},
        ).status_code
        == 200
    )

    # New Jira sync with SyncRunTask -> no warning
    new_run_resp = client.post(f"{base}/sources/jira/sync", headers=auth)
    assert new_run_resp.status_code == 202
    new_run_id = UUID(new_run_resp.json()["id"])
    sync.execute_sync(Principal.system_worker(org.id), new_run_id, page_size=50)
    assert (
        db.exec(
            select(SyncRunTask.id).where(
                SyncRunTask.org_id == org.id, SyncRunTask.sync_run_id == new_run_id
            )
        ).first()
        is not None
    )

    new_preview = client.get(
        f"{base}/work-records?sync_run_id={new_run_id}", headers=auth
    ).json()
    assert new_preview["count"] > 0
    assert new_preview["warning"] is None

    # Historical Jira sync (no SyncRunTask rows, but processed records > 0) -> explicit warning
    jira_conn = db.exec(
        select(SourceConnection).where(
            SourceConnection.org_id == org.id, SourceConnection.kind == "jira"
        )
    ).one()
    legacy_jira_run = SyncRun(
        org_id=org.id,
        connection_id=jira_conn.id,
        status="succeeded",
        requested_by_user_id=admin.id,
        counts={"records": 3, "tasks_added": 3, "people_unlinked": 3},
        input={"project_keys": ["PLAT"]},
    )
    empty_jira_run = SyncRun(
        org_id=org.id,
        connection_id=jira_conn.id,
        status="succeeded",
        requested_by_user_id=admin.id,
        counts={"records": 0},
        input={"project_keys": ["PLAT"]},
    )
    other_jira_conn = SourceConnection(
        org_id=other_org.id, kind="jira", updated_by_user_id=other_org_user.id
    )
    db.add_all([legacy_jira_run, empty_jira_run, other_jira_conn])
    db.flush()
    other_jira_run = SyncRun(
        org_id=other_org.id,
        connection_id=other_jira_conn.id,
        status="succeeded",
        requested_by_user_id=other_org_user.id,
        counts={"records": 5},
        input={"project_keys": ["PLAT"]},
    )
    db.add(other_jira_run)
    db.commit()

    legacy_preview = client.get(
        f"{base}/work-records?sync_run_id={legacy_jira_run.id}", headers=auth
    ).json()
    assert legacy_preview["count"] == 0
    assert legacy_preview["warning"]
    assert "不完整" in legacy_preview["warning"]

    # Historical Jira run with Evidence provenance but no SyncRunTask -> returns matched rows AND warning
    sample_jira_task = db.exec(
        select(Task).where(Task.org_id == org.id, Task.source == "jira")
    ).first()
    assert sample_jira_task is not None
    legacy_jira_with_evidence = SyncRun(
        org_id=org.id,
        connection_id=jira_conn.id,
        status="succeeded",
        requested_by_user_id=admin.id,
        counts={},
        input={"project_keys": ["PLAT"]},
    )
    db.add(legacy_jira_with_evidence)
    db.flush()
    append_evidence(
        db,
        org_id=org.id,
        subject_employee_id=employees[0].id,
        kind=EvidenceKind.WORK_RECORD,
        source="jira",
        source_ref=sample_jira_task.external_key,
        title=sample_jira_task.title,
        content={"key": sample_jira_task.external_key},
        visibility=Visibility.STANDARD,
        provenance={"sync_run_id": str(legacy_jira_with_evidence.id)},
    )
    db.commit()

    legacy_with_ev_preview = client.get(
        f"{base}/work-records?sync_run_id={legacy_jira_with_evidence.id}", headers=auth
    ).json()
    assert legacy_with_ev_preview["count"] == 1
    assert legacy_with_ev_preview["warning"]
    assert "不完整" in legacy_with_ev_preview["warning"]

    # Zero-record Jira run has no missing linkage -> no warning
    empty_preview = client.get(
        f"{base}/work-records?sync_run_id={empty_jira_run.id}", headers=auth
    ).json()
    assert empty_preview["count"] == 0
    assert empty_preview["warning"] is None

    # Cross-org Jira sync_run_id leaks neither data nor warning
    foreign_preview = client.get(
        f"{base}/work-records?sync_run_id={other_jira_run.id}", headers=auth
    ).json()
    assert foreign_preview["count"] == 0
    assert foreign_preview["warning"] is None

    _cleanup_jobs(db, org.id)


class _PagedFakeJira:
    def __init__(self, pages: Mapping[str | None, JiraPage | Exception]) -> None:
        self._pages = pages
        self.config = SimpleNamespace(project_keys=["PLAT"])

    def __enter__(self) -> _PagedFakeJira:
        return self

    def __exit__(self, *_: object) -> None:
        pass

    def search(
        self, _since: datetime, cursor: str | None, _page_size: int = 100
    ) -> JiraPage:
        page = self._pages[cursor]
        if isinstance(page, Exception):
            raise page
        return page


def test_cross_version_resumed_jira_batch_warns_incomplete(
    request: pytest.FixtureRequest,
    client: TestClient,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    orgs, _depts, employees, users = request.getfixturevalue("tenant_data")
    org = orgs[0]
    other_org = orgs[1]
    admin = users[0]
    other_org_user = users[3]
    base = f"/api/v1/orgs/{org.id}"
    auth = headers(admin)

    now = datetime(2026, 6, 10, 12, 0, tzinfo=UTC)
    legacy_issue = JiraIssue(
        key="PLAT-OLD-1",
        url="https://jira.example.com/browse/PLAT-OLD-1",
        summary="旧页面未关联记录",
        issue_type="Task",
        status="Done",
        created=now,
        updated=now,
        people=[JiraPerson(role="assignee", id="unlinked-old", display_name="旧成员")],
    )
    resumed_issue = JiraIssue(
        key="PLAT-NEW-2",
        url="https://jira.example.com/browse/PLAT-NEW-2",
        summary="续跑页新记录",
        issue_type="Task",
        status="Done",
        created=now,
        updated=now,
        people=[JiraPerson(role="assignee", id="unlinked-new", display_name="新成员")],
    )

    assert (
        client.put(
            f"{base}/sources/jira",
            headers=auth,
            json={**BODY, "start_date": "2000-01-01", "project_keys": ["PLAT"]},
        ).status_code
        == 200
    )

    # 1. Simulate page 1 committing under pre-#474 code (no SyncRunTask, no task_link_records),
    #    then failing before page 2, upgrading, and resuming page 2 via retry_run.
    failing_pages: dict[str | None, JiraPage | Exception] = {
        None: JiraPage(issues=[legacy_issue], next_cursor="page-2"),
        "page-2": RuntimeError("boom"),
    }
    monkeypatch.setattr(
        sync, "jira_client_for", lambda _c: _PagedFakeJira(failing_pages)
    )
    run_resp = client.post(f"{base}/sources/jira/sync", headers=auth)
    assert run_resp.status_code == 202
    resumed_run_id = UUID(run_resp.json()["id"])
    sync.execute_sync(Principal.system_worker(org.id), resumed_run_id, page_size=1)
    db.expire_all()
    resumed_run = db.get(SyncRun, resumed_run_id)
    assert resumed_run is not None
    assert resumed_run.status == "failed"
    assert resumed_run.counts["records"] == 1

    # Strip PR #474+ tracking from page 1 to match a pre-upgrade failed run.
    db.exec(delete(SyncRunTask).where(col(SyncRunTask.sync_run_id) == resumed_run_id))
    resumed_run.cursor = {
        k: v for k, v in resumed_run.cursor.items() if k != "task_link_records"
    }
    db.add(resumed_run)
    db.commit()

    # Resume page 2 after upgrade.
    resumed_pages: dict[str | None, JiraPage] = {
        "page-2": JiraPage(issues=[resumed_issue], next_cursor=None),
    }
    monkeypatch.setattr(
        sync, "jira_client_for", lambda _c: _PagedFakeJira(resumed_pages)
    )
    retry_resp = client.post(f"{base}/sync-runs/{resumed_run_id}/retry", headers=auth)
    assert retry_resp.status_code == 202
    sync.execute_sync(Principal.system_worker(org.id), resumed_run_id, page_size=1)
    db.expire_all()
    resumed_run = db.get(SyncRun, resumed_run_id)
    assert resumed_run is not None
    assert resumed_run.status == "succeeded"
    assert resumed_run.counts["records"] == 2

    preview_resp = client.get(
        f"{base}/work-records?sync_run_id={resumed_run_id}", headers=auth
    )
    assert preview_resp.status_code == 200
    preview = preview_resp.json()
    assert preview["count"] == 1
    assert [item["external_key"] for item in preview["data"]] == ["PLAT-NEW-2"]
    assert preview["warning"]
    assert "结果可能不完整" in preview["warning"]

    # Redaction and org boundary still hold on resumed partial batch.
    append_evidence(
        db,
        org_id=org.id,
        subject_employee_id=employees[0].id,
        kind=EvidenceKind.WORK_RECORD,
        source="jira",
        source_ref="PLAT-NEW-2",
        title="受限续跑记录",
        content={"detail": "绝密内容"},
        visibility=Visibility.RESTRICTED,
        provenance={"test": True},
    )
    db.commit()
    redacted_resp = client.get(
        f"{base}/work-records?sync_run_id={resumed_run_id}", headers=auth
    ).json()
    assert redacted_resp["count"] == 1
    assert redacted_resp["data"][0]["redacted"] is True
    assert redacted_resp["data"][0]["title"] == "工作记录（受限）"
    assert "绝密内容" not in str(redacted_resp)
    assert "结果可能不完整" in redacted_resp["warning"]

    assert (
        client.get(
            f"{base}/work-records?sync_run_id={resumed_run_id}",
            headers=headers(other_org_user),
        ).status_code
        == 404
    )

    # 2. Pre-#479 / manually constructed resumed Jira batch (cursor has no task_link_records):
    #    2 processed records, 1 unlinked old Task without SyncRunTask, 1 new Task with SyncRunTask.
    jira_conn = db.exec(
        select(SourceConnection).where(
            SourceConnection.org_id == org.id, SourceConnection.kind == "jira"
        )
    ).one()
    unlinked_old_task = Task(
        org_id=org.id,
        source="jira",
        external_key="PLAT-MAN-1",
        title="手工构造旧页任务",
    )
    linked_new_task = Task(
        org_id=org.id,
        source="jira",
        external_key="PLAT-MAN-2",
        title="手工构造新页任务",
    )
    manual_resumed_run = SyncRun(
        org_id=org.id,
        connection_id=jira_conn.id,
        status="succeeded",
        trigger="retry",
        requested_by_user_id=admin.id,
        counts={"records": 2, "tasks_added": 2, "people_unlinked": 2},
        cursor={"complete": True},
        input={"project_keys": ["PLAT"]},
    )
    db.add_all([unlinked_old_task, linked_new_task, manual_resumed_run])
    db.flush()
    db.add(
        SyncRunTask(
            org_id=org.id,
            sync_run_id=manual_resumed_run.id,
            task_id=linked_new_task.id,
        )
    )
    db.commit()

    manual_preview = client.get(
        f"{base}/work-records?sync_run_id={manual_resumed_run.id}", headers=auth
    )
    assert manual_preview.status_code == 200
    manual_body = manual_preview.json()
    assert manual_body["count"] == 1
    assert [item["external_key"] for item in manual_body["data"]] == ["PLAT-MAN-2"]
    assert manual_body["warning"]
    assert "结果可能不完整" in manual_body["warning"]

    # Cross-org isolation: other org user gets 404, and org[0] admin cannot see
    # another org's partial resumed run or trigger its warning.
    assert (
        client.get(
            f"{base}/work-records?sync_run_id={manual_resumed_run.id}",
            headers=headers(other_org_user),
        ).status_code
        == 404
    )
    other_conn = SourceConnection(
        org_id=other_org.id, kind="jira", updated_by_user_id=other_org_user.id
    )
    db.add(other_conn)
    db.flush()
    other_task = Task(
        org_id=other_org.id,
        source="jira",
        external_key="FOREIGN-RESUMED-1",
        title="跨企业续跑任务",
    )
    other_resumed_run = SyncRun(
        org_id=other_org.id,
        connection_id=other_conn.id,
        status="succeeded",
        trigger="retry",
        requested_by_user_id=other_org_user.id,
        counts={"records": 2, "tasks_added": 2},
        cursor={"complete": True},
        input={"project_keys": ["PLAT"]},
    )
    db.add_all([other_task, other_resumed_run])
    db.flush()
    db.add(
        SyncRunTask(
            org_id=other_org.id,
            sync_run_id=other_resumed_run.id,
            task_id=other_task.id,
        )
    )
    db.commit()
    cross_body = client.get(
        f"{base}/work-records?sync_run_id={other_resumed_run.id}",
        headers=auth,
    ).json()
    assert cross_body["count"] == 0
    assert cross_body["warning"] is None

    _cleanup_jobs(db, org.id)


def test_new_jira_batch_with_duplicate_issues_across_pages_does_not_warn(
    request: pytest.FixtureRequest,
    client: TestClient,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    orgs, _depts, _employees, users = request.getfixturevalue("tenant_data")
    org = orgs[0]
    admin = users[0]
    base = f"/api/v1/orgs/{org.id}"
    auth = headers(admin)

    now = datetime(2026, 6, 11, 12, 0, tzinfo=UTC)
    issue_1 = JiraIssue(
        key="PLAT-DUP-1",
        url="https://jira.example.com/browse/PLAT-DUP-1",
        summary="重复拉取测试一",
        issue_type="Task",
        status="Done",
        created=now,
        updated=now,
    )
    issue_2 = JiraIssue(
        key="PLAT-DUP-2",
        url="https://jira.example.com/browse/PLAT-DUP-2",
        summary="重复拉取测试二",
        issue_type="Task",
        status="Done",
        created=now,
        updated=now,
    )
    pages: dict[str | None, JiraPage] = {
        None: JiraPage(issues=[issue_1, issue_2], next_cursor="p2"),
        "p2": JiraPage(issues=[issue_2], next_cursor=None),
    }

    assert (
        client.put(
            f"{base}/sources/jira",
            headers=auth,
            json={**BODY, "start_date": "2000-01-01", "project_keys": ["PLAT"]},
        ).status_code
        == 200
    )
    monkeypatch.setattr(sync, "jira_client_for", lambda _c: _PagedFakeJira(pages))
    run_resp = client.post(f"{base}/sources/jira/sync", headers=auth)
    assert run_resp.status_code == 202
    run_id = UUID(run_resp.json()["id"])
    sync.execute_sync(Principal.system_worker(org.id), run_id, page_size=2)
    db.expire_all()

    run = db.get(SyncRun, run_id)
    assert run is not None
    assert run.status == "succeeded"
    assert run.counts["records"] == 3
    assert run.cursor["task_link_records"] == 3

    preview_resp = client.get(f"{base}/work-records?sync_run_id={run_id}", headers=auth)
    assert preview_resp.status_code == 200
    body = preview_resp.json()
    assert body["count"] == 2
    assert {item["external_key"] for item in body["data"]} == {
        "PLAT-DUP-1",
        "PLAT-DUP-2",
    }
    assert body["warning"] is None

    # A complete batch started on PR #474-#478 (has SyncRunTask, no task_link_records)
    # and resumed on newer code keeps warning=None when unique links match records.
    pr474_pages: dict[str | None, JiraPage | Exception] = {
        None: JiraPage(issues=[issue_1], next_cursor="p2"),
        "p2": RuntimeError("boom"),
    }
    monkeypatch.setattr(sync, "jira_client_for", lambda _c: _PagedFakeJira(pr474_pages))
    mid_resp = client.post(f"{base}/sources/jira/sync", headers=auth)
    assert mid_resp.status_code == 202
    mid_run_id = UUID(mid_resp.json()["id"])
    sync.execute_sync(Principal.system_worker(org.id), mid_run_id, page_size=1)
    db.expire_all()
    mid_run = db.get(SyncRun, mid_run_id)
    assert mid_run is not None
    mid_run.cursor = {
        k: v for k, v in mid_run.cursor.items() if k != "task_link_records"
    }
    db.add(mid_run)
    db.commit()

    monkeypatch.setattr(
        sync,
        "jira_client_for",
        lambda _c: _PagedFakeJira({"p2": JiraPage(issues=[issue_2], next_cursor=None)}),
    )
    assert (
        client.post(f"{base}/sync-runs/{mid_run_id}/retry", headers=auth).status_code
        == 202
    )
    sync.execute_sync(Principal.system_worker(org.id), mid_run_id, page_size=1)
    mid_preview = client.get(
        f"{base}/work-records?sync_run_id={mid_run_id}", headers=auth
    ).json()
    assert mid_preview["count"] == 2
    assert mid_preview["warning"] is None

    # Zero-record Jira sync executed through execute_sync keeps warning=None.
    monkeypatch.setattr(
        sync,
        "jira_client_for",
        lambda _c: _PagedFakeJira({None: JiraPage(issues=[], next_cursor=None)}),
    )
    zero_resp = client.post(f"{base}/sources/jira/sync", headers=auth)
    assert zero_resp.status_code == 202
    zero_run_id = UUID(zero_resp.json()["id"])
    sync.execute_sync(Principal.system_worker(org.id), zero_run_id, page_size=10)
    zero_preview = client.get(
        f"{base}/work-records?sync_run_id={zero_run_id}", headers=auth
    ).json()
    assert zero_preview["count"] == 0
    assert zero_preview["warning"] is None

    _cleanup_jobs(db, org.id)


def test_work_record_filter_pagination_beyond_100_employees_and_50_batches(
    request: pytest.FixtureRequest,
    client: TestClient,
    db: Session,
) -> None:
    from datetime import timedelta

    orgs, _, _, users = request.getfixturevalue("tenant_data")
    org = orgs[0]
    other_org = orgs[1]
    admin = users[0]
    non_admin = users[2]
    other_org_admin = users[3]
    base = f"/api/v1/orgs/{org.id}"
    auth = headers(admin)

    # Create 105 employees in org[0] to exceed the 100-employee single-page cap.
    created_employees = [
        Employee(
            org_id=org.id,
            employee_code=f"EMP-{i:03d}",
            display_name=f"测试员工{i:03d}" if i < 105 else "第一百零五号目标员工",
        )
        for i in range(1, 106)
    ]
    db.add_all(created_employees)

    # Create 55 sync runs in org[0] (plus 1 in other_org for tenant isolation).
    csv_conn = SourceConnection(org_id=org.id, kind="csv", updated_by_user_id=admin.id)
    other_conn = SourceConnection(
        org_id=other_org.id, kind="csv", updated_by_user_id=other_org_admin.id
    )
    db.add_all([csv_conn, other_conn])
    db.flush()

    now = datetime(2026, 7, 1, tzinfo=UTC)
    runs = [
        SyncRun(
            org_id=org.id,
            connection_id=csv_conn.id,
            status="succeeded",
            trigger="manual",
            requested_by_user_id=admin.id,
            input={
                "filename": "early-target-batch.csv" if i == 0 else f"batch-{i:03d}.csv"
            },
            created_at=now + timedelta(minutes=i),
        )
        for i in range(55)
    ]
    other_run = SyncRun(
        org_id=other_org.id,
        connection_id=other_conn.id,
        status="succeeded",
        trigger="manual",
        requested_by_user_id=other_org_admin.id,
        input={"filename": "early-target-batch.csv"},
        created_at=now,
    )
    db.add_all([*runs, other_run])
    db.commit()

    # Employees beyond 100 are reachable via pagination and keyword search.
    page1 = client.get(f"{base}/accounts?skip=0&limit=100", headers=auth).json()
    page2 = client.get(f"{base}/accounts?skip=100&limit=100", headers=auth).json()
    assert page1["count"] >= 105
    assert len(page1["data"]) == 100
    assert len(page2["data"]) >= 5
    searched_emp = client.get(
        f"{base}/accounts?q=第一百零五号目标", headers=auth
    ).json()
    assert searched_emp["count"] == 1
    assert searched_emp["data"][0]["employee_code"] == "EMP-105"

    # Batches beyond 50 are reachable via pagination and keyword search, with tenant isolation.
    runs_page1 = client.get(f"{base}/sync-runs?skip=0&limit=50", headers=auth).json()
    runs_page2 = client.get(f"{base}/sync-runs?skip=50&limit=50", headers=auth).json()
    assert runs_page1["count"] == 55
    assert len(runs_page1["data"]) == 50
    assert len(runs_page2["data"]) == 5
    assert any(r["filename"] == "early-target-batch.csv" for r in runs_page2["data"])

    searched_runs = client.get(f"{base}/sync-runs?q=early-target", headers=auth).json()
    assert searched_runs["count"] == 1
    assert searched_runs["data"][0]["filename"] == "early-target-batch.csv"
    assert searched_runs["data"][0]["id"] == str(runs[0].id)

    assert (
        client.get(
            f"{base}/sync-runs?q=early-target", headers=headers(non_admin)
        ).status_code
        == 403
    )
    assert (
        client.get(
            f"{base}/sync-runs?q=early-target", headers=headers(other_org_admin)
        ).status_code
        == 404
    )
