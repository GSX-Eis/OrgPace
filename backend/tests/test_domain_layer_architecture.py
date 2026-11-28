"""Enforce 4-layer domain dependency direction and SCC convergence."""

import ast
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

DOMAINS = Path(__file__).resolve().parents[1] / "app" / "domains"

LAYER_BY_DOMAIN: dict[str, int] = {
    # L0: core domain foundations
    "org": 0,
    "account": 0,
    "audit": 0,
    "evidence": 0,
    "profile": 0,
    "capability": 0,
    # L1: shared infrastructure
    "model": 1,
    "access_token": 1,
    "chat_runtime": 1,
    # L2: business workflows
    "change_request": 2,
    "review": 2,
    "drafting": 2,
    "source": 2,
    "work": 2,
    "capacity": 2,
    "planning": 2,
    "inbox": 2,
    # L3: entrypoints & assistants
    "bot": 3,
    "admin_assistant": 3,
    "im": 3,
    "admin": 3,
    "setup": 3,
}

# Temporary whitelist strictly reserved for D10a (capacity/assistant.py -> bot).
# Remove entries immediately once the underlying dependency is eliminated.
UPWARD_WHITELIST: set[tuple[str, str]] = {
    ("capacity/assistant.py", "app.domains.bot.tools.confirm_plan_reply"),
}

# Temporary whitelist strictly reserved for D9a (bot <-> admin_assistant L3 cycle).
# Remove entries immediately once chat_runtime is extracted.
L3_BOT_ADMIN_ASSISTANT_WHITELIST: set[tuple[str, str]] = {
    ("admin_assistant/change_set.py", "app.domains.bot.store"),
    ("admin_assistant/core.py", "app.domains.bot.admission.BotBusy"),
    ("admin_assistant/core.py", "app.domains.bot.admission.BotDraftingPriority"),
    ("admin_assistant/core.py", "app.domains.bot.admission.BotQuotaPaused"),
    ("admin_assistant/core.py", "app.domains.bot.admission.BotRateLimited"),
    ("admin_assistant/core.py", "app.domains.bot.admission.begin_turn"),
    ("admin_assistant/core.py", "app.domains.bot.attachments"),
    ("admin_assistant/core.py", "app.domains.bot.presentation.DEADLINE_MESSAGE"),
    ("admin_assistant/core.py", "app.domains.bot.presentation.retry_time"),
    ("admin_assistant/core.py", "app.domains.bot.store"),
    ("admin_assistant/files.py", "app.domains.bot.store"),
    ("admin_assistant/materials.py", "app.domains.bot.attachments.AttachmentError"),
    (
        "admin_assistant/materials.py",
        "app.domains.bot.attachments.get_session_attachment",
    ),
    ("admin_assistant/registry.py", "app.domains.bot.settings"),
    ("admin_assistant/store.py", "app.domains.bot.store"),
    ("admin_assistant/tools.py", "app.domains.bot.attachments"),
    ("bot/admission.py", "app.domains.admin_assistant.store"),
    ("bot/attachments.py", "app.domains.admin_assistant.store"),
}

NON_LAYERED_MODULES = {"base", "employee_tools", "manager_tools"}


@dataclass(frozen=True)
class AnalysisResult:
    unknown_packages: list[str]
    upward_violations: list[str]
    stale_upward_whitelist: list[str]
    bot_aa_violations: list[str]
    stale_bot_aa_whitelist: list[str]
    edges: dict[str, set[str]]
    sccs: list[list[str]]


def _is_type_checking(node: ast.If) -> bool:
    test = node.test
    return (isinstance(test, ast.Name) and test.id == "TYPE_CHECKING") or (
        isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING"
    )


