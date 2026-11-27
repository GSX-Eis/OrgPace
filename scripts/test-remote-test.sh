#!/usr/bin/env bash
set -euo pipefail

scripts_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
runner=$scripts_dir/remote-test.sh
metadata=$scripts_dir/remote-test-metadata.py
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT

expect_failure() {
  local expected=$1
  shift
  if "$@" >"$scratch/output" 2>&1; then
    echo "Expected failure containing: $expected" >&2
    exit 1
  fi
  if ! grep -Fq -- "$expected" "$scratch/output"; then
    cat "$scratch/output" >&2
    exit 1
  fi
}

export CLOUD_RUNNER_CONFIG=$scratch/missing.env
export CLOUD_TEST_CACHE_DIR=$scratch/cache
export CLOUD_TEST_SSH_DIR=$scratch/ssh
unset GCP_PROJECT GCP_ZONE GCP_INSTANCE
help=$("$runner" --help)
grep -q 'Usage:' <<< "$help"
expect_failure 'Usage:' "$runner" unknown
expect_failure 'preflight does not take arguments' "$runner" preflight unexpected
expect_failure '--force only applies' "$runner" --force status
expect_failure '--no-cache only applies' "$runner" --no-cache status
expect_failure '1–2999' env COMPOSE_PROJECT_NAME=nere3000 "$runner" pytest
expect_failure '1–16' env COMPOSE_PROJECT_NAME=nere123 PREFLIGHT_PYTEST_WORKERS=17 "$runner" preflight
expect_failure 'Set GCP_PROJECT' "$runner" status

export CLOUD_RUNNER_CONFIG=$scratch/runner.env
export CLOUD_TEST_QUEUE_DIR=$scratch/queue
export GCP_PROJECT=sample-project
export USAGE_LEDGER_FILE=$scratch/usage.jsonl
export SOFT_CAP_USD=36 DISK_FIXED_MONTHLY_USD=36
cat > "$CLOUD_RUNNER_CONFIG" <<'CONFIG'
GCP_PROJECT=ignored-project
GCP_ZONE=example-zone
GCP_INSTANCE=example-instance
SPOT_HOURLY_RATE_USD=0.2
CONFIG
mkdir -p "$scratch/bin"
cat > "$scratch/bin/gcloud" <<'MOCK'
#!/usr/bin/env bash
set -eu
case "$*" in
  'compute instances describe example-instance --project sample-project '*)
    printf '%s\n' '{"status":"TERMINATED"}' ;;
  'compute instances start example-instance --project sample-project '*)
    echo 'mock start reached'
    exit 99 ;;
  *) echo 'Unexpected gcloud invocation' >&2; exit 3 ;;
esac
MOCK
chmod +x "$scratch/bin/gcloud"
export PATH="$scratch/bin:$PATH"
"$runner" status | grep -F 'VM: TERMINATED'
expect_failure 'Monthly soft cap reached' env COMPOSE_PROJECT_NAME=nere123 "$runner" preflight
if grep -q 'mock start reached' "$scratch/output"; then exit 1; fi
expect_failure 'mock start reached' env COMPOSE_PROJECT_NAME=nere123 "$runner" --force preflight
expect_failure 'mock start reached' env COMPOSE_PROJECT_NAME=nere123 PREFLIGHT_PYTEST_WORKERS=12 "$runner" --force preflight --full

