# ADR-0046：Agent / Planning / Capacity 三层职责与周级容量

状态：采用（NERE-637 M7 规划、NERE-691，2026-11-16）。依据：E27、E31、E32、D2。
本决策规定 M7～M9 的分层、容量和隐私契约；取代 [ADR-0045](0045-capacity-module.md) 中经理确认值的负荷口径。

## 背景

容量数据用于判断能否作出承诺，候选方案需要能模拟、校验和比较。
建议、模拟和真实分配必须分开，避免助手把建议当成承诺，或把没有确认的数据当成空闲。

## 三层职责与依赖

| 层 | 位置 | 职责 | 写入边界 |
| --- | --- | --- | --- |
| Agent | `domains/bot`、`mcp` | 按调用人身份读取、调用 Planning 模拟、提出方案和确认卡 | 只提方案，不改资源；不能调用创建分配、改完成日期、批准延期等承诺写入 |
| Planning | `domains/planning/` | 保存 PlanningCase、快照和候选方案，校验、模拟、比较 | 不写任何 `capacity_*` 表，不宣布方案生效 |
| Capacity | `domains/capacity/` | 管理需求、周级容量、分配和审批，落实批准后的安排 | 承诺写入时重新检查权限、在职、能力、容量和版本 |

Planning 与 Capacity 之间只允许 Planning → Capacity 的只读依赖：
读取 `models`、`calendar` 和 `demand` 中的读取函数，不能调用 `demand` 的写函数，
不能依赖 `assignment`、`workload`、`extension` 等写入模块；Capacity 不能 import Planning。
S5a 的架构测试检查两个方向；只读模拟测试比较调用前后的全部 `capacity_*` 表和审计表，必须完全相同。
Capacity 对画像只读，画像代码不依赖 Capacity；沿用 ADR-0045 的边界。

M7 用 Python 规则和枚举实现模拟。未来求解器只作为 Planning 调用的一个工具（E27），
不获得真实分配的写入权。候选方案通过校验也不构成批准或真实承诺。

## 周级容量口径

- 周是周一开始的自然周，`week_start` 为周一的日期；「本周」按企业时区的今天计算。
- 每人每周一条「平台外其他工作占比」`other_percent`，范围 0–200%，允许如实记录超负荷。
- 当周可用 = 100% × 当周未被不可用日期覆盖的工作日数 / 5。
  工作日仅为周一到周五，不引入节假日日历；重叠的不可用日期不重复扣减，不保存原因。
- 当周占用 = `other_percent` + 与当周有重叠的进行中分配的 `allocation_percent` 之和。
  分配即使只重叠一天也按整周计算，不按天折算；已完成或已取消的分配不计入。
- 没有当周记录为 `unconfirmed`（「未确认」），不能当成零或显示「有空」。
  有记录且在 28 天内确认过为 `confirmed`；超过 28 天为 `stale`（「需重新确认」）。
  员工有待审修正申请时另标 `correction_pending`，申请值不替代已确认值。
- Jira 未解决任务件数仍只是参考，不换算成比例；不用工时（D2、计划书 §1.4）。
  负荷不用于绩效，不打分、不排名，不提供按负荷高低排序。

`capacity_week` 按 `(org_id, employee_id, week_start)` 唯一，保留确认人和确认时间。
不可用日期记录在 `capacity_unavailability`；分配使用开始和结束日期。
周记录、不可用日期和分配均带租户上下文，权限沿用服务端 Principal 与现有策略，不扩大管理员权限。

### 旧数据迁移

旧 `capacity_workload` 的每条记录只迁入其 `updated_at`（UTC）所在的那一周，
保留该时间为 `confirmed_at`、原修改人为确认人；之后的周不补值，显示「未确认」。
界面可展示上次确认的值和日期，经理明确确认后才写入新一周；迁移后删除旧表。
downgrade 按每人最新一周重建旧表，会丢失按周明细，迁移文件必须说明此损失。

