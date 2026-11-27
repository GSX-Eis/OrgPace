import { expect, type Page, test } from "@playwright/test"
import type { McpSettingPublic, TokenCreated, TokenPublic } from "../src/client"
import { logInUser, logOutUser } from "./utils/user"

test.use({ storageState: { cookies: [], origins: [] } })

test("external MCP, PAT, and OAuth endpoints and UI are closed by default", async ({
  page,
  request,
}) => {
  await logInUser(
    page,
    "admin@demo.example.com",
    process.env.DEMO_USER_PASSWORD!,
  )

  const token = await page.evaluate(() => localStorage.getItem("access_token"))
  expect(token).toBeTruthy()
  const authHeader = { Authorization: `Bearer ${token}` }

  const meRes = await request.get("/api/v1/me/memberships", {
    headers: authHeader,
  })
  expect(meRes.ok()).toBeTruthy()
  const memberships = (await meRes.json()) as Array<{ org: { id: string } }>
  const orgId = memberships[0].org.id
  const orgBase = `/api/v1/orgs/${orgId}`

  // Deployment switch EXTERNAL_MCP_ENABLED defaults to false -> all external MCP/PAT/OAuth routes return 404.
  const closedGets = [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/oauth/authorize",
    `${orgBase}/mcp-setting`,
    `${orgBase}/me/access-tokens`,
    `/api/v1/oauth/consent?request=dummy`,
    `/api/v1/oauth/grants?org_id=${orgId}`,
  ]
  for (const url of closedGets) {
    const res = await request.get(url, { headers: authHeader })
    expect(res.status(), `GET ${url} should return 404`).toBe(404)
  }

  const closedPosts: Array<[string, Record<string, unknown>]> = [
    ["/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" }],
    ["/oauth/register", { client_name: "synthetic-client" }],
    ["/oauth/token", { grant_type: "authorization_code", code: "invalid" }],
    [
      `${orgBase}/me/access-tokens`,
      { name: "synthetic-token", expires_in_days: 7 },
    ],
  ]
  for (const [url, data] of closedPosts) {
    const res = await request.post(url, { headers: authHeader, data })
    expect(res.status(), `POST ${url} should return 404`).toBe(404)
  }

  const putSetting = await request.put(`${orgBase}/mcp-setting`, {
    headers: authHeader,
    data: { enabled: true },
  })
  expect(putSetting.status()).toBe(404)

  // Personal settings keeps integrations container without external AI / PAT / OAuth entries.
  await page.goto("/settings?section=integrations")
  await expect(
    page.getByRole("heading", { name: "聊天账号与外部工作身份", exact: true }),
  ).toBeVisible()
  await expect(page.getByText("当前账号没有员工身份，不能绑定。")).toBeVisible()
  await expect(page.getByRole("region", { name: "我的令牌" })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "已授权应用" })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "外部 AI 工具" })).toHaveCount(
    0,
  )

  // Sidebar & admin space panel hide 外部 AI 工具; admin data-ai keeps internal tabs.
  await page.goto("/admin/data-ai")
  const spaceNav = page.getByRole("navigation", { name: "空间导航" })
  await expect(
    spaceNav.getByRole("link", { name: "外部 AI 工具" }),
  ).toHaveCount(0)
  await expect(page.getByText(/外部 AI 工具|MCP 开关/)).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "数据来源", exact: true }),
  ).toBeVisible()

  // Legacy routes redirect away from MCP tabs.
  await page.goto("/admin/data-ai?tab=mcp")
  await expect(page).toHaveURL(/\/admin\/data-ai\?tab=sources/)
  await page.goto("/admin/assistants")
  await expect(page).toHaveURL(/\/admin\/data-ai\?tab=sources/)
  await page.goto("/admin/connections?tab=mcp")
  await expect(page).toHaveURL(/\/admin\/data-ai\?tab=im/)

  // Internal IM & built-in assistant entry points stay functional.
  await expect(
    page.getByRole("heading", { name: "IM 入口", exact: true }),
  ).toBeVisible()
  await page.goto("/assistant?mode=admin")
  await expect(page).toHaveURL(/\/assistant/)

  // Employee integrations keeps IM 绑定 & 本人关联账号 without PAT / OAuth, and consent page reports disabled.
  await logOutUser(page)
  await logInUser(
    page,
    "employee.platform@demo.example.com",
    process.env.DEMO_USER_PASSWORD!,
  )
  await page.goto("/settings?section=integrations")
  await expect(
    page.getByRole("region", { name: "IM 绑定", exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("region", { name: "本人关联账号", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("region", { name: "我的令牌" })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "已授权应用" })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "外部 AI 工具" })).toHaveCount(
    0,
  )
  await page.goto("/assistant")
  await expect(page).toHaveURL(/\/assistant/)

  // OAuth consent page shows disabled alert on 404 and renders no consent actions.
  await page.goto("/oauth/consent?request=synthetic")
  await expect(
    page.getByRole("heading", { name: "外部工具授权未启用", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(
    page.getByRole("button", { name: /同意|允许|授权|拒绝/ }),
  ).toHaveCount(0)
})

async function sessionHeaders(page: Page) {
  const token = await page.evaluate(() => localStorage.getItem("access_token"))
  expect(token).toBeTruthy()
  return { Authorization: `Bearer ${token}` }
}

test("HTTPS personal settings keep the MCP connection UI retired @external-mcp", async ({
  page,
  baseURL,
}) => {
  const httpsOrigin = "https://platform.example.test"
  await page.route(`${httpsOrigin}/**`, async (route) => {
    const url = new URL(route.request().url())
    const response = await route.fetch({
      url: `${baseURL}${url.pathname}${url.search}`,
    })
    await route.fulfill({ response })
  })
  await page.goto(`${httpsOrigin}/login`)
  await page
    .getByTestId("email-input")
    .fill("employee.platform@demo.example.com")
  await page.getByTestId("password-input").fill(process.env.DEMO_USER_PASSWORD!)
  await page.getByRole("button", { name: "登录", exact: true }).click()
  await expect(page.getByTestId("user-menu")).toBeVisible()
  await page.goto(`${httpsOrigin}/settings?section=integrations`)
  await expect(page.getByRole("region", { name: "IM 绑定" })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "查看 MCP 接入配置" }),
  ).toHaveCount(0)
  await expect(page.getByRole("region", { name: "我的令牌" })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "已授权应用" })).toHaveCount(0)
})

