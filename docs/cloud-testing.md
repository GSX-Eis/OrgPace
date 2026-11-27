# 共享云端测试机

在仓库根目录运行 `scripts/remote-test.sh`，可把自检和指定用例交给共享 GCP 测试机。首次配置需要本机的 Bash、Python 3.11+、Git、rsync 和已认证的 Google Cloud CLI，以及目标实例的 IAP SSH 权限。测试机需要 Docker Compose（支持 `!override`）、uv、Bun、Playwright Chromium、ripgrep、ShellCheck，以及已部署的共享租约和空闲关机脚本。

## 本机配置

将以下模板填入 `~/.config/employee-profile-platform/cloud-runner.env` 并设置权限为 `600`。脚本会加载这个受信任的本机 Bash 文件。也可直接导出同名环境变量，环境变量优先。

```bash
GCP_PROJECT=your-gcp-project
GCP_ZONE=your-zone
GCP_INSTANCE=your-instance
MONTHLY_BUDGET_USD=40
SOFT_CAP_USD=36
DISK_FIXED_MONTHLY_USD=10
SPOT_HOURLY_RATE_USD=0.161
# USAGE_LEDGER_FILE=~/.config/employee-profile-platform/cloud-runner-usage.jsonl
```

按共享机配置填写 Spot 估算单价。省略 `SOFT_CAP_USD` 时按月预算的 90% 计算。配置文件与台账应保存在本机。

## 常用命令

```bash
export COMPOSE_PROJECT_NAME=nere123  # 替换成当前 issue 编号
scripts/remote-test.sh status
scripts/remote-test.sh preflight
scripts/remote-test.sh preflight --baseline-gate
scripts/remote-test.sh pytest tests/api/routes/test_utils.py --no-cov -x -q
scripts/remote-test.sh playwright tests/login.spec.ts -g 'Log in with valid email and password' --project=chromium
scripts/remote-test.sh --force preflight
bash scripts/test-remote-test.sh
```

`pytest` 的路径相对于 `backend/`，Playwright 的路径相对于 `frontend/`。远端 `pytest` worker 并发数受本机弹性名额队列注入的 `CLOUD_TEST_QUEUE_SLOTS` 严格约束：

- **走 `cloud-test-queue`（`slots-v1`）时**：无论 `preflight` 自动计算并发还是显式传入 `PREFLIGHT_PYTEST_WORKERS`、`pytest -n <N>` / `-n auto` / `--numprocesses=<N>`，远端 worker 都会将实际并发收敛至 `<= CLOUD_TEST_QUEUE_SLOTS`，确保 EPP 拿到 1–4 个槽位时不会在共享 VM 上超开 worker 挤爆并发中的量化任务。
- **未安装 `cloud-test-queue` 退回旧独占锁时**：仍按宿主机 vCPU 与量化租约探测自动选择并发（8 vCPU / 16 vCPU+ 独享默认 8 worker，检测到外部未排队量化租约时降为 4 / 6 worker），也可用 `PREFLIGHT_PYTEST_WORKERS=1` 至 `16` 显式指定。

预检命中超过 30% 的后端测试文件时，仅运行直接改动、对应单测和守卫。用 `scripts/remote-test.sh preflight --full` 或 `PREFLIGHT_FULL_PYTEST=1` 保留完整的预检选择；用 `scripts/remote-test.sh preflight --baseline-gate` 或 `PREFLIGHT_BASELINE_GATE=1` 开启 Node ID 哈希棘轮门禁（校验 `backend/tests/baseline_failures.json` 与独立收集/执行证据，防止删测、skip 绕过与 worker 吞结果；CI `test-backend` 全量门禁默认全片开启）。Playwright 复用 Compose 后端、worker 和 mock Jira，通过 VM 上的 Chromium 跑单 worker。失败时终端会显示本机临时报告目录，可在其中打开 `report/index.html` 或用 Playwright 查看 `test-results/` 里的 trace。

