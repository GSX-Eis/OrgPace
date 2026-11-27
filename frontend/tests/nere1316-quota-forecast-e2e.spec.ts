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
  name: string,
): Promise<void> {
  const shot = await page.screenshot({ animations: "disabled" })
  await testInfo.attach(name, { body: shot, contentType: "image/png" })
  if (!process.env.CI) {
    const dir = path.join(tmpdir(), "nere1320-screenshots")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${name}.png`), shot)
  }
}

test("NERE-1316：配额设置 → 预测基线排期表 → 弹性求解 → 跨部门远期可行性卡片端到端回归", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000)
  const password = "synthetic-nere1316-password-2026"
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
    org_name: "合成配额与预测基线企业",
    admin_username: `nere1316-${crypto.randomUUID()}@example.com`,
    admin_password: password,
  })
  const base = `/api/v1/orgs/${admin.org_id}`
  const adminHeaders = { Authorization: `Bearer ${admin.access_token}` }

  const roster = await request.post(`${base}/roster/imports`, {
    headers: adminHeaders,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          [
            "工号,姓名,部门,上级工号,邮箱",
            `A,合成需求经理,产品部,,a-${crypto.randomUUID()}@example.com`,
            `M,合成研发经理,研发部,,m-${crypto.randomUUID()}@example.com`,
            `B1,合成研发甲,研发部,M,b1-${crypto.randomUUID()}@example.com`,
            `B2,合成研发乙,研发部,M,b2-${crypto.randomUUID()}@example.com`,
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
  for (const code of ["A", "M"]) {
    await api(
      `${base}/role-grants`,
      {
        user_id: person(code).account!.user_id,
        role: "dept_manager",
        department_id: person(code).department!.id,
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
  const requesterToken = tokens.get("A")!
  const managerToken = tokens.get("M")!

  for (const code of ["B1", "B2"]) {
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

  // 1. 管理员「规划与负荷设置」页：验证默认 70% 配额与 30% 弹性空间联动并保存
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
  await captureDesktop(page, testInfo, "01-admin-capacity-settings")

  // 2. 部门经理「团队负荷」甘特图：设置正式排期，生成预测基线与手动修正基线并核对抽屉来源说明
  const start = (
    await api(`${base}/capacity/workloads/me`, undefined, managerToken)
  ).weeks[0].week_start as string
  const later = (days: number) =>
    new Date(Date.parse(`${start}T12:00:00Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10)

  await api(
    `${base}/capacity/weeks`,
    {
      items: [{ employee_id: person("B2").id, other_percent: 30 }],
      start_week: start,
      end_week: later(7),
    },
    managerToken,
    "PUT",
  )

  await open(managerToken, "/capacity?tab=team")
  const workloadTable = page.getByRole("table", {
    name: "团队负荷，按部门、姓名排序",
  })
  const b1Row = workloadTable.getByRole("row").filter({ hasText: "合成研发甲" })
  const b2Row = workloadTable.getByRole("row").filter({ hasText: "合成研发乙" })

  await b1Row.getByRole("button", { name: "设置", exact: true }).click()
  const editDrawer = page.getByRole("dialog", {
    name: "设置周投入 · 合成研发甲",
  })
  await editDrawer.getByLabel("其他工作占比（%）").fill("80")
  await editDrawer.getByRole("button", { name: "确认设置" }).click()
  await expect(editDrawer).toBeHidden()

  // B1 本周正式确认 80% / 100%（突破常规上限动用弹性 10%），第 1..7 周按系统默认周延续系数 0.65 逐周衰减：50%、35%、20%、15%...
  await expect(b1Row.getByText("80% / 100%", { exact: true })).toHaveCount(1)
  await expect(b1Row.getByText("动用弹性 10%", { exact: true })).toHaveCount(1)
  await expect(b1Row.getByText("预测基线", { exact: true })).toHaveCount(7)
  await expect(b1Row.getByText("预计 50% / 70%", { exact: true })).toHaveCount(
    1,
  )
  await expect(b1Row.getByText("预计 35% / 70%", { exact: true })).toHaveCount(
    1,
  )
  await expect(b1Row.getByText("预计 20% / 70%", { exact: true })).toHaveCount(
    1,
  )
  await expect(b1Row.getByText("预计 15% / 70%", { exact: true })).toHaveCount(
    1,
  )
  // B2 第 0..1 周正式确认 30% / 100%，第 2..7 周按 0.65 逐周衰减
  await expect(b2Row.getByText("30% / 100%", { exact: true })).toHaveCount(2)
  await expect(b2Row.getByText("预测基线", { exact: true })).toHaveCount(6)

  // 手动修正 B1 第 2 周（35%）预测基线为 60%，并在同画面打开第 1 周（50%）预测基线抽屉查看来源说明
  const b1Week4Cell = b1Row.getByRole("button", {
    name: /预计 50% \/ 70%.*查看负荷明细$/,
  })
  const b1Week5Cell = b1Row.getByRole("button", {
    name: /预计 35% \/ 70%.*查看负荷明细$/,
  })
  await b1Week5Cell.click()
  const detailsDrawer = page.getByRole("dialog", {
    name: "负荷明细 · 合成研发甲",
  })
  await detailsDrawer.getByRole("button", { name: "调整预测基线" }).click()
  const forecastForm = page.getByRole("dialog", {
    name: "调整预测基线 · 合成研发甲",
  })
  await forecastForm.getByLabel("预测平台外占比（%）").fill("60")
  await forecastForm.getByLabel("调整说明（选填）").fill("客户专项支持")
  await forecastForm.getByRole("button", { name: "保存预测基线" }).click()
  await expect(forecastForm).toBeHidden()
  await expect(b1Row.getByText("已修正基线", { exact: true })).toHaveCount(1)
  await expect(b1Row.getByText("预计 60% / 70%", { exact: true })).toHaveCount(
    1,
  )

  await b1Week4Cell.click()
  await expect(detailsDrawer).toContainText("常规配额上限 70% · 弹性空间 30%")
  await expect(detailsDrawer).toContainText(
    "来源：周延续系数 0.65（系统默认）：基于近 1 周已确认均值 80%逐周衰减",
  )
  await captureDesktop(page, testInfo, "02-manager-team-workload-forecast")

  // 刷新全员预测基线（为同部门经理同步生成预测行，且保留已修正基线）
  await detailsDrawer.press("Escape")
  await page.getByRole("button", { name: "刷新预测基线" }).click()
  await expect(page.getByRole("status")).toContainText("已刷新预测基线")
  await expect(b1Row.getByText("已修正基线", { exact: true })).toHaveCount(1)

  // 3. 部门经理「内部方案」页：常规 70% 上限受限 vs 勾选「允许动用弹性空间」生成标注「已占用弹性配额 10%」
  const demand = await api(
    `${base}/capacity/demands`,
    {
      requesting_department_id: person("A").department!.id,
      target_department_id: person("M").department!.id,
      capability_key: "delivery",
      headcount: 1,
      allocation_percent: 50,
      window_start: start,
      window_end: later(13),
      description: "合成配额与弹性空间端到端验证需求",
    },
    requesterToken,
  )

  await open(managerToken, `/capacity?tab=incoming&demand=${demand.id}&plans=1`)
  await expect(
    page.getByText("当前模式：遵循企业常规配额上限（70%）"),
  ).toBeVisible()
  const elasticToggle = page.getByRole("checkbox", { name: "允许动用弹性空间" })
  await expect(elasticToggle).not.toBeChecked()
  const directCard = page.getByRole("article", { name: "直接安排方案" })
  await expect(directCard).toContainText("直接安排 · 不可行")
  await expect(directCard).toContainText("超出常规配额")

  await elasticToggle.check()
  const elasticRespPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/planning/demands/${demand.id}/cases`) &&
      response.request().method() === "POST",
  )
  await page.getByRole("button", { name: "重新模拟" }).click()
  const elasticResp = await elasticRespPromise
  expect(elasticResp.ok()).toBeTruthy()
  expect(elasticResp.request().postDataJSON()).toEqual({ allow_elastic: true })

  await expect(
    page.getByText(
      "当前模式：已允许动用弹性空间（常规配额上限 70%，最高不超过员工可用容量）",
    ),
  ).toBeVisible()
  await expect(directCard).toContainText("直接安排 · 可行")
  await expect(directCard).toContainText("已占用弹性配额 10%")
  await captureDesktop(page, testInfo, "03-manager-plans-elastic")

  // 4. 跨部门需求方在内置助手查询 6–8 周后远期时段，收到真实 backend 计算的 FeasibilityCard
  const farStart = later(42)
  const farEnd = later(55)
  const server = createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const done = body.messages.at(-1).role === "tool"
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(
      `data: ${JSON.stringify({
        id: "nere1316-e2e",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: done
              ? {
                  role: "assistant",
                  content:
                    "已完成 6 至 8 周后远期时段评估：研发部基于预测基线可承接该需求，当前常规配额余量不足，需动用弹性空间并由目标部门经理最终确认。",
                }
              : {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "feasibility_call",
                      type: "function",
                      function: {
                        name: "coordination",
                        arguments: JSON.stringify({
                          function: "assess_cross_department_feasibility",
                          arguments: {
                            capability_key: "delivery",
                            window_start: farStart,
                            window_end: farEnd,
                            estimated_headcount: 1,
                            estimated_allocation_percent: 70,
                          },
                        }),
                      },
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

    await open(requesterToken, "/assistant")
    const panel = page.getByRole("region", { name: "助手", exact: true })
    await panel
      .getByLabel("发给助手的消息")
      .fill(`请评估 ${farStart} 至 ${farEnd} 期间研发团队能否承接合成交付需求`)
    await panel.getByRole("button", { name: "发送", exact: true }).click()

    const log = page.getByRole("log")
    const card = log.getByRole("region", { name: "合成交付跨部门可行性" })
    await expect(card).toContainText(
      `评估时间窗 ${farStart} 至 ${farEnd} · 常规配额 70% / 弹性空间 30%`,
    )
    const deptItem = card.getByRole("listitem").filter({ hasText: "研发部" })
    await expect(deptItem).toContainText("3%")
    await expect(deptItem).toContainText(
      "常规配额（上限 70%）：已用 3% · 余量 67%",
    )
    await expect(deptItem).toContainText("弹性空间（30%）：已用 0% · 余量 30%")
    await expect(deptItem).toContainText("有空承接")
    await expect(deptItem).toContainText("预测基线")
    await expect(deptItem).toContainText("需动用弹性空间")
    await expect(deptItem).toContainText(`最早可能开始：${farStart}`)
    await expect(card).toContainText(
      "提示：预测基线由系统基于历史排期与在途工作自动估算；动用弹性空间需目标部门经理最终确认。",
    )
    for (const code of ["M", "B1", "B2"]) {
      await expect(log).not.toContainText(person(code).display_name)
      await expect(log).not.toContainText(person(code).id)
    }
    await expectChineseCopy(page)
    await card.scrollIntoViewIfNeeded()
    await captureDesktop(page, testInfo, "04-requester-assistant-feasibility")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
