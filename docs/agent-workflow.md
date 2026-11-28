# Agent 检查与异步合并

NERE-272 试行此流程，NERE-277 明确沿用；Mika 更新「全栈开发」指令前，其他正在进行的 M4.1 子 issue 继续按原流程交付。本文件不修改任何 agent 的配置或指令。

## 检查与测试

本机只做代码风格、类型检查和构建，不跑 pytest 和 Playwright，也不为跑测试在本机起数据库或后端；每次 push 前执行：

```bash
uv sync --all-packages --frozen
bun ci
(cd backend && uv run bash scripts/lint.sh)
(cd frontend && bunx biome check --no-errors-on-unmatched --files-ignore-unknown=true ./)
(cd frontend && bunx tsc --noEmit && bun run build)
uv run prek run --from-ref origin/master --to-ref HEAD
```

改动涉及的 pytest、相关 Playwright spec 和 push 前自检，统一通过 `scripts/remote-test.sh` 在共享 GCP 测试机上运行。每次先在仓库根目录设置 `export COMPOSE_PROJECT_NAME=nere<编号>`，具体配置、并发和参数用法见 [共享云端测试机](cloud-testing.md)：

```bash
export COMPOSE_PROJECT_NAME=nere<编号>
scripts/remote-test.sh pytest <相对 backend/ 的路径> --no-cov -x -q
scripts/remote-test.sh playwright <相对 frontend/ 的 spec> --project=chromium
scripts/remote-test.sh preflight
```

- 选哪些测试：优先运行改动的测试、对应模块的测试、直接引用者和守卫测试（如审计事件 `tests/domains/test_audit_labels.py`、工作流 `tests/test_ci_workflows.py`、变更集/审计/注册表 `tests/admin_assistant/` 等，以及改动页面命中的 Playwright spec）；排查上次失败可加 `--lf`。
- 范围收窄：共享领域模型和契约按本域及变更类型收窄引用者。评测和验收用例分别在直接改动评测或求解相关文件、直接改动验收文件时选中。
- 高风险与迁移：迁移、权限和租户范围、证据协议、凭据发生变化时，只跑改动涉及的测试；迁移仍需验证 `upgrade`、`downgrade` 和单一 Alembic head。
- 退回本机：仅当 `scripts/remote-test.sh` 提示预算已到软上限，或无法连接 GCP 测试机（IAP、认证、实例异常）时，才退回本机运行 `bash scripts/preflight.sh`（须显式设置当前 issue 的独立 `DATABASE_URL` 和 `POSTGRES_PORT`，不能连接默认 `5432` 或其他任务的数据库；`--list` 只列计划，不 fetch 或执行检查），并在结果评论里写明退回原因和脚本原始提示。不用 `--force` 越过预算上限，除非大古明确要求；不手动关闭或重启 GCP 测试机。
- Docker 规则：改了 Dockerfile、`pi/` 或 Compose 使用 Docker，或退回本机跑测试时，仍遵守项目名、端口、磁盘和清理规则。
- CI 边界：全量 pytest、全部 Playwright、Compose 和生产安装测试仍交给必需 CI 检查执行，不重复跑。

## Push、自审与自动合并

1. 检查通过后 push，创建指向 `dev` 的 **Draft PR**（`gh pr create --base dev --draft ...`，标题以子单编号开头）。PR 描述列出验证、假设、依赖及许可证；CI 改动单独列出。**`OP·Dev` 在开发及门禁 1 阶段严禁提前开启 `--auto` 或执行 `gh pr ready`**，以便 Draft PR 期间跳过全套 CI、避免无效并发。
2. 立即用 `ponytail-review` 审查完整改动和关联代码，不等 CI。Must fix 全部修好、验证并 push 后才继续。高风险改动仍逐项检查迁移、证据只追加、跨租户/越权测试、凭据保密和已有检查完整性。Should fix / Nice to have 记入结果评论。
3. 用 `"$MULTICA_CLI_PATH" issue pull-requests <子issue> --output json` 确认 PR 已关联。记录当前 head SHA，并在子单发交付评论后移入「门禁1审查」，由 `OP·Reviewer` 执行纯只读审查。
4. 门禁 1 批准并移入「待合入dev」列后，由 `OP·Leader` 严格按以下**「转 Ready 后不开 `--auto`，异步核验全绿再直合」零竞态规程**放行合入（只对当前子单创建的 PR 执行，不用 `--auto` 或 `--admin`，不直接 push `dev`/`master`，不 force push）：
   1. 核对当前 `headRefOid` 与 `OP·Reviewer` 批准的 40 位 SHA 一致，且 `isDraft=true`、`autoMergeRequest=null`、`mergeable=MERGEABLE`（`gh pr view <PR> --json headRefOid,isDraft,autoMergeRequest,mergeable,mergeStateStatus`）；
   2. 记录当前 UTC 时间戳（`ready_utc`）及 `<SHA>` 上既有 Draft `check-runs` 的 `id` 基线，随后执行 `gh pr ready <PR>`；
   3. 执行**有界短时核验**（最多 30 秒、每 3 秒查一次 `gh run list --commit <SHA>` 与 `gh api repos/{owner}/{repo}/commits/<SHA>/check-runs`，严禁同步等 CI 跑完），确认**全部 6 个 workflow** 均已在 `ready_utc` 之后为 `<SHA>` 启动新一轮 `pull_request` run：
      - 6 项入口必需检查（`changes`、`Run zizmor`、`test-pi`、`pre-commit`、`test-docker-compose`、`test-production-install`）已生成新非 `skipped` `check-run`（`id` 不在旧 Draft 基线内且晚于 `ready_utc`）；
      - `Test Backend` 与 `Playwright Tests` 均已启动新一轮 `pull_request` run；
      - **严禁在此时开启 `gh pr merge --auto`**：`test-backend`、`test-playwright` 为下游 `needs:` 聚合门禁，在所有上游分片结束前不会创建新 `check-run`，期间提交上仍残留旧 Draft `skipped` 记录；若此时开启 `--auto`，当其余 6 项入口检查先完成时 GitHub 分支保护会将旧 `skipped` 视为通过，触发跳过分片的提前误合入；
      - 若满 30 秒仍有 workflow 未启动，改查 `gh run list --commit <SHA>` 排查或上报；
   4. 确认上述全部 6 个 workflow 新 run 已启动后，直接进入第 5 步登记 `--until-pr checks` 异步唤醒并结束本轮（保护不要求 strict，不为单纯落后 `dev` 而重复合并；但凡后续需改代码，必须按第 6 步退回重走门禁 1 审查，严禁未经复审的 SHA 合入）。