旧分配的 `start_date` 保持为空，不能凭截止日期或创建时间推断真实开始日期。
仅计算占用时，保守地从 `created_at` 所在周算到 `due_date`，标记「开始日期未确认」，由 B 方经理补充。
旧待审修正申请没有周范围，批准时只作用于批准当天所在的那一周。

## 写入与并发规则

记录现实的写入（周值、不可用日期）不拦超额，返回结果标明超额，仍须检查权限。
做承诺的写入包括创建分配、修改完成日期、补充或修改开始日期、批准延期，必须统一校验：

1. 权限和版本有效；员工仍在职且在目标部门范围内。
   员工离职后，B 方经理只可取消其进行中分配，其他写入仍拒绝。
2. 员工在达到 `minimum_level` 的需求依据中，能力校验通过；
   不在依据中的本部门在职员工，必须显式确认 `outside_basis: true`，否则返回 409。
   审计记录该确认，不修改画像。
3. 新分配必须填写 `start_date`，不早于需求的承诺开始日期，且不晚于 `due_date`。
   `[start_date, due_date]` 涉及的每一周都要重新检查：未确认、需重新确认或占用超过当周可用均返回 409，
   列出需确认或超额的周及超出比例，没有越过校验的开关；更新已有分配时不重复计入自身。
4. 先锁需求，再用 `SELECT … FOR UPDATE` 锁员工行，在同一事务内重新计算占用并写入。
   同一员工同一周的并发承诺串行校验，后到者看到前者写入的占用；周值和不可用日期写入只锁员工，不反向锁需求。

## 方案状态与过期

方案结论为 `feasible`（可行）、`conditional`（有条件可行）、`infeasible`（不可行）、
`insufficient_data`（数据不足）。组合问题按「不可行 > 数据不足 > 有条件可行 > 可行」取最严重结论。
能力不达标、离职或超额为不可行；未确认或需重新确认的周为数据不足；
需需求方接受新日期、缩小范围，或需借调同意等条件尚未满足时为有条件可行。

快照只存计算所需的需求、候选人、周容量、分配、不可用日期及规则字段，不存画像陈述或证据正文。
指纹涵盖需求 revision、候选人周记录的值和确认时间、不可用日期、进行中分配的 id / 日期 / 比例 / 状态、
在职状态和候选人已发布的判断。读取时重新计算指纹，数据变化则返回 `stale: true`，不改写原方案。
例外：若旧快照中的候选人已离职或调出调用人当前 `employee_scope_clause(principal)` 可见范围，
`GET /cases/{case_id}` 返回 409，提示重新模拟，不返回旧明细；历史快照和方案仍保留。
过期是独立于四种结论的标记；在过期快照上新增方案返回 409「数据已变化，请重新模拟」。
不使用触发器或后台过期任务。

## 隐私与调用身份

A 方是提需求的一方，只能看到 B 方的部门级结论（E31），不能取得姓名、工号、画像、
个人负荷、分配名单或负荷分档。Planning 快照和方案带有个人数据，
只允许 `represents_department()` 为真的目标部门代表读取；A 方读取返回 404。
所有入口的读取范围都从服务端 Principal 和现有权限策略计算，不能另设助手权限。
Agent 的每个工具按调用人身份过滤，Agent、MCP 或模拟本身均不增加权限。

借调模拟只到部门级，不提供其他部门的人名和余量；匹配少于 3 人时仅写「人数较少」。
模拟结论固定为有条件可行，仍需原部门经理和本人同意；不扩大 E8 的个人数据可见范围。

E32：目标部门匹配少于 3 人（含 0 人）时，答复正文不能写个人负荷。
表单、助手提示和 MCP 说明首先引导只写「能否承接、时间和条件」，关键词校验仅作兜底，
具体词和共用服务端校验由 S2 实现，网页、助手、飞书、MCP 共用。
单独的「未确认」不拦，避免误伤日期等描述；3 人及以上不触发该兜底，已存答复不改。
此阈值不改变 A 方只能取得部门级结论的权限边界。

