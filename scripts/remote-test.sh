#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'Usage: scripts/remote-test.sh [--force] [--no-cache] {preflight [--full] [--baseline-gate]|pytest [args...]|playwright [args...]|status}'
  echo 'Set COMPOSE_PROJECT_NAME=nere<issue-number> (optional -review suffix) for test runs.'
  echo 'Use preflight --full or PREFLIGHT_FULL_PYTEST=1 for the full selected pytest set.'
  echo 'Use preflight --baseline-gate or PREFLIGHT_BASELINE_GATE=1 to enforce the Node ID baseline gate.'
  echo 'Use --no-cache or CLOUD_TEST_NO_CACHE=1 to bypass the local content-addressed result cache.'
}

die() { echo "$*" >&2; exit 2; }

orig_args=("$@")
force=false
no_cache=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) force=true; shift ;;
    --no-cache) no_cache=true; shift ;;
    *) break ;;
  esac
done
mode=${1:-}
case "$mode" in
  -h|--help) usage; exit 0 ;;
  preflight|pytest|playwright|status) shift ;;
  *) usage >&2; exit 2 ;;
esac
if [[ $mode != status ]]; then
  filtered_args=()
  seen_sep=false
  for arg in "$@"; do
    if ! $seen_sep && [[ $arg == -- ]]; then
      seen_sep=true
      filtered_args+=("$arg")
    elif ! $seen_sep && [[ $arg == --no-cache ]]; then
      no_cache=true
    else
      filtered_args+=("$arg")
    fi
  done
  set -- ${filtered_args[@]+"${filtered_args[@]}"}
