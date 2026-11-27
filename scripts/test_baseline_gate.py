#!/usr/bin/env python3
"""Cross-project pytest Node ID hash ratchet gate (baseline_failures.v1).

Standalone, stdlib-only CLI and pytest plugin for preventing false-green test
results across repositories:
  1. empty_collection    - independent --collect-only returned 0 tests
  2. unreported          - expected node IDs missing from outcomes (worker crash / dropped)
  3. unexpected_failures - failures/errors outside the scoped baseline (new/substitute regressions)
  4. outcome_changed     - baseline failure flipped between failed and error
  5. missing_from_run    - baseline failure deleted, skipped, xfailed, or xpassed
  6. resolved_baseline   - baseline failure now passes (requires explicit ratchet refresh)

Compatible with the ``baseline_failures.v1`` schema used by ``quantation_factor_database``.
Install as ``~/.local/bin/test-baseline-gate`` or copy into a repo as ``scripts/test_baseline_gate.py``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import tempfile
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, TypedDict

SCHEMA = "baseline_failures.v1"
COLLECT_OPTION = "--baseline-collect"
RESULTS_OPTION = "--baseline-results"
OUTCOME_PRIORITY = {
    name: rank
    for rank, name in enumerate(
        ("passed", "skipped", "xfailed", "xpassed", "failed", "error")
    )
}
FAILURES = frozenset({"failed", "error"})

# Pytest flags that only affect execution/reporting and must be stripped during
# the independent --collect-only phase.
_COLLECT_STRIP_FLAGS = frozenset(
    {
        "-x",
        "--exitfirst",
        "--cov",
        "--store-durations",
        "--clean-durations",
        "--lf",
        "--last-failed",
        "--ff",
        "--failed-first",
        "--nf",
        "--new-first",
    }
)
_COLLECT_STRIP_VALUE_FLAGS = frozenset(
    {
        "-n",
        "--numprocesses",
        "--dist",
        "--maxfail",
        "--cov",
        "--cov-report",
        "--cov-config",
        "--cov-fail-under",
        "--junitxml",
        "--durations",
        "--durations-min",
        "--reruns",
        "--reruns-delay",
    }
)


class Entry(TypedDict):
    outcome: str
    reason: str
    issue: str


def set_sha256(entries: Mapping[str, Entry]) -> str:
    """Compute canonical SHA-256 over sorted [node_id, outcome] pairs."""
    pairs = [[node, entry["outcome"]] for node, entry in sorted(entries.items())]
    encoded = json.dumps(pairs, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    tmp_path = path.parent / f".tmp-{os.getpid()}-{secrets.token_hex(6)}"
    fd = os.open(str(tmp_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    try:
        os.write(fd, encoded)
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        tmp_path.unlink(missing_ok=True)
        raise
    os.close(fd)
    os.replace(tmp_path, path)


def _load_json(raw: str | bytes) -> Any:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key!r}")
            result[key] = value
        return result

    return json.loads(raw, object_pairs_hook=unique)


def node_file(node: str) -> str:
    return node.partition("::")[0]


def _valid_node(node: Any) -> bool:
    if not isinstance(node, str):
        return False
    file, separator, name = node.partition("::")
    path = PurePosixPath(file)
    return bool(
        separator
        and name
        and file
        and path.as_posix() == file
        and not path.is_absolute()
        and file != "."
        and ".." not in path.parts
    )


def _metadata(value: Any, node: str) -> tuple[str, str]:
    if isinstance(value, dict):
        reason, issue = value.get("reason"), value.get("issue")
        if (
            isinstance(reason, str)
            and reason.strip()
            and isinstance(issue, str)
            and issue.strip()
        ):
            return reason, issue
    raise ValueError(
        f"Baseline metadata for {node!r} needs nonempty reason and issue strings"
    )


@dataclass(frozen=True)
class Baseline:
    repo: str
    baseline_commit: str
    entries: dict[str, Entry]

    @classmethod
    def load(cls, path: Path, *, expected_repo: str | None = None) -> Baseline:
        data = _load_json(path.read_bytes())
        if not isinstance(data, dict) or data.get("schema_version") != SCHEMA:
            raise ValueError(f"{path}: expected schema {SCHEMA}")
        repo = data.get("repo")
        if not isinstance(repo, str) or not repo.strip():
            raise ValueError(f"{path}: repo must be a nonempty string")
        if expected_repo is not None and repo != expected_repo:
            raise ValueError(f"{path}: expected repo {expected_repo!r}, got {repo!r}")
        commit, entries = data.get("baseline_commit"), data.get("entries")
        if not isinstance(commit, str) or not re.fullmatch(r"[a-f0-9]{40}", commit):
            raise ValueError(f"{path}: baseline_commit must be a full Git commit SHA")
        if not isinstance(entries, dict):
            raise ValueError(f"{path}: entries must be a JSON object")  # noqa: TRY004
        for node, entry in entries.items():
            if not _valid_node(node):
                raise ValueError(f"{path}: invalid test node ID {node!r}")
            _metadata(entry, node)
            if entry.get("outcome") not in ("failed", "error"):
                raise ValueError(f"{path}: invalid failure outcome for {node!r}")
        expected_hash = set_sha256(entries)
        if data.get("set_sha256") != expected_hash:
            raise ValueError(f"{path}: set_sha256 mismatch (computed {expected_hash})")
        return cls(repo=repo, baseline_commit=commit, entries=entries)

    def write(self, path: Path) -> None:
        if not isinstance(self.repo, str) or not self.repo.strip():
            raise ValueError("repo must be a nonempty string")
        if not re.fullmatch(r"[a-f0-9]{40}", self.baseline_commit):
            raise ValueError("baseline_commit must be a full 40-char lowercase Git SHA")
        _atomic_write_json(
            path,
            {
                "schema_version": SCHEMA,
                "repo": self.repo,
                "baseline_commit": self.baseline_commit,
                "entries": dict(sorted(self.entries.items())),
                "set_sha256": set_sha256(self.entries),
            },
        )


def parse_expected(raw: str | bytes) -> set[str]:
    data = _load_json(raw)
    if not isinstance(data, list) or not all(map(_valid_node, data)):
        raise ValueError("Invalid pytest expected node ID manifest")
    return set(data)


def parse_outcomes(raw: str | bytes) -> dict[str, str]:
    data = _load_json(raw)
    if not isinstance(data, dict) or any(
        not _valid_node(node)
        or not isinstance(outcome, str)
        or outcome not in OUTCOME_PRIORITY
        for node, outcome in data.items()
    ):
        raise ValueError("Invalid pytest node ID outcome report")
    return data


def merge_outcome(outcomes: dict[str, str], node: str, outcome: str) -> None:
    if (
        node not in outcomes
        or OUTCOME_PRIORITY[outcome] > OUTCOME_PRIORITY[outcomes[node]]
    ):
        outcomes[node] = outcome


@dataclass(frozen=True)
class GateVerdict:
    unreported: tuple[str, ...]
    unexpected_failures: tuple[str, ...]
    outcome_changed: tuple[str, ...]
    missing_from_run: tuple[str, ...]
    resolved_baseline: tuple[str, ...]
    empty_collection: bool

    @property
    def passed(self) -> bool:
        return not (
            self.unreported
            or self.unexpected_failures
            or self.outcome_changed
            or self.missing_from_run
            or self.resolved_baseline
            or self.empty_collection
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "empty_collection": self.empty_collection,
            "unreported": list(self.unreported),
            "unexpected_failures": list(self.unexpected_failures),
            "outcome_changed": list(self.outcome_changed),
            "missing_from_run": list(self.missing_from_run),
            "resolved_baseline": list(self.resolved_baseline),
        }

    def format_report(
        self, *, expected_count: int, outcomes_count: int, baseline_count: int
    ) -> str:
        if self.passed:
            return (
                f"[baseline-gate] PASS: {outcomes_count}/{expected_count} expected tests "
                f"verified against baseline ({baseline_count} known failure(s))."
            )
        lines = [
            (
                f"[baseline-gate] FAIL: {outcomes_count}/{expected_count} outcomes vs "
                f"baseline ({baseline_count} known failure(s)):"
            )
        ]
        if self.empty_collection:
            lines.append(
                "  - empty_collection: independent --collect-only collected 0 tests"
            )
        for label, items in (
            ("unreported", self.unreported),
            ("unexpected_failures", self.unexpected_failures),
            ("outcome_changed", self.outcome_changed),
            ("missing_from_run", self.missing_from_run),
            ("resolved_baseline", self.resolved_baseline),
        ):
            if items:
                preview = ", ".join(items[:10])
                extra = f" (+{len(items) - 10} more)" if len(items) > 10 else ""
                lines.append(f"  - {label} ({len(items)}): {preview}{extra}")
        return "\n".join(lines)


def evaluate(
    baseline: Baseline,
    expected: set[str],
    outcomes: Mapping[str, str],
    *,
    scoped_nodes: Collection[str],
) -> GateVerdict:
    failures = {node for node, outcome in outcomes.items() if outcome in FAILURES}
    scoped = baseline.entries.keys() & scoped_nodes
    return GateVerdict(
        unreported=tuple(sorted(expected - outcomes.keys())),
        unexpected_failures=tuple(sorted(failures - scoped)),
        outcome_changed=tuple(
            sorted(
                node
                for node in scoped & failures
                if outcomes[node] != baseline.entries[node]["outcome"]
            )
        ),
        missing_from_run=tuple(
            sorted(
                node
                for node in scoped
                if node not in expected
                or (node not in failures and outcomes.get(node) != "passed")
            )
        ),
        resolved_baseline=tuple(
            sorted(node for node in scoped & expected if outcomes.get(node) == "passed")
        ),
        empty_collection=not expected,
    )


def refresh(
    baseline: Baseline,
    verdict: GateVerdict,
    expected: set[str],
    outcomes: Mapping[str, str],
    *,
    commit: str,
    additions_path: Path | None,
) -> Baseline:
    if verdict.unreported or verdict.missing_from_run or verdict.empty_collection:
        raise ValueError("Cannot update baseline with incomplete pytest evidence")
    if outcomes.keys() - expected:
        raise ValueError(
            "Cannot update baseline with outcomes outside the independent collection"
        )
    additions = _load_json(additions_path.read_bytes()) if additions_path else {}
    if not isinstance(additions, dict) or additions.keys() != set(
        verdict.unexpected_failures
    ):
        raise ValueError(
            "--additions must provide reason and issue for each new failure node ID"
        )
    entries = {
        node: entry
        for node, entry in baseline.entries.items()
        if node not in verdict.resolved_baseline
    }
    for node in (*verdict.outcome_changed, *verdict.unexpected_failures):
        reason, issue = _metadata(entries.get(node, additions.get(node)), node)
        entries[node] = Entry(outcome=outcomes[node], reason=reason, issue=issue)
    return Baseline(repo=baseline.repo, baseline_commit=commit, entries=entries)


# ---------------------------------------------------------------------------
# Built-in pytest plugin (activate with `-p test_baseline_gate` or `run`)
# ---------------------------------------------------------------------------


def pytest_addoption(parser: Any) -> None:
    parser.addoption(
        COLLECT_OPTION,
        default=None,
        help="Write independent collected pytest node IDs to JSON file.",
    )
    parser.addoption(
        RESULTS_OPTION,
        default=None,
        help="Write per-node pytest outcomes to JSON file.",
    )


def pytest_configure(config: Any) -> None:
    collect = config.getoption(COLLECT_OPTION, default=None)
    results = config.getoption(RESULTS_OPTION, default=None)
    if not hasattr(config, "workerinput") and (collect or results):
        configure_evidence(config, collect, results)


def _strip_loadgroup_suffix(nodeid: str) -> str:
    """Remove pytest-xdist --dist=loadgroup's trailing ``@<group>`` suffix."""
    file_part, sep, item_part = nodeid.partition("::")
    if not sep:
        return nodeid
    search_start = item_part.rfind("]") + 1
    at_idx = item_part.find("@", search_start)
    if at_idx == -1:
        return nodeid
    return f"{file_part}::{item_part[:at_idx]}"


