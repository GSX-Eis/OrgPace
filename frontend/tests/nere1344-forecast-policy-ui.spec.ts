import { expect, test } from "@playwright/test"
import type { EmployeeAccount } from "../src/client"
import { expectChineseCopy } from "./utils/copy"

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
})

test("NERE-1347：预测策略与业务波动事件网页配置及排期表可解释性展示", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000)
  const password = "synthetic-nere1347-password-2026"
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
    org_name: "合成预测策略配置企业",
    admin_username: `nere1347-${crypto.randomUUID()}@example.com`,
    admin_password: password,
  })
  const base = `/api/v1/orgs/${admin.org_id}`
  const headers = { Authorization: `Bearer ${admin.access_token}` }

  const enableFieldsResp = await request.put(`${base}/employee-fields`, {
    headers,
    data: { fields: ["job_family"] },
  })
  expect(enableFieldsResp.ok(), await enableFieldsResp.text()).toBeTruthy()

  const roster = await request.post(`${base}/roster/imports`, {
    headers,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          [
            "工号,姓名,部门,岗位序列,上级工号,邮箱",
            `M,赵主管,仓储部,仓储,,m-${crypto.randomUUID()}@example.com`,
            `E1,钱理货,仓储部,仓储,M,e1-${crypto.randomUUID()}@example.com`,
            `E2,孙研发,研发部,研发,,e2-${crypto.randomUUID()}@example.com`,
          ].join("\n"),
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
  const worker = accounts.find((row) => row.employee_code === "E1")!
  await post(
    `${base}/role-grants`,
    {
      user_id: manager.account!.user_id,
      role: "dept_manager",
      department_id: manager.department!.id,
    },
    admin.access_token,
  )

  const reset = await post(
    `${base}/accounts/${manager.account!.user_id}/reset-password`,
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
  const mgrToken = (await changed.json()).access_token as string

  const open = async (token: string, path: string) => {
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

  // 1. 管理员在 /admin/rules?tab=capacity 启用规划与负荷并配置预测策略与业务波动事件
  await open(admin.access_token, "/admin/rules?tab=capacity")
  await page.getByRole("checkbox", { name: "启用规划与负荷功能" }).check()
  await page.getByRole("button", { name: "保存设置", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("负荷与需求规则已保存")

  const policySection = page.getByRole("region", { name: "预测策略配置" })
  await expect(policySection).toContainText("系统默认 0.65")

  // 配置企业默认策略：快捷填入「常规均衡型（0.5）」并校验实时推演示例，同时确认旧 6 项复杂控件已移除
  await policySection.getByRole("button", { name: "配置企业默认" }).click()
  const orgPolicyForm = policySection.getByRole("form", {
    name: "配置企业默认策略",
  })
  await expect(orgPolicyForm.getByLabel("常态基线（%）")).toHaveCount(0)
  await expect(orgPolicyForm.getByLabel("近期惯性周数")).toHaveCount(0)
  await expect(orgPolicyForm.getByLabel("远期回归速率")).toHaveCount(0)
  await expect(orgPolicyForm.getByText("双向回归")).toHaveCount(0)
  await expect(orgPolicyForm.getByText("参考未闭环 Jira 信号")).toHaveCount(0)
  await expect(orgPolicyForm.getByText("结合在途协作信号")).toHaveCount(0)

  await orgPolicyForm.getByRole("button", { name: "常规均衡型（0.5）" }).click()
  await expect(orgPolicyForm.getByLabel("周延续系数（0–1）")).toHaveValue("0.5")
  await expect(orgPolicyForm.getByLabel("周延续系数推演示例")).toContainText(
    "按当前负荷 80% 推算：1 周后 40% → 4 周后 5% → 8 周后 0%",
  )
  await orgPolicyForm.getByLabel("策略备注（选填）").fill("企业默认基准")
  await orgPolicyForm.getByRole("button", { name: "保存策略" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "已保存预测策略并重算基线" }),
  ).toBeVisible()

  const policyList = policySection.getByRole("list", { name: "预测策略列表" })
  await expect(policyList).toContainText("企业默认")
  await expect(policyList).toContainText("常规均衡型")
  await expect(policyList).toContainText("周延续系数 0.5")

  // 新增并删除一个「研发部 · 研发」自定义策略覆盖，验证新增/删除链路与 0.8 推演示例
  await policySection.getByRole("button", { name: "新增预测策略" }).click()
  const deptPolicyForm = policySection.getByRole("form", {
    name: "新增预测策略",
  })
  await deptPolicyForm.getByLabel("生效部门").click()
  await page.getByRole("option", { name: "研发部" }).click()
  await deptPolicyForm
    .getByRole("button", { name: "研发", exact: true })
    .click()
  await expect(deptPolicyForm.getByLabel("岗位序列（可选）")).toHaveValue(
    "研发",
  )
  await deptPolicyForm
    .getByRole("button", { name: "项目延续型（0.8）" })
    .click()
  await expect(deptPolicyForm.getByLabel("周延续系数（0–1）")).toHaveValue(
    "0.8",
  )
  await expect(deptPolicyForm.getByLabel("周延续系数推演示例")).toContainText(
    "按当前负荷 80% 推算：1 周后 65% → 4 周后 35% → 8 周后 15%",
  )
  await deptPolicyForm.getByRole("button", { name: "保存策略" }).click()
  await expect(policyList).toContainText("研发部 · 研发")
  await expect(policyList).toContainText("项目延续型")
  await expect(policyList).toContainText("周延续系数 0.8")

  const devPolicyItem = policyList
    .getByRole("listitem")
    .filter({ hasText: "研发部 · 研发" })
  await devPolicyItem.getByRole("button", { name: "删除" }).click()
  await expect(policyList).not.toContainText("研发部 · 研发")

  // 获取当前周与下周周一日期
  const myWorkloadResp = await request.get(`${base}/capacity/workloads/me`, {
    headers: { Authorization: `Bearer ${mgrToken}` },
  })
  expect(myWorkloadResp.ok(), await myWorkloadResp.text()).toBeTruthy()
  const myWorkload = await myWorkloadResp.json()
  const week0 = myWorkload.weeks[0].week_start as string
  const week1 = myWorkload.weeks[1].week_start as string
  const week2 = myWorkload.weeks[2].week_start as string

  // 管理员新增并编辑全企业业务波动事件（经理视角下应为只读）
  const eventSection = page.getByRole("region", { name: "业务波动事件管理" })
  await eventSection.getByRole("button", { name: "新增业务波动事件" }).click()
  const adminEventForm = eventSection.getByRole("form", {
    name: "新增业务波动事件",
  })
  await adminEventForm.getByLabel("事件标题").fill("全员季度盘点")
  await adminEventForm.getByLabel("开始周（周一）").fill(week2)
  await adminEventForm.getByLabel("结束周（周一）").fill(week2)
  await adminEventForm.getByLabel("修正方式").click()
  await page.getByRole("option", { name: "百分点加减（±%）" }).click()
  await adminEventForm.getByLabel("修正幅度").fill("15")
  await adminEventForm.getByLabel("原因说明").fill("季度末集中盘点")
  await adminEventForm.getByRole("button", { name: "保存事件" }).click()
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "已保存业务波动事件并重算基线" }),
  ).toBeVisible()

  const eventList = eventSection.getByRole("list", { name: "业务波动事件列表" })
  await expect(eventList).toContainText("全员季度盘点")
  await expect(eventList).toContainText("+15%")

  // 编辑刚创建的事件为 +20%
  const orgEventItem = eventList
    .getByRole("listitem")
    .filter({ hasText: "全员季度盘点" })
  await orgEventItem.getByRole("button", { name: "编辑" }).click()
  const editOrgEventForm = eventSection.getByRole("form", {
    name: "编辑业务波动事件",
  })
  await editOrgEventForm.getByLabel("修正幅度").fill("20")
  await editOrgEventForm.getByRole("button", { name: "保存事件" }).click()
  await expect(orgEventItem).toContainText("+20%")

  await expectChineseCopy(page)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()

  // 2. 为仓储部员工设置本周已确认 90%，随后经理在 /capacity?tab=team 抽屉配置脉冲策略与「下周无进货 ×0.4」事件
  await request.put(`${base}/capacity/weeks`, {
    headers: { Authorization: `Bearer ${mgrToken}` },
    data: {
      items: [{ employee_id: worker.id, other_percent: 90 }],
      start_week: week0,
      end_week: week0,
    },
  })

  await open(mgrToken, "/capacity?tab=team")
  const table = page.getByRole("table", { name: "团队负荷，按部门、姓名排序" })
  const e1Row = table.getByRole("row").filter({ hasText: "钱理货" })
  await expect(e1Row.getByText("90% / 100%", { exact: true })).toHaveCount(1)

  await page.getByRole("button", { name: "预测策略与事件" }).click()
  const policyDrawer = page.getByRole("dialog", { name: "预测策略与事件" })
  await expect(policyDrawer).toBeVisible()

  // 企业默认策略与全企业事件对经理均为只读，无编辑和删除按钮
  const mgrOrgPolicy = policyDrawer
    .getByRole("list", { name: "预测策略列表" })
    .getByRole("listitem")
    .filter({ hasText: "企业默认" })
  await expect(mgrOrgPolicy).toContainText("只读 / 继承")
  await expect(mgrOrgPolicy.getByRole("button", { name: "编辑" })).toHaveCount(
    0,
  )
  await expect(mgrOrgPolicy.getByRole("button", { name: "删除" })).toHaveCount(
    0,
  )

  const mgrOrgEvent = policyDrawer
    .getByRole("list", { name: "业务波动事件列表" })
    .getByRole("listitem")
    .filter({ hasText: "全员季度盘点" })
  await expect(mgrOrgEvent).toContainText("只读")
  await expect(mgrOrgEvent.getByRole("button", { name: "编辑" })).toHaveCount(0)
  await expect(mgrOrgEvent.getByRole("button", { name: "删除" })).toHaveCount(0)

  // 经理为仓储部快捷填入「脉冲波次型（0）」并保存
  await policyDrawer.getByRole("button", { name: "新增预测策略" }).click()
  const mgrPolicyForm = policyDrawer.getByRole("form", {
    name: "新增预测策略",
  })
  await mgrPolicyForm.getByLabel("生效部门").click()
  await expect(page.getByRole("option", { name: "企业默认" })).toHaveCount(0)
  await expect(page.getByRole("option", { name: "研发部" })).toHaveCount(0)
  await page.getByRole("option", { name: "仓储部" }).click()
  await mgrPolicyForm.getByRole("button", { name: "脉冲波次型（0）" }).click()
  await expect(mgrPolicyForm.getByLabel("周延续系数（0–1）")).toHaveValue("0")
  await expect(mgrPolicyForm.getByLabel("周延续系数推演示例")).toContainText(
    "当前已确认周结束后，后续未排周直接回落至 0%。",
  )
  await mgrPolicyForm.getByRole("button", { name: "保存策略" }).click()
  await expect(policyDrawer.getByRole("status")).toContainText(
    "已保存预测策略并重算基线",
  )

  // 经理为仓储部创建下周（week1）业务波动事件：+20%
  await policyDrawer.getByRole("button", { name: "新增业务波动事件" }).click()
  const mgrEventForm = policyDrawer.getByRole("form", {
    name: "新增业务波动事件",
  })
  await mgrEventForm.getByLabel("事件标题").fill("下周大促备货")
  await mgrEventForm.getByLabel("开始周（周一）").fill(week1)
  await mgrEventForm.getByLabel("结束周（周一）").fill(week1)
  await mgrEventForm.getByLabel("修正方式").click()
  await page.getByRole("option", { name: "百分点加减（±%）" }).click()
  await mgrEventForm.getByLabel("修正幅度").fill("20")
  await mgrEventForm.getByLabel("原因说明").fill("临时大促备货波次")
  await mgrEventForm.getByRole("button", { name: "保存事件" }).click()
  await expect(policyDrawer.getByRole("status")).toContainText(
    "已保存业务波动事件并重算基线",
  )
  await expect(
    policyDrawer.getByRole("list", { name: "业务波动事件列表" }),
  ).toContainText("下周大促备货")
  await expect(
    policyDrawer.getByRole("list", { name: "业务波动事件列表" }),
  ).toContainText("+20%")

  await expectChineseCopy(policyDrawer)
  await policyDrawer.press("Escape")
  await expect(policyDrawer).toBeHidden()

  // 3. 验证排期表自动刷新：下周按脉冲(0)归零后叠加事件 +20% = 20%，Tooltip 与详情抽屉展示策略与事件标签
  const week1Cell = e1Row
    .getByRole("button", { name: /预计 20% \/ 70%.*查看负荷明细$/ })
    .first()
  await expect(week1Cell).toBeVisible()
  await week1Cell.hover()
  const tooltip = page.getByRole("tooltip")
  await expect(tooltip).toContainText("策略：周延续系数 0（仓储部）")
  await expect(tooltip).toContainText("事件：下周大促备货（+20%）")

  await week1Cell.click()
  const detailsDrawer = page.getByRole("dialog", { name: "负荷明细 · 钱理货" })
  await expect(detailsDrawer).toContainText("策略：周延续系数 0（仓储部）")
  await expect(detailsDrawer).toContainText("事件：下周大促备货（+20%）")
  await expect(detailsDrawer).toContainText(
    "来源：周延续系数 0（仓储部）：基于近 1 周已确认均值 90%，末次确认周后归零；业务事件：下周大促备货（+20%）",
  )
  await expectChineseCopy(page)
  await detailsDrawer.press("Escape")

  // 4. 移动端视口下验证布局无横向溢出
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "预测策略与事件" }).click()
  await expect(policyDrawer).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()
})
