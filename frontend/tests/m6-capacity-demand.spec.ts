import { expect, test } from "@playwright/test"
import type { EmployeeAccount } from "../src/client"

test.use({ storageState: { cookies: [], origins: [] } })

test("无模型时需求表单完成跨部门承诺且 A 方只见汇总", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(10000)
  const password = "synthetic-demand-password-2026"
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
    org_name: "合成需求企业",
    admin_username: `demands-${crypto.randomUUID()}@example.com`,
    admin_password: password,
  })
  const base = `/api/v1/orgs/${admin.org_id}`
  const headers = { Authorization: `Bearer ${admin.access_token}` }
  const people = [
    ["A", "客户员工", "客户", ""],
    ["M", "合成答复经理", "研发", ""],
    ["B1", "研发甲合成", "研发", "M"],
    ["B2", "研发乙合成", "研发", "M"],
    ["B3", "研发丙合成", "研发", "M"],
    ["B4", "研发丁合成", "研发", "M"],
  ]
  const roster = await request.post(`${base}/roster/imports`, {
    headers,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          `工号,姓名,部门,上级工号,邮箱\n${people.map((row) => `${row.join(",")},${crypto.randomUUID()}@example.com`).join("\n")}\n`,
        ),
      },
    },
  })
  expect(roster.ok()).toBeTruthy()
  const preview = await roster.json()
  await post(
    `${base}/roster/imports/${preview.id}/apply`,
    { base_revision: preview.base_revision },
    admin.access_token,
  )
  await post(
    `${base}/capabilities/versions`,
    {
      expected_version: 0,
      definitions: [
        {
          key: "delivery",
          name: "合成交付能力",
          category: "工程",
          description: "合成测试",
          level_rubric: {
            levels: [
              { key: "routine", label: "独立完成", description: "能独立完成" },
              {
                key: "advanced",
                label: "复杂任务",
                description: "能处理复杂任务",
              },
            ],
          },
        },
      ],
    },
    admin.access_token,
  )
  expect(
    (await request.post(`${base}/accounts/issue`, { headers, data: {} })).ok(),
  ).toBeTruthy()
  const accounts: EmployeeAccount[] = (
    await (await request.get(`${base}/accounts`, { headers })).json()
  ).data
  const employee = accounts.find((row) => row.employee_code === "A")!
  const manager = accounts.find((row) => row.employee_code === "M")!
  await post(
    `${base}/role-grants`,
    {
      user_id: manager.account!.user_id,
      role: "dept_manager",
      department_id: manager.department!.id,
    },
    admin.access_token,
  )
  const tokens = new Map<string, string>()
  for (const account of [employee, manager]) {
    const reset = await post(
      `${base}/accounts/${account.account!.user_id}/reset-password`,
      {},
      admin.access_token,
    )
    const login = await request.post("/api/v1/login/access-token", {
      form: { username: reset.username, password: reset.initial_password },
    })
    expect(login.ok()).toBeTruthy()
    const changed = await request.patch("/api/v1/users/me/password", {
      headers: { Authorization: `Bearer ${(await login.json()).access_token}` },
      data: {
        current_password: reset.initial_password,
        new_password: password,
      },
    })
    expect(changed.ok()).toBeTruthy()
    tokens.set(account.employee_code!, (await changed.json()).access_token)
  }
  for (const person of accounts.filter((row) =>
    row.employee_code?.startsWith("B"),
  )) {
    await post(
      `${base}/employees/${person.id}/profile/direct-edits`,
      {
        base_revision: null,
        items: [
          {
            op: "add",
            capability_key: "delivery",
            statement: "合成工作经历",
            level: "routine",
          },
        ],
      },
      admin.access_token,
    )
  }
  const settings = async (requester_policy: "everyone" | "managers") => {
    const response = await request.put(`${base}/capacity-settings`, {
      headers,
      data: { enabled: true, requester_policy },
    })
    expect(response.ok()).toBeTruthy()
  }
  await settings("everyone")
  const windowStart = (
    await (
      await request.get(`${base}/capacity/workloads/me`, {
        headers: { Authorization: `Bearer ${tokens.get("M")}` },
      })
    ).json()
  ).weeks[0].week_start as string
  const windowEnd = new Date(Date.parse(windowStart) + 6 * 86400000)
    .toISOString()
    .slice(0, 10)
  for (const [code, base_percent] of [
    ["B1", 50],
    ["B2", 90],
    ["B3", 110],
  ] as const) {
    const person = accounts.find((row) => row.employee_code === code)!
    expect(
      (
        await request.put(`${base}/capacity/weeks`, {
          headers: { Authorization: `Bearer ${tokens.get("M")}` },
          data: {
            items: [{ employee_id: person.id, other_percent: base_percent }],
            start_week: (
              await (
                await request.get(`${base}/capacity/workloads/me`, {
                  headers: { Authorization: `Bearer ${tokens.get("M")}` },
                })
              ).json()
            ).weeks[0].week_start,
            end_week: (
              await (
                await request.get(`${base}/capacity/workloads/me`, {
                  headers: { Authorization: `Bearer ${tokens.get("M")}` },
                })
              ).json()
            ).weeks[0].week_start,
          },
        })
      ).ok(),
    ).toBeTruthy()
  }
  const signIn = async (token: string) => {
    await page.goto("/login")
    await page.evaluate(
      ({ token, orgId }) => {
        localStorage.setItem("access_token", token)
        localStorage.setItem("current_org_id", orgId)
      },
      { token, orgId: admin.org_id },
    )
  }
  const open = async (token: string, tab: string) => {
    await signIn(token)
    await page.goto(`/capacity?tab=${tab}`)
    await expect(
      page.getByRole("heading", {
        name:
          tab === "incoming"
            ? "待审批"
            : tab === "team"
              ? "团队负荷"
              : "协作需求",
        exact: true,
      }),
    ).toBeVisible()
    await expect(page.getByRole("status", { name: "正在加载" })).toHaveCount(0)
  }
  const privateNames = people
    .filter(([code]) => code.startsWith("B"))
    .map(([, name]) => name)
  const privatePage = async () => {
    for (const name of privateNames)
      await expect(page.locator("body")).not.toContainText(name)
    await expect(
      page.getByRole("region", { name: "本部门匹配人员" }),
    ).toHaveCount(0)
  }
  await open(tokens.get("A")!, "outgoing")
  await privatePage()
  await expect(
    page.getByRole("link", { name: "协作需求", exact: true }),
  ).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 700 })
  await page.getByRole("button", { name: "新建需求" }).click()
  await page
    .getByLabel("需求方部门", { exact: true })
    .selectOption(employee.department!.id)
  await page
    .getByLabel("目标部门", { exact: true })
    .selectOption(manager.department!.id)
  await page.getByLabel("能力", { exact: true }).selectOption("delivery")
  await page.getByLabel("最低等级").selectOption("routine")
  await expect(page.getByLabel("人数", { exact: true })).toHaveCount(0)
  await expect(page.getByLabel("每人投入比例（%）")).toHaveCount(0)
  await page.getByLabel("开始日期").fill(windowStart)
  await page.getByLabel("结束日期").fill(windowEnd)
  const assess = page.getByRole("button", { name: "评估承接部门" })
  const target = page.getByLabel("目标部门", { exact: true })
  await assess.click()
  await expect(
    target.locator(`option[value="${manager.department!.id}"]`),
  ).toContainText("可承接")
  await expect(target).not.toContainText(/\d+\s*人|有余量|基本满|超负荷/)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.screenshot({
    path: test.info().outputPath("01-create.png"),
    animations: "disabled",
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 700 })
  await page.getByLabel("最低等级").selectOption("advanced")
  await assess.click()
  await expect(
    target.locator(`option[value="${manager.department!.id}"]`),
  ).toContainText("暂不可承接")
  await page.getByLabel("最低等级").selectOption("routine")
  await privatePage()
  await page.getByLabel("需求说明").fill("合成需求：接口联调")
  await page.getByRole("button", { name: "预览需求" }).click()
  const demandPreview = page.getByRole("region", { name: "需求预览" })
  await expect(demandPreview).toContainText("客户 → 研发")
  await expect(demandPreview).toContainText("独立完成")
  await privatePage()
  await page.getByRole("button", { name: "返回修改" }).click()
  await expect(demandPreview).toHaveCount(0)
  const drawer = page.getByRole("dialog", { name: "新建协作需求" })
  const confirm = demandPreview.getByRole("button", { name: "确认提交需求" })
  await page
    .getByLabel("结束日期")
    .fill(
      new Date(Date.parse(windowStart) - 86400000).toISOString().slice(0, 10),
    )
  await page.getByRole("button", { name: "预览需求" }).click()
  await expect.soft(confirm).toBeInViewport()
  await confirm.click()
  await expect(drawer.getByRole("alert")).toContainText(
    "结束日期不能早于开始日期",
  )
  await page.getByRole("button", { name: "返回修改" }).click()
  await page.getByLabel("结束日期").fill(windowEnd)
  await page.getByRole("button", { name: "预览需求" }).click()
  await page.route(
    `**${base}/capacity/demands`,
    async (route) => {
      await route.fulfill({ status: 500 })
    },
    { times: 1 },
  )
  await confirm.click()
  await expect(drawer.getByRole("alert")).toContainText("服务暂时异常")
  await expect(drawer).toBeVisible()
  await confirm.click()
  await expect(drawer).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 720 })
  const detail = page.getByRole("region", { name: "需求详情", exact: true })
  const currentStatus = detail.locator("dt:has-text('当前状态') + dd")
  await expect(currentStatus).toHaveText("待目标部门确认")
  await expect(page.getByRole("button", { name: "接受答复" })).toHaveCount(0)
  await privatePage()
  const demandId = new URL(page.url()).searchParams.get("demand")
  expect(demandId).toBeTruthy()
  await page.getByRole("button", { name: "返回需求入口" }).click()
  await expect(page.getByRole("link", { name: "去 AI 助手" })).toBeVisible()
  const boardItem = page
    .getByRole("region", { name: "待目标部门确认", exact: true })
    .getByRole("article")
    .filter({ hasText: "合成需求：接口联调" })
  const requestNumber = Number.parseInt(demandId!.slice(-8), 16)
    .toString()
    .padStart(10, "0")
  await expect(
    boardItem.getByText(requestNumber, { exact: true }),
  ).toBeVisible()
  await expect(boardItem).not.toContainText(/\d+\s*人|\d+%/)
  const listView = page.getByRole("button", { name: "紧凑列表" })
  await listView.click()
  await expect(listView).toHaveAttribute("aria-pressed", "true")
  await expect(boardItem).toHaveCount(0)
  await page
    .getByRole("article")
    .filter({ hasText: "合成需求：接口联调" })
    .getByRole("link", { name: "查看详情" })
    .click()
  await expect(page).toHaveURL(`/capacity?tab=outgoing&demand=${demandId}`)
  await expect(detail).toContainText("合成需求：接口联调")
  await privatePage()
  const openNotice = async (token: string, title: string, tab: string) => {
    await signIn(token)
    await page.goto("/inbox")
    await page
      .getByRole("listitem")
      .filter({ hasText: title })
      .first()
      .getByRole("button")
      .click()
    const notice = page.getByRole("region", { name: "消息详情" })
    await expect(notice.getByRole("heading")).toContainText(title)
    await expect(notice.getByRole("heading")).not.toContainText("/capacity?")
    await notice.getByRole("link", { name: "查看详情" }).click()
    await expect(page).toHaveURL(`/capacity?tab=${tab}&demand=${demandId}`)
  }
  await open(tokens.get("M")!, "incoming")
  await page
    .getByRole("article")
    .filter({ hasText: "合成需求：接口联调" })
    .getByRole("link", { name: "查看详情", exact: true })
    .click()
  await expect(page).toHaveURL(`/capacity?tab=incoming&demand=${demandId}`)
  await openNotice(tokens.get("M")!, "收到新的协作需求", "incoming")
  const basis = page.getByRole("region", { name: "本部门匹配人员" })
  for (const name of privateNames) await expect(basis).toContainText(name)
  await expect(basis).toContainText("独立完成")
  await expect(basis).toContainText("50%")
  await expect(basis).toContainText("基本满")
  await page.screenshot({
    path: test.info().outputPath("demand-basis.png"),
    fullPage: true,
  })
  const note = page.getByLabel("答复说明")
  const reject = page.getByRole("button", { name: "确认拒绝需求" })
  await page.getByLabel("拒绝原因").selectOption("capacity")
  await note.fill(`由${privateNames[0]}完成`)
  await reject.click()
  await expect(page.getByRole("alert")).toContainText("请勿填写本部门员工姓名")
  await note.fill("当前容量不足")
  await reject.click()
  await expect(currentStatus).toHaveText("已拒绝")
  await openNotice(tokens.get("A")!, "协作需求已收到答复", "outgoing")
  await expect(currentStatus).toHaveText("已拒绝")
  await expect(
    page.getByRole("region", { name: "事件时间线" }),
  ).not.toContainText("答复时人员概况")
  await privatePage()
  await expect(page.getByRole("button", { name: "发送追问" })).toBeDisabled()
  await page.getByLabel("追问内容").fill("能否分阶段承接？")
  await page.getByRole("button", { name: "发送追问" }).click()
  await expect(currentStatus).toHaveText("待目标部门确认")
  await openNotice(tokens.get("M")!, "协作需求收到追问", "incoming")
  await expect(page.getByRole("region", { name: "事件时间线" })).toContainText(
    "能否分阶段承接？",
  )
  await page.getByRole("button", { name: "生成/调整内部方案" }).click()
  await page.getByRole("checkbox", { name: "允许动用弹性空间" }).check()
  await page.getByRole("button", { name: "重新模拟" }).click()
  await expect(page.getByText(/当前模式：已允许动用弹性空间/)).toBeVisible()
  const direct = page.getByRole("article", {
    name: "直接安排方案",
    exact: true,
  })
  await direct
    .getByRole("button", { name: /调整 .* 的人员安排/ })
    .first()
    .click()
  const editor = page
    .getByRole("dialog", { name: "调整投入分段" })
    .getByRole("form", { name: "编辑投入分段" })
  await editor.getByLabel(/投入/).fill("40")
  await editor.getByRole("button", { name: "模拟调整后的安排" }).click()
  await page
    .getByRole("article", { name: "自定方案方案", exact: true })
    .getByRole("button", { name: "按此方案答复" })
    .click()
  await note.fill("安排在需求时间内")
  await page.getByRole("button", { name: "确认方案并生效分配" }).click()
  await expect(page.getByRole("region", { name: "部门内分配" })).toContainText(
    "40%",
  )
  await expect(page.getByRole("region", { name: "协调方案" })).toHaveCount(0)
  await signIn(tokens.get("A")!)
  await page.goto("/inbox")
  await expect(page.getByText(/需求已接收并排期生效/).first()).toBeVisible()
  await page.goto("/capacity?tab=outgoing")
  const accepted = page
    .getByRole("region", { name: "已接收", exact: true })
    .getByRole("article")
    .filter({ hasText: "合成需求：接口联调" })
  await expect(accepted).toContainText(`${windowStart} 至 ${windowEnd}`)
  await expect(accepted).not.toContainText(/\d+\s*人|\d+%/)
  await accepted.getByRole("link", { name: "查看详情" }).click()
  await expect(currentStatus).toHaveText("已接收")
  await expect(detail.getByRole("list", { name: "阶段排期" })).toContainText(
    `${windowStart} 至 ${windowEnd}`,
  )
  await expect(detail).not.toContainText(/\d+\s*人|\d+%|答复时人员概况/)
  await expect(page.getByRole("button", { name: "确认排期" })).toHaveCount(0)
  await privatePage()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: test.info().outputPath("demand-mobile.png"),
    fullPage: true,
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()
  const withdrawable = await post(
    `${base}/capacity/demands`,
    {
      requesting_department_id: employee.department!.id,
      target_department_id: manager.department!.id,
      capability_key: "delivery",
      headcount: 1,
      allocation_percent: 50,
      window_start: "2026-12-01",
      window_end: "2026-12-31",
      description: "合成待撤回需求",
    },
    tokens.get("A"),
  )
  await open(tokens.get("A")!, `outgoing&demand=${withdrawable.id}`)
  await expect(detail).toContainText("合成待撤回需求")
  await page.getByRole("button", { name: "撤回需求" }).click()
  await expect(currentStatus).toHaveText("已撤回")
  await expect(page.getByRole("button", { name: "撤回需求" })).toHaveCount(0)
  await privatePage()
  await settings("managers")
  await open(tokens.get("A")!, "outgoing")
  await expect(page.getByRole("button", { name: "新建需求" })).toHaveCount(0)
  for (const token of [admin.access_token, tokens.get("M")!]) {
    await open(token, "outgoing")
    await expect(page.getByRole("button", { name: "新建需求" })).toBeVisible()
  }
})
