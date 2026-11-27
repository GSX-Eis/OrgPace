# 外部 MCP 接入状态

E53 将外部 MCP、个人访问令牌（PAT）和 OAuth 授权置于服务端部署开关 `EXTERNAL_MCP_ENABLED` 后，默认关闭。员工和经理可用网页内置助手、已绑定的 IM 或网页表单处理画像请求。历史请求和审计记录继续显示原有的外部来源。

协议和启用态验证见 [ADR-0017](adr/0017-mcp-transport-and-token-auth.md) 与 [ADR-0019](adr/0019-mcp-oauth-authorization.md)。
