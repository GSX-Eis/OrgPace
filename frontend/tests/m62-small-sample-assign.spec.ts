import { expect, test } from "@playwright/test"
import type { EmployeeAccount } from "../src/client"
import { seedLegacyAcceptedDemand } from "./utils/legacyCapacity"
import { importRoster } from "./utils/roster"

test.use({ storageState: { cookies: [], origins: [] } })

test("小样本隐藏及零依据时选择本部门其他员工", async ({ page, request }) => {
  test.setTimeout(120000)
  const password = "synthetic-assignment-password-2026"
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
    org_name: "合成小样本企业",
    admin_username: `${crypto.randomUUID()}@example.com`,
    admin_password: password,
  })
  const base = `/api/v1/orgs/${admin.org_id}`
  await api(
    `${base}/capacity-settings`,
    { enabled: true, requester_policy: "everyone" },
    admin.access_token,
    "PUT",
  )
  const open = async (token: string, tab: string) => {
    await page.goto("/login")
    await page.evaluate(
      ({ token, org }) => {
        localStorage.setItem("access_token", token)
        localStorage.setItem("current_org_id", org)
      },
      { token, org: admin.org_id },
    )
    await page.goto(`/capacity?tab=${tab}`)
    await expect(
      page.getByRole("heading", {
        name: tab === "team" ? "团队负荷" : "协作需求",
        exact: true,
      }),
    ).toBeVisible()
  }
  await open(admin.access_token, "team")
  await importRoster(
    page,
    Buffer.from(
      `工号,姓名,部门,上级工号,邮箱\nA,合成客户,客户,,a@example.com\nM,合成经理,研发,,m@example.com\nB1,合成研发甲,研发,M,b1@example.com\nB2,合成研发乙,研发,M,b2@example.com\n`.replace(
        /@example\.com/g,
        `-${crypto.randomUUID()}@example.com`,
      ),
    ),
  )
  await api(
    `${base}/capabilities/versions`,
    {
      expected_version: 0,
      definitions: [
        {
          key: "empty",
          name: "合成新能力",
          category: "工程",
          description: "合成零依据",
          level_rubric: {
            levels: [
              { key: "routine", label: "独立完成", description: "独立完成" },
            ],
          },
        },
        {
          key: "delivery",
          name: "合成交付",
          category: "工程",
          description: "合成能力",
          level_rubric: {
            levels: [
              { key: "routine", label: "独立完成", description: "独立完成" },
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
  await api(
    `${base}/role-grants`,
    {
      user_id: person("M").account!.user_id,
      role: "dept_manager",
      department_id: person("M").department!.id,
    },
    admin.access_token,
  )
  const tokens = new Map<string, string>()
  for (const code of ["A", "M"]) {
    const reset = await api(
      `${base}/accounts/${person(code).account!.user_id}/reset-password`,
      {},
      admin.access_token,
    )
    const login = await request.post("/api/v1/login/access-token", {
      form: { username: reset.username, password: reset.initial_password },
    })
    expect(login.ok()).toBeTruthy()
    const changed = await api(
      "/api/v1/users/me/password",
      { current_password: reset.initial_password, new_password: password },
      (await login.json()).access_token,
      "PATCH",
    )
    tokens.set(code, changed.access_token)
  }
  const a = tokens.get("A")!,
    m = tokens.get("M")!
  const weeks: { week_start: string }[] = (
    await api(`${base}/capacity/workloads/me`, undefined, m)
  ).weeks
  const addDays = (iso: string, days: number) =>
    new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10)
  const startWeek = weeks[1].week_start
  const endWeek = weeks[3].week_start
  const windowStart = addDays(startWeek, 1)
  const windowEnd = addDays(endWeek, 4)
  await api(
    `${base}/employees/${person("B1").id}/profile/direct-edits`,
    {
      base_revision: null,
      items: [
        {
          op: "add",
          capability_key: "delivery",
          statement: "合成能力",
          level: "routine",
        },
      ],
    },
    admin.access_token,
  )
  await open(a, "outgoing")
  await page.getByRole("button", { name: "新建需求", exact: true }).click()
  await page
    .getByLabel("目标部门", { exact: true })
    .selectOption(person("M").department!.id)
  await page.getByLabel("能力", { exact: true }).selectOption("delivery")
  await page.getByLabel("开始日期").fill(windowStart)
  await page.getByLabel("结束日期").fill(windowEnd)
  const assess = page.getByRole("button", { name: "评估承接部门" })
  const reference = page
    .getByLabel("目标部门", { exact: true })
    .locator("option:checked")
  const assessCapability = async (key: string, conclusion: RegExp) => {
    await page.getByLabel("能力", { exact: true }).selectOption(key)
    await assess.click()
    await expect(reference).toContainText(conclusion)
    await expect(reference).not.toContainText(
      /\d+\s*人|有余量|基本满|超负荷|未确认/,
    )
  }
  await assessCapability("delivery", /暂无负荷数据，待目标部门确认/)
  await api(
    `${base}/capacity/weeks`,
    {
      items: [{ employee_id: person("B1").id, other_percent: 73 }],
      start_week: startWeek,
      end_week: endWeek,
    },
    m,
    "PUT",
  )
  // D-070 allows an actionable department-level conclusion for a single match.
  await assessCapability("delivery", / 至 .* 可承接/)
  const assessment = page.getByRole("region", { name: "承接部门评估" })
  const summary = assessment.getByRole("status")
  for (const view of [reference, summary]) {
    await expect(view).toContainText("整体负荷暂不展示")
    await expect(view).not.toContainText(/\d+%|暂无负荷数据|负荷偏高/)
  }
  await expect(reference).toContainText("目标时段可能有人有空")
  await expect(assessment).toContainText("估算参考")
  await expect(assessment).toContainText("最终以目标部门经理排期为准")
  await api(
    `${base}/capacity/weeks`,
    {
      items: [{ employee_id: person("B2").id, other_percent: 27 }],
      start_week: startWeek,
      end_week: endWeek,
    },
    m,
    "PUT",
  )
  await assessCapability("delivery", / 至 .* 可承接/)
  for (const view of [reference, summary]) {
    await expect(view).toContainText("整体负荷 50%（较空闲）")
    await expect(view).not.toContainText("整体负荷暂不展示")
  }
  for (const code of ["M", "B1", "B2"]) {
    await expect(assessment).not.toContainText(person(code).display_name)
    await expect(assessment).not.toContainText(person(code).id)
  }
  await assessCapability("empty", /暂不可承接/)
  await expect(reference).not.toContainText("整体负荷")
  for (const code of ["M", "B2"]) {
    await api(
      `${base}/employees/${person(code).id}/profile/direct-edits`,
      {
        base_revision: null,
        items: [
          {
            op: "add",
            capability_key: "delivery",
            statement: "合成能力",
            level: "routine",
          },
        ],
      },
      admin.access_token,
    )
  }
  await assessCapability("delivery", / 至 .* 可承接/)
  await assessCapability("empty", /暂不可承接/)
  const demand = await api(
    `${base}/capacity/demands`,
    {
      requesting_department_id: person("A").department!.id,
      target_department_id: person("M").department!.id,
      capability_key: "empty",
      headcount: 2,
      allocation_percent: 50,
      window_start: windowStart,
      window_end: addDays(endWeek, 6),
      description: "合成零依据分配",
    },
    a,
  )
  await api(
    `${base}/capacity/demands/${demand.id}/reply`,
    {
      revision: 1,
      outcome: "can_do",
      start_date: windowStart,
      end_date: windowEnd,
      text: "合成承接",
    },
    m,
  )
  await seedLegacyAcceptedDemand(
    request,
    admin.org_id,
    demand.id,
    admin.access_token,
  )
  await api(
    `${base}/capacity/weeks`,
    {
      items: [{ employee_id: person("B2").id, other_percent: 0 }],
      start_week: startWeek,
      end_week: endWeek,
    },
    m,
    "PUT",
  )
  await open(m, `incoming&demand=${demand.id}`)
  const assignment = page.getByRole("region", { name: "部门内分配" })
  await expect(assignment).toContainText(
    "符合画像条件的有 0 人（需 2 人），也可按实际需要选择部门内其他员工，不影响画像数据。",
  )
  const group = assignment.locator('optgroup[label="本部门其他员工"]')
  await expect(group.locator("option")).toHaveCount(3)
  await expect(
    assignment.locator('optgroup[label="符合条件的员工"] option'),
  ).toHaveCount(0)
  await assignment
    .locator('select[name="employee_id"]')
    .selectOption(person("B2").id)
  await assignment.getByLabel("预计完成日期", { exact: true }).fill(windowEnd)
  await assignment.getByLabel("开始日期", { exact: true }).fill(windowStart)
  await assignment
    .getByLabel("该员工未满足画像条件，我确认按实际需要安排")
    .check()
  await assignment.getByRole("button", { name: "确认分配" }).click()
  await expect(
    assignment.getByRole("article", { name: person("B2").display_name }),
  ).toBeVisible()
  await open(a, `outgoing&demand=${demand.id}`)
  await expect(page.getByRole("region", { name: "部门内分配" })).toHaveCount(0)
  for (const code of ["M", "B1", "B2"])
    await expect(page.locator("body")).not.toContainText(
      person(code).display_name,
    )
})