fi
case "$mode" in
  preflight)
    preflight_full=false
    preflight_baseline_gate=false
    for arg in "$@"; do
      case "$arg" in
        --full) preflight_full=true ;;
        --baseline-gate) preflight_baseline_gate=true ;;
        *) die 'preflight does not take arguments other than --full and --baseline-gate' ;;
      esac
    done
    if [[ ${PREFLIGHT_FULL_PYTEST:-0} == 1 ]]; then preflight_full=true; fi
    if [[ ${PREFLIGHT_BASELINE_GATE:-0} == 1 ]]; then preflight_baseline_gate=true; fi
    preflight_args=()
    if $preflight_full; then preflight_args+=(--full); fi
    if $preflight_baseline_gate; then preflight_args+=(--baseline-gate); fi
    set -- ${preflight_args[@]+"${preflight_args[@]}"}
    ;;
  status) [[ $# == 0 ]] || die "$mode does not take arguments" ;;
esac
project=${COMPOSE_PROJECT_NAME:-}
workers=${PREFLIGHT_PYTEST_WORKERS:-}
if [[ $mode == status ]]; then
  ! $force || die '--force only applies to test runs'
  ! $no_cache || die '--no-cache only applies to test runs'
else
  if ! [[ $project =~ ^nere([1-9][0-9]{0,3})(-review)?$ ]] || (( BASH_REMATCH[1] > 2999 )); then
    die 'Set COMPOSE_PROJECT_NAME=nere<issue-number 1–2999> (optional -review suffix)'
  fi
  [[ -z $workers || ( $workers =~ ^[1-9][0-9]*$ && $workers -le 16 ) ]] || die 'Set PREFLIGHT_PYTEST_WORKERS to 1–16'
  [[ -z ${EPP_WARM_DB:-} || ${EPP_WARM_DB} == 0 || ${EPP_WARM_DB} == 1 ]] || die 'Set EPP_WARM_DB to 0 or 1'
  if [[ -n ${EPP_WARM_DB_PORT:-} ]] && { ! [[ $EPP_WARM_DB_PORT =~ ^[1-9][0-9]*$ ]] || (( EPP_WARM_DB_PORT >= 65536 || EPP_WARM_DB_PORT == 5432 )); }; then
    die 'Set EPP_WARM_DB_PORT to 1–65535 (and != 5432)'
  fi
fi

config_dir=$HOME/.config/employee-profile-platform
config=${CLOUD_RUNNER_CONFIG:-$config_dir/cloud-runner.env}
keys=(GCP_PROJECT GCP_ZONE GCP_INSTANCE MONTHLY_BUDGET_USD SOFT_CAP_USD
      DISK_FIXED_MONTHLY_USD SPOT_HOURLY_RATE_USD USAGE_LEDGER_FILE)
if [[ -f $config ]]; then
  overrides=()
  values=()
  for key in "${keys[@]}"; do
    if declare -p "$key" >/dev/null 2>&1; then
      overrides+=("$key")
      values+=("${!key}")
    fi
  done
  # shellcheck source=/dev/null
  source "$config"
  for i in "${!overrides[@]}"; do printf -v "${overrides[i]}" '%s' "${values[i]}"; done
fi
[[ ${GCP_PROJECT:-} =~ ^[a-z][a-z0-9-]+$ && ${GCP_ZONE:-} =~ ^[a-z0-9-]+$ &&
   ${GCP_INSTANCE:-} =~ ^[a-z][a-z0-9-]*$ ]] || die \
  "Set GCP_PROJECT, GCP_ZONE and GCP_INSTANCE in $config or export them. See docs/cloud-testing.md."
[[ -n ${SPOT_HOURLY_RATE_USD:-} ]] || die "Set SPOT_HOURLY_RATE_USD in $config or export it."
export GCP_PROJECT GCP_ZONE GCP_INSTANCE
export PATH
monthly=${MONTHLY_BUDGET_USD:-40}
cap=${SOFT_CAP_USD:-}
disk=${DISK_FIXED_MONTHLY_USD:-10}
ledger=${USAGE_LEDGER_FILE:-$config_dir/cloud-runner-usage.jsonl}

scripts_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
metadata=$scripts_dir/remote-test-metadata.py
umask 077

observe() {
  local instance estimate
  instance=$(gcloud compute instances describe "$GCP_INSTANCE" --project "$GCP_PROJECT" \
    --zone "$GCP_ZONE" --format='json(status,lastStartTimestamp,lastStopTimestamp)') || return
  vm_status=$(python3 -c 'import json, sys; print(json.load(sys.stdin)["status"])' <<< "$instance") || return
  estimate=$(python3 "$metadata" estimate "$ledger" "$instance" "$disk" "$SPOT_HOURLY_RATE_USD" "$cap" "$monthly") || return
  budget_state=${estimate##*$'\n'}
  printf 'VM: %s\n%s\n' "$vm_status" "${estimate%$'\n'*}"
}

ssh_control_dir=${CLOUD_TEST_SSH_DIR:-$HOME/.cache/cloud_test_ssh}
mkdir -p "$ssh_control_dir"
chmod 700 "$ssh_control_dir"
ssh_control_key=$(python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' \
  "$GCP_PROJECT/$GCP_ZONE/$GCP_INSTANCE")
ssh_control_path="$ssh_control_dir/$ssh_control_key.sock"
export EPP_SSH_CONTROL_PATH=$ssh_control_path

cloud_ssh() {
  gcloud compute ssh "$GCP_INSTANCE" --project "$GCP_PROJECT" --zone "$GCP_ZONE" \
    --tunnel-through-iap --quiet \
    --ssh-flag=-oBatchMode=yes \
    --ssh-flag=-oConnectTimeout=30 \
    --ssh-flag=-oServerAliveInterval=15 \
    --ssh-flag=-oServerAliveCountMax=6 \
    --ssh-flag=-oTCPKeepAlive=yes \
    --ssh-flag=-oControlMaster=auto \
    --ssh-flag=-oControlPersist=10m \
    --ssh-flag="-oControlPath=$ssh_control_path" "$@"
}

if [[ $mode != status && $no_cache != true && ${CLOUD_TEST_NO_CACHE:-0} != 1 ]]; then
  if (cd "$scripts_dir/.." && python3 "$metadata" cache-lookup "$mode" -- "$@"); then
    exit 0
  fi
fi

resolve_queue_bin() {
  if [[ -n ${CLOUD_TEST_QUEUE_BIN+x} ]]; then
    if [[ -n $CLOUD_TEST_QUEUE_BIN && -x $CLOUD_TEST_QUEUE_BIN ]]; then
      printf '%s\n' "$CLOUD_TEST_QUEUE_BIN"
    fi
    return 0
  fi
  if [[ -x $HOME/.local/bin/cloud-test-queue ]]; then
    printf '%s\n' "$HOME/.local/bin/cloud-test-queue"
  elif command -v cloud-test-queue >/dev/null 2>&1; then
    command -v cloud-test-queue
  fi
}

if [[ $mode != status && ${CLOUD_TEST_QUEUE_HELD:-0} != 1 && ${CLOUD_TEST_QUEUE_DISABLE:-0} != 1 ]]; then
  queue_timeout=${CLOUD_TEST_LOCK_TIMEOUT:-900}
  queue_bin=$(resolve_queue_bin)
  if [[ -n $queue_bin ]]; then
    exec "$queue_bin" \
      --queue "$GCP_INSTANCE" \
      --project epp \
      --kind "$mode" \
      --timeout "$queue_timeout" \
      --label "epp:$project:$mode" \
      -- "${BASH_SOURCE[0]}" "${orig_args[@]}"
  fi
  exec env CLOUD_TEST_QUEUE_HELD=1 python3 "$metadata" queue-run \
    "$GCP_INSTANCE" "$queue_timeout" "epp:$project:$mode" -- \
    "${BASH_SOURCE[0]}" "${orig_args[@]}"
fi

slot_cap=${CLOUD_TEST_QUEUE_SLOTS:-}
if [[ -n $slot_cap ]]; then
  [[ $slot_cap =~ ^[1-9][0-9]*$ ]] || die "Invalid CLOUD_TEST_QUEUE_SLOTS: $slot_cap"
fi

observe
if [[ $mode == status ]]; then
  queue_bin=$(resolve_queue_bin)
  if [[ -n $queue_bin ]]; then
    "$queue_bin" status --queue "$GCP_INSTANCE" || true
  fi
  if [[ $vm_status == RUNNING ]]; then
    cloud_ssh --command="/usr/local/bin/auto-shutdown-idle.sh --status"
  else
    echo 'Active leases: unavailable while the VM is offline.'
  fi
  exit 0
fi

scratch=$(mktemp -d)
finish() {
  local code=$1
  trap - EXIT
  rm -rf -- "$scratch"
  if ! (observe); then
    echo 'Could not update the local usage estimate at exit.' >&2
    if [[ $code == 0 ]]; then code=1; fi
  fi
  exit "$code"
}
trap 'finish "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

need_ssh_probe=true
case "$vm_status" in
  TERMINATED)
    if [[ $budget_state == at-cap ]] && ! $force; then
      die 'Monthly soft cap reached. Run locally or use --force to start the VM.'
    fi
    gcloud compute instances start "$GCP_INSTANCE" --project "$GCP_PROJECT" --zone "$GCP_ZONE" --quiet
    ;;
  RUNNING)
    need_ssh_probe=false
    ;;
  PROVISIONING|STAGING) ;;
  *) die "VM state $vm_status does not support a test run. Check status and retry." ;;
