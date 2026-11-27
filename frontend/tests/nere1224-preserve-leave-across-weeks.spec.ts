import { expect, test } from "@playwright/test"
import type { EmployeeAccount } from "../src/client"

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
})

function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

test("NERE-1224：跨周调整负荷时保留已有请假，支持单周正常编辑与显式撤销", async ({
  page,
  request,
}) => {
  test.setTimeout(120000)
  const password = "synthetic-nere1224-password-2026"
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
    org_name: "合成跨周保留请假企业",
    admin_username: `nere1224-${crypto.randomUUID()}@example.com`,
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
          `工号,姓名,部门,上级工号,邮箱\nM,林经理,产品部,,m-${crypto.randomUUID()}@example.com\nE1,陈一,产品部,M,e1-${crypto.randomUUID()}@example.com\n`,
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
  const emp1 = accounts.find((row) => row.employee_code === "E1")!
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
  for (const account of [manager, emp1]) {
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

  const mgrToken = tokens.get("M")!
  const e1Token = tokens.get("E1")!
  const e1Headers = { Authorization: `Bearer ${e1Token}` }

  const myData = await (
    await request.get(`${base}/capacity/workloads/me`, { headers: e1Headers })
  ).json()
  const w0 = myData.weeks[0].week_start as string
  const w1 = myData.weeks[1].week_start as string
  const w2 = myData.weeks[2].week_start as string

  // W0=100% (无请假), W1=80% (周三 1 天请假), W2=60% (周四-周五 2 天请假)
  const w0Tue = shiftDays(w0, 1)
  const w0Thu = shiftDays(w0, 3)
  const w1Wed = shiftDays(w1, 2)
  const w2Thu = shiftDays(w2, 3)
  const w2Fri = shiftDays(w2, 4)
  await post(
    `${base}/capacity/unavailability`,
    { employee_id: emp1.id, start_date: w1Wed, end_date: w1Wed },
    e1Token,
  )
  await post(
    `${base}/capacity/unavailability`,
    { employee_id: emp1.id, start_date: w2Thu, end_date: w2Fri },
    e1Token,
  )

  await page.goto("/login")
  await page.evaluate(
    ({ token, orgId }) => {
      localStorage.setItem("access_token", token)
      localStorage.setItem("current_org_id", orgId)
    },
    { token: mgrToken, orgId: admin.org_id },
  )
  await page.goto("/capacity?tab=team")

  const table = page.getByRole("table", { name: "团队负荷，按部门、姓名排序" })
  const e1Row = table.getByRole("row").filter({ hasText: "陈一" })
  await expect(e1Row.getByText("可用上限 80%", { exact: true })).toBeVisible()
  await expect(e1Row.getByText("可用上限 60%", { exact: true })).toBeVisible()

  // 1. 从 W0 打开「设置周投入」，跨周 (W0..W2) 只修改「其他工作占比」为 25%
  await e1Row.getByRole("button", { name: "设置", exact: true }).click()
  const editDrawer = page.getByRole("dialog", { name: "设置周投入 · 陈一" })
  await expect(editDrawer.getByLabel("可用上限（%）")).toHaveValue("100")
  await expect(
    editDrawer.getByRole("checkbox", { name: "请假" }),
  ).not.toBeChecked()

  await editDrawer.getByLabel("结束周", { exact: true }).fill(w2)
  await editDrawer.getByLabel("其他工作占比（%）").fill("25")

  const putPromise = page.waitForRequest(
    (req) => req.method() === "PUT" && req.url().endsWith("/capacity/weeks"),
  )
  await editDrawer.getByRole("button", { name: "确认设置" }).click()
  const putReq = await putPromise
  const putBody = putReq.postDataJSON() as {
    items: Array<Record<string, unknown>>
  }
  expect(putBody.items[0].other_percent).toBe(25)
  expect(putBody.items[0].capacity_percent).toBeUndefined()
  expect(putBody.items[0].on_leave).toBeUndefined()
  await expect(editDrawer).toBeHidden()

  // W0=25%/100%, W1=25%/80% (保留请假), W2=25%/60% (保留请假)
  await expect(e1Row.getByText("25% / 100%", { exact: true })).toBeVisible()
  await expect(e1Row.getByText("25% / 80%", { exact: true })).toBeVisible()
  await expect(e1Row.getByText("25% / 60%", { exact: true })).toBeVisible()

  const afterMulti = await (
    await request.get(`${base}/capacity/workloads/me`, { headers: e1Headers })
  ).json()
  expect(
    afterMulti.weeks
      .slice(0, 3)
      .map((w: { capacity_percent: number }) => w.capacity_percent),
  ).toEqual([100, 80, 60])
  expect(
    afterMulti.unavailabilities.map(
      (u: { start_date: string; end_date: string }) => [
        u.start_date,
        u.end_date,
      ],
    ),
  ).toEqual([
    [w1Wed, w1Wed],
    [w2Thu, w2Fri],
  ])

  // 2. 单周正常编辑：点开 W1 详情再进「设置周投入」，只改占比为 15%，保留 80% 请假
  await e1Row
    .getByRole("button", { name: /25% \/ 80%.*请假，查看负荷明细/ })
    .click()
  const detailsDrawer = page.getByRole("dialog", { name: "负荷明细 · 陈一" })
  await detailsDrawer.getByRole("button", { name: "设置周投入" }).click()
  await expect(editDrawer.getByLabel("可用上限（%）")).toHaveValue("80")
  await expect(editDrawer.getByRole("checkbox", { name: "请假" })).toBeChecked()
  await editDrawer.getByLabel("其他工作占比（%）").fill("15")
  await editDrawer.getByRole("button", { name: "确认设置" }).click()
  await expect(editDrawer).toBeHidden()
  await expect(e1Row.getByText("15% / 80%", { exact: true })).toBeVisible()

  // 3. 单周显式修改 W0 请假为 60%（需选定具体工作日，未选足前不提交），并显式撤销 W1 请假（D-012 通知）
  await e1Row.getByRole("button", { name: "设置", exact: true }).click()
  await editDrawer.getByLabel("可用上限（%）").fill("60")
  await expect(editDrawer.getByRole("checkbox", { name: "请假" })).toBeChecked()
  await editDrawer.getByRole("button", { name: "确认设置" }).click()
  await expect(editDrawer.getByRole("alert")).toContainText(
    "需选定 2 个请假工作日",
  )
  const w0Picker = editDrawer.getByRole("group", { name: "选择请假工作日" })
  await w0Picker.getByRole("checkbox", { name: /^周二 / }).check()
  await w0Picker.getByRole("checkbox", { name: /^周四 / }).check()
  await editDrawer.getByRole("button", { name: "确认设置" }).click()
  await expect(editDrawer).toBeHidden()
  await expect(e1Row.getByText("25% / 60%", { exact: true })).toHaveCount(2)

  await e1Row
    .getByRole("button", { name: /15% \/ 80%.*请假，查看负荷明细/ })
    .click()
  await detailsDrawer.getByRole("button", { name: "设置周投入" }).click()
  await editDrawer.getByRole("checkbox", { name: "请假" }).uncheck()
  await expect(editDrawer.getByLabel("可用上限（%）")).toHaveValue("100")
  await expect(
    editDrawer.getByRole("group", { name: "选择请假工作日" }),
  ).toContainText(`将撤销：${w1Wed}`)
  await editDrawer.getByRole("button", { name: "确认设置" }).click()
  await expect(editDrawer).toBeHidden()

  await expect(e1Row.getByText("15% / 100%", { exact: true })).toBeVisible()
  await expect(e1Row.getByText("25% / 60%", { exact: true })).toHaveCount(2)

  const inboxRes = await request.get(`${base}/me/inbox`, { headers: e1Headers })
  expect(inboxRes.ok(), await inboxRes.text()).toBeTruthy()
  const inbox = await inboxRes.json()
  expect(
    inbox.data.some((item: { message: string }) =>
      item.message.includes(`你的不可用时段已撤销（${w1Wed} 至 ${w1Wed}）`),
    ),
  ).toBeTruthy()
  const afterSingle = await (
    await request.get(`${base}/capacity/workloads/me`, { headers: e1Headers })
  ).json()
  expect(
    afterSingle.unavailabilities.map(
      (u: { start_date: string; end_date: string }) => [
        u.start_date,
        u.end_date,
      ],
    ),
  ).toEqual([
    [w0Tue, w0Tue],
    [w0Thu, w0Thu],
    [w2Thu, w2Fri],
  ])
})