def configure_evidence(config: Any, collect: str | None, results: str | None) -> None:
    from pytest import UsageError, hookimpl

    if bool(collect) != bool(config.option.collectonly) or (collect and results):
        raise UsageError(
            "Baseline gate requires separate collection (--collect-only) and execution sessions"
        )
    if any(
        config.getoption(option, False)
        for option in (
            "lf",
            "stepwise",
            "stepwise_skip",
            "stepwise_reset",
            "looponfail",
            "setuponly",
            "setupplan",
        )
    ):
        raise UsageError(
            "Baseline gate cannot use pytest history filters or setup-only modes"
        )
    if collect and hasattr(config.option, "numprocesses"):
        config.option.numprocesses = 0
        config.option.dist = "no"

    strip_loadgroup = getattr(config.option, "dist", None) == "loadgroup"

    class Evidence:
        def __init__(self) -> None:
            self.invalid = False
            self.outcomes: dict[str, str] = {}
            self.finished: set[str] = set()

        def pytest_collectreport(self, report: Any) -> None:
            self.invalid |= report.failed

        @hookimpl(optionalhook=True)
        def pytest_testnodedown(self, node: Any, error: Any) -> None:
            del node
            self.invalid |= error is not None

        def pytest_runtest_logreport(self, report: Any) -> None:
            nodeid = (
                _strip_loadgroup_suffix(report.nodeid)
                if strip_loadgroup
                else report.nodeid
            )
            if report.when == "teardown":
                self.finished.add(nodeid)
            if report.failed:
                outcome = "failed" if report.when == "call" else "error"
            elif report.skipped:
                outcome = "xfailed" if hasattr(report, "wasxfail") else "skipped"
            elif report.passed and report.when == "call":
                outcome = "xpassed" if hasattr(report, "wasxfail") else "passed"
            else:
                return
            merge_outcome(self.outcomes, nodeid, outcome)

        def pytest_sessionfinish(self, session: Any, exitstatus: int) -> None:
            if self.invalid or exitstatus not in {0, 1, 5}:
                return
            if collect and exitstatus in {0, 5}:
                path = Path(collect)
                data: Any = sorted({item.nodeid for item in session.items})
            elif results:
                path = Path(results)
                data = {
                    node: self.outcomes[node]
                    for node in sorted(self.finished & self.outcomes.keys())
                }
            else:
                return
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8"
            )

    config.pluginmanager.register(Evidence())


