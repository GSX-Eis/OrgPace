import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { networkInterfaces, tmpdir } from "node:os"
import path from "node:path"
import { expect, type Page, type TestInfo, test } from "@playwright/test"
import type { EmployeeAccount } from "../src/client"
import { expectChineseCopy } from "./utils/copy"

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
})

async function captureDesktop(
  page: Page,
  testInfo: TestInfo,
  filename: string,
): Promise<void> {
  const shot = await page.screenshot({ animations: "disabled" })
  await testInfo.attach(filename, { body: shot, contentType: "image/png" })
  if (!process.env.CI) {
    const dir = path.join(tmpdir(), "nere1348-screenshots")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, filename), shot)
  }
}

test("NERE-1344：差异化预测策略、双向回归、助手业务波动事件确认卡与跨部门可行性全链路 E2E", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  test.setTimeout(210_000)
  const password = "synthetic-nere1348-password-2026"
  const api = async (
    url: string,
    data?: object,
    token?: string,
    method = data ? "POST" : "GET",
  ) => {
    const response = await request.fetch(url, {
      method,
      data,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.headers()["content-type"]?.includes("application/json")
      ? response.json()
      : null
  }

  const setup = await api("/api/v1/private/setup-tokens", {
    purpose: "new_org",
  })
  const admin = await api("/api/v1/setup/initialize", {
    token: setup.token,
    org_name: "合成差异化预测策略全链路企业",
    admin_username: `nere1348-${crypto.randomUUID()}@example.com`,
    admin_password: password,
  })
  const base = `/api/v1/orgs/${admin.org_id}`
  const adminHeaders = { Authorization: `Bearer ${admin.access_token}` }

  await api(
    `${base}/employee-fields`,
    { fields: ["job_family"] },
    admin.access_token,
    "PUT",
  )

  const roster = await request.post(`${base}/roster/imports`, {
    headers: adminHeaders,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          [
            "工号,姓名,部门,岗位序列,上级工号,邮箱",
            `REQ,需求经理,产品部,产品,,req-${crypto.randomUUID()}@example.com`,
            `WM,仓储主管,运营中心,运营,,wm-${crypto.randomUUID()}@example.com`,
            `W1,仓储忙员,仓储部,仓储,WM,w1-${crypto.randomUUID()}@example.com`,
            `W2,仓储闲员,仓储部,仓储,WM,w2-${crypto.randomUUID()}@example.com`,
            `DM,研发主管,技术中心,研发,,dm-${crypto.randomUUID()}@example.com`,
            `D1,研发甲,研发部,研发,DM,d1-${crypto.randomUUID()}@example.com`,
            `D2,研发乙,研发部,研发,DM,d2-${crypto.randomUUID()}@example.com`,
          ].join("\n"),
        ),
      },
    },
  })
  expect(roster.ok(), await roster.text()).toBeTruthy()
  const preview = await roster.json()
  await api(
    `${base}/roster/imports/${preview.id}/apply`,
    { base_revision: preview.base_revision },
    admin.access_token,
  )

  await api(
    `${base}/capabilities/versions`,
    {
      expected_version: 0,
      definitions: [
        {
          key: "delivery",
          name: "合成交付",
          category: "工程",
          description: "跨部门端到端交付能力",
          level_rubric: {
            levels: [
              { key: "routine", label: "独立完成", description: "能独立完成" },
            ],
          },
        },
      ],
    },
    admin.access_token,
  )

  await api(`${base}/accounts/issue`, {}, admin.access_token)
  const accounts: EmployeeAccount[] = (
    await api(`${base}/accounts`, undefined, admin.access_token)
  ).data
  const person = (code: string) =>
    accounts.find((row) => row.employee_code === code)!

  const tokens = new Map<string, string>()
  const managedDeptByCode = new Map<string, string>([
    ["REQ", person("REQ").department!.id],
    ["WM", person("W1").department!.id],
    ["DM", person("D1").department!.id],
  ])
  for (const code of ["REQ", "WM", "DM"]) {
    await api(
      `${base}/role-grants`,
      {
        user_id: person(code).account!.user_id,
        role: "dept_manager",
        department_id: managedDeptByCode.get(code)!,
      },
      admin.access_token,
    )
    const reset = await api(
      `${base}/accounts/${person(code).account!.user_id}/reset-password`,
      {},
      admin.access_token,
    )
    const login = await request.post("/api/v1/login/access-token", {
      form: { username: reset.username, password: reset.initial_password },
    })
    expect(login.ok(), await login.text()).toBeTruthy()
    const changed = await api(
      "/api/v1/users/me/password",
      {
        current_password: reset.initial_password,
        new_password: password,
      },
      (await login.json()).access_token,
      "PATCH",
    )
    tokens.set(code, changed.access_token)
  }
  const requesterToken = tokens.get("REQ")!
  const warehouseManagerToken = tokens.get("WM")!
  const devManagerToken = tokens.get("DM")!

  for (const code of ["W1", "W2", "D1", "D2"]) {
    await api(
      `${base}/employees/${person(code).id}/profile/direct-edits`,
      {
        base_revision: null,
        items: [
          {
            op: "add",
            capability_key: "delivery",
            statement: "独立承担合成交付任务",
            level: "routine",
          },
        ],
      },
      admin.access_token,
    )
  }

  const open = async (token: string, urlPath: string) => {
    await page.goto("/login")
    await page.evaluate(
      ({ token, orgId }) => {
        localStorage.setItem("access_token", token)
        localStorage.setItem("current_org_id", orgId)
      },
      { token, orgId: admin.org_id },
    )
    await page.goto(urlPath)
  }

  // 1. 差异化策略与常态基线/配额解耦
  await open(admin.access_token, "/admin/rules?tab=capacity")
  await page.getByRole("checkbox", { name: "启用规划与负荷功能" }).check()
  const capInput = page.getByLabel("员工默认建议分配上限（配额 %）")
  await expect(capInput).toHaveValue("70")
  await expect(
    page.getByText("预留弹性空间：30%（用于临时/紧急外部需求）"),
  ).toBeVisible()
  await page.getByRole("button", { name: "保存设置", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("负荷与需求规则已保存")
  await expect(page.getByText("70% / 30%")).toBeVisible()

  const policySection = page.getByRole("region", { name: "预测策略配置" })
  await expect(policySection).toContainText("系统默认 0.65")

  // 为「仓储部」配置「脉冲波次型（0）」
  await policySection.getByRole("button", { name: "新增预测策略" }).click()
  const warehousePolicyForm = policySection.getByRole("form", {
    name: "新增预测策略",
  })
  await expect(warehousePolicyForm.getByLabel("常态基线（%）")).toHaveCount(0)
  await expect(warehousePolicyForm.getByLabel("近期惯性周数")).toHaveCount(0)
  await warehousePolicyForm.getByLabel("生效部门").click()
  await page.getByRole("option", { name: "仓储部" }).click()
  await warehousePolicyForm
    .getByRole("button", { name: "脉冲波次型（0）" })
    .click()
  await expect(warehousePolicyForm.getByLabel("周延续系数（0–1）")).toHaveValue(
    "0",
  )
  await expect(
    warehousePolicyForm.getByLabel("周延续系数推演示例"),
  ).toContainText("当前已确认周结束后，后续未排周直接回落至 0%。")
  await warehousePolicyForm.getByRole("button", { name: "保存策略" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "已保存预测策略并重算基线" }),
  ).toBeVisible()

  // 为「研发部」配置「项目延续型（0.8）」
  await policySection.getByRole("button", { name: "新增预测策略" }).click()
  const devPolicyForm = policySection.getByRole("form", {
    name: "新增预测策略",
  })
  await devPolicyForm.getByLabel("生效部门").click()
  await page.getByRole("option", { name: "研发部" }).click()
  await devPolicyForm.getByRole("button", { name: "项目延续型（0.8）" }).click()
  await expect(devPolicyForm.getByLabel("周延续系数（0–1）")).toHaveValue("0.8")
  await expect(devPolicyForm.getByLabel("周延续系数推演示例")).toContainText(
    "按当前负荷 80% 推算：1 周后 65% → 4 周后 35% → 8 周后 15%",
  )
  await devPolicyForm.getByRole("button", { name: "保存策略" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "已保存预测策略并重算基线" }),
  ).toBeVisible()

  const policyList = policySection.getByRole("list", { name: "预测策略列表" })
  const warehouseItem = policyList
    .getByRole("listitem")
    .filter({ hasText: "仓储部" })
  await expect(warehouseItem).toContainText("脉冲波次型")
  await expect(warehouseItem).toContainText("周延续系数 0")

  const devItem = policyList.getByRole("listitem").filter({ hasText: "研发部" })
  await expect(devItem).toContainText("项目延续型")
  await expect(devItem).toContainText("周延续系数 0.8")
  await expect(page.getByText("70% / 30%")).toBeVisible()

  await expectChineseCopy(page)
  await captureDesktop(page, testInfo, "01-admin-forecast-policies.png")

  // 设置本周（week0）历史负荷：W1=90%, W2=20%, D1=90%, D2=90%
  const start = (
    await api(`${base}/capacity/workloads/me`, undefined, warehouseManagerToken)
  ).weeks[0].week_start as string
  const later = (days: number) =>
    new Date(Date.parse(`${start}T12:00:00Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10)
  const week0 = start
  const week1 = later(7)
  const week1End = later(13)

  await api(
    `${base}/capacity/weeks`,
    {
      items: [
        { employee_id: person("W1").id, other_percent: 90 },
        { employee_id: person("W2").id, other_percent: 20 },
      ],
      start_week: week0,
      end_week: week0,
    },
    warehouseManagerToken,
    "PUT",
  )
  await api(
    `${base}/capacity/weeks`,
    {
      items: [
        { employee_id: person("D1").id, other_percent: 90 },
        { employee_id: person("D2").id, other_percent: 90 },
      ],
      start_week: week0,
      end_week: week0,
    },
    devManagerToken,
    "PUT",
  )

  // 验证同为近期 90% 历史负荷下：仓储部(0)次周立即归 0%，研发部(0.8)按 90 * 0.8^steps 平滑衰减，常规配额仍为 70%
  await open(admin.access_token, "/capacity?tab=team")
  const teamTable = page.getByRole("table", {
    name: "团队负荷，按部门、姓名排序",
  })
  const w1AdminRow = teamTable.getByRole("row").filter({ hasText: "仓储忙员" })
  const d1AdminRow = teamTable.getByRole("row").filter({ hasText: "研发甲" })

  await expect(w1AdminRow.getByText("90% / 100%", { exact: true })).toHaveCount(
    1,
  )
  await expect(
    w1AdminRow.getByText("预计 0% / 70%", { exact: true }),
  ).toHaveCount(7)

  await expect(d1AdminRow.getByText("90% / 100%", { exact: true })).toHaveCount(
    1,
  )
  for (const pct of [70, 60, 45, 35, 30, 25, 20]) {
    await expect(
      d1AdminRow.getByText(`预计 ${pct}% / 70%`, { exact: true }),
    ).toHaveCount(1)
  }

  // 2. 优先级守护：confirmed > manager_override > agent_auto
  await open(warehouseManagerToken, "/capacity?tab=team")
  const mgrTable = page.getByRole("table", {
    name: "团队负荷，按部门、姓名排序",
  })
  const w2Row = mgrTable.getByRole("row").filter({ hasText: "仓储闲员" })

  // W2 近期 20% 负荷在脉冲(0)下：week1..7 全部立即回落至 0%
  await expect(w2Row.getByText("20% / 100%", { exact: true })).toHaveCount(1)
  await expect(w2Row.getByText("预计 0% / 70%", { exact: true })).toHaveCount(7)

  // 对 W2 第 3 周（week2）转为正式确认（25%）
  await w2Row
    .getByRole("button", { name: /预计 0% \/ 70%.*查看负荷明细$/ })
    .nth(1)
    .click()
  const w2DetailsDrawer = page.getByRole("dialog", {
    name: "负荷明细 · 仓储闲员",
  })
  await w2DetailsDrawer.getByRole("button", { name: "转为正式确认" }).click()
  const w2EditDrawer = page.getByRole("dialog", {
    name: "设置周投入 · 仓储闲员",
  })
  await w2EditDrawer.getByLabel("其他工作占比（%）").fill("25")
  await w2EditDrawer.getByRole("button", { name: "确认设置" }).click()
  await expect(w2EditDrawer).toBeHidden()
  await expect(w2Row.getByText("25% / 100%", { exact: true })).toHaveCount(1)

  // 对 W2 第 4 周（week3）执行经理手动修正（manager_override = 60%）
  await w2Row
    .getByRole("button", { name: /预计 0% \/ 70%.*查看负荷明细$/ })
    .nth(1)
    .click()
  await w2DetailsDrawer.getByRole("button", { name: "调整预测基线" }).click()
  const w2OverrideDrawer = page.getByRole("dialog", {
    name: "调整预测基线 · 仓储闲员",
  })
  await w2OverrideDrawer.getByLabel("预测平台外占比（%）").fill("60")
  await w2OverrideDrawer.getByLabel("调整说明（选填）").fill("经理手动修正保护")
  await w2OverrideDrawer.getByRole("button", { name: "保存预测基线" }).click()
  await expect(w2OverrideDrawer).toBeHidden()
  await expect(w2Row.getByText("已修正基线", { exact: true })).toHaveCount(1)
  await expect(w2Row.getByText("预计 60% / 70%", { exact: true })).toHaveCount(
    1,
  )

  // 修改策略为 0.5 并刷新预测基线后，confirmed 与 manager_override 均未被覆盖
  await page.getByRole("button", { name: "预测策略与事件" }).click()
  const policyDrawer = page.getByRole("dialog", { name: "预测策略与事件" })
  const mgrPolicyList = policyDrawer.getByRole("list", {
    name: "预测策略列表",
  })
  await mgrPolicyList
    .getByRole("listitem")
    .filter({ hasText: "仓储部" })
    .getByRole("button", { name: "编辑" })
    .click()
  const editWarehousePolicyForm = policyDrawer.getByRole("form", {
    name: "编辑预测策略",
  })
  await editWarehousePolicyForm.getByLabel("周延续系数（0–1）").fill("0.5")
  await editWarehousePolicyForm
    .getByRole("button", { name: "保存策略" })
    .click()
  await expect(policyDrawer.getByRole("status")).toContainText(
    "已保存预测策略并重算基线",
  )
  await policyDrawer.press("Escape")
  await expect(policyDrawer).toBeHidden()

  await expect(w2Row.getByText("25% / 100%", { exact: true })).toHaveCount(1)
  await expect(w2Row.getByText("已修正基线", { exact: true })).toHaveCount(1)
  await expect(w2Row.getByText("预计 60% / 70%", { exact: true })).toHaveCount(
    1,
  )
  // week1<=anchor_week(week2) -> round_5(22.5)=25%; week4 -> round_5(22.5*0.25)=5%
  await expect(w2Row.getByText("预计 25% / 70%", { exact: true })).toHaveCount(
    1,
  )
  await expect(w2Row.getByText("预计 5% / 70%", { exact: true })).toHaveCount(1)

  // 恢复仓储部系数至 0 并再次刷新全员预测基线，确认两者仍受保护
  await page.getByRole("button", { name: "预测策略与事件" }).click()
  await expect(policyDrawer).toBeVisible()
  await mgrPolicyList
    .getByRole("listitem")
    .filter({ hasText: "仓储部" })
    .getByRole("button", { name: "编辑" })
    .click()
  await editWarehousePolicyForm.getByLabel("周延续系数（0–1）").fill("0")
  await editWarehousePolicyForm
    .getByRole("button", { name: "保存策略" })
    .click()
  await expect(policyDrawer.getByRole("status")).toContainText(
    "已保存预测策略并重算基线",
  )
  await policyDrawer.press("Escape")
  await expect(policyDrawer).toBeHidden()

  await page.getByRole("button", { name: "刷新预测基线" }).click()
  await expect(page.getByRole("status")).toContainText("已刷新预测基线")
  await expect(w2Row.getByText("25% / 100%", { exact: true })).toHaveCount(1)
  await expect(w2Row.getByText("已修正基线", { exact: true })).toHaveCount(1)
  await expect(w2Row.getByText("预计 60% / 70%", { exact: true })).toHaveCount(
    1,
  )
  await expect(w2Row.getByText("预计 0% / 70%", { exact: true })).toHaveCount(4)

  // 3. Agent 对话调整周延续系数（0.8）+ 动态注入业务波动事件 + 确认卡闭环（本地合成上游模型）
  const warehouseDeptId = person("W1").department!.id
  let sawGetForecastConfig = false
  let sawPrepareForecastPolicy = false
  let sawPrepareForecastEvent = false

  const server = createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const messages = body.messages as Array<{ role: string; content?: unknown }>
    const lastMessage = messages[messages.length - 1]
    const lastUser = [...messages]
      .reverse()
      .find((item) => item.role === "user")
    const userText = JSON.stringify(lastUser?.content ?? "")

    let delta: Record<string, unknown>
    let finishReason = "stop"

    if (userText.includes("延续系数")) {
      if (lastMessage?.role !== "tool") {
        delta = {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_get_forecast_config_policy",
              type: "function",
              function: {
                name: "coordination",
                arguments: JSON.stringify({
                  function: "get_forecast_config",
                  arguments: {},
                }),
              },
            },
          ],
        }
        finishReason = "tool_calls"
      } else {
        const toolContent =
          typeof lastMessage.content === "string"
            ? lastMessage.content
            : JSON.stringify(lastMessage.content ?? "")
        if (toolContent.includes("default_retention_rate")) {
          sawGetForecastConfig = true
          const parsed = JSON.parse(toolContent) as {
            departments?: Array<{ id: string; name: string }>
          }
          const matchedDept =
            parsed.departments?.find((dept) => dept.name === "仓储部")?.id ??
            warehouseDeptId
          delta = {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_prepare_forecast_policy",
                type: "function",
                function: {
                  name: "coordination",
                  arguments: JSON.stringify({
                    function: "prepare_forecast_policy",
                    arguments: {
                      action: "upsert",
                      department_id: matchedDept,
                      retention_rate: 0.8,
                      note: "项目期间按 0.8 延续",
                    },
                  }),
                },
              },
            ],
          }
          finishReason = "tool_calls"
        } else {
          sawPrepareForecastPolicy = true
          delta = {
            role: "assistant",
            content:
              "已生成仓储部周延续系数调整确认卡（0.8 项目延续型），请核对适用范围与修改前后对比后点击确认。",
          }
        }
      }
    } else if (userText.includes("进货")) {
      if (lastMessage?.role !== "tool") {
        delta = {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_get_forecast_config",
              type: "function",
              function: {
                name: "coordination",
                arguments: JSON.stringify({
                  function: "get_forecast_config",
                  arguments: {},
                }),
              },
            },
          ],
        }
        finishReason = "tool_calls"
      } else {
        const toolContent =
          typeof lastMessage.content === "string"
            ? lastMessage.content
            : JSON.stringify(lastMessage.content ?? "")
        if (toolContent.includes("default_retention_rate")) {
          sawGetForecastConfig = true
          const parsed = JSON.parse(toolContent) as {
            departments?: Array<{ id: string; name: string }>
          }
          const matchedDept =
            parsed.departments?.find((dept) => dept.name === "仓储部")?.id ??
            warehouseDeptId
          delta = {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_prepare_forecast_event",
                type: "function",
                function: {
                  name: "coordination",
                  arguments: JSON.stringify({
                    function: "prepare_forecast_event",
                    arguments: {
                      action: "create",
                      department_id: matchedDept,
                      title: "下周无进货",
                      start_week: week1,
                      end_week: week1,
                      modifier_kind: "multiplier",
                      modifier_value: 0.4,
                      reason: "下周供应商无进货",
                    },
                  }),
                },
              },
            ],
          }
          finishReason = "tool_calls"
        } else {
          sawPrepareForecastEvent = true
          delta = {
            role: "assistant",
            content:
              "已生成「下周无进货」业务波动事件确认卡，请核对生效部门、起止周与系数后点击确认。",
          }
        }
      }
    } else if (lastMessage?.role !== "tool") {
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_feasibility",
            type: "function",
            function: {
              name: "coordination",
              arguments: JSON.stringify({
                function: "assess_cross_department_feasibility",
                arguments: {
                  capability_key: "delivery",
                  window_start: week1,
                  window_end: week1End,
                  estimated_headcount: 1,
                  estimated_allocation_percent: 65,
                },
              }),
            },
          },
        ],
      }
      finishReason = "tool_calls"
    } else {
      delta = {
        role: "assistant",
        content:
          "已完成跨部门可行性评估：仓储部在下周无进货事件重算后基于预测基线可承接该需求，需动用弹性空间并由目标部门经理最终确认。",
      }
    }

    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(
      `data: ${JSON.stringify({
        id: "nere1348-e2e",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta,
            finish_reason: finishReason,
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve))
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Missing mock model address")
  }
  const host =
    process.env.MODEL_TEST_HOST ??
    (baseURL?.includes("backend:")
      ? Object.values(networkInterfaces())
          .flat()
          .find((network) => network?.family === "IPv4" && !network.internal)
          ?.address
      : "localhost")

  try {
    await api(
      `${base}/model-setting`,
      {
        enabled: true,
        kind: "openai_compatible",
        provider: "openai-compatible",
        model: "synthetic",
        base_url: `http://${host}:${address.port}/v1`,
        api_key: "synthetic-key",
      },
      admin.access_token,
      "PUT",
    )

    // 部门经理在 /assistant 对话调整周延续系数（0.8）并确认，随后注入业务波动事件
    await open(warehouseManagerToken, "/assistant")
    const mgrAssistantPanel = page.getByRole("region", {
      name: "助手",
      exact: true,
    })
    await mgrAssistantPanel
      .getByLabel("发给助手的消息")
      .fill("把仓储部的周延续系数调整为 0.8")
    await mgrAssistantPanel
      .getByRole("button", { name: "发送", exact: true })
      .click()

    const mgrLog = page.getByRole("log")
    const policyCard = mgrLog.getByRole("region", { name: "配置负荷预测策略" })
    await expect(policyCard).toBeVisible()
    expect(sawPrepareForecastPolicy).toBeTruthy()
    await expect(policyCard).toContainText("适用范围：仓储部")
    await expect(policyCard).toContainText("周延续系数：0.8（项目延续型")
    await expect(policyCard).toContainText("修改前：")
    await expect(policyCard).toContainText("修改后：0.8")
    await expect(policyCard).toContainText("受影响人数：2 名在职员工")
    await expect(policyCard).not.toContainText("常态基线")
    await expect(policyCard).not.toContainText("惯性")
    await captureDesktop(
      page,
      testInfo,
      "02-assistant-forecast-policy-card.png",
    )
    await policyCard.getByRole("button", { name: "确认", exact: true }).click()
    await expect(policyCard.getByRole("status")).toContainText(
      "预测策略已保存，已重算",
    )

    await mgrAssistantPanel
      .getByLabel("发给助手的消息")
      .fill("下周供应商无进货，仓储部负荷按 0.4 系数下调")
    await mgrAssistantPanel
      .getByRole("button", { name: "发送", exact: true })
      .click()

    const eventCard = mgrLog.getByRole("region", { name: "注入业务波动事件" })
    await expect(eventCard).toBeVisible()
    expect(sawGetForecastConfig).toBeTruthy()
    expect(sawPrepareForecastEvent).toBeTruthy()

    await expect(eventCard).toContainText("事件名称：下周无进货")
    await expect(eventCard).toContainText("生效范围：仓储部")
    await expect(eventCard).toContainText(`起止周：${week1} 至 ${week1}`)
    await expect(eventCard).toContainText("修正方式：×0.4")
    await expect(eventCard).toContainText("原因说明：下周供应商无进货")
    for (const code of ["WM", "W1", "W2"]) {
      await expect(eventCard).not.toContainText(person(code).display_name)
      await expect(eventCard).not.toContainText(person(code).id)
    }

    await expectChineseCopy(page)
    await eventCard.scrollIntoViewIfNeeded()
    await captureDesktop(page, testInfo, "03-assistant-forecast-event-card.png")

    await eventCard.getByRole("button", { name: "确认", exact: true }).click()
    await expect(eventCard.getByRole("status")).toContainText(
      "业务波动事件已注入，已重算",
    )

    // 切回 /capacity?tab=team 验证目标周预测值已按 90 * 0.8 * 0.4 = 28.8 -> 30% 重算，抽屉可见策略标签与事件徽标
    await open(warehouseManagerToken, "/capacity?tab=team")
    const updatedTable = page.getByRole("table", {
      name: "团队负荷，按部门、姓名排序",
    })
    const updatedW1Row = updatedTable
      .getByRole("row")
      .filter({ hasText: "仓储忙员" })
    const eventCell = updatedW1Row
      .getByRole("button", { name: /预计 30% \/ 70%.*查看负荷明细$/ })
      .first()
    await expect(eventCell).toBeVisible()
    await eventCell.click()

    const w1DetailsDrawer = page.getByRole("dialog", {
      name: "负荷明细 · 仓储忙员",
    })
    await expect(w1DetailsDrawer).toContainText(
      "策略：周延续系数 0.8（仓储部）",
    )
    await expect(w1DetailsDrawer).toContainText("事件：下周无进货（×0.4）")
    await expect(w1DetailsDrawer).toContainText(
      "来源：周延续系数 0.8（仓储部）：基于近 1 周已确认均值 90%逐周衰减；业务事件：下周无进货（×0.4）",
    )
    await expectChineseCopy(page)
    await captureDesktop(
      page,
      testInfo,
      "04-team-workload-policy-event-drawer.png",
    )

    // 4. 跨部门可行性评估无缝衔接与隐私红线
    await open(requesterToken, "/assistant")
    const reqPanel = page.getByRole("region", { name: "助手", exact: true })
    await reqPanel
      .getByLabel("发给助手的消息")
      .fill(
        `请评估 ${week1} 至 ${week1End} 期间各部门能否承接 65% 投入的合成交付需求`,
      )
    await reqPanel.getByRole("button", { name: "发送", exact: true }).click()

    const reqLog = page.getByRole("log")
    const feasibilityCard = reqLog.getByRole("region", {
      name: "合成交付跨部门可行性",
    })
    await expect(feasibilityCard).toContainText(
      `评估时间窗 ${week1} 至 ${week1End} · 常规配额 70% / 弹性空间 30%`,
    )
    const warehouseDeptItem = feasibilityCard
      .getByRole("listitem")
      .filter({ hasText: "仓储部" })
    // 仓储部 2 人在 week1 预测分别为 W1=30%、W2=10%，均值 (30+10)/2 = 20%
    // 常规配额已用 20%/余量 50%，弹性空间已用 0%/余量 30%
    await expect(warehouseDeptItem).toContainText("20%")
    await expect(warehouseDeptItem).toContainText(
      "常规配额（上限 70%）：已用 20% · 余量 50%",
    )
    await expect(warehouseDeptItem).toContainText(
      "弹性空间（30%）：已用 0% · 余量 30%",
    )
    await expect(warehouseDeptItem).toContainText("有空承接")
    await expect(warehouseDeptItem).toContainText("预测基线")
    await expect(warehouseDeptItem).toContainText("需动用弹性空间")
    await expect(warehouseDeptItem).toContainText(`最早可能开始：${week1}`)
    await expect(feasibilityCard).toContainText(
      "提示：预测基线由系统基于历史排期与在途工作自动估算；动用弹性空间需目标部门经理最终确认。",
    )

    for (const code of ["WM", "W1", "W2", "DM", "D1", "D2"]) {
      const member = person(code)
      if (!member.employee_code) {
        throw new Error(`Expected employee_code for ${code}`)
      }
      await expect(reqLog).not.toContainText(member.display_name)
      await expect(reqLog).not.toContainText(member.id)
      await expect(reqLog).not.toContainText(member.employee_code)
    }
    for (const forbidden of [
      "个人负荷",
      "周负荷",
      "平台分配",
      "其他工作占比",
    ]) {
      await expect(reqLog).not.toContainText(forbidden)
    }

    await expectChineseCopy(page)
    await feasibilityCard.scrollIntoViewIfNeeded()
    await captureDesktop(
      page,
      testInfo,
      "05-cross-dept-feasibility-after-event.png",
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
