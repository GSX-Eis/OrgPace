import ast
from pathlib import Path
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


L0_PACKAGES = ("org", "account", "audit", "evidence", "profile", "capability")
FORBIDDEN_L2_L3 = {
    "admin",
    "admin_assistant",
    "bot",
    "capacity",
    "change_request",
    "drafting",
    "im",
    "inbox",
    "planning",
    "review",
    "setup",
    "source",
    "work",
}


def _is_type_checking(node: ast.If) -> bool:
    test = node.test
    return (isinstance(test, ast.Name) and test.id == "TYPE_CHECKING") or (
        isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING"
    )


def _iter_runtime_imports(tree: ast.AST) -> list[tuple[str, int]]:
    results: list[tuple[str, int]] = []
    stack: list[ast.AST] = [tree]
    while stack:
        node = stack.pop()
        if isinstance(node, ast.If) and _is_type_checking(node):
            stack.extend(node.orelse)
            continue
        if isinstance(node, ast.Import):
            results.extend((alias.name, 0) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            results.append((node.module or "", node.level))
        stack.extend(ast.iter_child_nodes(node))
    return results


def _l0_boundary_violations(domains: Path) -> list[str]:
    violations: list[str] = []
    for package in L0_PACKAGES:
        pkg_dir = domains / package
        if not pkg_dir.exists():
            continue
        for path in sorted(pkg_dir.rglob("*.py")):
            if path.name in ("models.py", "schemas.py"):
                continue
            rel = path.relative_to(domains)
            rel_parts = ["app", "domains", *rel.parts[:-1]]
            for module, level in _iter_runtime_imports(ast.parse(path.read_text())):
                if level:
                    base = rel_parts[: len(rel_parts) - level + 1]
                    resolved = ".".join([*base, *([module] if module else [])])
                else:
                    resolved = module
                if not resolved.startswith("app.domains."):
                    continue
                parts = resolved.split(".")
                if len(parts) < 3:
                    continue
                target = parts[2]
                tail = parts[3] if len(parts) > 3 else ""
                if (
                    target == "base"
                    or tail in ("models", "schemas")
                    or tail.endswith("_schemas")
                ):
                    continue
                if target in FORBIDDEN_L2_L3 or (
                    package == "org" and target == "capability"
                ):
                    violations.append(f"{rel.as_posix()}: {resolved}")
    return violations


def test_l0_layer_boundaries(tmp_path: Path) -> None:
    domains = Path(__file__).resolve().parents[3] / "app" / "domains"
    assert not (domains / "profile" / "coverage.py").exists()
    assert (domains / "admin" / "coverage.py").exists()
    assert _l0_boundary_violations(domains) == []

    # Counterexamples: top-level import, lazy local import, and relative import are caught;
    # TYPE_CHECKING and models/schemas imports are allowed.
    probe = tmp_path / "domains"
    (probe / "profile").mkdir(parents=True)
    (probe / "capability").mkdir(parents=True)
    (probe / "org").mkdir(parents=True)
    (probe / "profile" / "bad_top.py").write_text(
        "import app.domains.drafting.update_settings\n"
    )
    (probe / "capability" / "bad_lazy.py").write_text(
        "def f():\n"
        "    from app.domains.inbox.service import notify\n"
        "    from ..drafting.service import queue_drafting\n"
    )
    (probe / "org" / "bad_cap.py").write_text(
        "from app.domains.capability.department import DepartmentArgs\n"
    )
    (probe / "profile" / "ok.py").write_text(
        "from typing import TYPE_CHECKING\n"
        "from app.domains.change_request.models import ProfileChangeRequest\n"
        "from app.domains.change_request.schemas import ChangeRequestPublic\n"
        "if TYPE_CHECKING:\n"
        "    from app.domains.drafting.service import queue_drafting\n"
    )
    assert sorted(_l0_boundary_violations(probe)) == sorted(
        [
            "profile/bad_top.py: app.domains.drafting.update_settings",
            "capability/bad_lazy.py: app.domains.inbox.service",
            "capability/bad_lazy.py: app.domains.drafting.service",
            "org/bad_cap.py: app.domains.capability.department",
        ]
    )
