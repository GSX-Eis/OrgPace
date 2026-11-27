import os
import subprocess
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.unit

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"


@pytest.mark.parametrize("result", ["success", "failure", "cancelled", "skipped", ""])
def test_backend_gate_requires_all_shards(result: str) -> None:
    workflow = yaml.safe_load((WORKFLOWS / "test-backend.yml").read_text())
    shards = workflow["jobs"]["backend-shard"]
    assert shards["strategy"] == {
        "fail-fast": False,
        "matrix": {"shard": [1, 2, 3]},
    }
    gate = workflow["jobs"]["test-backend"]
    assert gate["if"] == "${{ always() }}"
    assert gate["needs"] == ["backend-shard"]
    require = gate["steps"][0]
    assert require["env"]["TEST_RESULT"] == "${{ needs.backend-shard.result }}"
    completed = subprocess.run(
        ["bash", "-e", "-c", require["run"]],
        env={**os.environ, "TEST_RESULT": result},
        check=False,
    )
    assert (completed.returncode == 0) is (result == "success")


@pytest.mark.parametrize(
    "changes,changed,shards,success",
    [
        ("success", "true", "success", True),
        ("success", "false", "skipped", True),
        ("success", "true", "failure", False),
        ("success", "true", "cancelled", False),
        ("success", "true", "skipped", False),
        ("failure", "", "skipped", False),
        ("cancelled", "", "skipped", False),
        ("success", "false", "failure", False),
        ("success", "", "skipped", False),
    ],
)
def test_playwright_gate(
    changes: str, changed: str, shards: str, success: bool
) -> None:
    workflow = yaml.safe_load((WORKFLOWS / "playwright.yml").read_text())
    gate = workflow["jobs"]["test-playwright"]
    assert gate["if"] == "${{ always() }}"
    assert set(gate["needs"]) == {"changes", "playwright-shard"}
    result = subprocess.run(
        ["bash", "-e", "-c", gate["steps"][0]["run"]],
        env={
            **os.environ,
            "CHANGES_RESULT": changes,
            "CHANGED": changed,
            "TEST_RESULT": shards,
        },
        check=False,
    )
    assert (result.returncode == 0) is success


def test_required_workflows_have_no_top_level_path_filter() -> None:
    for path in WORKFLOWS.glob("*.yml"):
        # BaseLoader preserves GitHub's 'on' key instead of parsing it as bool.
        workflow = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
        assert "pull_request" in workflow["on"], path
        for event in ("pull_request", "push"):
            if event in workflow["on"]:
                trigger = workflow["on"][event] or {}
                assert "paths" not in trigger and "paths-ignore" not in trigger, (
                    f"{path} ({event})"
                )


@pytest.mark.parametrize(
    "workflow_name",
    [
        "test-backend.yml",
        "playwright.yml",
        "test-docker-compose.yml",
        "test-pi.yml",
        "zizmor.yml",
        "pre-commit.yml",
    ],
)
def test_push_workflows_include_master_and_dev(workflow_name: str) -> None:
    workflow = yaml.load(
        (WORKFLOWS / workflow_name).read_text(), Loader=yaml.BaseLoader
    )
    branches = workflow["on"]["push"]["branches"]
    assert "master" in branches, workflow_name
    assert "dev" in branches, workflow_name