## 收益、代价与风险

分层让模拟可以验证不改真实分配，承诺在统一写入口按最新数据校验。
按整周计入和缺数据即阻断偏保守；升级后经理须确认后续周，才能继续作出承诺。
28 天的新鲜度不保证现实永远不变；指纹只证明输入未变，不保证候选方案已经获批。
旧数据降级会丢失周明细，旧分配开始日期仍须人工确认。
带人名的持久快照必须持续执行目标部门权限检查，不能因历史读取或工具调用保留额外权限。

## E52 修订：全公司只读可行性评估与灵活规划校验

- Planning 的 `assess_cross_department_feasibility` 和 `POST /planning/feasibility` 在同一企业内读取能力匹配情况、周容量、请假与排期，计算结果不落表。接口与助手只返回部门级承接结论、最早开始日、可行时间窗和整体负荷。试算人数和投入比例只用于内部计算。
- 当需求的 `headcount` / `allocation_percent` 为空时，Planning 默认以基准规模（1 人，按候选可用容量上限取整至多 100%）生成初始方案，部门经理可自由增删人员、调整比例与分段日期，校验器不再强制与需求固定人数/比例一致（仅要求至少一条有效分配行且人选、能力、在职与周容量校验通过）。

### D-070 与 D-072 补充

- 正式排期继续要求逐周确认，且确认时间在 28 天内。跨部门只读评估中，近期与未确认周不直接当成零负荷或无条件空闲（已由 NERE-1316 统一配额弹性模型与远期预测基线架构正式取代 NERE-1315 的「4 周后按暂无排期/0% 返回」过渡逻辑）。
- 跨部门评估沿用容量查询的 26 周上限。按企业时区从本周周一起计，评估时间窗最晚结束于第 26 周周日。原起始日期早于本周时，计算仍将起始日期移到本周并保留原有跨度。超出范围的请求会收到日期校验提示。计入近期基线和后移搜索后，每名员工最多读取 42 周。
- 部门整体负荷与余量按全体在职成员与目标窗周数取均值。单周负荷计入平台外有效负荷、计过一次有效预占的平台负荷与请假占比，单周上限为 200%。
- 公开部门整体负荷与余量至少需要 2 名在职成员（`len(member_weeks) >= 2`）且至少 2 名不同在职成员具备独立原始周负荷记录或经理修正记录（`source_count >= 2`）；`agent_auto` 自动预测与补齐值不计为独立来源。未达门槛时，`load_level` 为 `withheld`，`department_load_percent`、`regular_headroom_percent` 与 `elastic_headroom_percent` 全部置空，并同步抑制 `needs_elastic = False`（隐藏「需动用弹性空间」提示），网页、助手与 IM 标明「整体负荷暂不展示」，仅保留承接结论及已有档期。
- 有能力匹配且个人与部门均无任何确认或预测数据时，诚实返回 `needs_confirmation`，负荷、余量、可用性和日期字段为空。无能力匹配时返回 `cannot_do`，负荷与余量数值为空。单人或双人匹配仍可返回部门级结论。接口、卡片、助手与 IM 回复不得披露员工姓名、员工 ID、匹配人数、个人负荷明细或试算人数和投入比例。

### NERE-1316 修订：统一 70%/30% 配额弹性模型与远期预测基线