# Stop the worker at its first VM operation after checking the lease selection.
mkdir "$scratch/leases"
touch "$scratch/leases/quant-test.lock"
cat > "$scratch/bin/flock" <<'MOCK'
#!/usr/bin/env bash
[[ $* == '-xn -E 75 9' && -f /dev/fd/9 ]] || exit 3
exit "${MOCK_LEASE_STATUS:-0}"
MOCK
cat > "$scratch/bin/lsof" <<'MOCK'
#!/usr/bin/env bash
echo 'mock lsof reached' >&2
exit 3
MOCK
chmod +x "$scratch/bin/flock" "$scratch/bin/lsof"
worker=$scripts_dir/remote-test-worker.sh
for lease in 0 75; do
  expect_failure 'mock lsof reached' env CLOUD_TEST_NPROC=8 CLOUD_TEST_LEASE_DIR="$scratch/leases" MOCK_LEASE_STATUS=$lease bash "$worker" fixture nere123 preflight ''
  if [[ $lease == 0 ]]; then expected=8; else expected=4; fi
  grep -Fq "pytest workers: $expected" "$scratch/output"
done
for lease in 0 75; do
  expect_failure 'mock lsof reached' env CLOUD_TEST_NPROC=16 CLOUD_TEST_LEASE_DIR="$scratch/leases" MOCK_LEASE_STATUS=$lease bash "$worker" fixture nere123 preflight ''
  if [[ $lease == 0 ]]; then expected=8; else expected=6; fi
  grep -Fq "pytest workers: $expected" "$scratch/output"
done
expect_failure 'mock lsof reached' env CLOUD_TEST_NPROC=16 CLOUD_TEST_LEASE_DIR="$scratch/leases" MOCK_LEASE_STATUS=75 bash "$worker" fixture nere123 preflight 12
grep -Fq 'pytest workers: 12（显式指定）' "$scratch/output"

# Verify CLOUD_TEST_QUEUE_SLOTS strictly caps pytest workers in both preflight and pytest modes.
expect_failure 'mock lsof reached' env CLOUD_TEST_NPROC=16 CLOUD_TEST_LEASE_DIR="$scratch/leases" MOCK_LEASE_STATUS=0 CLOUD_TEST_QUEUE_SLOTS=2 bash "$worker" fixture nere123 preflight ''
grep -Fq 'pytest workers: 2（受分配槽位 CLOUD_TEST_QUEUE_SLOTS=2 约束）' "$scratch/output"
expect_failure 'mock lsof reached' env CLOUD_TEST_NPROC=16 CLOUD_TEST_LEASE_DIR="$scratch/leases" MOCK_LEASE_STATUS=0 CLOUD_TEST_QUEUE_SLOTS=2 bash "$worker" fixture nere123 preflight 12
grep -Fq 'pytest workers: 2（受分配槽位 CLOUD_TEST_QUEUE_SLOTS=2 约束，原指定 12）' "$scratch/output"
expect_failure 'mock lsof reached' env CLOUD_TEST_NPROC=16 CLOUD_TEST_LEASE_DIR="$scratch/leases" MOCK_LEASE_STATUS=0 CLOUD_TEST_QUEUE_SLOTS=2 bash "$worker" fixture nere123 preflight 1
grep -Fq 'pytest workers: 1（显式指定）' "$scratch/output"
expect_failure 'mock lsof reached' env CLOUD_TEST_QUEUE_SLOTS=2 bash "$worker" fixture nere123 pytest '' tests/test_a.py -n auto --numprocesses=8 -n6 -q
grep -Fq '远端 pytest workers 已按分配槽位收敛至 <= 2（CLOUD_TEST_QUEUE_SLOTS=2）' "$scratch/output"
expect_failure 'mock lsof reached' env CLOUD_TEST_QUEUE_SLOTS=2 bash "$worker" fixture nere123 pytest '' tests/test_a.py -n 1 -q
grep -Fq '远端 pytest 分配槽位: 2（CLOUD_TEST_QUEUE_SLOTS=2）' "$scratch/output"
expect_failure 'Invalid CLOUD_TEST_QUEUE_SLOTS' env CLOUD_TEST_QUEUE_SLOTS=0 bash "$worker" fixture nere123 pytest '' tests/test_a.py

# Verify remote-test.sh prefers cloud-test-queue (slots-v1) and falls back cleanly when absent.
cat > "$scratch/bin/mock-cloud-test-queue" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == status ]]; then
  printf 'Mock queue status: %s\n' "$*"
  exit 0