esac
if $need_ssh_probe; then
  if [[ -S $ssh_control_path ]]; then
    ssh -S "$ssh_control_path" -O exit "$GCP_INSTANCE" 2>/dev/null || rm -f "$ssh_control_path"
  fi
  ready=false
  for (( attempt=0; attempt<12; attempt++ )); do
    if cloud_ssh --command=true; then ready=true; break; fi
    sleep 5
  done
  $ready || die 'IAP SSH did not become ready'
  observe
fi

cd "$scripts_dir/.."
run_id=$(basename "$scratch")
[[ $run_id =~ ^[A-Za-z0-9._-]+$ ]] || die 'Unexpected temporary directory name'
run_started=$(python3 -c 'import time; print(time.monotonic())')
if [[ $no_cache != true && ${CLOUD_TEST_NO_CACHE:-0} != 1 ]]; then
  python3 "$metadata" cache-prepare "$scratch/cache-meta.json" "$mode" -- "$@"
fi
mkdir "$scratch/tree"
python3 "$metadata" snapshot "$scratch/tree" "$run_id"

# rsync's shell receives the instance name followed by the server command.
cat > "$scratch/iap-ssh" <<'BASH'
#!/usr/bin/env bash
host=$1
shift
exec gcloud compute ssh "$host" --project "$GCP_PROJECT" --zone "$GCP_ZONE" \
  --tunnel-through-iap --quiet --ssh-flag=-T \
  --ssh-flag=-oBatchMode=yes \
  --ssh-flag=-oConnectTimeout=30 \
  --ssh-flag=-oServerAliveInterval=15 \
  --ssh-flag=-oServerAliveCountMax=6 \
  --ssh-flag=-oTCPKeepAlive=yes \
  --ssh-flag=-oControlMaster=auto \
  --ssh-flag=-oControlPersist=10m \
  --ssh-flag="-oControlPath=$EPP_SSH_CONTROL_PATH" \
  --command="${EPP_RSYNC_PREFIX:+$EPP_RSYNC_PREFIX }$*"