本机默认启用内容寻址共享结果缓存（`~/.cache/cloud_test_results/epp/`，默认 TTL 24 小时，可用 `CLOUD_TEST_CACHE_TTL_HOURS` 覆盖）。仅缓存 `exit == 0` 的通过结果，缓存键绑定过滤后的工作区内容树 SHA、归一化命令与语义环境变量（`preflight` 额外绑定 `origin/master` SHA 与 `PREFLIGHT_FULL_PYTEST` / `PREFLIGHT_BASELINE_GATE`），不绑定分支名、worktree 路径或 `COMPOSE_PROJECT_NAME`，可在排队与唤醒 VM 之前直接 0 秒命中。含 `@external-mcp`、`chatgpt_live`、`--count`、`--repeat` 等非确定性/有状态参数时自动绕过；传入 `--no-cache` 或设置 `CLOUD_TEST_NO_CACHE=1` 可强制重跑。IAP SSH 默认在 `~/.cache/cloud_test_ssh/`（权限 `700`）启用 `ControlMaster=auto` + `ControlPersist=10m` 连接复用。

共享云端与 GitHub Actions 的 Playwright 环境会显式开启 `PLAYWRIGHT_FIXTURES_ENABLED=true`，用来构造合成的历史协作需求。开发者直接运行相关浏览器测试时，可在隔离的开发测试后端启动前设置同一个开关。开关默认关闭。

### 跨项目弹性名额队列（`slots-v1`）与量化并发规则

- **队列入口与回退**：`scripts/remote-test.sh` 优先调用本机通用调度器 `~/.local/bin/cloud-test-queue --queue "$GCP_INSTANCE" --project epp --kind "$mode" --timeout "$queue_timeout" --label "epp:$project:$mode"`（可用 `CLOUD_TEST_QUEUE_BIN` 覆写路径；仅当本机未安装 `cloud-test-queue` 时回退至旧 `remote-test-metadata.py queue-run` 独占锁）。
- **槽位配置（`~/.config/cloud-test-queue/<GCP_INSTANCE>.json`）**：共享机总容量 `8` 槽位（`e2-standard-8`），EPP 预配弹性名额为 `default` / `playwright` `1–2` 槽位、`pytest` `1–4` 槽位；量化仓默认 `4–8` 槽位（`--all` 全量门禁固定独占 8 槽位）。只要空闲槽位满足 `min_slots`，EPP 与量化即可在 `quant-test-runner` 上安全并发运行（队列底层使用内核 `flock`，进程崩溃或 SSH 断开自动释放槽位）。
- **单次拿锁批跑**：多个相关 `pytest` 目标应合并在一次 `scripts/remote-test.sh pytest <file1> <file2> ...` 调用中批量执行，避免在循环中反复拿锁排队与重复同步工作区；等待超时默认 `900s`（可用 `CLOUD_TEST_LOCK_TIMEOUT` 覆盖，设 `0` 为立即失败返回 `75`），排队期间不建立 SSH/IAP 连接。
- **远端隔离与清理**：每个项目使用 `~/epp-runs/<COMPOSE_PROJECT_NAME>`（与量化仓 `~/quant-test-work` 物理隔离）、单独的数据库和 API 端口，以及 `/usr/local/bin/cloud-test-lease-run.sh epp-<COMPOSE_PROJECT_NAME>` 共享租约。第二套环境使用 `-review` 后缀。同步和执行都在项目锁内进行。遇到同项目正在运行或同步快照被另一进程替换时，等待对方完成后重试。测试结束时清理本次 Compose 容器和卷，保留镜像与构建缓存。

工作区通过 IAP 增量同步，包含已跟踪文件和 Git 未忽略的新文件，跳过依赖目录、常见凭据路径和环境文件，保留 `.env.example`。自检从公开的 `origin/master` 和过滤后的 Git 补丁重建已提交及暂存改动，再检测当前工作区。请确保 Git 未忽略的新文件也只包含可上传的代码和合成数据。测试设置在 VM 上生成，浏览器通过后端同源访问测试 UI。

## 预算和共享约定

`status` 显示实例状态、VM 上的活跃租约及本机台账估算的 UTC 当月开机时长与费用。台账按观测到的 VM 开关机区间计入共享时长，同一次开机连续跑多个测试只计一次。两次观察之间完全错过的开机区间可能缺失，费用以 GCP 账单和共享预算告警为准。

实例处于 `TERMINATED` 且估算费用达到软上限时，脚本会提示回退本机。明确要覆盖时使用命令最前面的 `--force`。已经运行的实例仍可执行测试。测试结束后只释放自己的租约，请避免手动关闭共享机。VM 会等所有项目空闲后自行关机。
