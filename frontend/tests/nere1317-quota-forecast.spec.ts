import { expect, test } from "@playwright/test"
import type { EmployeeAccount } from "../src/client"

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
})

test("NERE-1317：默认配额设置与团队负荷预测基线展示及例外操作", async ({
  page,
  request,
}) => {
  test.setTimeout(120000)
  const password = "synthetic-nere1317-password-2026"
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
    org_name: "合成预测基线企业",
    admin_username: `nere1317-${crypto.randomUUID()}@example.com`,
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
          `工号,姓名,部门,上级工号,邮箱\nM,周经理,研发部,,m-${crypto.randomUUID()}@example.com\nE1,吴一,研发部,M,e1-${crypto.randomUUID()}@example.com\n`,
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

  // 1. 管理员配置员工默认建议分配上限（配额）并查看弹性空间联动
  await open(admin.access_token, "/admin/rules?tab=capacity")
  await page.getByRole("checkbox", { name: "启用规划与负荷功能" }).check()
  const capInput = page.getByLabel("员工默认建议分配上限（配额 %）")
  await expect(capInput).toHaveValue("70")
  await expect(
    page.getByText("预留弹性空间：30%（用于临时/紧急外部需求）"),
  ).toBeVisible()
  await capInput.fill("65")
  await expect(
    page.getByText("预留弹性空间：35%（用于临时/紧急外部需求）"),
  ).toBeVisible()
  await page.getByRole("button", { name: "保存设置", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("负荷与需求规则已保存")
  await expect(page.getByText("65% / 35%")).toBeVisible()

  await capInput.fill("70")
  await page.getByRole("button", { name: "保存设置", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("负荷与需求规则已保存")
  await expect(page.getByText("70% / 30%")).toBeVisible()

  // 2. 经理在团队负荷中设置本周 90%，远期格子展示预测基线，并支持修正、恢复与转为正式确认
  await open(mgrToken, "/capacity?tab=team")
  const table = page.getByRole("table", { name: "团队负荷，按部门、姓名排序" })
  const e1Row = table.getByRole("row").filter({ hasText: "吴一" })
  await e1Row.getByRole("button", { name: "设置", exact: true }).click()
  const editDrawer = page.getByRole("dialog", { name: "设置周投入 · 吴一" })
  await editDrawer.getByLabel("其他工作占比（%）").fill("90")
  await editDrawer.getByRole("button", { name: "确认设置" }).click()
  await expect(editDrawer).toBeHidden()

  // 本周为正式确认 90% / 100%（突破常规上限动用弹性 20%），第 1..7 周按系统默认周延续系数 0.65 逐周衰减：60%、40%、25%、15%、10%、5%、5%
  await expect(e1Row.getByText("90% / 100%", { exact: true })).toHaveCount(1)
  await expect(e1Row.getByText("动用弹性 20%", { exact: true })).toHaveCount(1)
  await expect(e1Row.getByText("预测基线", { exact: true })).toHaveCount(7)
  await expect(e1Row.getByText("预计 60% / 70%", { exact: true })).toHaveCount(
    1,
  )
  await expect(e1Row.getByText("预计 40% / 70%", { exact: true })).toHaveCount(
    1,
  )
  await expect(e1Row.getByText("预计 25% / 70%", { exact: true })).toHaveCount(
    1,
  )
  await expect(e1Row.getByText("预计 15% / 70%", { exact: true })).toHaveCount(
    1,
  )

  // 点开第 2 周（已衰减到 60%）查看抽屉详情并手动修正为 55%
  const futureCell = e1Row
    .getByRole("button", { name: /预计 60% \/ 70%.*查看负荷明细$/ })
    .first()
  await futureCell.click()
  const detailsDrawer = page.getByRole("dialog", { name: "负荷明细 · 吴一" })
  await expect(detailsDrawer).toContainText("常规配额上限 70% · 弹性空间 30%")
  await expect(detailsDrawer).toContainText(
    "来源：周延续系数 0.65（系统默认）：基于近 1 周已确认均值 90%逐周衰减",
  )
  await detailsDrawer.getByRole("button", { name: "调整预测基线" }).click()
  const forecastForm = page.getByRole("dialog", { name: "调整预测基线 · 吴一" })
  await forecastForm.getByLabel("预测平台外占比（%）").fill("55")
  await forecastForm.getByLabel("调整说明（选填）").fill("客户专项支持")
  await forecastForm.getByRole("button", { name: "保存预测基线" }).click()
  await expect(forecastForm).toBeHidden()

  await expect(e1Row.getByText("已修正基线", { exact: true })).toHaveCount(1)
  await expect(e1Row.getByText("预计 55% / 70%", { exact: true })).toHaveCount(
    1,
  )

  // 恢复自动预测
  await e1Row
    .getByRole("button", { name: /已修正基线，预计 55% \/ 70%.*查看负荷明细$/ })
    .click()
  await expect(detailsDrawer).toContainText("客户专项支持")
  await detailsDrawer.getByRole("button", { name: "恢复自动预测" }).click()
  await expect(page.getByRole("status")).toContainText("已恢复自动预测基线")
  await expect(e1Row.getByText("已修正基线", { exact: true })).toHaveCount(0)
  await expect(e1Row.getByText("预测基线", { exact: true })).toHaveCount(7)
  await detailsDrawer.press("Escape")

  // 刷新预测基线按钮
  await page.getByRole("button", { name: "刷新预测基线" }).click()
  await expect(page.getByRole("status")).toContainText("已刷新预测基线")

  // 转为正式确认（预填 forecast_other_percent = 60）
  await e1Row
    .getByRole("button", { name: /预计 60% \/ 70%.*查看负荷明细$/ })
    .first()
    .click()
  await detailsDrawer.getByRole("button", { name: "转为正式确认" }).click()
  await expect(editDrawer).toBeVisible()
  await expect(editDrawer.getByLabel("其他工作占比（%）")).toHaveValue("60")
  await editDrawer.getByRole("button", { name: "确认设置" }).click()
  await expect(editDrawer).toBeHidden()
  await expect(e1Row.getByText("60% / 100%", { exact: true })).toHaveCount(1)
  await expect(e1Row.getByText("预测基线", { exact: true })).toHaveCount(6)
})
