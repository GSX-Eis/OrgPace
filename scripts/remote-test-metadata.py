"""Create a filtered worktree snapshot and account for observed VM boot intervals."""

import argparse
import errno
import fcntl
import fnmatch
import hashlib
import json
import math
import os
import re
import secrets
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path, PurePosixPath
from typing import Any

METADATA = ".remote-test-snapshot"
EXCLUDED = (
    METADATA,
    ".git",
    ".claude",
    ".agents",
    ".codex",
    ".ssh",
    ".aws",
    ".gcloud",
    ".azure",
    ".gnupg",
    ".kube",
    ".docker",
    ".config",
    ".multica",
    ".auth",
    ".secrets",
    ".credentials",
    ".cache",
    "credentials",
    "secrets",
    "node_modules",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "playwright-report",
    "test-results",
    "blob-report",
    ".env",
    ".env.*",
    ".envrc",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "auth.json",
    "credentials*.json",
    "service-account*.json",
    "application_default_credentials.json",
    "cloud-runner*",
    "id_rsa*",
    "id_ed25519*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
)


def allowed(path: bytes) -> bool:
    parts = Path(path.decode(errors="surrogateescape")).parts
    return all(
        part == ".env.example"
        or not any(fnmatch.fnmatchcase(part.lower(), pattern) for pattern in EXCLUDED)
        for part in parts
    )


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "--literal-pathspecs", *args])


def paths(*args: str) -> list[bytes]:
    return git(*args).rstrip(b"\0").split(b"\0")