- **统一配额与弹性空间**：不拆分「内部/外部」双配额桶。企业在 `capacity_setting.default_allocation_cap_percent` 配置默认建议分配上限（50%–100%，默认 `70`），剩余 `100% - 配额`（默认 `30%`）作为弹性空间。对任一员工周，常规上限 `regular_cap = min(capacity_percent, default_allocation_cap_percent)`，弹性上限 `elastic_cap = capacity_percent`（员工请假使实际可用低于默认配额时自动取较小值）。
- **远期预测基线（`capacity_week_forecast`）**：由 Capacity 层维护滚动 26 周的预测基线，后台周期任务与排期/设置变更时按历史确认负荷均值、在途协作与未闭环 Jira 件数参考（不换算比例、不用工时、不逐人调 LLM）确定性更新 `agent_auto`，且 `ON CONFLICT ... WHERE source = 'agent_auto'` 绝不覆盖经理手动修正 `manager_override`。`calendar.loads()` 仅在 `status != "confirmed"` 时填充 `forecast_*`，生效优先级严格遵循：**正式已确认排期 > 经理手动修正 > Agent 自动预测基线**；正式承诺校验 `shortfalls()` 仍严格要求 `status == "confirmed"`。
- **规划求解两档语义**：`POST /planning/demands/{demand_id}/cases` 默认 `allow_elastic=False`（遵守 `regular_cap` 保护弹性空间）；显式开启 `allow_elastic=True` 时允许突破常规上限至 `elastic_cap`，CP-SAT 对超出常规上限的占用施加惩罚以优先消耗常规余量，并在方案与 `PlanCard` 标注「已占用弹性配额 X%」。当方案任意周超出物理可用上限（`after > elastic_cap`，判为 `over_capacity` / `infeasible`）时，不再累加 `uses_elastic` / `elastic_used_percent`，避免不可行方案错误显示已占用弹性配额。
- **跨部门可行性评估新契约（`assess_cross_department_feasibility`）**：
  - 有效 `other_percent` 严格按 `confirmed > forecast_other_percent > 只读历史均值兜底` 取值；个人与部门均无确认与预测数据时保持 `None`（返回 `needs_confirmation`），严禁将远期未排期直接当成 0% 空闲。后移搜索超出 26 周预测视野（`week_start >= current_week + 26 周`）时，若该周既无正式确认也无显式预测记录，不以近期均值伪标为 `forecast_baseline`，直接保持 `unknown` 并返回 `needs_confirmation`，待目标部门确认。
  - 返回企业配额口径 `allocation_cap_percent`，以及部门级 `regular_headroom_percent`（`max(0, regular_available)` 均值）、`elastic_headroom_percent`（`max(0, elastic_available) - max(0, regular_available)` 均值）、`needs_elastic` 与 `data_source`（`confirmed` / `forecast_baseline` / `mixed` / `unknown`）。
  - 两档窗口判定优先检查常规配额 `regular_available >= need_percent`，不足时再检查弹性上限 `elastic_available >= need_percent`（并标记 `needs_elastic=True`；`load_level == "withheld"` 时同步强制 `needs_elastic=False`，隐去弹性提示），仍不足且未知候选人足以补齐时返回 `needs_confirmation`，否则继续后移搜索（最多 12 周）。
  - `FeasibilityCard`、内置助手与 IM 文本渲染清晰区分「已确认排期 / 预测基线 / 已确认+预测基线」，在 `needs_elastic=True` 且 `load_level != "withheld"` 时明确提示「需动用弹性空间」，并向后兼容历史会话中旧卡片 JSON（忽略已废弃的 `unscheduled_beyond_horizon` 字段，且对历史 `withheld` 卡片同步抑制 `needs_elastic`）。

### NERE-1344 修订：按部门/岗位差异化的负荷预测策略与 Agent 对话动态调参（方案 A）