5. 用已核实的条件参数注册下一次运行，然后结束当前运行，不执行 `gh pr checks --watch`：

   ```bash
   "$MULTICA_CLI_PATH" issue wakeup create <子issue> \
     --until-pr checks --expires-in 2h --on-timeout wake \
     --parent <结果评论ID> \
     --instruction "唤醒后核验 6 个 workflow 均已完成且全部 8 项必需检查为本轮 Ready 后的真实 success，再执行 gh pr merge <PR> --merge --match-head-commit <SHA> 直接合入（不使用 --auto 或 --admin）；若 CI 失败或有冲突需改代码，执行 gh pr ready <PR> --undo 恢复 Draft 后退回开发中（started_8）。"
   "$MULTICA_CLI_PATH" issue wakeup list <子issue> --output json
   ```

   条件只观察本 issue 直接关联的 PR；缺失链接或 GitHub snapshot 会记入 `last_error` 后重试。它只等待注册之后完成的新结果，不能拿它等待已经完成的检查；注册前若发现检查已完成，当前运行直接处理结果。多个 PR 时须核对实际触发的 PR 和 head，不能把旧 PR 的成功当作新 PR 的结果。
6. 唤醒后读取 issue、评论、规则和当前 PR 的所有 checks 与 workflow runs，记录触发时间与结果：
   - 尚有运行中检查或下游门禁未出齐：若仍有 workflow/job 处于运行态，或 8 项必需检查中任一项尚未生成晚于 `ready_utc` 的新记录，重新登记 `--until-pr checks` 后退出；超时唤醒则检查是否卡住，说明原因，必要时 blocked 并提及技术规划。
   - 全部 8 项必需检查本轮真实成功：逐项核对 `changes`、`test-playwright`、`test-backend`、`test-docker-compose`、`test-production-install`、`test-pi`、`pre-commit`、`Run zizmor` 均满足「属于当前 PR 与已批准 40 位 SHA、`id` 不在旧 Draft 基线、晚于 `ready_utc`、`status == completed`、`conclusion == success`」（非必需 `playwright-shard` 因路径过滤合法 `skipped` 不受影响），且当前无运行中 workflow、`headRefOid` 仍等于批准 SHA，随后执行：

     ```bash
     gh pr merge <PR> --merge --match-head-commit <SHA>
     gh pr view <PR> --json state,mergedAt,mergeCommit,headRefOid
     ```

     确认 `state=MERGED` 及子单已自动关闭（未自动关闭则手动移至 `done`）；严禁 `--admin`。
   - 有失败或冲突需改代码：读取 `gh run view <run-id> --log-failed`。如存在误开的 `autoMergeRequest` 则先 `gh pr merge <PR> --disable-auto`，执行 `gh pr ready <PR> --undo` 恢复 Draft 并退回「开发中」（`started_8`）；由 `OP·Dev` 追加新 commit（若与 `origin/dev` 冲突则先 fetch 并 merge 最新 `origin/dev`，严禁 rebase / force push；同一子单最多修 3 轮，不删除、跳过或放宽检查）、完成复验与自审后重进「门禁1审查」（`1`），待 `OP·Reviewer` 批准新的 40 位 SHA 后再由 `OP·Leader` 重走第 4 步。若为与本次改动无关且已在本地/云端验证通过的偶发失败（无需改 HEAD），仍允许执行 `gh run rerun <run-id> --failed` 一次并重挂 `--until-pr checks`。
   - 已合并：确认 issue 已 done。成功路径无需另启运行回复 SHA，技术规划在阶段核对时读取关联 PR 的合并信息；还有本 issue 明确要求的验收事项（例如提速测量）时，仍需完成后再 done。