fi
printf '%s\n' "$*" > "$MOCK_QUEUE_ARGS_FILE"
while [[ $# -gt 0 ]]; do
  if [[ $1 == -- ]]; then
    shift
    break
  fi
  shift
done
exec env CLOUD_TEST_QUEUE_HELD=1 CLOUD_TEST_QUEUE_SLOTS=2 CLOUD_TEST_QUEUE_CAPACITY=8 "$@"
MOCK
chmod +x "$scratch/bin/mock-cloud-test-queue"
queue_args_file=$scratch/mock-queue-args.txt
expect_failure 'mock start reached' env \
  COMPOSE_PROJECT_NAME=nere123 \
  CLOUD_TEST_QUEUE_BIN="$scratch/bin/mock-cloud-test-queue" \
  MOCK_QUEUE_ARGS_FILE="$queue_args_file" \
  CLOUD_TEST_LOCK_TIMEOUT=420 \
  "$runner" --force --no-cache pytest tests/api/test_utils.py -q
grep -Fq -- '--queue example-instance --project epp --kind pytest --timeout 420 --label epp:nere123:pytest -- ' "$queue_args_file"
status_out=$(CLOUD_TEST_QUEUE_BIN="$scratch/bin/mock-cloud-test-queue" "$runner" status)
grep -Fq 'Mock queue status: status --queue example-instance' <<< "$status_out"
expect_failure 'mock start reached' env \
  COMPOSE_PROJECT_NAME=nere123 \
  CLOUD_TEST_QUEUE_BIN="" \
  "$runner" --force --no-cache preflight

# Mock wall-clock time after the first hour, including when run at month rollover.
python3 - "$metadata" "$scratch" <<'PY'
from datetime import UTC, datetime
from pathlib import Path
import importlib.util
import io
import sys
from contextlib import redirect_stdout

script, work = sys.argv[1:]
spec = importlib.util.spec_from_file_location("metadata", script)
assert spec and spec.loader
metadata = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(metadata)

class TestClock(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 11, 1, 2, tzinfo=UTC).astimezone(tz)

metadata.datetime = TestClock
instance = '{"status":"TERMINATED","lastStartTimestamp":"2026-10-31T12:00:00+00:00","lastStopTimestamp":"2026-11-01T01:00:00+00:00"}'
ledger = Path(work) / "estimate.jsonl"
for cap, expected in (("12", "at-cap"), ("", "below-cap")):
    output = io.StringIO()
    with redirect_stdout(output):
        metadata.estimate(ledger, instance, "10", "2", cap, "40")
    assert "1.00 h. Estimated cost: $12.00" in output.getvalue()
    assert output.getvalue().splitlines()[-1] == expected
assert len(ledger.read_text().splitlines()) == 1
PY

mkdir "$scratch/repo" "$scratch/tree"
cd "$scratch/repo"
git init -q
git config user.name Fixture
git config user.email fixture@example.invalid
git config commit.gpgsign false
printf '*.local\n' > .gitignore
printf 'base\n' > code
printf 'public example\n' > .env.example
git add -f .gitignore code .env.example
git commit -qm base
git update-ref refs/remotes/origin/master HEAD
mkdir -p frontend/credentials nested/.codex nested/.git/objects nested/node_modules nested/.venv
for path in .env frontend/.env.local frontend/credentials/key.json nested/.codex/auth.json \
  nested/.git/objects/internal nested/node_modules/package.json nested/.venv/settings \
  nested/site.pem nested/cloud-runner.env private.local; do
  printf 'sensitive fixture\n' > "$path"
done
git add -f .env frontend/credentials/key.json
printf 'committed\n' > code
git add code
git commit -qm committed
printf 'staged secret\n' > frontend/.env.local
printf 'staged\n' > code
printf 'example staged\n' > .env.example
git add code .env.example
git add -f frontend/.env.local
printf 'working\n' > code
printf 'untracked\n' > 'new file'
python3 "$metadata" snapshot "$scratch/tree" fixture
[[ $(cat "$scratch/tree/code") == working ]]
[[ $(cat "$scratch/tree/.env.example") == 'example staged' ]]
[[ $(cat "$scratch/tree/new file") == untracked ]]
[[ $(cat "$scratch/tree/.remote-test-snapshot/id") == fixture ]]
[[ ! -e "$scratch/tree/frontend" && ! -e "$scratch/tree/nested" &&
   ! -e "$scratch/tree/.env" && ! -e "$scratch/tree/private.local" &&
   ! -e "$scratch/tree/.git" ]]
if grep -R -E 'sensitive fixture|staged secret' "$scratch/tree"; then exit 1; fi
grep -q '^+committed$' "$scratch/tree/.remote-test-snapshot/committed.patch"
grep -q '^+staged$' "$scratch/tree/.remote-test-snapshot/staged.patch"
grep -q '^+example staged$' "$scratch/tree/.remote-test-snapshot/staged.patch"
[[ $(cat "$scratch/tree/.remote-test-snapshot/base-ref") == origin/master ]]

# Prefer origin/dev when present, and honor explicit PREFLIGHT_BASE_REF overrides.
git update-ref refs/remotes/origin/dev HEAD
mkdir "$scratch/tree-dev" "$scratch/tree-override"
python3 "$metadata" snapshot "$scratch/tree-dev" fixture-dev
[[ $(cat "$scratch/tree-dev/.remote-test-snapshot/base-ref") == origin/dev ]]
[[ ! -s "$scratch/tree-dev/.remote-test-snapshot/committed.patch" ]]
PREFLIGHT_BASE_REF=origin/master python3 "$metadata" snapshot "$scratch/tree-override" fixture-override
[[ $(cat "$scratch/tree-override/.remote-test-snapshot/base-ref") == origin/master ]]
grep -q '^+committed$' "$scratch/tree-override/.remote-test-snapshot/committed.patch"

mkdir "$scratch/another"
ln -s "$scratch/usage.jsonl" outside
expect_failure 'Cannot sync symlink' python3 "$metadata" snapshot "$scratch/another" fixture

# Verify local cross-project FIFO queue ordering, fast-fail (exit 75), and stale ticket cleanup.
python3 - "$metadata" "$scratch" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys
import time

metadata_script, work = sys.argv[1:]
qdir = Path(work) / "fifo-queue"
order_file = Path(work) / "fifo-order.txt"
ready1 = Path(work) / "fifo-ready1"
release1 = Path(work) / "fifo-release1"
env = {**os.environ, "CLOUD_TEST_QUEUE_DIR": str(qdir)}

worker1 = (
    f"import pathlib, time\n"
    f"pathlib.Path({str(ready1)!r}).touch()\n"
    f"open({str(order_file)!r}, 'a').write('epp1\\n')\n"
    f"while not pathlib.Path({str(release1)!r}).exists():\n"
    f"    time.sleep(0.02)\n"
)
p1 = subprocess.Popen(
    [sys.executable, metadata_script, "queue-run", "example-instance", "10", "epp:nere1:preflight", "--",
     sys.executable, "-c", worker1],
    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
for _ in range(150):
    if ready1.exists() or p1.poll() is not None:
        break
    time.sleep(0.02)
assert ready1.exists(), f"job1 failed: {p1.communicate()}"

ff = subprocess.run(
    [sys.executable, metadata_script, "queue-run", "example-instance", "0", "epp:fastfail", "--", "true"],
    env=env, capture_output=True, text=True,
)
assert ff.returncode == 75, (ff.returncode, ff.stderr)
holder = json.loads(ff.stderr.splitlines()[1])
assert holder["label"] == "epp:nere1:preflight", holder

stale = qdir / "example-instance.queue" / "00000000000000000001-99999999-deadbeef.ticket"
stale.parent.mkdir(parents=True, exist_ok=True)
stale.write_text('{"pid": 99999999, "label": "crashed"}\n')

p2 = subprocess.Popen(
    [sys.executable, metadata_script, "queue-run", "example-instance", "10", "epp:nere2:pytest", "--",
     sys.executable, "-c", f"import time; open({str(order_file)!r}, 'a').write('epp2\\n'); time.sleep(0.15)"],
    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
time.sleep(0.3)
p3 = subprocess.Popen(
    [sys.executable, metadata_script, "queue-run", "example-instance", "10", "epp:nere3:playwright", "--",
     sys.executable, "-c", f"open({str(order_file)!r}, 'a').write('epp3\\n')"],
    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
time.sleep(0.35)
assert not stale.exists(), "stale ticket was not cleaned up"

release1.touch()
for proc in (p1, p2, p3):
    out, err = proc.communicate(timeout=10)
    assert proc.returncode == 0, (proc.returncode, out, err)
assert order_file.read_text().splitlines() == ["epp1", "epp2", "epp3"]
assert not list((qdir / "example-instance.queue").glob("*.ticket"))
PY

# Verify local content-addressed result cache: exact hit, cross-project hit,
# subset hit (never reverse), guardrails, TTL, and --no-cache bypass.
python3 - "$metadata" "$scratch" <<'PY'
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

metadata_script, work = sys.argv[1:]
repo = Path(work) / "cache-repo"
cache_dir = Path(work) / "result-cache"
(repo / "backend/tests/api").mkdir(parents=True)
(repo / "backend/tests/api/test_a.py").write_text("def test_a(): pass\n", encoding="utf-8")
(repo / "backend/tests/api/test_b.py").write_text("def test_b(): pass\n", encoding="utf-8")
(repo / "app.py").write_text("x = 1\n", encoding="utf-8")
subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
subprocess.run(["git", "config", "user.name", "Fixture"], cwd=repo, check=True)
subprocess.run(["git", "config", "user.email", "fixture@example.invalid"], cwd=repo, check=True)
subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=repo, check=True)
subprocess.run(["git", "add", "."], cwd=repo, check=True)
subprocess.run(["git", "commit", "-qm", "init"], cwd=repo, check=True)
subprocess.run(["git", "update-ref", "refs/remotes/origin/master", "HEAD"], cwd=repo, check=True)

base_env = {**os.environ, "CLOUD_TEST_CACHE_DIR": str(cache_dir)}
base_env.pop("CLOUD_TEST_NO_CACHE", None)
base_env.pop("EXTERNAL_MCP_ENABLED", None)
base_env.pop("PLAYWRIGHT_FIXTURES_ENABLED", None)
base_env.pop("PREFLIGHT_FULL_PYTEST", None)
base_env.pop("PYTEST_ADDOPTS", None)

def run_meta(args, env=None):
    return subprocess.run(
        [sys.executable, metadata_script, *args],
        cwd=repo,
        env=env or base_env,
        capture_output=True,
        text=True,
    )

# 1. Cold miss
assert run_meta(["cache-lookup", "pytest", "--", "tests/api/test_a.py", "-q"]).returncode == 1

# 2. Prepare + store multi-file PASS
desc_path = Path(work) / "desc-multi.json"
out_log = Path(work) / "out.log"
out_log.write_text("2 passed in 1.23s\n", encoding="utf-8")
assert run_meta(["cache-prepare", str(desc_path), "pytest", "--", "tests/api/test_b.py", "tests/api/test_a.py", "-v", "--durations=10"]).returncode == 0
assert run_meta(["cache-store", str(desc_path), "nere123", "12.5", str(out_log)]).returncode == 0

# Check file permissions == 600
entries = list((cache_dir / "epp/entries").glob("*.json"))
assert len(entries) == 1
assert stat.S_IMODE(entries[0].stat().st_mode) == 0o600

# 3. Exact hit with reordered targets & different non-semantic flags (-q, -n 4)
hit = run_meta(["cache-lookup", "pytest", "--", "tests/api/test_a.py", "tests/api/test_b.py", "-q", "-n", "4", "--lock-timeout", "300"])
assert hit.returncode == 0, hit.stdout + hit.stderr
assert "[cloud-test-cache] HIT" in hit.stdout
assert "match=exact" in hit.stdout
assert "source=nere123" in hit.stdout
assert "2 passed in 1.23s" in hit.stdout

# 4. Subset hit: single file covered by multi-file PASS
sub_hit = run_meta(["cache-lookup", "pytest", "--", "tests/api/test_a.py", "-q"])
assert sub_hit.returncode == 0, sub_hit.stdout + sub_hit.stderr
assert "match=subset(1/2 files)" in sub_hit.stdout

# 5. Reverse subset must NOT hit: store single-file on modified tree, verify multi-file misses
(repo / "app.py").write_text("x = 2\n", encoding="utf-8")
assert run_meta(["cache-lookup", "pytest", "--", "tests/api/test_a.py"]).returncode == 1
desc_single = Path(work) / "desc-single.json"
assert run_meta(["cache-prepare", str(desc_single), "pytest", "--", "tests/api/test_a.py"]).returncode == 0
assert run_meta(["cache-store", str(desc_single), "nere124", "4.0", str(out_log)]).returncode == 0
assert run_meta(["cache-lookup", "pytest", "--", "tests/api/test_a.py"]).returncode == 0
assert run_meta(["cache-lookup", "pytest", "--", "tests/api/test_a.py", "tests/api/test_b.py"]).returncode == 1

# 6. Non-deterministic / bypass flags & env vars
assert run_meta(["cache-lookup", "pytest", "--", "tests/api/test_a.py", "--count=3"]).returncode == 1
assert run_meta(["cache-lookup", "pytest", "--", "tests/api/test_a.py", "-m", "chatgpt_live"]).returncode == 1
assert run_meta(["cache-lookup", "playwright", "--", "--grep", "@external-mcp"]).returncode == 1
assert run_meta(["cache-lookup", "pytest", "--", "tests/api/test_a.py"], env={**base_env, "CLOUD_TEST_NO_CACHE": "1"}).returncode == 1

# 7. Preflight key includes resolved base ref/SHA (origin/dev default, origin/master fallback/override), PREFLIGHT_FULL_PYTEST and PREFLIGHT_BASELINE_GATE
desc_pf = Path(work) / "desc-pf.json"
assert run_meta(["cache-prepare", str(desc_pf), "preflight", "--"]).returncode == 0
assert json.loads(desc_pf.read_text())["extra_inputs"]["base_ref"] == "origin/master"
assert run_meta(["cache-store", str(desc_pf), "nere124", "22.0", str(out_log)]).returncode == 0
assert run_meta(["cache-lookup", "preflight", "--"]).returncode == 0
assert run_meta(["cache-lookup", "preflight", "--", "--full"]).returncode == 1
assert run_meta(["cache-lookup", "preflight", "--", "--baseline-gate"]).returncode == 1
assert run_meta(["cache-lookup", "preflight", "--"], env={**base_env, "PREFLIGHT_FULL_PYTEST": "1"}).returncode == 1
assert run_meta(["cache-lookup", "preflight", "--"], env={**base_env, "PREFLIGHT_BASELINE_GATE": "1"}).returncode == 1
subprocess.run(["git", "add", "app.py"], cwd=repo, check=True)
subprocess.run(["git", "commit", "-qm", "advance"], cwd=repo, check=True)
subprocess.run(["git", "update-ref", "refs/remotes/origin/master", "HEAD"], cwd=repo, check=True)
assert run_meta(["cache-lookup", "preflight", "--"]).returncode == 1

# When origin/dev exists, it becomes the default base_ref and isolates from explicit origin/master overrides.
subprocess.run(["git", "update-ref", "refs/remotes/origin/dev", "HEAD"], cwd=repo, check=True)
desc_dev = Path(work) / "desc-pf-dev.json"
assert run_meta(["cache-prepare", str(desc_dev), "preflight", "--"]).returncode == 0
assert json.loads(desc_dev.read_text())["extra_inputs"]["base_ref"] == "origin/dev"
assert run_meta(["cache-store", str(desc_dev), "nere124", "21.0", str(out_log)]).returncode == 0
assert run_meta(["cache-lookup", "preflight", "--"]).returncode == 0
assert run_meta(["cache-lookup", "preflight", "--"], env={**base_env, "PREFLIGHT_BASE_REF": "origin/master"}).returncode == 1

# 8. TTL expiry misses
assert run_meta(["cache-lookup", "pytest", "--", "tests/api/test_a.py"], env={**base_env, "CLOUD_TEST_CACHE_TTL_HOURS": "0"}).returncode == 1
PY

# Verify runner returns cached PASS before touching gcloud, and --no-cache forces gcloud call.
cached_desc=$scratch/runner-preflight.json
cached_log=$scratch/runner-preflight.log
printf '自检汇总（exit=0）\n' > "$cached_log"
(cd "$scripts_dir/.." && python3 "$metadata" cache-prepare "$cached_desc" preflight --)
(cd "$scripts_dir/.." && python3 "$metadata" cache-store "$cached_desc" nere123 18.4 "$cached_log")
hit_out=$(COMPOSE_PROJECT_NAME=nere123-review "$runner" preflight)
grep -Fq '[cloud-test-cache] HIT' <<< "$hit_out"
grep -Fq 'source=nere123' <<< "$hit_out"
expect_failure 'mock start reached' env COMPOSE_PROJECT_NAME=nere123-review "$runner" --force --no-cache preflight
expect_failure 'mock start reached' env COMPOSE_PROJECT_NAME=nere123-review CLOUD_TEST_NO_CACHE=1 "$runner" --force preflight

# IAP is mandatory, ControlMaster reuse and SSH keepalive/timeout hardening must remain enabled.
grep -q -- '--tunnel-through-iap' "$runner"
grep -q -- 'env CLOUD_TEST_QUEUE_SLOTS=' "$runner"
grep -q -- 'PREFLIGHT_BASE_REF=' "$runner"

# Verify consistent PREFLIGHT_BASE_REF contract (snapshot + metadata + remote-test-worker.sh)
# against a real temporary bare Git remote without mocking git.
git init --bare -q "$scratch/origin.git"
mkdir -p "$scratch/real-seed" "$scratch/real-local" "$scratch/real-snap" "$scratch/real-snap-dev" "$scratch/real-snap-master" "$scratch/real-worker"
(
  cd "$scratch/real-seed"
  git init -q -b master
  git config user.name Fixture
  git config user.email fixture@example.invalid
  git config commit.gpgsign false
  echo 'm0' > file.txt
  git add file.txt
  git commit -qm master-base
  git branch dev
  git checkout -q dev
  echo 'd1' > file.txt
  git add file.txt
  git commit -qm dev-base
  git remote add origin "$scratch/origin.git"
  git push -q origin master dev
)
(
  cd "$scratch/real-local"
  git init -q
  git config user.name Fixture
  git config user.email fixture@example.invalid
  git config commit.gpgsign false
  git remote add origin "$scratch/origin.git"
  git fetch -q origin
  git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/dev
  git checkout -q -b feat origin/dev
  echo 'f1' > file.txt
  git add file.txt
  git commit -qm feat-commit
  python3 "$metadata" snapshot "$scratch/real-snap" fixture-real
  [[ $(cat "$scratch/real-snap/.remote-test-snapshot/base-ref") == origin/dev ]]
  PREFLIGHT_BASE_REF=origin/dev python3 "$metadata" snapshot "$scratch/real-snap-dev" fixture-dev
  [[ $(cat "$scratch/real-snap-dev/.remote-test-snapshot/base-ref") == origin/dev ]]
  PREFLIGHT_BASE_REF=refs/remotes/origin/master python3 "$metadata" snapshot "$scratch/real-snap-master" fixture-master
  [[ $(cat "$scratch/real-snap-master/.remote-test-snapshot/base-ref") == origin/master ]]
  mkdir -p "$scratch/bad-snap"
  for bad_ref in origin/HEAD refs/remotes/origin/HEAD ' origin/dev ' 'origin/dev ' '   ' master refs/heads/master HEAD~1 origin/; do
    expect_failure 'PREFLIGHT_BASE_REF' env PREFLIGHT_BASE_REF="$bad_ref" python3 "$metadata" snapshot "$scratch/bad-snap" fixture-bad
  done
  expect_failure 'Base ref not found' env PREFLIGHT_BASE_REF=origin/missing python3 "$metadata" snapshot "$scratch/bad-snap" fixture-missing
)
cp -R "$scratch/real-snap/.remote-test-snapshot" "$scratch/real-worker/"
(
  cd "$scratch/real-worker"
  git init -q
  git remote add origin "$scratch/origin.git"
  echo "/.remote-test-snapshot/" >> .git/info/exclude
  expect_failure 'mock lsof reached' bash "$worker" fixture nere123 preflight 4
  git show-ref --verify --quiet refs/remotes/origin/dev
  expect_failure 'mock lsof reached' env PREFLIGHT_BASE_REF=origin/dev bash "$worker" fixture nere123 preflight 4
  rm -rf .remote-test-snapshot
  cp -R "$scratch/real-snap-master/.remote-test-snapshot" .
  expect_failure 'mock lsof reached' env PREFLIGHT_BASE_REF=origin/master bash "$worker" fixture nere123 preflight 4
  git show-ref --verify --quiet refs/remotes/origin/master
  expect_failure 'mock lsof reached' env PREFLIGHT_BASE_REF=refs/remotes/origin/master bash "$worker" fixture nere123 preflight 4
  for bad_ref in origin/HEAD refs/remotes/origin/HEAD ' origin/dev ' 'origin/dev ' '   ' master refs/heads/master HEAD~1 origin/; do
    expect_failure 'PREFLIGHT_BASE_REF' env PREFLIGHT_BASE_REF="$bad_ref" bash "$worker" fixture nere123 preflight 4
  done
  expect_failure 'fatal:' env PREFLIGHT_BASE_REF=origin/missing bash "$worker" fixture nere123 preflight 4
)
grep -q -- '-oControlMaster=auto' "$runner"
grep -q -- '-oControlPersist=10m' "$runner"
grep -q -- '-oControlPath=' "$runner"
grep -q -- '-oConnectTimeout=30' "$runner"
grep -q -- '-oServerAliveInterval=15' "$runner"
grep -q -- '-oServerAliveCountMax=6' "$runner"
grep -q -- '-oTCPKeepAlive=yes' "$runner"
if grep -Ei 'instances[[:space:]]+stop|[[:xdigit:]]{6}(-[[:xdigit:]]{6}){2}|BEGIN .*PRIVATE KEY' \
  "$runner" "$metadata" "$scripts_dir/remote-test-worker.sh"; then exit 1; fi
if grep -Ei '[[:alnum:]_.+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}' \
  "$runner" "$metadata" "$scripts_dir/remote-test-worker.sh" | grep -vE '@example\.(com|invalid)'; then exit 1; fi

if grep -E '([0-9]{1,3}\.){3}[0-9]{1,3}' \
  "$runner" "$metadata" "$scripts_dir/remote-test-worker.sh" | grep -vF '127.0.0.1'; then exit 1; fi

echo 'remote-test tests passed'
