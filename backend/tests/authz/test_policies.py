"""Unit tests for pure department/aggregate authorization policy helpers."""

from uuid import UUID, uuid4

import pytest

from app.authz.policies import (
    can_manage_department,
    can_view_org_aggregates,
    manages_department,
)
from app.authz.principal import Principal
from app.domains.audit.models import ActorKind

pytestmark = pytest.mark.unit

ORG_ID = uuid4()
GRANTED_DEPT = uuid4()
SUB_DEPT = uuid4()
UNMANAGED_DEPT = uuid4()


def _user(
    *,
    is_org_admin: bool = False,
    managed: frozenset[UUID] = frozenset(),
) -> Principal:
    return Principal(
        actor_type=ActorKind.USER,
        org_id=ORG_ID,
        user_id=uuid4(),
        employee_id=uuid4(),
        is_org_admin=is_org_admin,
        managed_department_ids=managed,
    )


@pytest.mark.parametrize(
    (
        "role_name",
        "principal",
        "target_dept",
        "expected_can_manage",
        "expected_manages",
    ),
    [
        ("org_admin/granted", _user(is_org_admin=True), GRANTED_DEPT, True, False),
        ("org_admin/sub_dept", _user(is_org_admin=True), SUB_DEPT, True, False),
        ("org_admin/unmanaged", _user(is_org_admin=True), UNMANAGED_DEPT, True, False),
        ("org_admin/none", _user(is_org_admin=True), None, True, False),
        (
            "dept_manager/granted",
            _user(managed=frozenset({GRANTED_DEPT, SUB_DEPT})),
            GRANTED_DEPT,
            True,
            True,
        ),
        (
            "dept_manager/sub_dept",
            _user(managed=frozenset({GRANTED_DEPT, SUB_DEPT})),
            SUB_DEPT,
            True,
            True,
        ),
        (
            "dept_manager/unmanaged",
            _user(managed=frozenset({GRANTED_DEPT, SUB_DEPT})),
            UNMANAGED_DEPT,
            False,
            False,
        ),
        (
            "dept_manager/none",
            _user(managed=frozenset({GRANTED_DEPT, SUB_DEPT})),
            None,
            False,
            False,
        ),
        ("employee/granted", _user(), GRANTED_DEPT, False, False),
        ("employee/none", _user(), None, False, False),
        (
            "system_worker/granted",
            Principal.system_worker(ORG_ID),
            GRANTED_DEPT,
            False,
            False,
        ),
        ("system_worker/none", Principal.system_worker(ORG_ID), None, False, False),
    ],
)
def test_department_management_policy_matrix(
    role_name: str,  # noqa: ARG001
    principal: Principal,
    target_dept: UUID | None,
    expected_can_manage: bool,
    expected_manages: bool,
) -> None:
    assert can_manage_department(principal, target_dept) is expected_can_manage
    assert manages_department(principal, target_dept) is expected_manages


@pytest.mark.parametrize(
    ("role_name", "principal", "expected"),
    [
        ("org_admin", _user(is_org_admin=True), True),
        ("dept_manager", _user(managed=frozenset({GRANTED_DEPT})), True),
        ("employee", _user(), False),
        ("system_worker", Principal.system_worker(ORG_ID), False),
    ],
)
def test_can_view_org_aggregates_matrix(
    role_name: str,  # noqa: ARG001
    principal: Principal,
    expected: bool,
) -> None:
    assert can_view_org_aggregates(principal) is expected