- **分层预测策略数据模型与约束（`capacity_forecast_policy`）**：
  - 复用现有 `Department` 层级树与 `Employee.job_family`（岗位序列，`max_length=50`，去空白为空时存 `None`），不另建冗余岗位主数据表。表 `capacity_forecast_policy` 继承 `TenantRecord`，通过 `UniqueConstraint("org_id", "department_id", "job_family", name="uq_forecast_policy_scope", postgresql_nulls_not_distinct=True)` 保证同一租户同一作用域唯一。
  - 核心参数：`preset`（`pulse` 脉冲波动型 / `project` 项目延续型 / `cyclical` 周期波动型 / `custom` 自定义策略）、`baseline_percent`（`0..150`）、`near_weeks`（`0..12`，近期惯性延续周数）、`decay_rate`（`0.0..1.0`，超出惯性期后每周指数平滑收敛速率）、`bidirectional_regression`（双向回归开关）、`use_jira_signal`（参考未闭环 Jira 件数开关，仍严守 D2 仅作参考信号、不换算工时，非研发岗位可关闭）、`use_assignment_signal`（结合在途协作/项目截止周开关）、`note`（最长 200 字）。
  - 3 个内置预设模板：
    - `pulse`（脉冲波动型，适合仓储/零售/客服/运营）：`baseline_percent=45`、`near_weeks=1`、`decay_rate=0.8`、`bidirectional_regression=True`、`use_jira_signal=False`、`use_assignment_signal=False`；
    - `project`（项目延续型，适合研发/设计/咨询）：`baseline_percent=70`、`near_weeks=6`、`decay_rate=0.35`、`bidirectional_regression=True`、`use_jira_signal=True`、`use_assignment_signal=True`；
    - `cyclical`（周期波动型，适合财务/运维窗口/周期大促）：`baseline_percent=60`、`near_weeks=2`、`decay_rate=0.5`、`bidirectional_regression=True`、`use_jira_signal=False`、`use_assignment_signal=True`。
- **分层继承优先级与向后兼容**：
  - 对在职员工 `emp`，沿其所属部门祖先链 `[dept, parent, ...]` 自下而上逐层匹配：`(dept, job_family)` > `(dept, None)` > `(parent, job_family)` > `(parent, None)` > … > `(None, job_family)`（全企业岗位级） > `(None, None)`（企业默认） > **隐式向后兼容默认**。
  - 未显式配置任何策略时落入**隐式向后兼容默认**（`baseline_percent = default_allocation_cap_percent`、`near_weeks = 4`、`decay_rate = 1.0`、`bidirectional_regression = False`、`use_jira_signal = True`、`use_assignment_signal = True`），保证未配置企业行为与 NERE-1316 100% 一致。
- **常态基线与配额上限彻底解耦**：
  - `capacity_setting.default_allocation_cap_percent`（50%–100%，默认 `70`）继续定义全企业常规配额上限 `regular_cap = min(capacity_percent, default_allocation_cap_percent)` 与弹性空间 `100% - 配额`（默认 `30%`），排期校验与规划求解语义保持不变；
  - `CapacityForecastPolicy.baseline_percent`（0%–150%）独立定义远期预测基线的常态回归目标，两者互不耦合。
- **双向平滑回归、信号开关与确定性 26 周预测公式**：
  - 历史均值采集继续严守「无历史不捏造」与「同部门兜底须 ≥ 2 名不同在职同事（`len(dept_fresh_emps) >= 2` / `len(dept_stale_emps) >= 2`）」隐私规则；无历史记录员工清理其 `agent_auto` 预测行。
  - 对滚动 26 周（`offset = 0..25`）：
    - `offset < near_weeks`：保持近期均值 `hist_mean`；
    - `offset >= near_weeks`（`steps = offset - near_weeks + 1`）：
      - `hist_mean > baseline`：当启用且命中未闭环 Jira（`use_jira_signal=True` 且 `open_jira >= 5`）或命中在途协作信号（`use_assignment_signal=True` 且 `active_count > 0` 或 `week_date <= min(max_due_week, current + 12w)`（截止周条件仅显式策略生效，隐式默认只看 `active_count > 0`））时 `effective_decay = decay_rate * 0.5`，否则 `effective_decay = decay_rate`；隐式默认保持单步回归 `baseline + (hist_mean - baseline) * (1 - effective_decay)`，显式策略按指数平滑公式 `baseline + (hist_mean - baseline) * ((1 - effective_decay) ** steps)` 收敛；
      - `hist_mean < baseline`：开启 `bidirectional_regression=True` 时按 `baseline + (hist_mean - baseline) * ((1 - decay_rate) ** steps)` 向上平滑回归至常态基线；关闭时保持 `hist_mean`。
  - 严格维持生效优先级：**正式已确认排期（`confirmed`） > 经理单人单周手动修正（`manager_override`） > 策略与事件驱动的自动预测基线（`agent_auto`）**；重算时通过 `ON CONFLICT ... WHERE source = 'agent_auto'` 保护 `manager_override` 与 `confirmed` 不被覆盖。
