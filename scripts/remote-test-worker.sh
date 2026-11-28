#!/usr/bin/env bash
# Invoked inside the project lock and VM lease by remote-test.sh.
set -euo pipefail
umask 077

run_id=$1
export COMPOSE_PROJECT_NAME=$2
mode=$3
export PREFLIGHT_PYTEST_WORKERS=$4
shift 4
project=$COMPOSE_PROJECT_NAME
number=${project#nere}
number=${number%-review}
export POSTGRES_PORT=$((15000 + number))
export API_PORT=$((18000 + number))
if [[ $project == *-review ]]; then
  export POSTGRES_PORT=$((POSTGRES_PORT + 10000))
  export API_PORT=$((API_PORT + 10000))
fi

slot_cap=${CLOUD_TEST_QUEUE_SLOTS:-}
if [[ -n $slot_cap && ! $slot_cap =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid CLOUD_TEST_QUEUE_SLOTS: $slot_cap" >&2
  exit 2
fi

if [[ $mode == preflight ]]; then
  if [[ -z $PREFLIGHT_PYTEST_WORKERS ]]; then
    host_cpus=${CLOUD_TEST_NPROC:-$(nproc 2>/dev/null || echo 8)}
    if [[ ! $host_cpus =~ ^[0-9]+$ ]]; then host_cpus=8; fi
    if (( host_cpus >= 16 )); then
      solo_workers=8
      shared_workers=6
    else
      solo_workers=8
      shared_workers=4
    fi
    PREFLIGHT_PYTEST_WORKERS=$solo_workers
    for lock in "${CLOUD_TEST_LEASE_DIR:-/run/cloud-test-leases}"/quant-*.lock; do
      [[ -f $lock ]] || continue
      # The lease runner holds a shared lock, so probe with an exclusive lock.
      if flock -xn -E 75 9 9< "$lock"; then
        continue
      elif [[ $? == 75 ]]; then
        PREFLIGHT_PYTEST_WORKERS=$shared_workers
        break
      else
        echo "Could not inspect cloud test lease: $lock" >&2
        exit 1
      fi
    done
    if [[ -n $slot_cap ]] && (( PREFLIGHT_PYTEST_WORKERS > slot_cap )); then
      PREFLIGHT_PYTEST_WORKERS=$slot_cap
      printf '远端预检 pytest workers: %s（受分配槽位 CLOUD_TEST_QUEUE_SLOTS=%s 约束）\n' \
        "$PREFLIGHT_PYTEST_WORKERS" "$slot_cap"
    else
      printf '远端预检 pytest workers: %s（%s vCPU，按量化租约自动选择）\n' "$PREFLIGHT_PYTEST_WORKERS" "$host_cpus"
    fi
  elif [[ -n $slot_cap ]] && (( PREFLIGHT_PYTEST_WORKERS > slot_cap )); then
    requested_workers=$PREFLIGHT_PYTEST_WORKERS
    PREFLIGHT_PYTEST_WORKERS=$slot_cap
    printf '远端预检 pytest workers: %s（受分配槽位 CLOUD_TEST_QUEUE_SLOTS=%s 约束，原指定 %s）\n' \
      "$PREFLIGHT_PYTEST_WORKERS" "$slot_cap" "$requested_workers"
  else
    printf '远端预检 pytest workers: %s（显式指定）\n' "$PREFLIGHT_PYTEST_WORKERS"
  fi
fi

clamp_pytest_workers() {
  local cap=$1
  shift
  clamped_pytest_args=()
  clamped_pytest_workers=false
  local after_sep=false
  local val
  while [[ $# -gt 0 ]]; do
    local arg=$1
    shift
    if $after_sep; then
      clamped_pytest_args+=("$arg")
      continue
    fi
    if [[ $arg == -- ]]; then
      after_sep=true
      clamped_pytest_args+=("$arg")
      continue
    fi
    case "$arg" in
      -n|--numprocesses)
        if [[ $# -gt 0 ]]; then
          val=$1
          shift
          if [[ $val == auto || $val == logical ]] || { [[ $val =~ ^[1-9][0-9]*$ ]] && (( val > cap )); }; then
            clamped_pytest_args+=("$arg" "$cap")
            clamped_pytest_workers=true
          else
            clamped_pytest_args+=("$arg" "$val")
          fi
        else
          clamped_pytest_args+=("$arg")
        fi
        ;;
      --numprocesses=*)
        val=${arg#--numprocesses=}
        if [[ $val == auto || $val == logical ]] || { [[ $val =~ ^[1-9][0-9]*$ ]] && (( val > cap )); }; then
          clamped_pytest_args+=("--numprocesses=$cap")
          clamped_pytest_workers=true
        else
          clamped_pytest_args+=("$arg")
        fi
        ;;
      -n*)
        val=${arg#-n}
        if [[ $val == auto || $val == logical ]] || { [[ $val =~ ^[1-9][0-9]*$ ]] && (( val > cap )); }; then
          clamped_pytest_args+=("-n$cap")
          clamped_pytest_workers=true
        else
          clamped_pytest_args+=("$arg")
        fi
        ;;
      *)
        clamped_pytest_args+=("$arg")
        ;;
    esac
  done
}

if [[ $mode == pytest && -n $slot_cap ]]; then
  clamp_pytest_workers "$slot_cap" "$@"
  set -- ${clamped_pytest_args[@]+"${clamped_pytest_args[@]}"}
  if $clamped_pytest_workers; then
    printf '远端 pytest workers 已按分配槽位收敛至 <= %s（CLOUD_TEST_QUEUE_SLOTS=%s）\n' "$slot_cap" "$slot_cap"
  else
    printf '远端 pytest 分配槽位: %s（CLOUD_TEST_QUEUE_SLOTS=%s）\n' "$slot_cap" "$slot_cap"
  fi
fi

normalize_base_ref() {
  local raw=$1
  raw=${raw#refs/remotes/}
  if [[ $raw != origin/* || $raw == origin/ || $raw == origin/HEAD ]] || ! git check-ref-format "refs/remotes/$raw" >/dev/null 2>&1; then
    echo "PREFLIGHT_BASE_REF 仅支持真实远端分支引用（origin/<branch>），当前为: $1" >&2
    exit 2
  fi
  printf '%s\n' "$raw"
}

if [[ $mode == preflight && -d .remote-test-snapshot ]]; then
  meta=.remote-test-snapshot
  base=$(cat "$meta/base")
  base_ref=${PREFLIGHT_BASE_REF:-}
  if [[ -z $base_ref && -f $meta/base-ref ]]; then
    base_ref=$(cat "$meta/base-ref")
  fi
  if [[ -n $base_ref ]]; then
    base_ref=$(normalize_base_ref "$base_ref")
  fi
  if [[ ! -d .git ]]; then
    git init -q
    git remote add origin https://github.com/GSX-Eis/OrgPace.git
    echo "/$meta/" >> .git/info/exclude
  fi
  if [[ -n $base_ref ]]; then
    base_branch=${base_ref#origin/}
    git fetch -q origin "+refs/heads/$base_branch:refs/remotes/origin/$base_branch"
  elif git fetch -q origin '+refs/heads/dev:refs/remotes/origin/dev' 2>/dev/null; then
    base_ref=origin/dev
  else
    git fetch -q origin '+refs/heads/master:refs/remotes/origin/master'
    base_ref=origin/master
  fi
  export PREFLIGHT_BASE_REF=$base_ref
  export PREFLIGHT_SKIP_FETCH=1
  git merge-base --is-ancestor "$base" "$base_ref"
  git read-tree "$base"
  if [[ -s $meta/committed.patch ]]; then git apply --cached "$meta/committed.patch"; fi
  tree=$(git write-tree)
  head=$base
  if [[ $tree != "$(git rev-parse "$base^{tree}")" ]]; then
    head=$(git -c user.name='Remote test snapshot' -c user.email=snapshot@example.invalid \
      commit-tree "$tree" -p "$base" -m 'Reproduce the local committed changes')
  fi
  git update-ref HEAD "$head"
  if [[ -s $meta/staged.patch ]]; then git apply --cached "$meta/staged.patch"; fi
  git update-index --skip-worktree -z --stdin < "$meta/excluded"
fi

# Scope all Compose calls to an explicit test project and synthetic settings.
export FASTAPI_ENV=development API_BIND=127.0.0.1 COMPOSE_ANSI=never COMPOSE_PROGRESS=plain
export PROJECT_NAME='Employee Profile Remote Test'
export SECRET_KEY PI_SERVICE_TOKEN POSTGRES_PASSWORD FIRST_SUPERUSER_PASSWORD DEMO_USER_PASSWORD
SECRET_KEY=$(openssl rand -hex 32)
PI_SERVICE_TOKEN=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
FIRST_SUPERUSER_PASSWORD=$(openssl rand -hex 16)
DEMO_USER_PASSWORD=$(openssl rand -hex 16)
export FIRST_SUPERUSER=admin@example.com SEED_DEMO_DATA=true
export DATABASE_URL="postgresql://postgres:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/app"
export FRONTEND_HOST="http://127.0.0.1:$API_PORT"
unset SENTRY_DSN COMPOSE_PROFILES

EPP_WARM_DB=${EPP_WARM_DB:-1}
EPP_WARM_DB_PORT=${EPP_WARM_DB_PORT:-14532}
if [[ $EPP_WARM_DB != 0 && $EPP_WARM_DB != 1 ]]; then
  echo "Invalid EPP_WARM_DB (expected 0 or 1): $EPP_WARM_DB" >&2
  exit 2
fi
if ! [[ $EPP_WARM_DB_PORT =~ ^[1-9][0-9]*$ ]] || (( EPP_WARM_DB_PORT >= 65536 || EPP_WARM_DB_PORT == 5432 )); then
  echo "Invalid EPP_WARM_DB_PORT (expected 1-65535 and != 5432): $EPP_WARM_DB_PORT" >&2
  exit 2
fi

# The override is kept outside the build context.
scratch=$(mktemp -d)
compose=(docker compose --env-file /dev/null -p "$project" -f compose.yml -f compose.dev.yml -f tests/postgres-fast.yml -f "$scratch/ports.yml")
started=false
warm_active=false
artifacts=

run_backend_python() {
  if [[ -x backend/.venv/bin/python ]]; then
    backend/.venv/bin/python "$@"
  else
    (cd backend && uv run python "$@")
  fi
}

cleanup() {
  local code=$?
  trap - EXIT
  trap '' HUP INT TERM
  if $warm_active && [[ -n ${PYTEST_DB_PREFIX:-} ]]; then
    if ! run_backend_python - <<'PY'
import os
import psycopg
from psycopg import sql
from sqlalchemy.engine import make_url

prefix = os.environ["PYTEST_DB_PREFIX"] + "_"
admin_url = make_url(os.environ["DATABASE_URL"]).set(
    drivername="postgresql", database="postgres"
)
with psycopg.connect(
    admin_url.render_as_string(hide_password=False), autocommit=True
) as admin:
    rows = admin.execute(
        "SELECT datname FROM pg_database WHERE starts_with(datname, %s) AND NOT datistemplate",
        (prefix,),
    ).fetchall()
    for (datname,) in rows:
        admin.execute(
            sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(
                sql.Identifier(datname)
            )
        )
PY
    then
      echo "Warm DB leftover cleanup failed for prefix $PYTEST_DB_PREFIX." >&2
      if [[ $code == 0 ]]; then code=1; fi
    fi
  fi
  if $started; then
    if ! "${compose[@]}" down -v --remove-orphans; then
      echo "Compose cleanup failed for $project." >&2
      if [[ $code == 0 ]]; then code=1; fi
    fi
  fi
  if [[ -n $artifacts ]]; then
    rm -rf -- frontend/playwright/.auth
    if [[ $code == 0 ]]; then rm -rf -- "$artifacts"; fi
  fi
  rm -rf -- "$scratch"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

check_port() {
  local port=$1 listeners mappings rc=0
  listeners=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN) || rc=$?
  if [[ $rc != 0 && $rc != 1 ]]; then
    exit "$rc"
  fi
  mappings=$(docker ps --format '{{.Names}} {{.Ports}}')
  if [[ -n $listeners || $mappings == *":$port->"* ]]; then
    printf 'Port %s is occupied.\n%s\n' "$port" "$listeners" >&2
    printf '%s\n' "$mappings" | grep -F ":$port->" >&2 || true
    exit 1
  fi
}

warm_dir=${EPP_WARM_DB_DIR:-$HOME/epp-runs/.warm-db}
warm_pw_file=$warm_dir/password

setup_warm_db() {
  local warm_project=epp-warm-db
  local warm_lock=$warm_dir/lock
  local warm_fp_file=$warm_dir/fingerprint
  local warm_override=$warm_dir/warm-override.yml
  (
    set -euo pipefail
    umask 077
    [[ -d backend ]]
    mkdir -p "$warm_dir"
    chmod 700 "$warm_dir"
    exec 8>"$warm_lock"
    flock -w "${EPP_WARM_DB_LOCK_TIMEOUT:-120}" 8

    local pw
    if [[ -s $warm_pw_file ]]; then
      pw=$(cat "$warm_pw_file")
    else
      pw=$(openssl rand -hex 16)
      printf '%s' "$pw" > "$warm_pw_file.tmp"
      chmod 600 "$warm_pw_file.tmp"
      mv -f "$warm_pw_file.tmp" "$warm_pw_file"
    fi
    [[ -n $pw ]]

    local override_content
    override_content=$(cat <<EOF
services:
  db:
    ports: !override
      - "127.0.0.1:$EPP_WARM_DB_PORT:5432"
    command: ["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "max_wal_size=2GB", "-c", "max_connections=300"]
EOF
    )

    local fp
    fp=$(python3 - "$EPP_WARM_DB_PORT" "$override_content" <<'PY'
import hashlib, sys
from pathlib import Path
h = hashlib.sha256(f"port={sys.argv[1]}\n{sys.argv[2]}\n".encode())
for rel in ("compose.yml", "compose.dev.yml", "tests/postgres-fast.yml"):
    data = Path(rel).read_bytes() if Path(rel).is_file() else b""
    h.update(f"{rel}:{len(data)}\n".encode() + data + b"\n")
print(h.hexdigest()[:16])
PY
    )

    local warm_compose=(
      docker compose --env-file /dev/null -p "$warm_project"
      -f compose.yml -f compose.dev.yml -f tests/postgres-fast.yml -f "$warm_override"
    )

    probe_select_1() {
      local db_url="postgresql://postgres:$pw@127.0.0.1:$EPP_WARM_DB_PORT/app"
      EPP_PROBE_URL="$db_url" run_backend_python - <<'PY' >/dev/null 2>&1
import os
import psycopg

with psycopg.connect(os.environ["EPP_PROBE_URL"], connect_timeout=5) as conn:
    row = conn.execute("SELECT 1").fetchone()
    assert row == (1,), row
PY
    }

    if [[ -f $warm_fp_file && $(cat "$warm_fp_file") == "$fp" && -f $warm_override ]]; then
      local cid health mapped_port
      cid=$(docker ps -q \
        --filter "label=com.docker.compose.project=$warm_project" \
        --filter "label=com.docker.compose.service=db" \
        --filter "status=running" | head -n 1 || true)
      if [[ -n $cid ]]; then
        health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)
        mapped_port=$(docker port "$cid" 5432/tcp 2>/dev/null | head -n 1 || true)
        if [[ $health == healthy && $mapped_port == "127.0.0.1:$EPP_WARM_DB_PORT" ]] && probe_select_1; then
          exit 0
        fi
      fi
    fi

    if [[ -f $warm_override ]]; then
      "${warm_compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    else
      docker compose --env-file /dev/null -p "$warm_project" -f compose.yml down -v --remove-orphans >/dev/null 2>&1 || true
    fi
    check_port "$EPP_WARM_DB_PORT" || exit 1
    printf '%s\n' "$override_content" > "$warm_override.tmp"
    mv -f "$warm_override.tmp" "$warm_override"
    POSTGRES_PASSWORD="$pw" "${warm_compose[@]}" up -d --wait db || exit 1
    [[ $("${warm_compose[@]}" port db 5432) == "127.0.0.1:$EPP_WARM_DB_PORT" ]] || exit 1
    probe_select_1 || exit 1
    printf '%s\n' "$fp" > "$warm_fp_file.tmp"
    mv -f "$warm_fp_file.tmp" "$warm_fp_file"
  )
}

if [[ $mode != playwright && $EPP_WARM_DB == 1 ]]; then
  set +e
  setup_warm_db
  warm_rc=$?
  set -e
  if [[ $warm_rc == 0 ]]; then
    warm_active=true
    warm_password=$(cat "$warm_pw_file")
    run8=$(python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:8])' "$run_id")
    export POSTGRES_PASSWORD="$warm_password"
    export POSTGRES_PORT="$EPP_WARM_DB_PORT"
    export DATABASE_URL="postgresql://postgres:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/app"
    export PYTEST_SHARED_TEMPLATE=${PYTEST_SHARED_TEMPLATE:-1}
    export PYTEST_DB_PREFIX="r${number}_${run8}"
  else
    echo "预热 Postgres 启动或探活失败，安全回退到独立 Compose DB ($project)。" >&2
  fi
fi

if ! $warm_active; then
  check_port "$POSTGRES_PORT"
  if [[ $mode == playwright ]]; then check_port "$API_PORT"; fi
  cat > "$scratch/ports.yml" <<EOF
services:
  db:
    ports: !override
      - "127.0.0.1:$POSTGRES_PORT:5432"
EOF

  started=true
  "${compose[@]}" up -d --wait db
  [[ $("${compose[@]}" port db 5432) == "127.0.0.1:$POSTGRES_PORT" ]]
fi
if [[ $mode != playwright ]]; then
  pi_lock_hash=$(sha256sum pi/package-lock.json | awk '{print $1}')
  pi_hash_file=pi/node_modules/.package-lock.sha256
  if [[ -d pi/node_modules && -f $pi_hash_file && $(cat "$pi_hash_file") == "$pi_lock_hash" ]]; then
    echo 'pi/node_modules: 跳过 npm ci（package-lock.json 未变化）'
  else
    npm ci --prefix pi --ignore-scripts --no-audit --no-fund
    printf '%s\n' "$pi_lock_hash" > "$pi_hash_file"
  fi
fi
case "$mode" in
  preflight)
    # Share host mypy and ruff caches across ~/epp-runs/nere* safely; fall back to
    # per-project cache directories if another concurrent EPP run holds the cache lock.
    cache_root=$HOME/.cache
    mkdir -p "$cache_root"
    lint_cache_lock=$cache_root/.epp-lint-cache.lock
    exec 7>> "$lint_cache_lock"
    if flock -xn 7; then
      export MYPY_CACHE_DIR=${MYPY_CACHE_DIR:-$cache_root/epp-mypy}
      export RUFF_CACHE_DIR=${RUFF_CACHE_DIR:-$cache_root/epp-ruff}
    else
      exec 7>&-
      export MYPY_CACHE_DIR=${MYPY_CACHE_DIR:-$cache_root/epp-mypy-$project}
      export RUFF_CACHE_DIR=${RUFF_CACHE_DIR:-$cache_root/epp-ruff-$project}
    fi
    mkdir -p "$MYPY_CACHE_DIR" "$RUFF_CACHE_DIR"
    if [[ -f bun.lock ]] && command -v bun >/dev/null 2>&1; then
      fe_lock_hash=$(sha256sum bun.lock | awk '{print $1}')
      fe_hash_file=node_modules/.bun.lock.sha256
      if [[ -d node_modules && -f $fe_hash_file && $(cat "$fe_hash_file") == "$fe_lock_hash" ]]; then
        echo 'node_modules: 跳过 bun install（bun.lock 未变化）'
      else
        bun install --frozen-lockfile
        mkdir -p node_modules
        printf '%s\n' "$fe_lock_hash" > "$fe_hash_file"
      fi
    fi
    bash scripts/preflight.sh "$@"
    ;;
  pytest) (cd backend && uv run pytest "$@") ;;
  playwright)
    export PLAYWRIGHT_FIXTURES_ENABLED=true
    artifacts=$HOME/epp-runs/.artifacts/$project/$run_id
    mkdir -p "$artifacts"
    if [[ " $* " == *" --grep @external-mcp "* ]]; then
      export EXTERNAL_MCP_ENABLED=true
    fi
    # Use the existing host-browser CI flow, with the backend serving its UI.
    "${compose[@]}" build backend pi
    "${compose[@]}" up -d --no-build --wait backend worker mock-jira
    (
      cd frontend
      bun install --frozen-lockfile
      export PLAYWRIGHT_BASE_URL=$FRONTEND_HOST VITE_API_URL=$FRONTEND_HOST
      export MODEL_TEST_HOST
      MODEL_TEST_HOST=${MODEL_TEST_HOST:-$(hostname -I | awk '{print $1}')}
      export PLAYWRIGHT_HTML_OUTPUT_DIR=$artifacts/report PLAYWRIGHT_HTML_OPEN=never
      bunx playwright test "$@" --workers=1 --trace=retain-on-failure --reporter=html \
        --output "$artifacts/test-results"
    )
    ;;
esac