BASH
chmod 700 "$scratch/iap-ssh"

remote_root="\"\$HOME/epp-runs\""
remote_dir="\"\$HOME/epp-runs/$project\""
remote_lock="\"\$HOME/epp-runs/.$project.lock\""
lease=/usr/local/bin/cloud-test-lease-run.sh
locked="$lease epp-$project -- flock -n -E 75 $remote_lock"
# Invalidate the previous snapshot before any writes. A racing or failed sync
# can cause a retry, but it cannot run the wrong checkout.
# The lease runner backgrounds its child, which otherwise receives /dev/null.
receiver="test ! -L $remote_dir && rm -f $remote_dir/.remote-test-snapshot/id && exec \"\$@\" <&8"
upload="umask 077 && mkdir -p $remote_root && exec 8<&0 && exec $locked bash -c $(printf '%q' "$receiver") epp-receiver"
EPP_RSYNC_PREFIX=$upload rsync -rpt --checksum --timeout=60 --delete --exclude='/.git' --exclude=.venv --exclude=node_modules \
  -e "$(printf '%q' "$scratch/iap-ssh")" \
  "$scratch/tree/" "$GCP_INSTANCE:epp-runs/$project/" || die 'Workspace sync failed (project may be busy)'

# Quote each argument for the VM shell. A tty gives the remote worker a HUP
# on disconnect, including when the caller interrupts gcloud or SSH.
remote_env=''
if [[ -n $slot_cap ]]; then
  remote_env="env CLOUD_TEST_QUEUE_SLOTS=$(printf '%q' "$slot_cap") "
fi
if [[ -n ${PREFLIGHT_BASE_REF:-} ]]; then
  remote_env=${remote_env:-env }
  remote_env+="PREFLIGHT_BASE_REF=$(printf '%q' "$PREFLIGHT_BASE_REF") "
fi
for env_name in EPP_WARM_DB EPP_WARM_DB_PORT; do
  if [[ -n ${!env_name:-} ]]; then
    remote_env=${remote_env:-env }
    remote_env+="${env_name}=$(printf '%q' "${!env_name}") "
  fi
done
args=$(printf ' %q' "$run_id" "$project" "$mode" "$workers" "$@")
execute="cd $remote_dir && test \"\$(cat .remote-test-snapshot/id)\" = $run_id || { echo 'Snapshot changed; retry the run.' >&2; exit 75; }; exec ${remote_env}bash scripts/remote-test-worker.sh$args"
set +e
cloud_ssh --command="exec $locked bash -c $(printf '%q' "$execute")" -- -tt 2>&1 | tee "$scratch/output.log"
code=${PIPESTATUS[0]}
set -e

if [[ $code == 0 && -f $scratch/cache-meta.json ]]; then
  run_duration=$(python3 -c 'import sys, time; print(f"{max(0.0, time.monotonic() - float(sys.argv[1])):.3f}")' "$run_started")
  python3 "$metadata" cache-store "$scratch/cache-meta.json" "$project" "$run_duration" "$scratch/output.log" || true
fi

if [[ $mode == playwright && $code != 0 ]]; then
  report=$(mktemp -d "${TMPDIR:-/tmp}/epp-playwright.XXXXXXXX")
  remote_report="epp-runs/.artifacts/$project/$run_id"
  if rsync -rpt --timeout=60 -e "$(printf '%q' "$scratch/iap-ssh")" \
      "$GCP_INSTANCE:$remote_report/" "$report/"; then
    echo "Playwright artifacts: $report"
    cloud_ssh --command="rm -rf -- \"\$HOME/$remote_report\"" || true
  else
    rmdir "$report" 2>/dev/null || true
    echo "Playwright artifact download failed. VM path: ~/$remote_report" >&2
  fi
fi
finish "$code"