@pytest.mark.parametrize(
    "event,before,root,expected",
    [
        ("pull_request", "zero", False, "origin/dev"),
        ("push", "first", False, "first"),
        ("push", "zero", False, "HEAD~1"),
        ("push", "missing", False, "HEAD~1"),
        ("push", "zero", True, "--all-files"),
    ],
)
def test_precommit_comparison_base(
    tmp_path: Path, event: str, before: str, root: bool, expected: str
) -> None:
    workflow = yaml.safe_load((WORKFLOWS / "pre-commit.yml").read_text())
    step = next(
        s for s in workflow["jobs"]["pre-commit"]["steps"] if s.get("id") == "precommit"
    )
    assert step["env"] == {
        "GITHUB_EVENT_NAME": "${{ github.event_name }}",
        "GITHUB_EVENT_BEFORE": "${{ github.event.before }}",
        "GITHUB_BASE_REF": "${{ github.base_ref }}",
    }
    assert "${{" not in step["run"]

    def git(*args: str) -> str:
        return subprocess.check_output(
            ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args],
            cwd=tmp_path,
            text=True,
        ).strip()

    git("init", "-q")
    git("commit", "--allow-empty", "-qm", "initial")
    first = git("rev-parse", "HEAD")
    if not root:
        git("commit", "--allow-empty", "-qm", "second")
        git("commit", "--allow-empty", "-qm", "third")

    uv = tmp_path / "uv"
    uv.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
    uv.chmod(0o755)
    result = subprocess.run(
        ["bash", "-e", "-c", step["run"]],
        cwd=tmp_path,
        env={
            **os.environ,
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "GITHUB_EVENT_NAME": event,
            "GITHUB_EVENT_BEFORE": {
                "first": first,
                "zero": "0" * 40,
                "missing": "1" * 40,
            }[before],
            "GITHUB_BASE_REF": "dev" if event == "pull_request" else "",
        },
        capture_output=True,
        text=True,
        check=True,
    )
    args = (
        ["--all-files"]
        if expected == "--all-files"
        else [
            "--from-ref",
            first if expected == "first" else expected,
            "--to-ref",
            "HEAD",
        ]
    )
    assert result.stdout.splitlines() == [
        "run",
        "prek",
        "run",
        *args,
        "--show-diff-on-failure",
    ]


def test_compose_ci_runs_https_config_tests() -> None:
    workflow = yaml.safe_load((WORKFLOWS / "test-docker-compose.yml").read_text())
    steps = workflow["jobs"]["test-docker-compose"]["steps"]
    assert any(
        "bash tests/smoke/compose_smoke.sh" in step.get("run", "") for step in steps
    )
    smoke = (WORKFLOWS.parents[1] / "tests" / "smoke" / "compose_smoke.sh").read_text()
    assert "python3 -m unittest deploy/test_https_config.py" in smoke


def test_backend_ci_enforces_baseline_gate() -> None:
    workflow = yaml.safe_load((WORKFLOWS / "test-backend.yml").read_text())
    shard_steps = workflow["jobs"]["backend-shard"]["steps"]
    assert any("--baseline-collect=" in step.get("run", "") for step in shard_steps)
    assert any("--baseline-results=" in step.get("run", "") for step in shard_steps)
    gate_steps = workflow["jobs"]["test-backend"]["steps"]
    assert any(
        "scripts/test_baseline_gate.py verify" in step.get("run", "")
        for step in gate_steps
    )


def test_playwright_ci_uses_balanced_shard_selector_and_excludes_real_jira() -> None:
    workflow = yaml.safe_load((WORKFLOWS / "playwright.yml").read_text())
    shard_steps = workflow["jobs"]["playwright-shard"]["steps"]
    main_step = next(
        step for step in shard_steps if step.get("name") == "Run Playwright tests"
    )
    run_cmd = main_step["run"]
    assert 'select-playwright-shard.mjs "$SHARD" 3 --patterns' in run_cmd
    assert '--grep-invert "@external-mcp|@real-jira"' in run_cmd
    assert "--fail-on-flaky-tests" in run_cmd
    assert "--shard=" not in run_cmd
    assert any(
        step.get("run") == "bun test" and step.get("working-directory") == "frontend"
        for step in shard_steps
    )
    assert any(
        step.get("run") == "bun scripts/check-playwright-shards.mjs"
        and step.get("working-directory") == "frontend"
        and step.get("if") == "matrix.shard == 1"
        for step in shard_steps
    )
    assert any(
        step.get("name") == "Run external MCP Playwright tests"
        and "--grep @external-mcp" in step.get("run", "")
        for step in shard_steps
    )
