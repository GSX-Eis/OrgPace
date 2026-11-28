import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.unit
ROOT = Path(__file__).resolve().parents[3]


def test_im_production_compose() -> None:
    prod = (ROOT / "deploy/compose.prod.yml").read_text()
    # BaseLoader accepts custom Compose tags; check the reset tag explicitly.
    service = yaml.load(prod, Loader=yaml.BaseLoader)["services"]["im"]
    assert service["restart"] == "unless-stopped"
    assert service["environment"]["FASTAPI_ENV"] == "null"
    assert re.search(r"(?m)^  im:\n(?: {4,}.*\n)*      FASTAPI_ENV: !reset null$", prod)
    base = yaml.safe_load((ROOT / "compose.yml").read_text())
    assert base["services"]["im"]["depends_on"]["pi"]["condition"] == "service_healthy"


def test_development_ports_are_loopback() -> None:
    services = yaml.safe_load((ROOT / "compose.dev.yml").read_text())["services"]
    assert services["db"]["ports"] == ["127.0.0.1:5432:5432"]
    assert services["adminer"]["ports"] == ["127.0.0.1:8080:8080"]
    assert not any(
        "htmlcov" in volume for volume in services["backend"].get("volumes", [])
    )


@pytest.mark.parametrize("ref", [[], ["new-version"]])
def test_upgrade_failed_backup_does_not_move_head(
    tmp_path: Path, ref: list[str]
) -> None:
    shutil.copy(ROOT / "upgrade.sh", tmp_path)
    (tmp_path / "deploy").mkdir()
    shutil.copy(ROOT / "deploy/common.sh", tmp_path / "deploy")
    (tmp_path / ".env").write_text("PI_SERVICE_TOKEN=synthetic-test-token\n")
    git = tmp_path / "git"
    git.write_text(
        '#!/bin/sh\nprintf "%s\\n" "$*" >> git.log\ncase "$1" in rev-parse) echo old-head;; esac\n'
    )
    git.chmod(0o755)
    backup = tmp_path / "backup.sh"
    backup.write_text("#!/bin/sh\nexit 17\n")
    backup.chmod(0o755)
    result = subprocess.run(
        ["bash", "upgrade.sh", *ref],
        cwd=tmp_path,
        env={**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}"},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 17
    assert (tmp_path / "git.log").read_text().splitlines() == [
        "status --porcelain",
        "rev-parse HEAD",
    ]
    assert "git checkout" not in result.stderr
