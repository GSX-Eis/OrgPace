import { expect, test } from "@playwright/test"
import type { EmployeeAccount } from "../src/client"
import { seedLegacyAcceptedDemand } from "./utils/legacyCapacity"

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
})

test("NERE-1216：我的负荷统一网格与详情、可用上限加请假标记、逐周沿用与连续回撤", async ({
  page,
  request,
}) => {
  test.setTimeout(120000)
  const password = "synthetic-nere1216-password-2026"
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
    org_name: "合成负荷体验企业",
    admin_username: `nere1216-${crypto.randomUUID()}@example.com`,
    admin_password: password,
  })
  const base = `/api/v1/orgs/${admin.org_id}`
  const headers = { Authorization: `Bearer ${admin.access_token}` }

  // 创建部门、能力词典和员工（需求方 A，经理 M，员工 E1/E2）
  const roster = await request.post(`${base}/roster/imports`, {
    headers,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          `工号,姓名,部门,上级工号,邮箱\nA,张需求,市场部,,a-${crypto.randomUUID()}@example.com\nM,林经理,产品部,,m-${crypto.randomUUID()}@example.com\nE1,陈一,产品部,M,e1-${crypto.randomUUID()}@example.com\nE2,周二,产品部,M,e2-${crypto.randomUUID()}@example.com\n`,
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
  await post(
    `${base}/capabilities/versions`,
    {
      expected_version: 0,
      definitions: [
        {
          key: "delivery",
          name: "产品交付",
          category: "产品",
          description: "产品交付能力",
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
  expect(
    (await request.post(`${base}/accounts/issue`, { headers, data: {} })).ok(),
  ).toBeTruthy()
  const accounts: EmployeeAccount[] = (
    await (await request.get(`${base}/accounts`, { headers })).json()
  ).data
  const requester = accounts.find((row) => row.employee_code === "A")!
  const manager = accounts.find((row) => row.employee_code === "M")!
  const emp1 = accounts.find((row) => row.employee_code === "E1")!
  const emp2 = accounts.find((row) => row.employee_code === "E2")!
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
  for (const account of [requester, manager, emp1, emp2]) {
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

  const reqToken = tokens.get("A")!
  const mgrToken = tokens.get("M")!
  const e1Token = tokens.get("E1")!
  const mgrHeaders = { Authorization: `Bearer ${mgrToken}` }
  const e1Headers = { Authorization: `Bearer ${e1Token}` }

  const myData = await (
    await request.get(`${base}/capacity/workloads/me`, { headers: e1Headers })
  ).json()
  const w0 = myData.weeks[0].week_start as string
  const w1 = myData.weeks[1].week_start as string
  const w2 = myData.weeks[2].week_start as string

  // 为陈一补充能力画像并确认本周基线，再创建一个已承接的部门需求任务，占本周 20%
  await post(
    `${base}/employees/${emp1.id}/profile/direct-edits`,
    {
      base_revision: null,
      items: [
        {
          op: "add",
          capability_key: "delivery",
          statement: "合成产品交付",
          level: "routine",
        },
      ],
    },
    admin.access_token,
  )
  expect(
    (
      await request.put(`${base}/capacity/weeks`, {
        headers: mgrHeaders,
        data: {
          start_week: w0,
          end_week: w0,
          items: [{ employee_id: emp1.id, other_percent: 0 }],
        },
      })
    ).ok(),
  ).toBeTruthy()
  const w0Fri = new Date(`${w0}T00:00:00Z`)
  w0Fri.setUTCDate(w0Fri.getUTCDate() + 4)
  const demand = await post(
    `${base}/capacity/demands`,
    {
      requesting_department_id: requester.department!.id,
      target_department_id: emp1.department!.id,
      capability_key: "delivery",
      headcount: 1,
      allocation_percent: 20,
      window_start: w0,
      window_end: w0Fri.toISOString().slice(0, 10),
      description: "合成产品需求交付",
    },
    reqToken,
  )
  await post(
    `${base}/capacity/demands/${demand.id}/reply`,
    {
      revision: demand.revision,
      outcome: "can_do",
      start_date: w0,
      end_date: w0Fri.toISOString().slice(0, 10),
      text: "可以承接",
    },
    mgrToken,
  )
  await seedLegacyAcceptedDemand(
    request,
    admin.org_id,
    demand.id,
    admin.access_token,
  )
  await post(
    `${base}/capacity/demands/${demand.id}/assignments`,
    {
      employee_id: emp1.id,
      allocation_percent: 20,
      start_date: w0,
      due_date: w0Fri.toISOString().slice(0, 10),
    },
    mgrToken,
  )

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

  // 1. 经理直接修改「可用上限」+「请假」标记（主视图无单独「不可用日期」按钮）
  await open(mgrToken, "/capacity?tab=team")
  const table = page.getByRole("table", { name: "团队负荷，按部门、姓名排序" })
  const e1Row = table.getByRole("row").filter({ hasText: "陈一" })
  await expect(e1Row.getByRole("button", { name: "不可用日期" })).toHaveCount(0)

  await e1Row.getByRole("button", { name: "设置", exact: true }).click()
  const editDrawer = page.getByRole("dialog", { name: "设置周投入 · 陈一" })
  await editDrawer.getByLabel("其他工作占比（%）").fill("20")
  await editDrawer.getByLabel("可用上限（%）").fill("60")
  const leaveCheckbox = editDrawer.getByRole("checkbox", { name: "请假" })
  await expect(leaveCheckbox).toBeChecked()
  const weekdayPicker = editDrawer.getByRole("group", {
    name: "选择请假工作日",
  })
  await expect(weekdayPicker).toBeVisible()
  await weekdayPicker.getByRole("checkbox", { name: /^周二 / }).check()
  await weekdayPicker.getByRole("checkbox", { name: /^周四 / }).check()
  await page.screenshot({
    path: test.info().outputPath("team-manager-setting-desktop.png"),
    fullPage: true,
    animations: "disabled",
  })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()
  await page.screenshot({
    path: test.info().outputPath("team-manager-setting-mobile.png"),
    fullPage: true,
    animations: "disabled",
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await editDrawer.getByRole("button", { name: "确认设置" }).click()
  await expect(editDrawer).toBeHidden()

  // 本周：其他 20% + 分配 20% = 40%，可用上限 60%，余量 20%，主视图显示「请假」标记而不展开日期
  await expect(e1Row.getByText("40% / 60%", { exact: true })).toBeVisible()
  await expect(e1Row.getByText("请假", { exact: true }).first()).toBeVisible()
  await expect(e1Row.getByRole("button", { name: /^不可用：/ })).toHaveCount(0)

  // 点开本周详情：显示选定的周二与周四具体请假日期
  const w0Tue = new Date(`${w0}T00:00:00Z`)
  w0Tue.setUTCDate(w0Tue.getUTCDate() + 1)
  const w0TueIso = w0Tue.toISOString().slice(0, 10)
  await e1Row
    .getByRole("button", { name: /40% \/ 60%.*请假，查看负荷明细/ })
    .click()
  const mgrDetails = page.getByRole("dialog", { name: "负荷明细 · 陈一" })
  await expect(mgrDetails).toContainText("20%")
  await expect(
    mgrDetails.getByRole("region", { name: "本周请假日期" }),
  ).toContainText(`${w0TueIso} 至 ${w0TueIso}`)
  await mgrDetails.press("Escape")

  // 2. 员工「我的负荷」与团队热力图一致，点一周打开详情看任务、拆解、请假与可用上限
  await open(e1Token, "/capacity")
  const overview = page.getByRole("region", { name: "每周投入" })
  // 主视图不再平铺 4 项明细
  await expect(overview.locator("dl")).toHaveCount(0)
  // 图例与团队热力图一致
  await expect(
    overview.getByRole("list", { name: "甘特图图例" }).getByRole("listitem"),
  ).toHaveText([
    "未确认",
    "有余量",
    "基本满",
    "超负荷（>100% 或超可用）",
    "已分配任务",
    "跨部门借调",
    "方案暂留",
    "请假 / 不可用",
    "其他工作",
    "预测基线",
  ])
  const w0Cell = overview.getByRole("button", { name: /查看负荷明细$/ }).first()
  await expect(w0Cell).toContainText("40% / 60%")
  await expect(w0Cell).toContainText("请假")
  await w0Cell.click()
  const myDetails = page.getByRole("dialog", { name: /^负荷明细/ })
  await expect(myDetails.locator("dl dt")).toHaveText([
    "平台外工作",
    "平台内分配",
    "可用上限",
    "余量",
    "请假",
  ])
  await expect(myDetails.locator("dl dd")).toHaveText([
    "20%",
    "20%",
    "60%",
    "20%",
    "已请假",
  ])
  await expect(
    myDetails.getByRole("region", { name: "已分配任务" }),
  ).toContainText("20%")
  await expect(
    myDetails.getByRole("region", { name: "本周请假日期" }),
  ).toContainText(`${w0TueIso} 至 ${w0TueIso}`)
  await page.screenshot({
    path: test.info().outputPath("my-workload-desktop.png"),
    fullPage: true,
    animations: "disabled",
  })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()
  await page.screenshot({
    path: test.info().outputPath("my-workload-mobile.png"),
    fullPage: true,
    animations: "disabled",
  })
  await page.setViewportSize({ width: 1440, height: 900 })

  // 3. 逐周沿用（基准周选择、已确认周不覆盖、连续点 3 次填 3 周、连续回撤 2 次恢复数据与审计）
  // 设陈一 W2=75%（W1 留空，最后已确认周应为 W2），周二 W0=50%、W1=80%（最后已确认周应为 W1）
  expect(
    (
      await request.put(`${base}/capacity/weeks`, {
        headers: mgrHeaders,
        data: {
          start_week: w2,
          end_week: w2,
          items: [{ employee_id: emp1.id, other_percent: 75 }],
        },
      })
    ).ok(),
  ).toBeTruthy()
  expect(
    (
      await request.put(`${base}/capacity/weeks`, {
        headers: mgrHeaders,
        data: {
          start_week: w0,
          end_week: w0,
          items: [{ employee_id: emp2.id, other_percent: 50 }],
        },
      })
    ).ok(),
  ).toBeTruthy()
  expect(
    (
      await request.put(`${base}/capacity/weeks`, {
        headers: mgrHeaders,
        data: {
          start_week: w1,
          end_week: w1,
          items: [{ employee_id: emp2.id, other_percent: 80 }],
        },
      })
    ).ok(),
  ).toBeTruthy()

  await open(mgrToken, "/capacity?tab=team")
  const reuseBtn = page.getByRole("button", { name: "沿用上次配置" })
  const undoBtn = page.getByRole("button", { name: "回撤最近一次沿用" })
  await expect(undoBtn).toBeDisabled()

  // 连续沿用 3 次
  for (let step = 0; step < 3; step++) {
    await reuseBtn.click()
    const dlg = page.getByRole("dialog", { name: "沿用上次配置" })
    await expect(dlg).toContainText("陈一")
    await expect(dlg).toContainText("75%")
    await expect(dlg).toContainText("周二")
    await expect(dlg).toContainText("80%")
    if (step === 0) {
      await page.screenshot({
        path: test.info().outputPath("carry-over-preview-desktop.png"),
        fullPage: true,
        animations: "disabled",
      })
    }
    await dlg.getByRole("button", { name: "确认沿用" }).click()
    await expect(dlg).toBeHidden()
  }

  // 陈一应填出 W3/W4/W5=75%（连同原 W2 共 4 周），W1 仍未确认；周二 W1 仍为 80%（未覆盖），填出 W2/W3/W4=80%（共 4 周）
  const teamTable = page.getByRole("table", {
    name: "团队负荷，按部门、姓名排序",
  })
  const e1AfterCarry = teamTable.getByRole("row").filter({ hasText: "陈一" })
  const e2AfterCarry = teamTable.getByRole("row").filter({ hasText: "周二" })
  await expect(
    e1AfterCarry.getByText("75% / 100%", { exact: true }),
  ).toHaveCount(4)
  await expect(
    e2AfterCarry.getByText("80% / 100%", { exact: true }),
  ).toHaveCount(4)
  await page.screenshot({
    path: test.info().outputPath("carry-over-desktop.png"),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()
  await page.screenshot({
    path: test.info().outputPath("carry-over-mobile.png"),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1440, height: 900 })

  // 连续回撤 2 次（先核对操作者、部门、员工和周次确认框，并验证并发批次变化保护）：陈一保留 W2+W3 共 2 周 75%，周二保留 W1+W2 共 2 周 80%
  await expect(undoBtn).toBeEnabled()
  await undoBtn.click()
  const revertDialog = page.getByRole("dialog", { name: "确认回撤沿用配置" })
  await expect(revertDialog).toContainText("林经理")
  await expect(revertDialog).toContainText("产品部")
  await expect(revertDialog).toContainText("陈一")
  await expect(revertDialog).toContainText("周二")
  await page.screenshot({
    path: test.info().outputPath("carry-over-revert-confirm-desktop.png"),
    fullPage: true,
    animations: "disabled",
  })
  await revertDialog.getByRole("button", { name: "确认回撤" }).click()
  await expect(revertDialog).toBeHidden()
  await expect(page.getByRole("status").first()).toContainText(
    "已撤回最近一次沿用",
  )

  // 第二次点击回撤打开弹窗后，模拟后台另一位经理已提前回撤该批次 -> 提交时拦截 409，点「刷新重看」更新为上一批
  await undoBtn.click()
  await expect(revertDialog).toContainText("林经理")
  expect(
    (
      await request.post(`${base}/capacity/weeks/carry-over/revert`, {
        headers: mgrHeaders,
      })
    ).ok(),
  ).toBeTruthy()
  await revertDialog.getByRole("button", { name: "确认回撤" }).click()
  await expect(revertDialog.getByRole("alert")).toContainText("已变化")
  await revertDialog.getByRole("button", { name: "刷新重看" }).click()
  await expect(revertDialog.getByRole("alert")).toHaveCount(0)
  await revertDialog.getByRole("button", { name: "取消" }).click()
  await expect(revertDialog).toBeHidden()
  await expect(
    e1AfterCarry.getByText("75% / 100%", { exact: true }),
  ).toHaveCount(2)
  await expect(
    e2AfterCarry.getByText("80% / 100%", { exact: true }),
  ).toHaveCount(2)
  await page.screenshot({
    path: test.info().outputPath("carry-over-undo-desktop.png"),
    fullPage: true,
  })

  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()
  await page.screenshot({
    path: test.info().outputPath("carry-over-undo-mobile.png"),
    fullPage: true,
  })

  // 验证审计记录存在
  const auditRes = await (
    await request.get(`${base}/audit-events`, {
      headers,
      params: { action: "capacity.workload_carry_over_reverted" },
    })
  ).json()
  expect(auditRes.count).toBe(2)
})