def _iter_runtime_imports(tree: ast.AST, rel_parts: list[str]) -> list[str]:
    raw: list[tuple[str, int]] = []
    stack: list[ast.AST] = [tree]
    while stack:
        node = stack.pop()
        if isinstance(node, ast.If) and _is_type_checking(node):
            stack.extend(node.orelse)
            continue
        if isinstance(node, ast.Import):
            raw.extend((alias.name, 0) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            prefix = node.module or ""
            for alias in node.names:
                mod = f"{prefix}.{alias.name}" if prefix else alias.name
                raw.append((mod, node.level))
        stack.extend(ast.iter_child_nodes(node))

    resolved: list[str] = []
    for mod, level in raw:
        if level:
            base = rel_parts[: len(rel_parts) - level + 1]
            resolved.append(".".join([*base, *([mod] if mod else [])]))
        else:
            resolved.append(mod)
    return resolved


def _tarjan_sccs(nodes: list[str], edges: dict[str, set[str]]) -> list[list[str]]:
    index = 0
    indices: dict[str, int] = {}
    lowlink: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    sccs: list[list[str]] = []

    def strongconnect(node: str) -> None:
        nonlocal index
        indices[node] = lowlink[node] = index
        index += 1
        stack.append(node)
        on_stack.add(node)
        for neighbor in sorted(edges.get(node, ())):
            if neighbor not in indices:
                strongconnect(neighbor)
                lowlink[node] = min(lowlink[node], lowlink[neighbor])
            elif neighbor in on_stack:
                lowlink[node] = min(lowlink[node], indices[neighbor])
        if lowlink[node] == indices[node]:
            component: list[str] = []
            while True:
                member = stack.pop()
                on_stack.remove(member)
                component.append(member)
                if member == node:
                    break
            sccs.append(sorted(component))

    for node in sorted(nodes):
        if node not in indices:
            strongconnect(node)
    return sccs


def analyze_domains(
    domains_dir: Path,
    *,
    upward_whitelist: set[tuple[str, str]] = UPWARD_WHITELIST,
    bot_aa_whitelist: set[tuple[str, str]] = L3_BOT_ADMIN_ASSISTANT_WHITELIST,
) -> AnalysisResult:
    packages = sorted(
        p.name
        for p in domains_dir.iterdir()
        if p.is_dir() and not p.name.startswith("__")
    )
    unknown_packages = [pkg for pkg in packages if pkg not in LAYER_BY_DOMAIN]
    edges: dict[str, set[str]] = defaultdict(set)
    seen_upward: set[tuple[str, str]] = set()
    seen_bot_aa: set[tuple[str, str]] = set()
    upward_violations: list[str] = []
    bot_aa_violations: list[str] = []

    for path in sorted(domains_dir.rglob("*.py")):
        rel = path.relative_to(domains_dir)
        if len(rel.parts) < 2:
            continue
        if path.name in ("models.py", "schemas.py") or path.name.endswith(
            "_schemas.py"
        ):
            continue
        src_pkg = rel.parts[0]
        if src_pkg not in LAYER_BY_DOMAIN:
            continue
        rel_posix = rel.as_posix()
        rel_parts = ["app", "domains", *rel.parts[:-1]]
        for imp in _iter_runtime_imports(ast.parse(path.read_text()), rel_parts):
            if not imp.startswith("app.domains."):
                continue
            parts = imp.split(".")
            if len(parts) < 3:
                continue
            dst_pkg = parts[2]
            tail = parts[3] if len(parts) > 3 else ""
            if (
                dst_pkg in NON_LAYERED_MODULES
                or tail in ("models", "schemas")
                or tail.endswith("_schemas")
            ):
                continue
            if dst_pkg not in LAYER_BY_DOMAIN:
                unknown_packages.append(f"{rel_posix}: {dst_pkg}")
                continue
            if dst_pkg == src_pkg:
                continue
            edges[src_pkg].add(dst_pkg)
            edge_key = (rel_posix, imp)
            if LAYER_BY_DOMAIN[src_pkg] < LAYER_BY_DOMAIN[dst_pkg]:
                seen_upward.add(edge_key)
                if edge_key not in upward_whitelist:
                    upward_violations.append(
                        f"{rel_posix} (L{LAYER_BY_DOMAIN[src_pkg]}) -> "
                        f"{imp} (L{LAYER_BY_DOMAIN[dst_pkg]})"
                    )
            if {src_pkg, dst_pkg} == {"bot", "admin_assistant"}:
                seen_bot_aa.add(edge_key)
                if edge_key not in bot_aa_whitelist:
                    bot_aa_violations.append(f"{rel_posix} -> {imp}")

    stale_upward = [f"{f}: {m}" for f, m in sorted(upward_whitelist - seen_upward)]
    stale_bot_aa = [f"{f}: {m}" for f, m in sorted(bot_aa_whitelist - seen_bot_aa)]
    known_nodes = [pkg for pkg in packages if pkg in LAYER_BY_DOMAIN]
    sccs = _tarjan_sccs(known_nodes, edges)
    return AnalysisResult(
        unknown_packages=sorted(set(unknown_packages)),
        upward_violations=sorted(upward_violations),
        stale_upward_whitelist=stale_upward,
        bot_aa_violations=sorted(bot_aa_violations),
        stale_bot_aa_whitelist=stale_bot_aa,
        edges=dict(edges),
        sccs=sccs,
    )


def test_domain_4layer_architecture_and_scc_convergence() -> None:
    result = analyze_domains(DOMAINS)
    assert result.unknown_packages == []
    assert result.upward_violations == []
    assert result.stale_upward_whitelist == []
    assert result.bot_aa_violations == []
    assert result.stale_bot_aa_whitelist == []

    # Inbox must no longer point upward or into drafting/source.
    assert not (
        result.edges.get("inbox", set()) & {"im", "admin", "drafting", "source"}
    )
    assert not (DOMAINS / "inbox" / "admin_todos.py").exists()
    assert not (DOMAINS / "inbox" / "reminders.py").exists()
    assert not (DOMAINS / "capability" / "department_defaults.py").exists()
    assert (DOMAINS / "im" / "admin_todos.py").exists()
    assert (DOMAINS / "drafting" / "reminders.py").exists()
    assert (DOMAINS / "drafting" / "department_defaults.py").exists()

    # Largest SCC converged from 21 (d49cc80) / 13 (1544ab8) down to <= 5,
    # and access_token is completely outside any multi-node cycle.
    multi_sccs = [scc for scc in result.sccs if len(scc) > 1]
    assert max((len(scc) for scc in result.sccs), default=0) <= 5
    assert all("access_token" not in scc for scc in multi_sccs)


@pytest.mark.parametrize(
    ("relative", "source", "expected_fragment"),
    [
        (
            "capability/bad_l0_l1.py",
            "from app.domains.model.service import model_config\n",
            "capability/bad_l0_l1.py (L0) -> app.domains.model.service.model_config (L1)",
        ),
        (
            "org/bad_l0_l2.py",
            "import app.domains.inbox.service\n",
            "org/bad_l0_l2.py (L0) -> app.domains.inbox.service (L2)",
        ),
        (
            "access_token/bad_l1_l2.py",
            "from app.domains.change_request.employee import employee_id\n",
            "access_token/bad_l1_l2.py (L1) -> app.domains.change_request.employee.employee_id (L2)",
        ),
        (
            "inbox/bad_lazy.py",
            "def f():\n    from app.domains.im.notifications import enqueue\n",
            "inbox/bad_lazy.py (L2) -> app.domains.im.notifications.enqueue (L3)",
        ),
        (
            "capacity/bad_rel.py",
            "def f():\n    from .. import admin\n",
            "capacity/bad_rel.py (L2) -> app.domains.admin (L3)",
        ),
    ],
)
def test_upward_import_counterexamples(
    tmp_path: Path, relative: str, source: str, expected_fragment: str
) -> None:
    path = tmp_path / relative
    path.parent.mkdir(parents=True)
    path.write_text(source)
    result = analyze_domains(tmp_path, upward_whitelist=set(), bot_aa_whitelist=set())
    assert expected_fragment in result.upward_violations


def test_bot_admin_assistant_new_edge_blocked_and_stale_whitelist_rejected(
    tmp_path: Path,
) -> None:
    (tmp_path / "bot").mkdir()
    (tmp_path / "admin_assistant").mkdir()
    (tmp_path / "bot" / "new_bad.py").write_text(
        "from app.domains.admin_assistant.core import run\n"
    )
    (tmp_path / "capacity").mkdir()
    (tmp_path / "capacity" / "ok.py").write_text(
        "from typing import TYPE_CHECKING\n"
        "from app.domains.bot.models import BotSession\n"
        "from app.domains.bot.schemas import BotReply\n"
        "from app.domains.capacity.demand_schemas import DemandListInput\n"
        "if TYPE_CHECKING:\n"
        "    from app.domains.im.notifications import enqueue\n"
    )

    result = analyze_domains(
        tmp_path,
        upward_whitelist={
            ("capacity/assistant.py", "app.domains.bot.tools.confirm_plan_reply")
        },
        bot_aa_whitelist={("admin_assistant/core.py", "app.domains.bot.store")},
    )
    assert result.upward_violations == []
    assert result.bot_aa_violations == [
        "bot/new_bad.py -> app.domains.admin_assistant.core.run"
    ]
    assert result.stale_upward_whitelist == [
        "capacity/assistant.py: app.domains.bot.tools.confirm_plan_reply"
    ]
    assert result.stale_bot_aa_whitelist == [
        "admin_assistant/core.py: app.domains.bot.store"
    ]