- **业务波动事件叠加（`capacity_forecast_event`）**：
  - 作用域 `(department_id, job_family)`（`department_id` 非空时覆盖本部门及全部下级部门），字段含 `title`（1–100 字）、`start_week` / `end_week`（均须周一，且跨度不超过 26 周即 `end_week <= start_week + 175` 天）、`modifier_kind`（`multiplier` 系数 `0.0..2.0` / `delta` 百分点 `-100.0..100.0`）、`modifier_value`、`reason`（1–300 字）。
  - 命中当周的生效事件按 `(created_at, id)` 升序先依次乘 `multiplier`、再依次加 `delta`，最终经 `_round_5()` 5% 取整并钳位至 `[0, 200]`。策略或事件的每次保存/更新/删除均在同一事务内写审计日志并分批（500 行/批）重算受影响范围（含下级部门）的 `agent_auto` 基线。
- **Agent 确认卡与确定性引擎分层原则、权限与隐私红线**：
  - 严守三层职责与 ADR-0044 的 29 顶层工具上限：不新增顶层 `ToolDefinition`，仅在 `domains/bot/tools.py` 的既有 `coordination` 聚合工具中向管理员与部门经理开放 `get_forecast_config`、`prepare_forecast_policy`、`prepare_forecast_event` 3 个子功能；
  - 采用「Agent 理解自然语言并生成结构化参数 → `CapacityCard`（`kind="forecast_policy"` / `"forecast_event"`）显式确认（网页与飞书 IM 共用 `confirm_capacity` / `cancel_capacity` 闭环） → 确定性引擎毫秒级重算 26 周基线」模式，严禁在查询时逐人调用 LLM 推算；
  - 分级权限：企业管理员全企业读写；部门经理仅可只读查看企业默认与上级祖先部门策略/事件，仅可读写自身 `managed_department_ids` 范围内的策略/事件（不可改企业默认或管辖外部门）；普通员工返回 403；无员工档案的纯管理员通过网页 `/admin/rules?tab=capacity` 配置；
  - 隐私红线：`CapacityCard` 预览与确认结果仅展示作用域、参数/修正幅度、原因说明与受影响在职人数，严禁包含任何员工姓名、员工 ID 或个人负荷明细；`domains/planning/feasibility.py` 保持只读边界直接消费重算后的 `CapacityWeekForecast`，维持 `withheld` 门槛与部门级脱敏输出。
- **预留给方案 B 的 `signals` 扩展位**：
  - 在 `capacity_week_forecast.signals` JSONB 中写入版本化元信息 `forecast_version: 2`、`policy_id`、`policy_scope`、`policy_preset`、`policy_label`、`baseline_percent`、`near_weeks`、`decay_rate`、`bidirectional_regression`、`use_jira_signal`、`use_assignment_signal`、`horizon_phase`（`near` / `far`）与 `applied_events`（含事件 `id`、`title`、`modifier_kind`、`modifier_value`、`reason`），同时在 `calendar.WeekLoad` 透出 `forecast_policy_label` 与 `forecast_events`，为方案 B 的误差监测与自调参预留无表结构破坏的扩展位。

### NERE-1372 修订：预测基线与常规配额彻底解耦、Agent 单轮自动刷新及常规/弹性分栏展示

