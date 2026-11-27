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
    ],
)
def test_push_workflows_include_master_and_dev(workflow_name: str) -> None:
    workflow = yaml.load(
        (WORKFLOWS / workflow_name).read_text(), Loader=yaml.BaseLoader
    )
    branches = workflow["on"]["push"]["branches"]
    assert "master" in branches, workflow_name
    assert "dev" in branches, workflow_name


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
    assert "select-playwright-shard.mjs" in run_cmd
    assert '--grep-invert "@external-mcp|@real-jira"' in run_cmd
    assert "--fail-on-flaky-tests" in run_cmd
    assert "--shard=" not in run_cmd
    assert any(
        step.get("name") == "Run external MCP Playwright tests"
        and "--grep @external-mcp" in step.get("run", "")
        for step in shard_steps
    )
