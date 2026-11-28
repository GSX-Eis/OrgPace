# 架构决策记录

| ADR | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-tenancy-and-core-objects.md) | 租户边界、核心对象、证据追加和画像快照 | M0 已采用 |
| [0002](0002-worker-and-compose-layout.md) | PostgreSQL Worker 与 Compose 分工 | 已采用 |
| [0003](0003-authz-and-tenant-context.md) | 租户上下文与基础角色权限 | 已采用 |
| [0004](0004-login-and-deployment-scope.md) | 登录与部署范围 | 已采用 |
| [0005](0005-login-session-and-rate-limits.md) | 登录会话与限流 | 已采用 |
| [0006](0006-manager-descendant-scope.md) | 部门经理的管辖范围包含下级部门 | 已采用 |
| [0007](0007-mock-jira-service.md) | 数据集驱动的模拟 Jira | 已采用 |
| [0008](0008-model-sdk-and-stored-credentials.md) | 模型 SDK 与已保存凭据 | 已采用 |
| [0009](0009-profile-change-requests.md) | 画像请求与正式判断分离、审核状态推算及迁移 | 已采用 |
| [0010](0010-source-record-ingestion.md) | 来源记录、未关联账号与证据粒度 | 已采用 |
| [0011](0011-chatgpt-subscription-sessions.md) | ChatGPT 订阅会话与开发登录隔离 | 已采用 |
| [0012](0012-resumable-source-sync.md) | 同步入队、分页事务和断点恢复 | 已采用 |

| [0013](0013-model-initial-drafting.md) | 模型起草白名单、输出校验和限流续跑事务 | 已采用 |
| [0014](0014-pi-agent.md) | Pi 调用边界、订阅凭据与会话并发 | 已采用 |

涉及新组件、协议或方案取舍时，随对应 PR 提交 ADR。文件名使用 `NNNN-短标题.md`，连续编号，不重复使用；记录背景、决策及其收益、代价与风险。注：`0015`、`0028`、`0031` 因历史并行合并存在重复前缀编号，下表与对应文档标题以 `a / b` 加注区分，保留原文件名以兼容既有引用。

- [ADR-0015a：邮箱登录和旧账号迁移](0015-email-login.md)
- [ADR-0015b：共享员工服务、预览修订号与自述证据](0015-employee-request-service.md)
- [ADR-0016：能力词典换版与历史判断](0016-capability-dictionary-versions.md)
- [ADR-0017：员工 MCP 传输与个人令牌认证](0017-mcp-transport-and-token-auth.md)
- [ADR-0018：内置机器人对话核心与入口约定](0018-bot-conversation-contract.md)
- [ADR-0019：MCP OAuth 授权服务器](0019-mcp-oauth-authorization.md)
- [ADR-0020：管理员导入候选画像](0020-admin-profile-import.md)
- [ADR-0021：ChatGPT 订阅支持目录外模型 ID](0021-codex-model-ids.md)
- [ADR-0022：飞书、企业微信与 Telegram 入口](0022-im-entrances.md)
- [ADR-0023：审批路由、临时读取权限与原子发布](0023-review-and-publish.md)
- [ADR-0024：版本化审批规则与员工确认发布](0024-approval-policy.md)
- [ADR-0025：申诉以展示状态覆盖正式画像（已取消新增申诉，保留历史只读与遗留收口）](0025-review-appeals.md)
- [ADR-0026：按组织架构自动代理审批（原限时代理审批）](0026-review-delegation.md)
- [ADR-0027：CI 隔离并行与异步自动合并](0027-ci-and-asynchronous-merge.md)
- [ADR-0028a：管理助手只读功能登记表](0028-admin-function-registry.md)
- [ADR-0028b：CI 浏览器运行在 runner 上并复用服务镜像](0028-ci-browser-on-runner.md)
- [ADR-0029：管理助手会话与共享对话准入](0029-admin-assistant-conversations.md)
- [ADR-0030：管理助手的普通变更集](0030-admin-change-sets.md)
- [ADR-0031a：词典变更通过新版本撤销](0031-admin-dictionary-undo.md)
- [ADR-0031b：管理助手高风险确认与安全输入](0031-admin-secure-confirmation.md)
- [ADR-0032：人员变动复用全量名单](0032-single-person-roster.md)
- [ADR-0033：管理助手的一次性账号输出](0033-admin-one-time-results.md)
- [ADR-0034：管理助手的文件预览与模型摘要](0034-admin-assistant-file-previews.md)
- [ADR-0035：借鉴 NocoBase 架构的范围](0035-nocobase-reference.md)（已接受，2026-11-10，大古）
- [ADR-0036：企业自动起草使用单一总开关](0036-auto-drafting-switch.md)
- [ADR-0037：私有会话附件与文件输入边界](0037-chat-attachments.md)
- [ADR-0038：首次设置使用持久管理对话](0038-setup-conversation.md)
- [ADR-0039：后端测试按耗时分三片](0039-backend-test-shards.md)
- [ADR-0040：管理员和经理直接修改画像](0040-direct-profile-edits.md)
- [ADR-0041：Pi 生成部门默认对应能力](0041-department-default-capabilities.md)
- [ADR-0042：初始画像状态与直属上级摘要](0042-initial-profile-status-and-manager-reference.md)
- [ADR-0043：旧初稿提交携带员工核对的正式画像版本](0043-stale-draft-confirmation.md)
- [ADR-0044：经理助手的工具定义上限](0044-manager-tool-definition-limit.md)
- [ADR-0045：独立的需求与容量模块](0045-capacity-module.md)
- [ADR-0046：Agent / Planning / Capacity 三层职责与周级容量](0046-agent-planning-capacity.md)
- [ADR-0047：协调 Agent 的工具与权限边界](0047-coordination-agent.md)
- [ADR-0048：员工助手最终回复的交付时权限复核](0048-bot-final-delivery-visibility.md)
- [ADR-0049：方案预占与原子承诺](0049-proposal-hold-commitment.md)
- [ADR-0050：员工助手按工具上报的员工读取范围失效](0050-bot-reported-employee-reads.md)
- [ADR-0051：项目需求聚合与角色依赖](0051-capacity-projects-and-roles.md)
- [ADR-0052：分配执行跟踪](0052-assignment-tracking.md)
- [ADR-0053：分配完成后的工作反馈](0053-assignment-feedback-evidence.md)
- [ADR-0054：排程评测与 SolverPort](0054-solver-port.md)（B2 已按 D-033 放行。CP-SAT 用单个需求的授权快照生成候选，承诺仍须人工确认）
- [ADR-0055：全站中英文双语界面与语言偏好记忆](0055-bilingual-ui.md)
