"""Keep audit filters readable when backend events are added."""

import ast
import json
import re
from collections.abc import Callable
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit


def test_audit_labels_cover_backend_events() -> None:
    root = Path(__file__).resolve().parents[3]
    labels = (root / "frontend/src/components/Admin/auditLabels.ts").read_text()
    expansions = {
        "capability_proposal.{}": {"open", "accepted", "dismissed"},
        "review_delegation.{}": {"created", "revoked"},
        "appeal.{}": {"open", "upheld", "reopened"},
        "setup.step_{}": {"completed", "skipped"},
        "sync_run.{}": {"succeeded", "failed"},
        "external_identity.{}": {"linked", "unlinked"},
        "account.{}": {"password_reset", "disabled", "enabled"},
    }
    actions: set[str] = {"seed.loaded"}
    targets: set[str] = set()
    for path in (root / "backend/app").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            if node.func.id not in {"record_audit", "audit"}:
                continue
            values = {k.arg: k.value for k in node.keywords}
            if node.func.id == "audit":
                if len(node.args) > 2:
                    values.setdefault("action", node.args[2])
                if "domains/capacity/" in path.as_posix() and len(node.args) > 3:
                    values.setdefault("target_type", node.args[3])
            for key, destination in (("action", actions), ("target_type", targets)):
                value = values.get(key)
                if isinstance(value, ast.JoinedStr):
                    pattern = "".join(
                        p.value
                        if isinstance(p, ast.Constant) and isinstance(p.value, str)
                        else "{}"
                        for p in value.values
                    )
                    assert pattern in expansions, f"Expand audit pattern {pattern}"
                    destination.update(pattern.format(v) for v in expansions[pattern])
                elif isinstance(value, ast.IfExp):
                    destination.update(
                        n.value
                        for n in (value.body, value.orelse)
                        if isinstance(n, ast.Constant) and isinstance(n.value, str)
                    )
                elif isinstance(value, ast.Constant):
                    destination.update(
                        n.value
                        for n in ast.walk(value)
                        if isinstance(n, ast.Constant) and isinstance(n.value, str)
                    )
    for name, expected in (("auditLabels", actions), ("targetLabels", targets)):
        block = labels.split(f"export const {name}")[1].split("}", 1)[0]
        for entry in expected:
            assert re.search(rf'["\s]{re.escape(entry)}"?:\s*"', block), entry

    catalogs = {
        locale: json.loads(
            (root / f"frontend/src/i18n/locales/{locale}/audit.json").read_text()
        )
        for locale in ("zh-CN", "en")
    }
    checks: tuple[tuple[str, set[str], Callable[[str], str]], ...] = (
        ("actions", actions, lambda key: key.replace(".", "_")),
        ("targets", targets, lambda key: key),
    )
    for locale, catalog in catalogs.items():
        for section, expected, transform in checks:
            entries = catalog[section]
            for entry in expected:
                key = transform(entry)
                text = entries.get(key)
                assert isinstance(text, str) and text.strip(), (
                    f"Missing {locale} audit label for {section}.{key}"
                )
