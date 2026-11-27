# ADR 0055：全站中英文双语界面与语言偏好记忆

## 背景

平台需要在保持默认中文界面和存量自动化测试完全兼容的前提下，支持全站中英文（`zh-CN` / `en`）一键切换与偏好记忆，覆盖前端 UI、后端报错与站内通知、IM 推送以及内置助手语言联动。

## 决策

### 1. 前端国际化方案与零闪烁初始化

- **库选型**：引入 `i18next@27.2.1` 与 `react-i18next@18.0.2`（MIT 许可证，精确锁版本）。不引入浏览器语言自动检测插件，首次访问固定使用 `zh-CN`。
- **双层记忆与优先级**：
  1. `localStorage.locale` 作为本地即时缓存。`frontend/index.html` 在首屏渲染前同步对齐 `<html lang>` 与默认 `<title>`，`frontend/src/i18n/index.ts` 在 `ReactDOM.createRoot` 前同步初始化 `i18next`，确保英文模式刷新与登录页均无中文闪烁。
  2. 后端 `user.preferred_locale`（`VARCHAR(8) NULL`，Check 约束 `IN ('zh-CN', 'en')`）作为跨设备账号偏好。登录后拉取 `GET /api/v1/users/me`，若 `preferred_locale` 非空且与本地不同，以账号为准同步回本地；为空则保持本地值。显式点击切换时同步更新本地、`<html lang>`、`router.invalidate()` 刷新路由标题，并在已登录时静默调用 `PATCH /api/v1/users/me/preferences`（失败仅记 `console.warn`，不打断用户）。退出登录不清除 `localStorage.locale`。
- **语言透传**：`frontend/src/main.tsx` 的 Axios 实例请求拦截器、`routes/_layout.tsx` 守卫请求以及 `Chat/useStreamingTurn.ts` 流式 `fetch` 统一附带 `Accept-Language: <当前 locale>`。
- **格式本地化**：`frontend/src/i18n/format.ts` 提供 `formatDate`、`formatDateRange`、`formatNumber`、`formatPercent`（`formatPercent` 接收 `0..1` 比例值），基于 `Intl` 与当前 locale 格式化。

### 2. 后端语言上下文、翻译目录与双语通知

- **请求上下文**：`backend/app/i18n/__init__.py` 维护 `current_locale: ContextVar[Locale]`（默认 `zh-CN`）。`LocaleMiddleware`（纯 ASGI 中间件，避免缓冲流式响应）按 `Accept-Language` 设置当前请求语言（以 `en` 开头解析为 `en`，其余 `zh-CN`；`# shortcut` 暂不解析 q 权重）。后台任务与 IM 投递通过 `use_locale(locale)` 显式绑定上下文。
- **gettext 风格目录**：以中文原文为 msgid，按区域拆分为 `backend/app/i18n/en_<area>.py` 中的 `EN: dict[str, str]`，`__init__.py` 通过 `pkgutil` 自动合并全部 `en_*.py`；同一 key 出现冲突译文时在导入期直接报错。
- **全局异常翻译**：`backend/app/main.py` 注册 `StarletteHTTPException` 处理器：当 `detail` 为字符串时执行 `tr(detail)`；为包含字符串 `message` 的字典时翻译 `message` 并原样保留 `code` 等结构化字段，不改造成全局错误码体系。
- **站内通知与 IM 推送**：在唯一迁移中新增 `inbox_item.message_en TEXT NULL`。`inbox.service.notify(..., message_en=...)` 支持同时写入中英文；读取时在 `current_locale == "en"` 且 `message_en` 非空时返回英文，历史通知自然回退中文。IM 推送在 `claim` 阶段读取收件人 `user.preferred_locale` 并用 `use_locale` 包裹发送文案；MCP 工具返回与模型工具描述保持中文。

### 3. 前端翻译统一约定（供全里程碑并行子单遵循）

1. **按命名空间拆分词典**：各子单只新增自己的词典文件 `frontend/src/i18n/locales/{zh-CN,en}/<ns>.json`（避免使用 `auth.json` / `credentials*.json` 等会被 `scripts/remote-test-metadata.py` 脱敏过滤的文件名），通过 `import.meta.glob("./locales/*/*.json", { eager: true })` 自动合并，键名写成 `t("<ns>.xxx")`。中文词条原样搬运现有中文文案，不改措辞，确保存量中文测试零改动通过。
2. **共享底座只读边界**：后续业务子单不修改 `frontend/src/i18n/*.ts`、`frontend/tests/utils/copy.ts`、`frontend/scripts/check-i18n.ts` 与 `.pre-commit-config.yaml`。
3. **日期与数值格式**：统一使用 `formatDate` / `formatDateRange` / `formatNumber` / `formatPercent`，清除业务组件内写死的 `"zh-CN"`。
4. **模块级常量动态化**：zod 校验信息、路由 `head` 标题、标签映射表改为渲染或校验时取值；被其他目录引用的共享标签模块保持导出名与调用方式不变。
5. **业务数据不翻译**：员工姓名、部门名称、企业能力词典条目、Jira 标题、证据原文、模型生成的画像陈述保持原文展示。
6. **英文排版与测试隔离**：桌面 1440×900 下确保导航、按钮组、标签、表头与弹窗不截断、不重叠；各子单新增 `frontend/tests/i18n-<ns>.spec.ts` 使用 `localStorage.setItem("locale", "en")` + `expectEnglishCopy(page, { allow: [...] })` 验证英文覆盖，禁止在业务页面测试中点击切换或修改演示账号的 `preferred_locale`。

### 4. 静态防线

- `frontend/scripts/check-i18n.ts` 校验 `zh-CN` 与 `en` 的文件集合、扁平键集合与每个键的 `{{占位符}}` 集合 100% 一致，并校验源码中字面量 `t("a.b")` / `i18n.t("a.b")` 引用的键全部存在；接入 `.pre-commit-config.yaml` 的 `check-i18n` 本地 hook。

## 收益与代价

- **收益**：不改造现有中文异常调用点与业务对象契约，各业务域可按命名空间并行推进；首屏无闪烁；默认中文完全向后兼容。
- **代价与约束**：`en_*.py` 依赖中文原文作为 key，修改中文报错原文时须同步更新对应英文目录（后续由 T07 的目录覆盖测试兜底）。