# ---------------------------------------------------------------------------
# CLI helpers
# ---------------------------------------------------------------------------


def _resolve_git_head(cwd: Path | None = None) -> str:
    raw = subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=str(cwd) if cwd else None,
        text=True,
    ).strip()
    if not re.fullmatch(r"[a-f0-9]{40}", raw):
        raise ValueError(f"Unexpected git HEAD SHA: {raw!r}")
    return raw


def _filter_collect_args(pytest_args: Sequence[str]) -> list[str]:
    """Keep selection/target args while stripping execution-only flags."""
    result: list[str] = []
    it = iter(pytest_args)
    for arg in it:
        if arg == "--":
            result.append(arg)
            result.extend(it)
            break
        if arg in _COLLECT_STRIP_VALUE_FLAGS:
            next(it, None)
            continue
        if arg in _COLLECT_STRIP_FLAGS:
            continue
        option, has_eq, _ = arg.partition("=")
        if has_eq and option in _COLLECT_STRIP_VALUE_FLAGS:
            continue
        if arg.startswith("-n") and len(arg) > 2:
            continue
        result.append(arg)
    return result


def _merge_evidence_files(
    expected_paths: Sequence[str], outcomes_paths: Sequence[str]
) -> tuple[set[str], dict[str, str]]:
    expected: set[str] = set()
    for raw_path in expected_paths:
        expected.update(parse_expected(Path(raw_path).read_bytes()))
    outcomes: dict[str, str] = {}
    for raw_path in outcomes_paths:
        for node, outcome in parse_outcomes(Path(raw_path).read_bytes()).items():
            merge_outcome(outcomes, node, outcome)
    return expected, outcomes