### 条件唤醒的边界

`--until-pr checks` 依赖平台定期检查，新规程不再在 CI 完成前开启 `--auto`，统一由 `--until-pr checks` 唤醒后核验全部 8 项必需检查均为本轮 Ready 后的真实 `success`，再直接执行 `gh pr merge <PR> --merge --match-head-commit <SHA>` 合入，彻底消除下游聚合门禁 `skipped` 残留导致的误合入竞态。平台关闭 issue 会禁用 wakeup，因此必须记录实际的 `wakeup runs`，不能把「已注册」写成「已唤醒」；不能靠反复计时轮询 PR 取代条件。

## 合并后 master CI

技术规划在阶段核对时检查 master 最新提交的 push workflow，失败则处理；PR 分支保护保证合并前检查通过。不为成功路径另建 master CI 定时唤醒，因为自动关单同样会禁用它。PR 条件观察的是 PR head 的检查，不能用它冒充 master 合并提交的检查。`pre-commit` 在 PR 与 `push` 到 `master`/`dev` 上均会运行。

## CI 门禁与并行边界

`master` / `dev` 必需检查名：`changes`、`test-playwright`、`test-backend`、`test-docker-compose`、`test-production-install`、`test-pi`、`pre-commit`、`Run zizmor`。全部 6 个 workflow 均无顶层 `paths` / `paths-ignore` 过滤：`pull_request` 明确声明 `types: [opened, synchronize, reopened, ready_for_review]` 并在全部 job 上施加 Draft 守卫（`github.event_name != 'pull_request' || github.event.pull_request.draft == false`），使 Draft PR 期间跳过实际执行（`skipped`），转 Ready 后正常触发全套检查；`push` 到 `master`/`dev` 与 `workflow_dispatch` 则通过短路无条件照常执行。Playwright 保留 job 级路径过滤，汇总门禁 job（`test-backend`、`test-playwright`）通过 `always()` 叠加 Draft 守卫，保证非 Draft PR 与 `push` 下任一 shard 失败或取消时必定报错拦截。

Playwright 分 3 个独立 runner，每个有自己的 Compose 网络、数据库和报告；每个 shard 仍用 1 worker。检查发现 admin-account-actions、admin-roles、admin-accounts、employees、approval-policy、drafting-settings 等使用共用演示企业，不能让同一数据库中的多个 worker 并发修改。已有 setup 和 admin-account-actions 的 serial 分组保留，不新增 serial 标记，不改变重试或 flaky 检查。

Docker 使用 SHA 固定的 Docker 官方 setup-buildx / bake action，为各 workflow 的 backend、pi 镜像配置 `type=gha` 导入与导出缓存。Bake 加载本地镜像，Playwright 与普通 Compose 验证用 `up --no-build` 复用它们。Playwright 浏览器在 runner 上安装 Chromium，直接测试容器里的后端及已构建的前端；不再构建和导出大型浏览器镜像。本地 Compose 的 playwright 服务保留。生产安装脚本仍执行原来的 Compose 构建和验证，并复用当前 Buildx builder。首次 PR 缓存可能为空；合并后 master 的 push 运行建立后续 PR 可读取的缓存。生产安装仍现场生成真实测试配置，缓存预热只使用合成的 Compose 解析占位值。

backend 在 coverage 启动前用 `uv sync --all-packages --frozen --compile-bytecode` 编译依赖，避免真实飞书 SDK 的大量模块在覆盖率跟踪期间首次编译。M2 的模拟 Jira 使用一个上下文内的 TestClient，复用 ASGI portal；同步、分页、失败重试、迁移和证据断言均保留。测量见 [CI 提速记录](ci-performance.md)。

backend 使用 pytest-split 的 `least_duration` 算法，按仓库中 `backend/.test_durations` 的历史耗时分成 3 片，各片保留 xdist loadgroup；新增用例按已知用例的平均耗时估算。各片上传 coverage、JUnit 和最新耗时；刷新基线时合并三份 `test-durations-*.json` 后提交。必需检查 `test-backend` 在所有分片成功后合并三份 coverage，仍要求总覆盖率 90%，任一片失败、取消或跳过都失败。

roster 性能函数的 6 个参数场景（包括两个 5000 行 XLSX）从带 coverage 的 xdist 阶段分离，在第 1 片内用 `-n 0 --no-cov` 运行。2 秒断言保持不变，其结果也计入必需检查。

分支保护要求 PR 和全部门禁，不要求人工 review；禁止 force push 和删除，保留 GitHub 默认的管理员 bypass，但 agent 不使用。strict 关闭，避免并行 PR 每合并一次就使其他分支重跑；合并后的 master CI 兜底。
