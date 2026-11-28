from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy.dialects import postgresql

from app.authz.policies import OrgAdminRequired
from app.authz.principal import Principal
from app.domains.audit.models import ActorKind
from app.domains.org.models import Department, Organization
from app.domains.org.paths import department_paths
from app.domains.org.service import lock_org, require_admin

pytestmark = pytest.mark.unit


def test_paths_stop_at_cycles_and_missing_parents() -> None:
    org_id = uuid4()
    a = Department(org_id=org_id, name="A")
    b = Department(org_id=org_id, name="B", parent_department_id=a.id)
    a.parent_department_id = b.id
    orphan = Department(org_id=org_id, name="Orphan", parent_department_id=uuid4())
    assert department_paths([a, b, orphan]) == {
        a.id: "B/A",
        b.id: "A/B",
        orphan.id: "Orphan",
    }
    assert department_paths([]) == {}


def test_require_admin_and_lock_org_options() -> None:
    org_id, user_id = uuid4(), uuid4()
    require_admin(Principal(ActorKind.USER, org_id, user_id, None, True, frozenset()))
    with pytest.raises(OrgAdminRequired):
        require_admin(
            Principal(ActorKind.USER, org_id, user_id, None, False, frozenset())
        )

    class _FakeResult:
        def __init__(self, value: Organization | None) -> None:
            self._value = value

        def one(self) -> Organization:
            assert self._value is not None
            return self._value

        def one_or_none(self) -> Organization | None:
            return self._value

    class _FakeSession:
        def __init__(self, value: Organization | None) -> None:
            self.value = value
            self.sql = ""

        def exec(self, statement: Any) -> _FakeResult:
            self.sql = str(statement.compile(dialect=postgresql.dialect()))
            return _FakeResult(self.value)

    org = Organization(id=org_id, slug=str(org_id), name="Org")
    session = _FakeSession(org)
    assert lock_org(session, org_id) is org  # type: ignore[arg-type]
    assert "FOR UPDATE" in session.sql and "SKIP LOCKED" not in session.sql
    assert lock_org(session, org_id, read=True) is org  # type: ignore[arg-type]
    assert "FOR SHARE" in session.sql
    missing = _FakeSession(None)
    assert lock_org(missing, org_id, skip_locked=True) is None  # type: ignore[arg-type]
    assert "FOR UPDATE SKIP LOCKED" in missing.sql