def _resolve_scope(
    baseline: Baseline,
    expected: set[str],
    scope: str,
    scope_files: Sequence[str],
) -> set[str]:
    if scope == "all":
        return set(baseline.entries.keys())
    if scope == "expected":
        expected_files = {node_file(node) for node in expected}
        return {node for node in baseline.entries if node_file(node) in expected_files}
    if scope == "files":
        normalized = {PurePosixPath(f).as_posix() for f in scope_files}
        return {node for node in baseline.entries if node_file(node) in normalized}
    raise ValueError(f"Unsupported scope: {scope!r}")


def _write_plugin_shim(directory: Path) -> str:
    """Create an importable pytest plugin shim pointing back to this file."""
    module_name = "_test_baseline_gate_shim"
    source = str(Path(__file__).resolve())
    shim = directory / f"{module_name}.py"
    shim.write_text(
        "import importlib.machinery, importlib.util, sys\n"
        f"_loader = importlib.machinery.SourceFileLoader('_tbg_core', {source!r})\n"
        "_spec = importlib.util.spec_from_loader('_tbg_core', _loader)\n"
        "_mod = importlib.util.module_from_spec(_spec)\n"
        "sys.modules['_tbg_core'] = _mod\n"
        "_loader.exec_module(_mod)\n"
        "pytest_addoption = _mod.pytest_addoption\n"
        "pytest_configure = _mod.pytest_configure\n",
        encoding="utf-8",
    )
    return module_name