- **隐式默认预测彻底与 `default_allocation_cap_percent`（70%）解耦**：
  - 调整 `default_allocation_cap_percent` 不再触发重算也不影响 `forecast_other_percent`；未配置显式 `CapacityForecastPolicy` 时落入隐式默认策略（`baseline_percent=0`、`near_weeks=4`、`decay_rate=0.35`、`bidirectional_regression=False`、`use_jira_signal=True`、`use_assignment_signal=True`）。
  - 自第 5 周起按周指数衰减 `(1 - effective_decay) ** steps` 趋近 `0%`；隐式默认下 Jira 信号（`open_jira >= 5`）仅在近中期（`offset < 8`）延缓衰减，在途协作信号仅在 `week_date <= min(max_due_week, current + 12w)` 内延缓衰减，确保 1 个月后与 2 个月后自然拉开梯度，不再锁死在 61%–75%。
- **Agent 单轮首次跨部门评估自动刷新**：
  - `bot/core.py` → `bot/tools.py` 在单轮工具执行上下文维护每轮去重标记；当一轮对话首次成功执行 `coordination` 的 `assess_cross_department_feasibility` 时，先在同事务内调用 `refresh_org_forecasts(db, p.org_id)` 更新 `agent_auto` 预测（`ON CONFLICT ... WHERE source = 'agent_auto'` 保护 `confirmed` 与 `manager_override`），同轮后续角色评估复用该结果；`POST /planning/feasibility` 保持纯只读，不产生写副作用。
- **常规 70% 与弹性 30% 分栏展示及突破上限标识**：
  - `CrossDeptFeasibilityDepartment` 与 `FeasibilityDepartmentItem` 新增 `regular_used_percent`（周均值 `min(occupied, regular_cap)`）、`elastic_used_percent`（周均值 `max(0, occupied - regular_cap)`）与 `exceeds_regular_cap`（`elastic_used_percent > 0` 且 `load_level != "withheld"`），`withheld` 守卫同步置空与置 `False`。
  - `FeasibilityCard` 采用原生 SVG 分段双色圆环（含 `{cap}%` 分界刻度）并分开展示常规配额与弹性空间各自的已用/余量及「已突破常规上限（动用弹性 X%）」标签；`im/rendering.py` 与 `TeamWorkloadGantt.tsx` 同步显式展示突破常规上限提示。

### NERE-1373 修订：精简预测策略为单一「周延续系数（0–1）」并保留业务波动事件

- **策略参数与零迁移兼容（`capacity_forecast_policy`）**：
  - 砍掉面向非技术用户过重且易冲突的 6 个参数（预设模式 `preset`、常态基线 `baseline_percent`、惯性周数 `near_weeks`、衰减率 `decay_rate`、双向回归 `bidirectional_regression`、Jira/在途协作信号开关 `use_jira_signal`/`use_assignment_signal`），API 与界面收敛为唯一参数 **`retention_rate`（周延续系数，`0.0`–`1.0`）** + 界面推荐提示（`0` 脉冲波次型、`0.5` 常规均衡型、`0.8` 项目延续型），系统默认 `DEFAULT_RETENTION_RATE = 0.65`。
  - 不新增 Alembic 迁移、不删除数据库旧列：写入时存 `decay_rate = round(1.0 - retention_rate, 4)`，冗余列写固定中立值（`baseline_percent=0`、`near_weeks=0`、`bidirectional_regression=False`、`use_jira_signal=False`、`use_assignment_signal=False`、`preset=None`）；读取时反算 `retention_rate = round(1.0 - row.decay_rate, 2)`（钳位至 `[0.0, 1.0]`）。