def _is_real_remote_branch(ref: str) -> bool:
    full_ref = f"refs/remotes/{ref}"
    exists = subprocess.run(
        ["git", "show-ref", "--verify", "--quiet", full_ref],
        check=False,
    )
    if exists.returncode != 0:
        return False
    symref = subprocess.run(
        ["git", "symbolic-ref", "--quiet", full_ref],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return symref.returncode != 0


def _normalize_base_ref(raw: str) -> str:
    ref = raw.removeprefix("refs/remotes/")
    if not ref.startswith("origin/") or ref in {"origin/", "origin/HEAD"}:
        raise ValueError(
            f"PREFLIGHT_BASE_REF must be a real remote branch ref (origin/<branch>), got: {raw!r}"
        )
    check = subprocess.run(
        ["git", "check-ref-format", f"refs/remotes/{ref}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if check.returncode != 0:
        raise ValueError(
            f"PREFLIGHT_BASE_REF must be a valid remote branch ref (origin/<branch>), got: {raw!r}"
        )
    return ref


def resolve_base_ref() -> str:
    explicit = os.environ.get("PREFLIGHT_BASE_REF", "")
    if explicit:
        ref = _normalize_base_ref(explicit)
        if not _is_real_remote_branch(ref):
            raise ValueError(f"Base ref not found or is symbolic: {ref}")
        return ref
    for candidate in ("origin/dev", "origin/master"):
        if _is_real_remote_branch(candidate):
            return candidate
    raise ValueError("Could not resolve base ref (tried origin/dev and origin/master)")


def snapshot(destination: Path, run_id: str) -> None:
    base_ref = resolve_base_ref()
    base = git("merge-base", base_ref, "HEAD").decode().strip()
    index = destination / METADATA
    index.mkdir()
    (index / "base").write_text(base + "\n")
    (index / "base-ref").write_text(base_ref + "\n")
    for name, revisions in (
        ("committed", (base, "HEAD")),
        ("staged", ("--cached", "HEAD")),
    ):
        diff = ("diff", "--no-renames", "--no-ext-diff", "--no-textconv", *revisions)
        changed = [
            path.decode(errors="surrogateescape")
            for path in paths(*diff, "--name-only", "-z")
            if path and allowed(path)
        ]
        (index / f"{name}.patch").write_bytes(
            git(*diff, "--binary", "--full-index", "--", *changed) if changed else b""
        )

    for raw in set(
        paths("ls-files", "-z", "--cached", "--others", "--exclude-standard")
    ):
        if not raw or not allowed(raw):
            continue
        source = Path(raw.decode(errors="surrogateescape"))
        if source.absolute() != source.resolve():
            raise ValueError(f"Cannot sync symlink or path through symlink: {source}")
        if not source.exists():
            continue
        if not stat.S_ISREG(source.stat().st_mode):
            raise ValueError(f"Cannot sync non-regular file: {source}")
        target = destination / source
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    blocked = [
        path
        for path in paths("ls-tree", "-r", "--name-only", "-z", base)
        if path and not allowed(path)
    ]
    (index / "excluded").write_bytes(b"".join(path + b"\0" for path in blocked))
    (index / "id").write_text(run_id + "\n")


def estimate(
    ledger_path: Path, instance_json: str, disk: str, rate: str, cap: str, monthly: str
) -> None:
    disk_cost, hourly_rate, monthly_budget = map(Decimal, (disk, rate, monthly))
    soft_cap = Decimal(cap) if cap else monthly_budget * Decimal("0.9")
    if not all(
        value.is_finite() and value >= 0
        for value in (disk_cost, hourly_rate, soft_cap, monthly_budget)
    ):
        raise ValueError("Budget settings must be finite non-negative USD amounts")

    vm = json.loads(instance_json)
    status = vm["status"]
    now = datetime.now(UTC)
    start = vm.get("lastStartTimestamp")
    stop = (
        datetime.fromisoformat(vm["lastStopTimestamp"])
        if vm.get("lastStopTimestamp")
        else None
    )
    ledger_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with ledger_path.open("a+", encoding="utf-8") as ledger:
        fcntl.flock(ledger, fcntl.LOCK_EX)
        ledger.seek(0)
        boots = {}
        for line in ledger:
            event = json.loads(line)
            boots[event["start"]] = (event["end"], event["closed"])

        previous = boots.copy()

        # Only associate a stop with the most recent known start before it.
        if start and stop and datetime.fromisoformat(start) <= stop:
            boots[start] = (stop.isoformat(), True)
        elif stop:
            stopped = max(
                (boot for boot in boots if datetime.fromisoformat(boot) <= stop),
                key=datetime.fromisoformat,
                default=None,
            )
            if stopped and not boots[stopped][1]:
                boots[stopped] = (stop.isoformat(), True)
        if start and status in {"RUNNING", "STOPPING", "SUSPENDING"}:
            end, closed = boots.get(start, (start, False))
            if not closed:
                boots[start] = (
                    max(now, datetime.fromisoformat(end)).isoformat(),
                    False,
                )

        for boot, (end, closed) in boots.items():
            if previous.get(boot) != (end, closed):
                ledger.write(
                    json.dumps({"start": boot, "end": end, "closed": closed}) + "\n"
                )

    month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    seconds = sum(
        max(
            0,
            (
                min(now, datetime.fromisoformat(end))
                - max(month, datetime.fromisoformat(boot))
            ).total_seconds(),
        )
        for boot, (end, _) in boots.items()
    )
    hours = Decimal(str(seconds)) / 3600
    cost = disk_cost + hours * hourly_rate
    print(
        f"Month (UTC), observed VM uptime: {hours:.2f} h. Estimated cost: ${cost:.2f} USD (soft cap ${soft_cap:.2f})."
    )
    print("at-cap" if cost >= soft_cap else "below-cap")


QUEUE_BUSY_CODE = 75
DEFAULT_QUEUE_DIR = "~/.cache/cloud_test_queue"
QUEUE_POLL_INTERVAL = 0.2
QUEUE_HEARTBEAT_SECONDS = 30.0


def _read_fd_json(fd: int) -> dict[str, Any] | None:
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        while True:
            chunk = os.read(fd, 8192)
            if not chunk:
                break
            chunks.append(chunk)
        text = b"".join(chunks).decode("utf-8", errors="replace").strip()
        if not text:
            return None
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _write_fd_json(fd: int, payload: dict[str, Any]) -> None:
    encoded = (json.dumps(payload, ensure_ascii=True) + "\n").encode("utf-8")
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    os.write(fd, encoded)


def _is_ticket_live(path: Path) -> bool:
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        except OSError as exc:
            if exc.errno in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                return True
            raise
        try:
            fd_stat = os.fstat(fd)
            path_stat = path.stat()
            if (
                fd_stat.st_ino == path_stat.st_ino
                and fd_stat.st_dev == path_stat.st_dev
            ):
                path.unlink(missing_ok=True)
        except OSError:
            pass
        return False
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)


def _create_queue_ticket(
    ticket_dir: Path, metadata: dict[str, Any]
) -> tuple[Path, int]:
    ticket_dir.mkdir(parents=True, exist_ok=True)
    ts = time.time_ns()
    pid = os.getpid()
    token = secrets.token_hex(4)
    tmp_path = ticket_dir / f".tmp-{ts:020d}-{pid:08d}-{token}"
    final_path = ticket_dir / f"{ts:020d}-{pid:08d}-{token}.ticket"
    fd = os.open(str(tmp_path), os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _write_fd_json(fd, metadata)
        os.replace(tmp_path, final_path)
    except BaseException:
        try:
            os.close(fd)
        finally:
            tmp_path.unlink(missing_ok=True)
            final_path.unlink(missing_ok=True)
        raise
    return final_path, fd


def _scan_queue_tickets(ticket_dir: Path, self_name: str) -> tuple[int, int]:
    if not ticket_dir.exists():
        return 0, 1
    ahead = 0
    total = 0
    for path in sorted(ticket_dir.glob("*.ticket")):
        if path.name == self_name:
            total += 1
            continue
        if _is_ticket_live(path):
            total += 1
            if path.name < self_name:
                ahead += 1
    return ahead, max(total, 1)


def _format_holder(holder: dict[str, Any] | None) -> str:
    if not holder:
        return "unknown holder"
    parts: list[str] = []
    if holder.get("issue_hint"):
        parts.append(str(holder["issue_hint"]))
    if holder.get("label"):
        parts.append(str(holder["label"]))
    elif holder.get("mode"):
        parts.append(str(holder["mode"]))
    if holder.get("pid"):
        parts.append(f"pid={holder['pid']}")
    if holder.get("cwd"):
        parts.append(f"cwd={Path(str(holder['cwd'])).name}")
    if holder.get("started_at"):
        parts.append(f"since={holder['started_at']}")
    return " ".join(parts) if parts else json.dumps(holder, ensure_ascii=True)


def queue_run(queue_name: str, timeout_raw: str, label: str, command: list[str]) -> int:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", queue_name):
        raise ValueError(f"Invalid queue name: {queue_name!r}")
    timeout = float(timeout_raw)
    if not math.isfinite(timeout) or timeout < 0:
        raise ValueError("CLOUD_TEST_LOCK_TIMEOUT must be finite and non-negative")
    if not command:
        raise ValueError("Missing command for queue-run")

    queue_root = Path(
        os.environ.get("CLOUD_TEST_QUEUE_DIR") or DEFAULT_QUEUE_DIR
    ).expanduser()
    queue_root.mkdir(parents=True, exist_ok=True)
    lock_path = queue_root / f"{queue_name}.lock"
    ticket_dir = queue_root / f"{queue_name}.queue"

    base_meta: dict[str, Any] = {
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "label": label,
        "cwd": os.getcwd(),
        "command": shlex.join(command),
        "enqueued_at": datetime.now(UTC).isoformat(),
        "issue_hint": os.environ.get("MULTICA_ISSUE_IDENTIFIER") or None,
    }

    main_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    ticket_path: Path | None = None
    ticket_fd: int | None = None
    acquired = False

    try:
        ticket_path, ticket_fd = _create_queue_ticket(ticket_dir, base_meta)
        start_mono = time.monotonic()
        deadline = start_mono + timeout
        waited = False
        last_report_state: tuple[int, int, str] | None = None
        last_report_time = 0.0

        while True:
            ahead, total = _scan_queue_tickets(ticket_dir, ticket_path.name)
            if ahead == 0:
                try:
                    fcntl.flock(main_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                    break
                except BlockingIOError:
                    pass
                except OSError as exc:
                    if exc.errno not in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                        raise

            now_mono = time.monotonic()
            remaining = deadline - now_mono
            holder = _read_fd_json(main_fd)
            holder_text = _format_holder(holder)

            if remaining <= 0:
                holder_json = (
                    json.dumps(holder, ensure_ascii=True)
                    if holder
                    else "holder metadata not yet available"
                )
                print(
                    f"Cloud test queue busy ({lock_path}, ahead={ahead}, queued={total})\n"
                    f"{holder_json}\n"
                    "Wait for the current run or increase CLOUD_TEST_LOCK_TIMEOUT and retry.",
                    file=sys.stderr,
                )
                return QUEUE_BUSY_CODE

            waited = True
            state = (ahead, total, holder_text)
            if (
                state != last_report_state
                or (now_mono - last_report_time) >= QUEUE_HEARTBEAT_SECONDS
            ):
                elapsed = int(now_mono - start_mono)
                print(
                    f"[cloud-test-queue] Waiting for '{queue_name}' "
                    f"(position #{ahead + 1}/{total}, elapsed {elapsed}s/{timeout:g}s) | "
                    f"holder: {holder_text}",
                    file=sys.stderr,
                    flush=True,
                )
                last_report_state = state
                last_report_time = now_mono
            time.sleep(min(QUEUE_POLL_INTERVAL, max(0.01, remaining)))

        holder_meta = {**base_meta, "started_at": datetime.now(UTC).isoformat()}
        _write_fd_json(main_fd, holder_meta)
        if ticket_path is not None:
            ticket_path.unlink(missing_ok=True)
        if ticket_fd is not None:
            os.close(ticket_fd)
            ticket_fd = None

        if waited:
            elapsed_f = time.monotonic() - start_mono
            print(
                f"[cloud-test-queue] Acquired '{queue_name}' after {elapsed_f:.1f}s",
                file=sys.stderr,
                flush=True,
            )

        proc = subprocess.Popen(command, pass_fds=(main_fd,))

        def _forward(signum: int, _frame: Any) -> None:
            if proc.poll() is None:
                try:
                    proc.send_signal(signum)
                except OSError:
                    pass

        prev_handlers: dict[int, Any] = {}
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            prev_handlers[sig] = signal.getsignal(sig)
            signal.signal(sig, _forward)
        try:
            rc = proc.wait()
        finally:
            for sig, handler in prev_handlers.items():
                signal.signal(sig, handler)
        return (128 + (-rc)) if rc < 0 else rc
    finally:
        if ticket_fd is not None:
            if ticket_path is not None:
                ticket_path.unlink(missing_ok=True)
            try:
                os.close(ticket_fd)
            except OSError:
                pass
        if acquired:
            try:
                fcntl.flock(main_fd, fcntl.LOCK_UN)
            except OSError:
                pass
        try:
            os.close(main_fd)
        except OSError:
            pass


DEFAULT_CACHE_DIR = "~/.cache/cloud_test_results"
DEFAULT_CACHE_TTL_HOURS = 24.0
CACHE_SCHEMA_VERSION = 1
CACHE_OUTPUT_TAIL_LINES = 50
CACHE_SCOPE_MAX_ENTRIES = 32

PYTEST_IGNORED_FLAGS = frozenset(
    {"-q", "--quiet", "-v", "--verbose", "-s", "--no-header", "-x", "--exitfirst"}
)
PYTEST_IGNORED_VALUE_OPTIONS = frozenset(
    {
        "-n",
        "--numprocesses",
        "--dist",
        "--durations",
        "--durations-min",
        "--lock-timeout",
        "--color",
        "--tb",
        "-r",
        "--show-capture",
        "--verbosity",
        "--maxfail",
    }
)
PYTEST_VALUE_OPTIONS = frozenset(
    {
        "-c",
        "-k",
        "-m",
        "-o",
        "-p",
        "-W",
        "--assert",
        "--basetemp",
        "--capture",
        "--code-highlight",
        "--confcutdir",
        "--config-file",
        "--cov",
        "--cov-config",
        "--cov-fail-under",
        "--cov-report",
        "--deselect",
        "--doctest-glob",
        "--doctest-report",
        "--group",
        "--ignore",
        "--ignore-glob",
        "--import-mode",
        "--junit-prefix",
        "--junit-xml",
        "--junitprefix",
        "--junitxml",
        "--lfnf",
        "--log-cli-format",
        "--log-cli-level",
        "--log-file",
        "--log-level",
        "--override-ini",
        "--pythonwarnings",
        "--rootdir",
        "--splits",
        "--timeout",
        "--timeout-method",
    }
    | PYTEST_IGNORED_VALUE_OPTIONS
)
PYTEST_RESTRICTING_OPTIONS = frozenset(
    {"-k", "-m", "--ignore", "--ignore-glob", "--deselect", "--splits", "--group"}
)
PYTEST_BYPASS_FLAGS = frozenset(
    {
        "--count",
        "--repeat",
        "--repeat-each",
        "--flake-finder",
        "--lf",
        "--last-failed",
        "--ff",
        "--failed-first",
        "--sw",
        "--stepwise",
        "--stepwise-skip",
        "--nf",
        "--new-first",
        "--pdb",
        "--pdbcls",
        "--trace",
        "--collect-only",
        "--co",
        "--setup-only",
    }
)
PLAYWRIGHT_IGNORED_FLAGS = frozenset({"--quiet"})
PLAYWRIGHT_IGNORED_VALUE_OPTIONS = frozenset({"--workers", "-j", "--reporter"})
PLAYWRIGHT_VALUE_OPTIONS = frozenset(
    {
        "-g",
        "--grep",
        "--grep-invert",
        "--project",
        "--config",
        "-c",
        "--timeout",
        "--global-timeout",
        "--shard",
        "--output",
        "--trace",
        "--retries",
        "--repeat-each",
    }
    | PLAYWRIGHT_IGNORED_VALUE_OPTIONS
)
PLAYWRIGHT_BYPASS_FLAGS = frozenset(
    {
        "--count",
        "--repeat",
        "--repeat-each",
        "--retries",
        "--list",
        "--debug",
        "--ui",
        "--update-snapshots",
        "-u",
    }
)
NON_DETERMINISTIC_TOKENS = ("@external-mcp", "chatgpt_live")


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes"}


def _cache_ttl_seconds() -> float:
    raw = os.environ.get("CLOUD_TEST_CACHE_TTL_HOURS", "").strip()
    if not raw:
        return DEFAULT_CACHE_TTL_HOURS * 3600.0
    hours = float(raw)
    if not math.isfinite(hours) or hours < 0:
        raise ValueError("CLOUD_TEST_CACHE_TTL_HOURS must be finite and non-negative")
    return hours * 3600.0


def _cache_repo_dir(repo_id: str = "epp") -> Path:
    root = Path(
        os.environ.get("CLOUD_TEST_CACHE_DIR") or DEFAULT_CACHE_DIR
    ).expanduser()
    repo_dir = root / repo_id
    repo_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    return repo_dir


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    encoded = (json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    tmp_path = path.parent / f".tmp-{os.getpid()}-{secrets.token_hex(6)}"
    fd = os.open(str(tmp_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(fd, encoded)
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        tmp_path.unlink(missing_ok=True)
        raise
    os.close(fd)
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, path)


def compute_tree_sha() -> str:
    """Compute a content-only Git tree SHA over allowed workspace files."""
    raw_paths = sorted(
        {
            raw
            for raw in paths(
                "ls-files", "-z", "--cached", "--others", "--exclude-standard"
            )
            if raw and allowed(raw)
        }
    )
    head_entries: dict[bytes, tuple[str, str]] = {}
    try:
        tree_raw = git("ls-tree", "-r", "-z", "HEAD")
        for rec in tree_raw.split(b"\0"):
            if not rec or b"\t" not in rec:
                continue
            meta_part, path_part = rec.split(b"\t", 1)
            parts = meta_part.decode("ascii").split(" ")
            if len(parts) == 3 and parts[1] == "blob":
                head_entries[path_part] = (parts[0], parts[2])
    except subprocess.CalledProcessError:
        head_entries = {}

    dirty_set: set[bytes] = set()
    if head_entries:
        try:
            dirty_set.update(p for p in paths("diff", "--name-only", "-z", "HEAD") if p)
        except subprocess.CalledProcessError:
            head_entries = {}

    real_objects = Path(
        git("rev-parse", "--git-path", "objects").decode().strip()
    ).resolve()
    repo_root_resolved = Path.cwd().resolve()
    with tempfile.TemporaryDirectory() as tmp_raw:
        tmp = Path(tmp_raw)
        tmp_objects = tmp / "objects"
        tmp_objects.mkdir()
        tmp_index = tmp / "index"
        git_env = {
            **os.environ,
            "GIT_INDEX_FILE": str(tmp_index),
            "GIT_OBJECT_DIRECTORY": str(tmp_objects),
            "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(real_objects),
        }

        to_hash: list[tuple[bytes, str]] = []
        index_entries: list[tuple[str, str, bytes]] = []
        for raw in raw_paths:
            source = Path(raw.decode(errors="surrogateescape"))
            if (repo_root_resolved / source) != source.resolve():
                raise ValueError(
                    f"Cannot hash symlink or path through symlink: {source}"
                )
            if not source.exists():
                continue
            st = source.stat()
            if not stat.S_ISREG(st.st_mode):
                raise ValueError(f"Cannot hash non-regular file: {source}")
            if raw in head_entries and raw not in dirty_set:
                mode_str, blob_sha = head_entries[raw]
                index_entries.append((mode_str, blob_sha, raw))
            else:
                mode_str = "100755" if (st.st_mode & 0o111) else "100644"
                to_hash.append((raw, mode_str))

        batch_size = 200
        for offset in range(0, len(to_hash), batch_size):
            batch = to_hash[offset : offset + batch_size]
            cmd = [
                "git",
                "--literal-pathspecs",
                "hash-object",
                "-w",
                "--",
                *[p.decode(errors="surrogateescape") for p, _ in batch],
            ]
            shas = (
                subprocess.check_output(cmd, env=git_env)
                .decode("ascii")
                .strip()
                .splitlines()
            )
            if len(shas) != len(batch):
                raise RuntimeError("Unexpected git hash-object output length")
            for (raw, mode_str), blob_sha in zip(batch, shas, strict=True):
                index_entries.append((mode_str, blob_sha, raw))

        if index_entries:
            index_entries.sort(key=lambda item: item[2])
            payload = b"".join(
                f"{mode_str} {blob_sha}\t".encode("ascii") + raw + b"\0"
                for mode_str, blob_sha, raw in index_entries
            )
            subprocess.run(
                ["git", "--literal-pathspecs", "update-index", "-z", "--index-info"],
                input=payload,
                env=git_env,
                check=True,
            )
        return (
            subprocess.check_output(
                ["git", "--literal-pathspecs", "write-tree"], env=git_env
            )
            .decode("ascii")
            .strip()
        )


def _normalize_target_path(raw: str) -> str:
    path_part, sep, node = raw.partition("::")
    norm = str(PurePosixPath(path_part.replace("\\", "/")))
    norm = norm.removeprefix("./")
    return f"{norm}{sep}{node}" if sep else norm


def _detect_bypass(mode: str, args: list[str]) -> str | None:
    if _truthy_env("CLOUD_TEST_NO_CACHE"):
        return "CLOUD_TEST_NO_CACHE=1"
    if _truthy_env("EXTERNAL_MCP_ENABLED"):
        return "EXTERNAL_MCP_ENABLED"
    joined_env = os.environ.get("PYTEST_ADDOPTS", "").lower()
    for token in NON_DETERMINISTIC_TOKENS:
        if token in joined_env:
            return f"env:{token}"
    bypass_flags = (
        PLAYWRIGHT_BYPASS_FLAGS if mode == "playwright" else PYTEST_BYPASS_FLAGS
    )
    for arg in args:
        lower = arg.lower()
        for token in NON_DETERMINISTIC_TOKENS:
            if token in lower:
                return f"marker:{token}"
        opt = arg.split("=", 1)[0]
        if opt in bypass_flags:
            return f"flag:{opt}"
    return None


def _normalize_pytest_args(args: list[str]) -> tuple[list[str], list[str]]:
    flags: list[str] = []
    targets: list[str] = []
    options_open = True
    i = 0
    while i < len(args):
        arg = args[i]
        if options_open and arg == "--":
            options_open = False
            i += 1
            continue
        if options_open and arg.startswith("-"):
            if arg.startswith("--"):
                opt, has_eq, val = arg.partition("=")
                if opt in PYTEST_IGNORED_FLAGS:
                    i += 1
                    continue
                if opt in PYTEST_IGNORED_VALUE_OPTIONS:
                    i += 1 if has_eq else 2
                    continue
                if opt in PYTEST_VALUE_OPTIONS:
                    if has_eq:
                        flags.append(f"{opt}={val}")
                        i += 1
                    elif i + 1 < len(args):
                        flags.append(f"{opt}={args[i + 1]}")
                        i += 2
                    else:
                        flags.append(opt)
                        i += 1
                    continue
                flags.append(arg)
                i += 1
                continue
            # Short flag or cluster
            if arg in PYTEST_IGNORED_FLAGS:
                i += 1
                continue
            if len(arg) > 2 and set(arg[1:]).issubset({"q", "v", "s", "x"}):
                i += 1
                continue
            short = arg[:2]
            if short in PYTEST_IGNORED_VALUE_OPTIONS:
                i += 1 if len(arg) > 2 else 2
                continue
            if short in PYTEST_VALUE_OPTIONS:
                if len(arg) > 2:
                    flags.append(f"{short}={arg[2:]}")
                    i += 1
                elif i + 1 < len(args):
                    flags.append(f"{short}={args[i + 1]}")
                    i += 2
                else:
                    flags.append(short)
                    i += 1
                continue
            flags.append(arg)
            i += 1
            continue
        targets.append(_normalize_target_path(arg))
        i += 1
    return sorted(flags), sorted(set(targets))


def _normalize_playwright_args(args: list[str]) -> tuple[list[str], list[str]]:
    flags: list[str] = []
    targets: list[str] = []
    options_open = True
    i = 0
    while i < len(args):
        arg = args[i]
        if options_open and arg == "--":
            options_open = False
            i += 1
            continue
        if options_open and arg.startswith("-"):
            opt, has_eq, val = arg.partition("=")
            if opt in PLAYWRIGHT_IGNORED_FLAGS:
                i += 1
                continue
            if opt in PLAYWRIGHT_IGNORED_VALUE_OPTIONS:
                i += 1 if has_eq else 2
                continue
            if opt in PLAYWRIGHT_VALUE_OPTIONS:
                if has_eq:
                    flags.append(f"{opt}={val}")
                    i += 1
                elif i + 1 < len(args):
                    flags.append(f"{opt}={args[i + 1]}")
                    i += 2
                else:
                    flags.append(opt)
                    i += 1
                continue
            flags.append(arg)
            i += 1
            continue
        targets.append(_normalize_target_path(arg))
        i += 1
    return sorted(flags), sorted(set(targets))


def _expand_epp_pytest_targets(targets: list[str]) -> list[str] | None:
    """Expand whole file/directory pytest targets relative to backend/."""
    if any("::" in t for t in targets):
        return None
    backend_root = Path("backend")
    if not backend_root.is_dir():
        return None
    search_roots = (
        [backend_root / t for t in targets] if targets else [backend_root / "tests"]
    )
    expanded: set[str] = set()
    for item in search_roots:
        if item.is_file():
            try:
                expanded.add(item.relative_to(backend_root).as_posix())
            except ValueError:
                return None
        elif item.is_dir():
            for candidate in item.rglob("*.py"):
                name = candidate.name
                if fnmatch.fnmatchcase(name, "test_*.py") or fnmatch.fnmatchcase(
                    name, "*_test.py"
                ):
                    expanded.add(candidate.relative_to(backend_root).as_posix())
        else:
            return None
    return sorted(expanded) if expanded else None


def _is_subset_eligible(mode: str, normalized_flags: list[str]) -> bool:
    if mode != "pytest":
        return False
    for flag in normalized_flags:
        opt = flag.split("=", 1)[0]
        if opt in PYTEST_RESTRICTING_OPTIONS:
            return False
    return True


def build_cache_descriptor(mode: str, args: list[str]) -> dict[str, Any]:
    bypass = _detect_bypass(mode, args)
    if bypass:
        return {"bypass": bypass}

    tree_sha = compute_tree_sha()
    extra_inputs: dict[str, str] = {}
    if mode == "preflight":
        base_ref = resolve_base_ref()
        base_sha = git("rev-parse", "--verify", base_ref).decode("ascii").strip()
        extra_inputs["base_ref"] = base_ref
        extra_inputs["base_sha"] = base_sha
        full = "--full" in args or _truthy_env("PREFLIGHT_FULL_PYTEST")
        baseline_gate = "--baseline-gate" in args or _truthy_env(
            "PREFLIGHT_BASELINE_GATE"
        )
        normalized_flags = []
        if full:
            normalized_flags.append("--full")
        if baseline_gate:
            normalized_flags.append("--baseline-gate")
        normalized_targets: list[str] = []
    elif mode == "pytest":
        normalized_flags, normalized_targets = _normalize_pytest_args(args)
    elif mode == "playwright":
        normalized_flags, normalized_targets = _normalize_playwright_args(args)
    else:
        return {"bypass": f"unsupported-mode:{mode}"}

    warm_db_mode = (
        "ephemeral"
        if mode == "playwright"
        else ("0" if os.environ.get("EPP_WARM_DB", "").strip() == "0" else "1")
    )
    semantic_env = {
        "EPP_WARM_DB": warm_db_mode,
        "EXTERNAL_MCP_ENABLED": os.environ.get("EXTERNAL_MCP_ENABLED", ""),
        "PLAYWRIGHT_FIXTURES_ENABLED": (
            "true"
            if mode == "playwright"
            else os.environ.get("PLAYWRIGHT_FIXTURES_ENABLED", "")
        ),
        "PREFLIGHT_BASELINE_GATE": (
            "1"
            if (mode == "preflight" and "--baseline-gate" in normalized_flags)
            else os.environ.get("PREFLIGHT_BASELINE_GATE", "")
        ),
        "PREFLIGHT_FULL_PYTEST": (
            "1"
            if (mode == "preflight" and "--full" in normalized_flags)
            else os.environ.get("PREFLIGHT_FULL_PYTEST", "")
        ),
        "PYTEST_ADDOPTS": os.environ.get("PYTEST_ADDOPTS", ""),
    }

    key_payload = {
        "schema_version": CACHE_SCHEMA_VERSION,
        "repo_id": "epp",
        "mode": mode,
        "tree_sha": tree_sha,
        "extra_inputs": extra_inputs,
        "semantic_env": semantic_env,
        "normalized_flags": normalized_flags,
        "normalized_targets": normalized_targets,
    }
    cache_key = hashlib.sha256(
        json.dumps(key_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    scope_hash: str | None = None
    expanded_files: list[str] | None = None
    if _is_subset_eligible(mode, normalized_flags):
        expanded_files = _expand_epp_pytest_targets(normalized_targets)
        if expanded_files:
            scope_payload = {
                "schema_version": CACHE_SCHEMA_VERSION,
                "repo_id": "epp",
                "mode": mode,
                "tree_sha": tree_sha,
                "extra_inputs": extra_inputs,
                "semantic_env": semantic_env,
                "normalized_flags": normalized_flags,
            }
            scope_hash = hashlib.sha256(
                json.dumps(scope_payload, sort_keys=True, separators=(",", ":")).encode(
                    "utf-8"
                )
            ).hexdigest()

    return {
        "bypass": None,
        "repo_id": "epp",
        "mode": mode,
        "tree_sha": tree_sha,
        "extra_inputs": extra_inputs,
        "semantic_env": semantic_env,
        "normalized_flags": normalized_flags,
        "normalized_targets": normalized_targets,
        "cache_key": cache_key,
        "scope_hash": scope_hash,
        "expanded_files": expanded_files,
    }


def _load_valid_entry(
    path: Path, now_epoch: float, ttl_seconds: float
) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("exit_code") != 0:
        return None
    passed_epoch = data.get("passed_at_epoch")
    if not isinstance(passed_epoch, (int, float)):
        return None
    if now_epoch - float(passed_epoch) > ttl_seconds:
        return None
    return data


def _print_cache_hit(
    entry: dict[str, Any], match_label: str, lookup_elapsed: float, ttl_seconds: float
) -> None:
    age_s = max(0.0, time.time() - float(entry["passed_at_epoch"]))
    ttl_h = ttl_seconds / 3600.0
    print(
        f"[cloud-test-cache] HIT ({lookup_elapsed:.3f}s, skipped queue & GCP VM wake)"
    )
    print(
        f"  repo={entry.get('repo_id', 'epp')} mode={entry.get('mode')} "
        f"match={match_label} cache_key={str(entry.get('cache_key', ''))[:16]}"
    )
    print(f"  tree_sha={entry.get('tree_sha')}")
    extra = entry.get("extra_inputs") or {}
    if extra.get("base_sha"):
        print(f"  base_ref={extra.get('base_ref', '')} base_sha={extra['base_sha']}")
    elif extra.get("origin_master_sha"):
        print(f"  origin_master_sha={extra['origin_master_sha']}")
    print(
        f"  passed_at={entry.get('passed_at')} (age={age_s:.0f}s / ttl={ttl_h:g}h) "
        f"source={entry.get('source_project') or 'unknown'} "
        f"original_duration={float(entry.get('duration_seconds', 0.0)):.1f}s"
    )
    print("  bypass: pass --no-cache or set CLOUD_TEST_NO_CACHE=1 to force re-run")
    tail = entry.get("output_tail") or ""
    if tail:
        print("--- cached output tail ---")
        print(tail.rstrip("\n"))
        print("--- end cached output ---")


def cache_lookup(mode: str, args: list[str]) -> int:
    started = time.monotonic()
    try:
        desc = build_cache_descriptor(mode, args)
    except (OSError, ValueError, subprocess.CalledProcessError):
        return 1
    if desc.get("bypass"):
        return 1

    ttl_seconds = _cache_ttl_seconds()
    if ttl_seconds <= 0:
        return 1
    now_epoch = time.time()
    repo_dir = _cache_repo_dir("epp")
    entries_dir = repo_dir / "entries"

    exact_path = entries_dir / f"{desc['cache_key']}.json"
    entry = _load_valid_entry(exact_path, now_epoch, ttl_seconds)
    if entry is not None:
        _print_cache_hit(entry, "exact", time.monotonic() - started, ttl_seconds)
        return 0

    scope_hash = desc.get("scope_hash")
    expanded_files = desc.get("expanded_files")
    if scope_hash and expanded_files:
        scope_path = repo_dir / "scopes" / f"{scope_hash}.json"
        try:
            scope_data = json.loads(scope_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            scope_data = None
        if isinstance(scope_data, dict):
            req_set = set(expanded_files)
            for item in reversed(scope_data.get("entries") or []):
                if not isinstance(item, dict):
                    continue
                covered = item.get("files")
                entry_id = item.get("entry_id")
                if not isinstance(covered, list) or not isinstance(entry_id, str):
                    continue
                if req_set.issubset(covered):
                    superset = _load_valid_entry(
                        entries_dir / f"{entry_id}.json", now_epoch, ttl_seconds
                    )
                    if superset is not None:
                        _print_cache_hit(
                            superset,
                            f"subset({len(req_set)}/{len(covered)} files)",
                            time.monotonic() - started,
                            ttl_seconds,
                        )
                        return 0
    return 1


def cache_prepare(output_path: Path, mode: str, args: list[str]) -> None:
    try:
        desc = build_cache_descriptor(mode, args)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        desc = {"bypass": f"error:{exc}"}
    _atomic_write_json(output_path, desc)


def cache_store(
    descriptor_path: Path,
    project: str,
    duration_raw: str,
    output_log: Path,
    summary_path: Path | None = None,
) -> None:
    try:
        desc = json.loads(descriptor_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(desc, dict) or desc.get("bypass") or not desc.get("cache_key"):
        return

    duration = float(duration_raw)
    tail_text = ""
    if summary_path is not None and summary_path.is_file():
        lines = summary_path.read_text(encoding="utf-8", errors="replace").splitlines()
        tail_text = "\n".join(lines[-CACHE_OUTPUT_TAIL_LINES:])
    elif output_log.is_file():
        raw_text = output_log.read_text(encoding="utf-8", errors="replace")
        lines = raw_text.splitlines()
        if len(lines) > CACHE_OUTPUT_TAIL_LINES or any(
            line.startswith("EPP_METRIC ") for line in lines
        ):
            summary_lines = build_summary_lines(
                mode=str(desc.get("mode") or "pytest"),
                project=project,
                exit_code=0,
                queue_wait_s="0.000",
                sync_s="0.000",
                total_s=f"{max(0.0, duration):.3f}",
                vm_summary="cached",
                raw_output=raw_text,
            )
            tail_text = "\n".join(summary_lines[-CACHE_OUTPUT_TAIL_LINES:])
        else:
            tail_text = "\n".join(lines[-CACHE_OUTPUT_TAIL_LINES:])

    now = datetime.now(UTC)
    entry = {
        "schema_version": CACHE_SCHEMA_VERSION,
        "repo_id": desc["repo_id"],
        "mode": desc["mode"],
        "cache_key": desc["cache_key"],
        "tree_sha": desc["tree_sha"],
        "extra_inputs": desc.get("extra_inputs") or {},
        "semantic_env": desc.get("semantic_env") or {},
        "normalized_flags": desc.get("normalized_flags") or [],
        "normalized_targets": desc.get("normalized_targets") or [],
        "exit_code": 0,
        "passed_at": now.isoformat(),
        "passed_at_epoch": now.timestamp(),
        "duration_seconds": round(max(0.0, duration), 3),
        "source_project": project,
        "source_issue": os.environ.get("MULTICA_ISSUE_IDENTIFIER") or project,
        "output_tail": tail_text,
    }
    repo_dir = _cache_repo_dir("epp")
    _atomic_write_json(repo_dir / "entries" / f"{desc['cache_key']}.json", entry)

    scope_hash = desc.get("scope_hash")
    expanded_files = desc.get("expanded_files")
    if scope_hash and expanded_files:
        scopes_dir = repo_dir / "scopes"
        scopes_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock_path = scopes_dir / f".{scope_hash}.lock"
        scope_path = scopes_dir / f"{scope_hash}.json"
        lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            try:
                existing = json.loads(scope_path.read_text(encoding="utf-8"))
                entries = list(existing.get("entries") or [])
            except (OSError, json.JSONDecodeError, AttributeError):
                entries = []
            entries = [
                e
                for e in entries
                if isinstance(e, dict) and e.get("entry_id") != desc["cache_key"]
            ]
            entries.append(
                {
                    "entry_id": desc["cache_key"],
                    "passed_at": now.isoformat(),
                    "files": expanded_files,
                }
            )
            entries = entries[-CACHE_SCOPE_MAX_ENTRIES:]
            _atomic_write_json(scope_path, {"entries": entries})
        finally:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(lock_fd)


_ANSI_RE = re.compile(
    r"\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_].*?\x1b\\|[@-Z\\-_])"
)
_PYTEST_BANNER_RE = re.compile(r"^={3,}\s+(.+?)\s+={3,}$")
_PYTEST_SUMMARY_RE = re.compile(
    r"^(?:=+\s*)?((?:(?:\d+\s+(?:passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)|no tests ran)(?:,\s*)?)+\s+in\s+\d+(?:\.\d+)?s(?:\s+\([^)]+\))?)(?:\s*=+)?$"
)
_PYTEST_COUNT_RE = re.compile(
    r"(\d+)\s+(passed|failed|skipped|errors?|xfailed|xpassed)"
)
_PYTEST_DURATION_LINE_RE = re.compile(
    r"^\s*(\d+(?:\.\d+)?s)\s+(call|setup|teardown)\s+(.+?)\s*$"
)
_PLAYWRIGHT_COUNT_RE = re.compile(
    r"^\s*(\d+)\s+(passed|failed|skipped|flaky|timed out|interrupted|did not run)(?:\s+\([^)]+\))?\s*$"
)
_PLAYWRIGHT_FATAL_ERROR_RE = re.compile(
    r"^\s*(\d+)\s+errors?\s+(?:was|were)\s+not\s+a\s+part\s+of\s+any\s+test(?:,\s*see above for details)?\s*$"
)
_PLAYWRIGHT_SUMMARY_DETAIL_RE = re.compile(r"^\s{4,}.+\s+›\s+")
_PREFLIGHT_STEP_RE = re.compile(
    r"^(同步检查|单一head|pre-commit|数据库环境|pytest|手动提示):\s*(通过|跳过|失败)\s*\((\d+)s\)$"
)
_SSH_CLOSED_RE = re.compile(r"^Shared connection to .+ closed\.$")


def _clean_output(raw: str) -> str:
    return _ANSI_RE.sub("", raw.replace("\r\n", "\n").replace("\r", "\n"))


def _fmt_sec(raw: str) -> str:
    if raw in {"", "n/a", "unknown"}:
        return "n/a"
    try:
        return f"{float(raw):.3f}s"
    except ValueError:
        return "n/a"


def _parse_counts_and_durations(
    mode: str, lines: list[str]
) -> tuple[dict[str, int] | None, int, list[str], list[tuple[str, str, int]]]:
    counts: dict[str, int] | None = None
    did_not_run = 0
    if mode != "playwright":
        summary_idx = next(
            (
                i
                for i in range(len(lines) - 1, -1, -1)
                if _PYTEST_SUMMARY_RE.match(lines[i].strip())
            ),
            None,
        )
        if summary_idx is not None and (
            m := _PYTEST_SUMMARY_RE.match(lines[summary_idx].strip())
        ):
            counts = {"passed": 0, "skipped": 0, "failed": 0, "errors": 0, "xfailed": 0}
            for num_raw, kind in _PYTEST_COUNT_RE.findall(m.group(1)):
                k = "errors" if kind in {"error", "errors"} else kind
                if k in counts:
                    counts[k] += int(num_raw)

    durations: list[str] = []
    dur_start = next(
        (
            i + 1
            for i in range(len(lines) - 1, -1, -1)
            if (b := _PYTEST_BANNER_RE.match(lines[i].strip()))
            and re.fullmatch(
                r"slowest(?:\s+\d+)?\s+durations", b.group(1), re.IGNORECASE
            )
        ),
        None,
    )
    if dur_start is not None:
        for ln in lines[dur_start:]:
            if _PYTEST_BANNER_RE.match(ln.strip()):
                break
            if dm := _PYTEST_DURATION_LINE_RE.match(ln):
                durations.append(f"{dm.group(1)} {dm.group(2)} {dm.group(3)}")

    if mode == "playwright":
        last_pw = next(
            (
                i
                for i in range(len(lines) - 1, -1, -1)
                if _PLAYWRIGHT_COUNT_RE.match(lines[i])
                or _PLAYWRIGHT_FATAL_ERROR_RE.match(lines[i])
            ),
            None,
        )
        if last_pw is not None:
            pw = {"passed": 0, "skipped": 0, "failed": 0, "errors": 0, "xfailed": 0}
            for i in range(last_pw, -1, -1):
                ln = lines[i]
                if fm := _PLAYWRIGHT_FATAL_ERROR_RE.match(ln):
                    pw["errors"] += int(fm.group(1))
                elif pm := _PLAYWRIGHT_COUNT_RE.match(ln):
                    num, kind = int(pm.group(1)), pm.group(2)
                    if kind == "did not run":
                        did_not_run += num
                    elif kind in {"failed", "timed out"}:
                        pw["failed"] += num
                    elif kind == "interrupted":
                        pw["errors"] += num
                    elif kind in {"passed", "skipped"}:
                        pw[kind] += num
                elif not _PLAYWRIGHT_SUMMARY_DETAIL_RE.match(ln):
                    break
            counts = pw

    pf_header = (
        next(
            (
                i
                for i in range(len(lines) - 1, -1, -1)
                if lines[i].startswith("自检汇总（exit=")
            ),
            None,
        )
        if mode == "preflight"
        else None
    )
    pf_steps = (
        [
            (sm.group(1), sm.group(2), int(sm.group(3)))
            for ln in lines[pf_header + 1 : pf_header + 8]
            if (sm := _PREFLIGHT_STEP_RE.match(ln.strip()))
        ]
        if pf_header is not None
        else []
    )
    return counts, did_not_run, durations[:20], pf_steps


def build_summary_lines(
    *,
    mode: str,
    project: str,
    exit_code: int,
    queue_wait_s: str,
    sync_s: str,
    total_s: str,
    vm_summary: str,
    raw_output: str,
    playwright_artifacts: str = "",
) -> list[str]:
    lines = _clean_output(raw_output).splitlines()
    metric = dict(
        tok.partition("=")[::2]
        for ln in lines
        if ln.startswith("EPP_METRIC ")
        for tok in ln[11:].split()
        if "=" in tok
    )
    counts, did_not_run, durations, pf_steps = _parse_counts_and_durations(mode, lines)
    top_slow = list(durations)
    if not top_slow and pf_steps:
        active = sorted(
            ((s, n, st) for n, st, s in pf_steps if st != "跳过"), reverse=True
        )
        top_slow = [f"{s}s {n} ({st})" for s, n, st in active[:5]]

    counts_str = (
        f"passed={counts['passed']} skipped={counts['skipped']} failed={counts['failed']} errors={counts['errors']} xfailed={counts['xfailed']}"
        + (f" did_not_run={did_not_run}" if did_not_run > 0 else "")
        if counts is not None
        else "passed=n/a skipped=n/a failed=n/a errors=n/a xfailed=n/a"
    )
    baseline_gate_line = next(
        (
            ln.strip()
            for ln in reversed(lines)
            if ln.strip().startswith("[baseline-gate] ")
        ),
        None,
    )
    db_clone_disp = _fmt_sec(metric.get("db_clone_s", "n/a"))
    db_clone_max = _fmt_sec(metric.get("db_clone_max_s", "n/a"))
    db_clone_count = metric.get("db_clone_count", "")
    if (
        db_clone_disp != "n/a"
        and db_clone_count.isdigit()
        and int(db_clone_count) > 1
        and db_clone_max != "n/a"
    ):
        db_clone_disp = f"{db_clone_disp}(max={db_clone_max},n={db_clone_count})"

    out = [
        f"[remote-test] {'PASS' if exit_code == 0 else 'FAIL'}",
        f"  mode: {mode}",
        f"  project: {project}",
        f"  exit_code: {exit_code}",
        f"  vm_budget: {vm_summary or 'n/a'}",
        f"  timings: queue_wait={_fmt_sec(queue_wait_s)} sync={_fmt_sec(sync_s)} db_prep={_fmt_sec(metric.get('db_prep_s', 'n/a'))} exec={_fmt_sec(metric.get('test_exec_s', 'n/a'))} total={_fmt_sec(total_s)}",
        f"  db: db_mode={metric.get('db_mode', 'unknown')} template_status={metric.get('template_status', 'unknown')} db_container={_fmt_sec(metric.get('db_container_s', 'n/a'))} template_s={_fmt_sec(metric.get('template_s', 'n/a'))} db_clone={db_clone_disp}",
        f"  counts: {counts_str}",
    ]
    if baseline_gate_line:
        out.append(f"  baseline_gate: {baseline_gate_line}")
    if pf_steps:
        out.append(
            "  preflight_steps: "
            + ", ".join(f"{n}={st}({s}s)" for n, st, s in pf_steps)
        )
    out.extend(
        ["  top_slow:", *(f"    - {x}" for x in top_slow)]
        if top_slow
        else ["  top_slow: n/a"]
    )
    if exit_code != 0:
        replay = [
            ln
            for ln in lines
            if not ln.startswith("EPP_METRIC ") and not _SSH_CLOSED_RE.match(ln.strip())
        ]
        out.append("--- failure diagnostics ---")
        if playwright_artifacts:
            out.append(f"Playwright artifacts: {playwright_artifacts}")
        out.extend(replay or ["(no output captured)"])
    return out


def format_summary_cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="remote-test-metadata.py format-summary")
    for flag in (
        "--mode",
        "--project",
        "--queue-wait",
        "--sync-seconds",
        "--total-seconds",
        "--vm-summary",
        "--playwright-artifacts",
    ):
        parser.add_argument(flag, default="")
    parser.add_argument("--exit-code", type=int, required=True)
    parser.add_argument("--output-log", type=Path, required=True)
    parser.add_argument("--summary-out", type=Path, default=None)
    ns = parser.parse_args(argv)
    raw = (
        ns.output_log.read_text(encoding="utf-8", errors="replace")
        if ns.output_log.is_file()
        else ""
    )
    lines = build_summary_lines(
        mode=ns.mode,
        project=ns.project,
        exit_code=ns.exit_code,
        queue_wait_s=ns.queue_wait or "0.000",
        sync_s=ns.sync_seconds or "0.000",
        total_s=ns.total_seconds or "0.000",
        vm_summary=ns.vm_summary,
        raw_output=raw,
        playwright_artifacts=ns.playwright_artifacts,
    )
    rendered = "\n".join(lines) + "\n"
    if ns.summary_out is not None:
        ns.summary_out.write_text(rendered, encoding="utf-8")
    sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    try:
        command, *args = sys.argv[1:]
        if command == "snapshot":
            snapshot(Path(args[0]), args[1])
        elif command == "estimate":
            estimate(Path(args[0]), *args[1:])
        elif command == "queue-run":
            if "--" not in args:
                sys.exit("Expected -- before command for queue-run")
            sep = args.index("--")
            if sep != 3:
                sys.exit("Expected queue-run <queue> <timeout> <label> -- <command...>")
            sys.exit(queue_run(args[0], args[1], args[2], args[sep + 1 :]))
        elif command == "cache-lookup":
            if "--" in args:
                sep = args.index("--")
                mode_arg, extra_args = args[0], args[sep + 1 :]
            else:
                mode_arg, extra_args = args[0], args[1:]
            sys.exit(cache_lookup(mode_arg, extra_args))
        elif command == "cache-prepare":
            if "--" in args:
                sep = args.index("--")
                out_arg, mode_arg, extra_args = args[0], args[1], args[sep + 1 :]
            else:
                out_arg, mode_arg, extra_args = args[0], args[1], args[2:]
            cache_prepare(Path(out_arg), mode_arg, extra_args)
        elif command == "cache-store":
            summary_arg: Path | None = None
            pos_args = args
            if len(args) >= 6 and args[4] == "--summary":
                summary_arg = Path(args[5])
                pos_args = args[:4]
            cache_store(
                Path(pos_args[0]),
                pos_args[1],
                pos_args[2],
                Path(pos_args[3]),
                summary_path=summary_arg,
            )
        elif command == "format-summary":
            sys.exit(format_summary_cli(args))
        else:
            sys.exit(
                "Expected snapshot, estimate, queue-run, cache-lookup, cache-prepare, cache-store or format-summary"
            )
    except (
        OSError,
        ValueError,
        ArithmeticError,
        KeyError,
        subprocess.CalledProcessError,
    ) as exc:
        sys.exit(f"Remote test metadata: {exc}")