test("enterprise switch and personal token lifecycle @external-mcp", async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  const password = process.env.DEMO_USER_PASSWORD!
  await logInUser(page, "admin@demo.example.com", password)
  const headers = await sessionHeaders(page)
  const membershipsRes = await request.get("/api/v1/me/memberships", {
    headers,
  })
  expect(membershipsRes.ok()).toBeTruthy()
  const memberships: Array<{ org: { id: string } }> =
    await membershipsRes.json()
  const base = `/api/v1/orgs/${memberships[0].org.id}`
  const setting = `${base}/mcp-setting`
  const tokens = `${base}/me/access-tokens`
  const originalRes = await request.get(setting, { headers })
  expect(originalRes.ok()).toBeTruthy()
  const original: McpSettingPublic = await originalRes.json()

  const employee = await browser.newPage({
    baseURL,
    storageState: { cookies: [], origins: [] },
  })
  await logInUser(employee, "employee.platform@demo.example.com", password)
  const employeeHeaders = await sessionHeaders(employee)
  const name = `合成工作电脑 ${crypto.randomUUID()}`
  let tokenId: string | undefined
  try {
    const enabled = await request.put(setting, {
      headers,
      data: { enabled: true, allowed_clients: ["Cursor"] },
    })
    expect(enabled.ok()).toBeTruthy()
    const saved = await request.get(setting, { headers })
    expect(await saved.json()).toMatchObject({
      enabled: true,
      allowed_clients: ["Cursor"],
    })

    const created = await request.post(tokens, {
      headers: employeeHeaders,
      data: { name },
    })
    expect(created.status()).toBe(201)
    const token: TokenCreated = await created.json()
    tokenId = token.id
    expect(token.token.length).toBeGreaterThan(0)

    const disabled = await request.put(setting, {
      headers,
      data: { enabled: false },
    })
    expect(disabled.ok()).toBeTruthy()
    const rejected = await request.post(tokens, {
      headers: employeeHeaders,
      data: { name: "合成备用电脑" },
    })
    expect(rejected.status()).toBe(403)
    const listed = await request.get(tokens, { headers: employeeHeaders })
    expect(listed.ok()).toBeTruthy()
    const existing: TokenPublic[] = await listed.json()
    const record = existing.find(({ id }) => id === tokenId)
    expect(record).toMatchObject({ name, revoked_at: null })
    expect(record).not.toHaveProperty("token")

    const revoked = await request.delete(`${tokens}/${tokenId}`, {
      headers: employeeHeaders,
    })
    expect(revoked.ok()).toBeTruthy()
    const revokedToken: TokenPublic = await revoked.json()
    expect(revokedToken.revoked_at).toBeTruthy()
  } finally {
    if (tokenId) {
      await request.delete(`${tokens}/${tokenId}`, { headers: employeeHeaders })
    }
    await employee.close()
    const restored = await request.put(setting, {
      headers,
      data: {
        enabled: original.enabled,
        allowed_clients: original.allowed_clients,
      },
    })
    expect(restored.ok()).toBeTruthy()
  }
})