def _cmd_init(args: argparse.Namespace) -> int:
    output = Path(args.output)
    if output.exists() and not args.force:
        sys.stderr.write(
            f"Refusing to overwrite existing baseline {output}; pass --force to replace.\n"
        )
        return 2
    commit = args.commit or _resolve_git_head()
    Baseline(repo=args.repo, baseline_commit=commit, entries={}).write(output)
    sys.stdout.write(
        f"Initialized zero-failure baseline ({SCHEMA}, repo={args.repo}, commit={commit}) at {output}\n"
    )
    return 0


def _cmd_check_file(args: argparse.Namespace) -> int:
    path = Path(args.baseline)
    baseline = Baseline.load(path, expected_repo=args.repo)
    sys.stdout.write(
        f"[baseline-gate] OK: {path} ({SCHEMA}, repo={baseline.repo}, "
        f"entries={len(baseline.entries)}, set_sha256={set_sha256(baseline.entries)[:12]})\n"
    )
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    baseline = Baseline.load(Path(args.baseline), expected_repo=args.repo)
    expected, outcomes = _merge_evidence_files(args.expected, args.outcomes)
    scoped = _resolve_scope(baseline, expected, args.scope, args.scope_file or ())
    verdict = evaluate(baseline, expected, outcomes, scoped_nodes=scoped)
    if args.json:
        payload = {
            **verdict.to_dict(),
            "repo": baseline.repo,
            "expected_count": len(expected),
            "outcomes_count": len(outcomes),
            "baseline_count": len(baseline.entries),
            "scoped_count": len(scoped),
        }
        sys.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    else:
        stream = sys.stdout if verdict.passed else sys.stderr
        stream.write(
            verdict.format_report(
                expected_count=len(expected),
                outcomes_count=len(outcomes),
                baseline_count=len(baseline.entries),
            )
            + "\n"
        )
    return 0 if verdict.passed else 1


def _cmd_refresh(args: argparse.Namespace) -> int:
    path = Path(args.baseline)
    baseline = Baseline.load(path, expected_repo=args.repo)
    expected, outcomes = _merge_evidence_files(args.expected, args.outcomes)
    scoped = _resolve_scope(baseline, expected, args.scope, args.scope_file or ())
    verdict = evaluate(baseline, expected, outcomes, scoped_nodes=scoped)
    commit = args.commit or _resolve_git_head()
    updated = refresh(
        baseline,
        verdict,
        expected,
        outcomes,
        commit=commit,
        additions_path=Path(args.additions) if args.additions else None,
    )
    updated.write(path)
    sys.stdout.write(
        f"[baseline-gate] Refreshed {path} (entries={len(updated.entries)}, "
        f"commit={commit}, set_sha256={set_sha256(updated.entries)[:12]})\n"
    )
    return 0