- **极简确定性预测公式（`domains/capacity/forecast.py`）**：
  - 保留员工近 8 周历史均值优先与「同部门 ≥ 2 名不同在职同事」兜底红线及「无历史不捏造」原则。
  - 取锚点周 `anchor_week`（个人取最近已确认周 `max(r.week_start)`，部门兜底取本周 `current`）与 `anchor_load = hist_mean`：
    - `week_date <= anchor_week`：`raw = anchor_load`（已确认周仍由 `CapacityWeek` 覆盖优先）；
    - `week_date > anchor_week`：`steps = (week_date - anchor_week).days // 7`，`raw = anchor_load * (retention_rate ** steps)`（`retention_rate == 0` 时次周立即归零）。
  - 移除 `open_jira_task_counts` 与在途协作对衰减速率的干扰，避免与 `calendar.py` 中的 `platform_percent` 重复计算；继续叠加 `CapacityForecastEvent`（先乘 `multiplier` 再加 `delta`）并经 `_round_5()` 钳位至 `[0, 200]`。
  - 保留 `confirmed > manager_override > agent_auto` 优先级、分级权限控制、Agent 单轮首次评估自动刷新与精简后的 `prepare_forecast_policy` 确认卡。

### NERE-1375 修订：内部方案生成与确认接入预测基线（方案 1）

- **模拟前自动刷新与快照指纹（`planning/service.py`、`planning/snapshot.py`）**：
  - `create_case()` 创建/重新模拟规划快照前，先为目标部门候选人刷新 `agent_auto` 预测基线（`ON CONFLICT ... WHERE source = 'agent_auto'` 保护 `confirmed` 与 `manager_override`）；`GET /cases/{case_id}`、`create_option()`、`revise_option()` 与 `POST /planning/feasibility` 保持纯只读不写库。
  - 快照 `_inputs()` 纳入候选人在目标窗内的 `CapacityWeekForecast`（`employee_id`、`week_start`、`forecast_other_percent`、`source`），预测基线变化时旧快照准确标为 `stale`；`rules.actor_employee_id` 记录当前模拟经理员工 ID（校验自定义/调整方案时同步传入当前操作人）。
- **有效负荷取值与三条安全守卫（`validator.py`、`simulator.py`、`cpsat.py`）**：
  - 统一通过 `effective_other(week, allow_forecast=...)` 取值：`confirmed` 真实周负荷优先；否则仅对下属（`employee_id != actor_employee_id`）取 `forecast_other_percent`；经理本人（`allow_forecast = False`）与零历史无预测基线的新人周仍返回 `None` 并报 `unconfirmed` / `insufficient_data`。
  - 使用预测基线校验时继续遵守 `regular_cap`（默认 70%）与 `elastic_cap`（100%）：未超限时输出温和提示 `code="forecast_week"`（`level="feasible"`），前端 `Plans.tsx` 合并为柔和信息条，仅存在真实 `unconfirmed` 时才提示跳转「去确认团队负荷」；超常规配额未开弹性仍报 `over_regular_cap`，超可用容量仍报 `over_capacity`。
- **确认方案同事务自动确认下属预测周（`capacity/proposal.py`）**：
  - 目标部门经理提交方案（含直接窗口内确认生效与超窗提交预占提议、及方案变更提交）时，在同一数据库事务内加锁员工并校验管辖权限及 `employee_id != principal.employee_id`；在全部受分配员工的预测周均满足 `forecast_other_percent + platform_percent + requested <= capacity_percent` 后，才写入 `CapacityWeek`（`other_percent = forecast_other_percent`、`confirmed_by_user_id = principal.user_id`、`confirmed_at = utc_now()`）并记审计事件 `capacity.workload_confirmed_from_forecast`，任意一周超可用容量即抛出 409 `ProposalConflict` 整事务回滚、不残留任何 `CapacityWeek`。
  - 经理本人未确认周与 `forecast_other_percent is None` 的未确认周绝不自动确认，仍返回 409；既有手工分配（`assignment.py`）与延期审批（`extension.py`）及 `accept()` 复核的硬校验规则保持不变。
