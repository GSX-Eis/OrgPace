import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlmodel import Session

from app.domains.capacity.models import CapacityWorkloadRequest
from app.domains.org.models import ReportingLine, RoleGrant
from tests.api.routes.test_m6_capacity_workload import capacity as capacity
from tests.api.routes.test_m6_capacity_workload import enable, headers


@pytest.mark.parametrize("reviewer", ["manager", "delegate", "fallback"])
def test_workload_request_names(
    capacity: tuple, db: Session, client: TestClient, reviewer: str
) -> None:
    url, employees, auth = capacity
    enable(client, capacity)
    org_id = employees["E02"].org_id
    actor = auth["manager"]
    if reviewer == "delegate":
        db.add(
            ReportingLine(
                org_id=org_id,
                employee_id=employees["E01"].id,
                manager_employee_id=employees["E05"].id,
            )
        )
        actor = headers(db, employees["E05"])
    elif reviewer == "fallback":
        db.execute(
            delete(RoleGrant).where(
                RoleGrant.org_id == org_id, RoleGrant.role == "dept_manager"
            )
        )
        actor = auth["admin"]
    expected = {}
    for code in ("E02", "E03"):
        row = CapacityWorkloadRequest(
            org_id=org_id,
            employee_id=employees[code].id,
            requested_percent=60,
            reason="合成调整原因",
        )
        db.add(row)
        expected[str(row.id)] = employees[code].display_name
    db.commit()
    listing = f"{url}/capacity/workload-requests"
    response = client.get(listing, headers=actor)
    assert response.status_code == 200, response.text
    rows = response.json()["data"]
    assert {row["id"]: row.get("employee_name") for row in rows} == expected
    for outsider in (
        auth["manager" if reviewer == "fallback" else "admin"],
        auth["employee"],
    ):
        result = client.get(listing, headers=outsider)
        assert result.status_code == 200
        assert result.json() == {"data": [], "count": 0}
    assert client.get(listing, headers=auth["foreign"]).status_code == 404