def _cmd_run(args: argparse.Namespace, pytest_args: list[str]) -> int:
    baseline_path = Path(args.baseline)
    baseline = Baseline.load(baseline_path, expected_repo=args.repo)
    base_cmd = shlex.split(args.pytest_cmd)
    if not base_cmd:
        sys.stderr.write("--pytest-cmd cannot be empty\n")
        return 2

    with tempfile.TemporaryDirectory(prefix="baseline-gate-") as raw_tmp:
        tmp = Path(raw_tmp)
        shim_mod = _write_plugin_shim(tmp)
        expected_path = tmp / "expected.json"
        outcomes_path = tmp / "outcomes.json"

        env = os.environ.copy()
        prev_pythonpath = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = (
            f"{tmp}{os.pathsep}{prev_pythonpath}" if prev_pythonpath else str(tmp)
        )

        collect_args = _filter_collect_args(pytest_args)
        collect_cmd = [
            *base_cmd,
            "-p",
            shim_mod,
            "--collect-only",
            "-q",
            COLLECT_OPTION,
            str(expected_path),
            *collect_args,
        ]
        collect_proc = subprocess.run(
            collect_cmd,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        if collect_proc.returncode not in {0, 5}:
            if collect_proc.stdout:
                sys.stderr.write(collect_proc.stdout)
            if collect_proc.stderr:
                sys.stderr.write(collect_proc.stderr)
            sys.stderr.write(
                f"[baseline-gate] Independent pytest collection failed (exit {collect_proc.returncode}).\n"
            )
            return collect_proc.returncode or 2

        run_cmd = [
            *base_cmd,
            "-p",
            shim_mod,
            RESULTS_OPTION,
            str(outcomes_path),
            *pytest_args,
        ]
        run_proc = subprocess.run(
            run_cmd,
            env=env,
            stdout=sys.stderr if args.json else None,
            check=False,
        )
        if run_proc.returncode not in {0, 1, 5}:
            sys.stderr.write(
                f"[baseline-gate] Pytest execution failed with infrastructure exit {run_proc.returncode}.\n"
            )
            return run_proc.returncode

        if not expected_path.is_file() or not outcomes_path.is_file():
            sys.stderr.write(
                "[baseline-gate] Missing collection or outcome evidence (possible collection error or worker crash).\n"
            )
            return 2

        expected = parse_expected(expected_path.read_bytes())
        outcomes = parse_outcomes(outcomes_path.read_bytes())
        scoped = _resolve_scope(baseline, expected, args.scope, ())
        verdict = evaluate(baseline, expected, outcomes, scoped_nodes=scoped)

        if args.refresh:
            commit = args.commit or _resolve_git_head()
            updated = refresh(
                baseline,
                verdict,
                expected,
                outcomes,
                commit=commit,
                additions_path=Path(args.additions) if args.additions else None,
            )
            updated.write(baseline_path)
            sys.stdout.write(
                f"[baseline-gate] Refreshed {baseline_path} (entries={len(updated.entries)}, "
                f"commit={commit}, set_sha256={set_sha256(updated.entries)[:12]})\n"
            )
            return 0

        if args.json:
            payload = {
                **verdict.to_dict(),
                "repo": baseline.repo,
                "expected_count": len(expected),
                "outcomes_count": len(outcomes),
                "baseline_count": len(baseline.entries),
                "scoped_count": len(scoped),
            }
            sys.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
        else:
            stream = sys.stdout if verdict.passed else sys.stderr
            stream.write(
                verdict.format_report(
                    expected_count=len(expected),
                    outcomes_count=len(outcomes),
                    baseline_count=len(baseline.entries),
                )
                + "\n"
            )
        return 0 if verdict.passed else 1


def main(argv: list[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    pytest_args: list[str] = []
    if "--" in raw:
        idx = raw.index("--")
        cli_args, pytest_args = raw[:idx], raw[idx + 1 :]
    else:
        cli_args = raw

    parser = argparse.ArgumentParser(
        prog="test-baseline-gate",
        description="Cross-project pytest Node ID hash ratchet gate (baseline_failures.v1).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="Initialize a zero-failure baseline JSON.")
    p_init.add_argument("--output", required=True, help="Output baseline JSON path.")
    p_init.add_argument("--repo", required=True, help="Repository identifier.")
    p_init.add_argument(
        "--commit",
        default=None,
        help="40-char Git commit SHA (default: current git HEAD).",
    )
    p_init.add_argument(
        "--force", action="store_true", help="Overwrite an existing file."
    )

    p_check = sub.add_parser(
        "check-file", help="Validate baseline schema, metadata, and set_sha256."
    )
    p_check.add_argument("--baseline", required=True, help="Baseline JSON path.")
    p_check.add_argument(
        "--repo", default=None, help="Require baseline repo field to match this value."
    )

    p_verify = sub.add_parser(
        "verify",
        help="Verify collected expected node IDs and outcomes against baseline.",
    )
    p_verify.add_argument("--baseline", required=True, help="Baseline JSON path.")
    p_verify.add_argument("--repo", default=None, help="Expected repo identifier.")
    p_verify.add_argument(
        "--expected",
        nargs="+",
        required=True,
        help="One or more JSON files from --baseline-collect.",
    )
    p_verify.add_argument(
        "--outcomes",
        nargs="+",
        required=True,
        help="One or more JSON files from --baseline-results.",
    )
    p_verify.add_argument(
        "--scope",
        choices=("all", "expected", "files"),
        default="all",
        help="Baseline entries in scope for this verification (default: all).",
    )
    p_verify.add_argument(
        "--scope-file",
        action="append",
        default=None,
        help="Explicit POSIX file paths when --scope=files.",
    )
    p_verify.add_argument("--json", action="store_true", help="Output JSON verdict.")

    p_refresh = sub.add_parser(
        "refresh", help="Ratchet/update baseline file from complete evidence."
    )
    p_refresh.add_argument("--baseline", required=True, help="Baseline JSON path.")
    p_refresh.add_argument("--repo", default=None, help="Expected repo identifier.")
    p_refresh.add_argument("--expected", nargs="+", required=True)
    p_refresh.add_argument("--outcomes", nargs="+", required=True)
    p_refresh.add_argument(
        "--commit", default=None, help="40-char Git SHA (default: git HEAD)."
    )
    p_refresh.add_argument(
        "--additions",
        default=None,
        help="JSON mapping new failure node IDs to {reason, issue}.",
    )
    p_refresh.add_argument(
        "--scope", choices=("all", "expected", "files"), default="all"
    )
    p_refresh.add_argument("--scope-file", action="append", default=None)

    p_run = sub.add_parser(
        "run",
        help="Run independent pytest collection + execution and enforce baseline gate.",
    )
    p_run.add_argument("--baseline", required=True, help="Baseline JSON path.")
    p_run.add_argument("--repo", default=None, help="Expected repo identifier.")
    p_run.add_argument(
        "--pytest-cmd",
        default=f"{shlex.quote(sys.executable)} -m pytest",
        help="Pytest invocation prefix (e.g. 'uv run pytest').",
    )
    p_run.add_argument(
        "--scope",
        choices=("all", "expected"),
        default="expected",
        help="Baseline scope: 'expected' for subset/preflight runs, 'all' for full suite.",
    )
    p_run.add_argument(
        "--refresh", action="store_true", help="Ratchet baseline in place."
    )
    p_run.add_argument("--commit", default=None, help="Git SHA for --refresh.")
    p_run.add_argument(
        "--additions", default=None, help="Additions JSON for --refresh."
    )
    p_run.add_argument("--json", action="store_true", help="Output JSON verdict.")

    parsed = parser.parse_args(cli_args)
    try:
        if parsed.command == "init":
            return _cmd_init(parsed)
        if parsed.command == "check-file":
            return _cmd_check_file(parsed)
        if parsed.command == "verify":
            return _cmd_verify(parsed)
        if parsed.command == "refresh":
            return _cmd_refresh(parsed)
        if parsed.command == "run":
            return _cmd_run(parsed, pytest_args)
    except ValueError as exc:
        sys.stderr.write(f"[baseline-gate] error: {exc}\n")
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
