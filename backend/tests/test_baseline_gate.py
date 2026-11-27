"""Contract and execution tests for the cross-project pytest Node ID baseline gate."""

from __future__ import annotations

import importlib.util
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GATE_SCRIPT = REPO_ROOT / "scripts" / "test_baseline_gate.py"
BASELINE_FILE = REPO_ROOT / "backend" / "tests" / "baseline_failures.json"

OLD = "tests/test_sample.py::test_old"
NEW = "tests/test_sample.py::test_new"
OTHER = "tests/test_other.py::test_other"
COMMIT = "a" * 40


def _load_gate() -> Any:
    spec = importlib.util.spec_from_file_location("test_baseline_gate_mod", GATE_SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


gate = _load_gate()


def _make_baseline(*nodes: str, repo: str = "OrgPace") -> Any:
    entries = {
        node: gate.Entry(outcome="failed", reason="known", issue="NERE-1499")
        for node in nodes
    }
    return gate.Baseline(repo=repo, baseline_commit=COMMIT, entries=entries)


@pytest.mark.parametrize("tamper", ["set_sha256", "outcome", "repo", "commit"])
def test_baseline_rejects_tampering(tmp_path: Path, tamper: str) -> None:
    path = tmp_path / "baseline.json"
    _make_baseline(OLD, NEW).write(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert gate.Baseline.load(path, expected_repo="OrgPace") == _make_baseline(OLD, NEW)
    assert gate.set_sha256(_make_baseline(OLD, NEW).entries) == gate.set_sha256(
        _make_baseline(NEW, OLD).entries
    )
    if tamper == "outcome":
        data["entries"][OLD]["outcome"] = "error"
        match = "set_sha256 mismatch"
    elif tamper == "set_sha256":
        data["set_sha256"] = "bogus"
        match = "set_sha256 mismatch"
    elif tamper == "repo":
        data["repo"] = "wrong_repo"
        match = "expected repo"
    else:
        data["baseline_commit"] = "not-a-sha"
        match = "baseline_commit"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match=match):
        gate.Baseline.load(path, expected_repo="OrgPace")


@pytest.mark.parametrize(
    ("expected", "outcomes", "category", "value"),
    [
        (set(), {}, "empty_collection", True),
        ({OLD, NEW}, {OLD: "failed"}, "unreported", (NEW,)),
        ({OLD, NEW}, {}, "unreported", tuple(sorted((OLD, NEW)))),
        ({OLD, NEW}, {OLD: "passed", NEW: "failed"}, "unexpected_failures", (NEW,)),
        ({OLD}, {OLD: "error"}, "outcome_changed", (OLD,)),
        ({NEW}, {NEW: "passed"}, "missing_from_run", (OLD,)),
        ({OLD}, {OLD: "skipped"}, "missing_from_run", (OLD,)),
        ({OLD}, {OLD: "xfailed"}, "missing_from_run", (OLD,)),
        ({OLD}, {OLD: "xpassed"}, "missing_from_run", (OLD,)),
        ({OLD}, {OLD: "passed"}, "resolved_baseline", (OLD,)),
    ],
)
def test_gate_classifies_all_six_false_green_categories(
    expected: set[str],
    outcomes: dict[str, str],
    category: str,
    value: Any,
) -> None:
    verdict = gate.evaluate(_make_baseline(OLD), expected, outcomes, scoped_nodes={OLD})
    assert not verdict.passed
    assert getattr(verdict, category) == value


def test_exact_match_and_repo_zero_baseline() -> None:
    assert gate.evaluate(
        _make_baseline(OLD, OTHER), {OLD}, {OLD: "failed"}, scoped_nodes={OLD}
    ).passed
    zero = gate.Baseline.load(BASELINE_FILE, expected_repo="OrgPace")
    assert zero.entries == {}
    assert gate.evaluate(zero, {NEW}, {NEW: "passed"}, scoped_nodes=set()).passed


def test_refresh_requires_metadata_and_preserves_out_of_scope_entries(
    tmp_path: Path,
) -> None:
    existing = _make_baseline(OLD, OTHER)
    expected = {OLD, NEW}
    outcomes = {OLD: "error", NEW: "failed"}
    verdict = gate.evaluate(existing, expected, outcomes, scoped_nodes={OLD})
    with pytest.raises(ValueError, match="--additions"):
        gate.refresh(
            existing, verdict, expected, outcomes, commit=COMMIT, additions_path=None
        )
    additions = tmp_path / "additions.json"
    additions.write_text(
        json.dumps({NEW: {"reason": "known regression", "issue": "NERE-1500"}}),
        encoding="utf-8",
    )
    updated = gate.refresh(
        existing, verdict, expected, outcomes, commit="b" * 40, additions_path=additions
    )
    assert updated.baseline_commit == "b" * 40
    assert updated.entries[OLD] == dict(existing.entries[OLD], outcome="error")
    assert updated.entries[OTHER] == existing.entries[OTHER]
    assert updated.entries[NEW] == {
        "outcome": "failed",
        "reason": "known regression",
        "issue": "NERE-1500",
    }


def test_evidence_parsers_and_priority_merge() -> None:
    assert gate.parse_expected(json.dumps([OLD, OLD, NEW])) == {OLD, NEW}
    with pytest.raises(ValueError, match="manifest"):
        gate.parse_expected(json.dumps(["../tests/test_file.py::test_case"]))
    with pytest.raises(ValueError, match="Duplicate"):
        gate.parse_outcomes(f'{{"{OLD}":"passed","{OLD}":"error"}}')
    with pytest.raises(ValueError, match="outcome report"):
        gate.parse_outcomes(json.dumps({OLD: "rerun"}))
    outcomes: dict[str, str] = {}
    for outcome in ["passed", "xfailed", "failed", "skipped", "error", "xpassed"]:
        gate.merge_outcome(outcomes, OLD, outcome)
    assert outcomes == {OLD: "error"}


def test_strip_loadgroup_suffix_preserves_parametrized_at_signs() -> None:
    assert (
        gate._strip_loadgroup_suffix("tests/acceptance/test_m2.py::test_case@model")
        == "tests/acceptance/test_m2.py::test_case"
    )
    assert (
        gate._strip_loadgroup_suffix(
            "tests/acceptance/test_m2.py::test_login[user@example.com]@model"
        )
        == "tests/acceptance/test_m2.py::test_login[user@example.com]"
    )
    assert (
        gate._strip_loadgroup_suffix("tests/test_auth.py::test_login[user@example.com]")
        == "tests/test_auth.py::test_login[user@example.com]"
    )


def test_cli_init_verify_multi_shard_and_run_end_to_end(tmp_path: Path) -> None:
    baseline_path = tmp_path / "baseline_failures.json"
    init_res = subprocess.run(
        [
            sys.executable,
            str(GATE_SCRIPT),
            "init",
            "--output",
            str(baseline_path),
            "--repo",
            "sample-repo",
            "--commit",
            COMMIT,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert init_res.returncode == 0, init_res.stderr

    # Verify multi-shard aggregation (like CI 3-shard backend job).
    exp1 = tmp_path / "exp1.json"
    exp2 = tmp_path / "exp2.json"
    out1 = tmp_path / "out1.json"
    out2 = tmp_path / "out2.json"
    exp1.write_text(json.dumps([OLD]), encoding="utf-8")
    exp2.write_text(json.dumps([NEW]), encoding="utf-8")
    out1.write_text(json.dumps({OLD: "passed"}), encoding="utf-8")
    out2.write_text(json.dumps({NEW: "passed"}), encoding="utf-8")

    verify_ok = subprocess.run(
        [
            sys.executable,
            str(GATE_SCRIPT),
            "verify",
            "--baseline",
            str(baseline_path),
            "--repo",
            "sample-repo",
            "--scope",
            "all",
            "--expected",
            str(exp1),
            str(exp2),
            "--outcomes",
            str(out1),
            str(out2),
            "--json",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert verify_ok.returncode == 0, verify_ok.stdout + verify_ok.stderr
    assert json.loads(verify_ok.stdout)["passed"] is True

    # End-to-end `run` subcommand against a real isolated pytest project.
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
    (proj / "test_cases.py").write_text(
        "def test_ok():\n    assert True\n\ndef test_ok2():\n    assert 1 + 1 == 2\n",
        encoding="utf-8",
    )
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in {"PYTEST_ADDOPTS", "PYTEST_PLUGINS"}
    }
    env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    run_ok = subprocess.run(
        [
            sys.executable,
            str(GATE_SCRIPT),
            "run",
            "--baseline",
            str(baseline_path),
            "--repo",
            "sample-repo",
            "--pytest-cmd",
            f"{shlex.quote(sys.executable)} -m pytest",
            "--",
            "-q",
            "-p",
            "no:cacheprovider",
            "test_cases.py",
        ],
        cwd=proj,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert run_ok.returncode == 0, run_ok.stdout + run_ok.stderr
    assert "[baseline-gate] PASS" in run_ok.stdout

    # Inject a conftest that silently drops test_ok2 during execution (false-green attack).
    (proj / "conftest.py").write_text(
        "def pytest_collection_modifyitems(config, items):\n"
        "    if not config.option.collectonly:\n"
        "        items[:] = [i for i in items if i.name != 'test_ok2']\n",
        encoding="utf-8",
    )
    run_tampered = subprocess.run(
        [
            sys.executable,
            str(GATE_SCRIPT),
            "run",
            "--baseline",
            str(baseline_path),
            "--repo",
            "sample-repo",
            "--pytest-cmd",
            f"{shlex.quote(sys.executable)} -m pytest",
            "--json",
            "--",
            "-q",
            "-p",
            "no:cacheprovider",
            "test_cases.py",
        ],
        cwd=proj,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert run_tampered.returncode == 1, run_tampered.stdout + run_tampered.stderr
    payload = json.loads(run_tampered.stdout)
    assert payload["passed"] is False
    assert payload["unreported"] == ["test_cases.py::test_ok2"]
