import { createServer } from "node:http"
import { networkInterfaces } from "node:os"
import { expect, test } from "@playwright/test"
import type { EmployeeAccount } from "../src/client"

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
})

test("NERE-1214：下周负荷调整（网页与助手）、员工请假（网页与助手）、经理经助手改下属负荷", async ({
  page,
  request,
}) => {
  test.setTimeout(120000)
  const password = "synthetic-capacity-password-2026"
  const post = async (url: string, data: object, token?: string) => {
    const response = await request.post(url, {
      data,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json()
  }
  const setup = await post("/api/v1/private/setup-tokens", {
    purpose: "new_org",
  })
  const admin = await post("/api/v1/setup/initialize", {
    token: setup.token,
    org_name: "合成负荷验收企业",
    admin_username: `nere1214-${crypto.randomUUID()}@example.com`,
    admin_password: password,
  })
  const base = `/api/v1/orgs/${admin.org_id}`
  const headers = { Authorization: `Bearer ${admin.access_token}` }
  const roster = await request.post(`${base}/roster/imports`, {
    headers,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          `工号,姓名,部门,上级工号,邮箱\nM,合成经理林,产品部,,m-${crypto.randomUUID()}@example.com\nE,合成员工陈,产品部,M,e-${crypto.randomUUID()}@example.com\n`,
        ),
      },
    },
  })
  expect(roster.ok(), await roster.text()).toBeTruthy()
  const preview = await roster.json()
  await post(
    `${base}/roster/imports/${preview.id}/apply`,
    { base_revision: preview.base_revision },
    admin.access_token,
  )
  expect(
    (await request.post(`${base}/accounts/issue`, { headers, data: {} })).ok(),
  ).toBeTruthy()
  const accounts: EmployeeAccount[] = (
    await (await request.get(`${base}/accounts`, { headers })).json()
  ).data
  const manager = accounts.find((row) => row.employee_code === "M")!
  const employee = accounts.find((row) => row.employee_code === "E")!
  await post(
    `${base}/role-grants`,
    {
      user_id: manager.account!.user_id,
      role: "dept_manager",
      department_id: manager.department!.id,
    },
    admin.access_token,
  )
  expect(
    (
      await request.put(`${base}/capacity-settings`, {
        headers,
        data: { enabled: true, requester_policy: "everyone" },
      })
    ).ok(),
  ).toBeTruthy()

  const tokens = new Map<string, string>()
  for (const account of [manager, employee]) {
    const reset = await post(
      `${base}/accounts/${account.account!.user_id}/reset-password`,
      {},
      admin.access_token,
    )
    const login = await request.post("/api/v1/login/access-token", {
      form: { username: reset.username, password: reset.initial_password },
    })
    expect(login.ok(), await login.text()).toBeTruthy()
    const changed = await request.patch("/api/v1/users/me/password", {
      headers: { Authorization: `Bearer ${(await login.json()).access_token}` },
      data: {
        current_password: reset.initial_password,
        new_password: password,
      },
    })
    expect(changed.ok(), await changed.text()).toBeTruthy()
    tokens.set(account.employee_code!, (await changed.json()).access_token)
  }

  const open = async (token: string, path = "/capacity") => {
    await page.goto("/login")
    await page.evaluate(
      ({ token, orgId }) => {
        localStorage.setItem("access_token", token)
        localStorage.setItem("current_org_id", orgId)
      },
      { token, orgId: admin.org_id },
    )
    await page.goto(path)
  }

  const empToken = tokens.get("E")!
  const mgrToken = tokens.get("M")!
  const empHeaders = { Authorization: `Bearer ${empToken}` }
  const mgrHeaders = { Authorization: `Bearer ${mgrToken}` }

  const mineBefore = await (
    await request.get(`${base}/capacity/workloads/me`, { headers: empHeaders })
  ).json()
  const nextWeek = mineBefore.weeks[1].week_start as string
  const thirdWeek = mineBefore.weeks[2].week_start as string
  const nextTue = new Date(`${nextWeek}T00:00:00Z`)
  nextTue.setUTCDate(nextTue.getUTCDate() + 1)
  const thirdTue = new Date(`${thirdWeek}T00:00:00Z`)
  thirdTue.setUTCDate(thirdTue.getUTCDate() + 1)

  // 1a. 网页「我的负荷」提交下一周的负荷调整（仅修改开始周为下周）
  await open(empToken, "/capacity")
  await expect(
    page.getByRole("button", { name: "请假", exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: test.info().outputPath("my-workload-desktop.png"),
    fullPage: true,
  })
  await page.getByRole("button", { name: "申请调整", exact: true }).click()
  const drawer = page.getByRole("dialog", { name: "申请调整" })
  const form = drawer.getByRole("form", { name: "申请调整" })
  await form.getByLabel("开始周", { exact: true }).fill(nextWeek)
  await expect(form.getByLabel("结束周", { exact: true })).toHaveValue(nextWeek)
  await form.getByLabel("申请负荷（%）").fill("50")
  await form.getByLabel("申请原因").fill("合成下周网页调整")
  await form.getByRole("button", { name: "提交申请" }).click()
  await expect(drawer).toBeHidden()
  await expect(
    page.getByRole("region", { name: "调整申请记录" }),
  ).toContainText("已提交，等待 合成经理林 审批")
  await page.reload()
  await expect(
    page.getByRole("region", { name: "调整申请记录" }),
  ).toContainText("已提交，等待 合成经理林 审批")

  // 经理在收件箱与「待审批 → 负荷与延期」可见，批准后下周生效
  await open(mgrToken, "/inbox")
  await expect(page.getByText(/有负荷调整申请等你审批/).first()).toBeVisible()
  await page.goto("/reviews?type=workload")
  const pendingRow = page.locator("summary").filter({ hasText: "合成员工陈" })
  await expect(pendingRow).toContainText(`${nextWeek} 至 ${nextWeek}`)
  await pendingRow.click()
  await page.getByRole("button", { name: "同意", exact: true }).click()
  await expect(pendingRow).toHaveCount(0)

  const mineAfterWeb = await (
    await request.get(`${base}/capacity/workloads/me`, { headers: empHeaders })
  ).json()
  expect(mineAfterWeb.weeks[1].other_percent).toBe(50)

  // 2a. 员工通过网页「请假」入口请假（无自由文本说明字段，通知仅含日期）
  await open(empToken, "/capacity")
  await page.getByRole("button", { name: "请假", exact: true }).click()
  const leaveDrawer = page.getByRole("dialog", { name: "请假" })
  await expect(leaveDrawer.getByLabel(/说明/)).toHaveCount(0)
  await expect(leaveDrawer).toContainText("通知仅含日期")
  await leaveDrawer.getByLabel("开始日期", { exact: true }).fill(nextWeek)
  await leaveDrawer
    .getByLabel("结束日期", { exact: true })
    .fill(nextTue.toISOString().slice(0, 10))
  await leaveDrawer.getByRole("button", { name: "提交请假" }).click()
  await expect(leaveDrawer).toBeHidden()
  await expect(page.getByRole("status").first()).toContainText("已登记请假")

  const mineAfterLeave = await (
    await request.get(`${base}/capacity/workloads/me`, { headers: empHeaders })
  ).json()
  expect(mineAfterLeave.weeks[1].capacity_percent).toBe(60)

  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()
  await page.screenshot({
    path: test.info().outputPath("my-workload-mobile.png"),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1440, height: 900 })

  // 1b + 2b + 3. 助手路径：员工下周调整、员工请假、经理修改下属下周负荷为 0
  let scenario: "workload" | "leave" | "team" = "workload"
  const server = createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const done = body.messages.at(-1).role === "tool"
    const toolCall =
      scenario === "workload"
        ? {
            name: "prepare_workload_request",
            arguments: JSON.stringify({
              requested_percent: 20,
              reason: "合成下周助手调整",
              start_week: nextWeek,
              end_week: nextWeek,
            }),
          }
        : scenario === "leave"
          ? {
              name: "coordination",
              arguments: JSON.stringify({
                function: "prepare_leave",
                arguments: {
                  start_date: thirdWeek,
                  end_date: thirdTue.toISOString().slice(0, 10),
                },
              }),
            }
          : {
              name: "coordination",
              arguments: JSON.stringify({
                function: "prepare_team_workload",
                arguments: {
                  employee_id: employee.id,
                  other_percent: 0,
                  start_week: nextWeek,
                  end_week: nextWeek,
                },
              }),
            }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(
      `data: ${JSON.stringify({
        id: "nere1214",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: done
              ? { role: "assistant", content: "请核对确认卡" }
              : {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${scenario}`,
                      type: "function",
                      function: toolCall,
                    },
                  ],
                },
            finish_reason: done ? "stop" : "tool_calls",
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing address")
  const baseURL = test.info().project.use.baseURL
  const host =
    process.env.MODEL_TEST_HOST ??
    (baseURL?.includes("backend:")
      ? Object.values(networkInterfaces())
          .flat()
          .find((network) => network?.family === "IPv4" && !network.internal)
          ?.address
      : undefined) ??
    "127.0.0.1"
  try {
    expect(
      (
        await request.put(`${base}/model-setting`, {
          headers,
          data: {
            enabled: true,
            kind: "openai_compatible",
            provider: "openai-compatible",
            model: "synthetic",
            base_url: `http://${host}:${address.port}/v1`,
            api_key: "synthetic-key",
          },
        })
      ).ok(),
    ).toBeTruthy()

    // 1b. 员工经助手提交下周调整 -> 经理批准
    await open(empToken, "/assistant")
    const panel = page.getByRole("region", { name: "助手", exact: true })
    await panel.getByLabel("发给助手的消息").fill("帮我把下周负荷调成20%")
    await panel.getByRole("button", { name: "发送", exact: true }).click()
    const workloadCard = panel.getByRole("region", {
      name: "申请调整负荷",
      exact: true,
    })
    await expect(workloadCard).toContainText(
      `周范围：${nextWeek} 至 ${nextWeek}`,
    )
    await workloadCard
      .getByRole("button", { name: "确认", exact: true })
      .click()
    await expect(workloadCard.last().getByRole("status")).toContainText(
      "负荷调整申请已提交",
    )
    const mgrRequests = await (
      await request.get(`${base}/capacity/workload-requests`, {
        headers: mgrHeaders,
      })
    ).json()
    const botReq = mgrRequests.data.find(
      (r: { status: string; requested_percent: number }) =>
        r.status === "pending" && r.requested_percent === 20,
    )
    expect(botReq).toBeTruthy()
    expect(
      (
        await request.post(
          `${base}/capacity/workload-requests/${botReq.id}/decision`,
          { headers: mgrHeaders, data: { approve: true } },
        )
      ).ok(),
    ).toBeTruthy()

    // 2b. 员工经助手请假
    scenario = "leave"
    await panel.getByLabel("发给助手的消息").fill("下下周请假两天")
    await panel.getByRole("button", { name: "发送", exact: true }).click()
    const leaveCard = panel.getByRole("region", {
      name: "登记请假",
      exact: true,
    })
    await expect(leaveCard).toContainText("通知仅含日期")
    await leaveCard.getByRole("button", { name: "确认", exact: true }).click()
    await expect(leaveCard.last().getByRole("status")).toContainText(
      "请假已登记并生效",
    )
    const mineAfterBotLeave = await (
      await request.get(`${base}/capacity/workloads/me`, {
        headers: empHeaders,
      })
    ).json()
    expect(mineAfterBotLeave.weeks[2].capacity_percent).toBe(60)
    const mgrInbox = await (
      await request.get(`${base}/me/inbox`, { headers: mgrHeaders })
    ).json()
    expect(
      mgrInbox.data.some(
        (item: { message: string }) =>
          item.message.includes("合成员工陈") &&
          item.message.includes(thirdWeek) &&
          !item.message.includes("说明："),
      ),
    ).toBeTruthy()

    // 3. 经理经助手将下属下周负荷设为 0
    scenario = "team"
    await open(mgrToken, "/assistant")
    const mgrPanel = page.getByRole("region", { name: "助手", exact: true })
    await mgrPanel
      .getByLabel("发给助手的消息")
      .fill("合成员工陈下周设置成0的负载")
    await mgrPanel.getByRole("button", { name: "发送", exact: true }).click()
    const teamCard = mgrPanel.getByRole("region", {
      name: "调整下属负荷",
      exact: true,
    })
    await expect(teamCard).toContainText("合成员工陈")
    await expect(teamCard).toContainText("平台外工作占比：0%")
    // 未点确认前仍为 20%
    const beforeConfirm = await (
      await request.get(`${base}/capacity/workloads/me`, {
        headers: empHeaders,
      })
    ).json()
    expect(beforeConfirm.weeks[1].other_percent).toBe(20)
    await teamCard.getByRole("button", { name: "确认", exact: true }).click()
    await expect(teamCard.last().getByRole("status")).toContainText(
      "下属周负荷已更新并通知本人",
    )
    const afterConfirm = await (
      await request.get(`${base}/capacity/workloads/me`, {
        headers: empHeaders,
      })
    ).json()
    expect(afterConfirm.weeks[1].other_percent).toBe(0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
