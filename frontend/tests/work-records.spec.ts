import { expect, test } from "@playwright/test"
import { expectChineseCopy } from "./utils/copy"
import { createSourcesOrg } from "./utils/sources"
import { logInUser } from "./utils/user"

test.use({
  viewport: { width: 1440, height: 900 },
  storageState: { cookies: [], origins: [] },
})

test("admin navigates to work records from sidebar and sources, imports CSV and filters unified preview", async ({
  page,
}, testInfo) => {
  test.setTimeout(120000)
  await createSourcesOrg(page)
  const nav = page.getByRole("navigation", { name: "空间导航" })
  await expect(
    nav.getByRole("link", { name: "工作记录", exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "查看工作记录", exact: true }),
  ).toBeVisible()

  await page
    .getByRole("button", { name: "导入 CSV / Excel 工作记录", exact: true })
    .click()
  const csv = [
    "记录编号,来源,发生时间,执行人账号,执行人姓名,状态,标题,说明",
    "WR-CSV-1,Git,2026-07-01T10:00:00+08:00,git.demo,示例工程师,已合并,实现多来源工作记录预览,正常详情",
  ].join("\n")
  await page.getByLabel("选择工作记录文件").setInputFiles({
    name: "work-records.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  })
  await expect(page.getByText("已开始导入", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("link", { name: /前往工作记录预览/ }),
  ).toBeVisible()
  await expect(page.getByText("文件导入：成功", { exact: true })).toBeVisible({
    timeout: 90000,
  })
  await page.getByRole("link", { name: /前往工作记录预览/ }).click()
  await expect(page).toHaveURL(
    /\/admin\/data-ai\?tab=work-records&sync_run_id=/,
  )
  await expect(
    page.getByRole("status").filter({ hasText: "显示这些任务的当前记录" }),
  ).toBeVisible()
  const table = page.getByRole("table")
  await expect(table.getByText("实现多来源工作记录预览")).toBeVisible()
  await expect(table.getByText("CSV · Git")).toBeVisible()
  await expect(table.getByText("未关联")).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("work-records-batch.png"),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    page.getByRole("status").filter({ hasText: "显示这些任务的当前记录" }),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole("button", { name: "重置筛选", exact: true }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "显示这些任务的当前记录" }),
  ).toHaveCount(0)
  await expect(table.getByText("实现多来源工作记录预览")).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  const cards = page.getByRole("region", { name: "工作记录卡片" })
  await expect(cards.getByText("实现多来源工作记录预览")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await expectChineseCopy(page, ["Git", "CSV"])
})

test("demo admin views seeded Jira records and filters read-only work records", async ({
  page,
}) => {
  await logInUser(
    page,
    "admin@demo.example.com",
    process.env.DEMO_USER_PASSWORD!,
  )
  await page.getByRole("link", { name: "设置", exact: true }).click()
  await page
    .getByRole("navigation", { name: "空间导航" })
    .getByRole("link", { name: "工作记录", exact: true })
    .click()
  await expect(page).toHaveURL("/admin/data-ai?tab=work-records")
  await expect(
    page.getByRole("heading", { name: "工作记录", exact: true }),
  ).toBeVisible()
  await expect(page.getByText("不包含评论、工时和附件")).toBeVisible()
  await expect(
    page.getByRole("columnheader", { name: "任务标题" }),
  ).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "状态" })).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "时间" })).toBeVisible()
  await expect(
    page.getByRole("columnheader", { name: "关联的人" }),
  ).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "来源" })).toBeVisible()
  await expect(page.locator("tbody tr").first()).toBeVisible()

  await page.getByRole("combobox", { name: "部门筛选" }).click()
  await page.getByRole("option", { name: "平台研发部", exact: true }).click()
  await expect(page.locator("tbody tr").first()).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("region", { name: "工作记录卡片" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  )
})

test("demo admin sees incomplete warning banner for legacy Jira batch", async ({
  page,
}) => {
  await logInUser(
    page,
    "admin@demo.example.com",
    process.env.DEMO_USER_PASSWORD!,
  )
  const warningText =
    "该历史 Jira 同步批次缺少任务关联记录，当前仅能按已生成证据匹配，未关联账号或未变更的记录可能未包含在内，结果可能不完整。"
  await page.route("**/api/v1/orgs/*/work-records*", async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    await route.fulfill({
      response,
      json: { ...payload, warning: warningText },
    })
  })
  await page.goto("/admin/data-ai?tab=work-records")
  const banner = page.getByRole("status").filter({ hasText: warningText })
  await expect(banner).toBeVisible()
  await expectChineseCopy(banner)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(banner).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  )
})

for (const account of ["manager.platform", "employee.platform"]) {
  test(`${account}: cannot access work records`, async ({ page }) => {
    await logInUser(
      page,
      `${account}@demo.example.com`,
      process.env.DEMO_USER_PASSWORD!,
    )
    await page.goto("/admin/data-ai?tab=work-records")
    await expect(page.getByRole("alert")).toContainText("需要企业管理员权限")
  })
}

test("admin can search and load more employees and sync batches beyond first page", async ({
  page,
}) => {
  await logInUser(
    page,
    "admin@demo.example.com",
    process.env.DEMO_USER_PASSWORD!,
  )
  const extraEmpId = "00000000-0000-4000-8000-000000000105"
  const extraRunId = "00000000-0000-4000-8000-000000000055"
  const workRecordQueries: string[] = []

  await page.route("**/api/v1/orgs/*/accounts*", async (route) => {
    const url = new URL(route.request().url())
    const q = url.searchParams.get("q") ?? ""
    const skip = Number(url.searchParams.get("skip") ?? "0")
    if (q.includes("第一百零五")) {
      await route.fulfill({
        json: {
          count: 1,
          data: [
            {
              id: extraEmpId,
              display_name: "第一百零五号员工",
              employee_code: "EMP-105",
              employment_status: "active",
              roles: [],
            },
          ],
        },
      })
      return
    }
    const items = Array.from({ length: skip === 0 ? 50 : 5 }, (_, idx) => {
      const n = skip + idx + 1
      return {
        id:
          n === 105
            ? extraEmpId
            : `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        display_name: n === 105 ? "第一百零五号员工" : `测试员工${n}`,
        employee_code: `EMP-${String(n).padStart(3, "0")}`,
        employment_status: "active",
        roles: [],
      }
    })
    await route.fulfill({ json: { count: 105, data: items } })
  })

  await page.route("**/api/v1/orgs/*/sync-runs*", async (route) => {
    const url = new URL(route.request().url())
    const q = url.searchParams.get("q") ?? ""
    const skip = Number(url.searchParams.get("skip") ?? "0")
    if (q.includes("早期批次")) {
      await route.fulfill({
        json: {
          count: 1,
          data: [
            {
              id: extraRunId,
              kind: "csv",
              status: "succeeded",
              trigger: "manual",
              attempts: 1,
              counts: { records: 2 },
              error: null,
              filename: "早期批次.csv",
              project_keys: null,
              created_at: "2026-01-01T00:00:00Z",
              started_at: null,
              finished_at: null,
            },
          ],
        },
      })
      return
    }
    const items = Array.from({ length: skip === 0 ? 50 : 5 }, (_, idx) => {
      const n = skip + idx + 1
      return {
        id:
          n === 55
            ? extraRunId
            : `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
        kind: "csv",
        status: "succeeded",
        trigger: "manual",
        attempts: 1,
        counts: { records: 1 },
        error: null,
        filename: n === 55 ? "早期批次.csv" : `批次-${n}.csv`,
        project_keys: null,
        created_at: "2026-02-01T00:00:00Z",
        started_at: null,
        finished_at: null,
      }
    })
    await route.fulfill({ json: { count: 55, data: items } })
  })

  await page.route("**/api/v1/orgs/*/work-records*", async (route) => {
    workRecordQueries.push(route.request().url())
    const response = await route.fetch()
    await route.fulfill({ response })
  })

  await page.goto("/admin/data-ai?tab=work-records")

  // Employee picker: load more + keyword search
  await page.getByRole("button", { name: "人员筛选", exact: true }).click()
  const empDialog = page.getByRole("dialog", { name: "选择筛选人员" })
  await expect(empDialog.getByText("共 105 条")).toBeVisible()
  await empDialog.getByRole("button", { name: "加载更多", exact: true }).click()
  await empDialog
    .getByRole("textbox", { name: "搜索人员姓名、工号或账号" })
    .fill("第一百零五")
  await empDialog
    .getByRole("button", { name: "第一百零五号员工（EMP-105）" })
    .click()
  await expect(
    page.getByRole("button", { name: "人员筛选", exact: true }),
  ).toContainText("第一百零五号员工")

  // Sync batch picker: load more + keyword search
  await page.getByRole("button", { name: "同步批次筛选", exact: true }).click()
  const batchDialog = page.getByRole("dialog", { name: "选择同步批次" })
  await expect(batchDialog.getByText("共 55 条")).toBeVisible()
  await batchDialog
    .getByRole("button", { name: "加载更多", exact: true })
    .click()
  await expect(
    batchDialog.getByRole("button", { name: /早期批次\.csv/ }),
  ).toBeVisible()
  await batchDialog
    .getByRole("textbox", { name: "搜索同步批次文件名或来源" })
    .fill("早期批次")
  await batchDialog.getByRole("button", { name: /早期批次\.csv/ }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "显示这些任务的当前记录" }),
  ).toBeVisible()
  expect(
    workRecordQueries.some(
      (url) =>
        url.includes(`employee_id=${extraEmpId}`) &&
        url.includes(`sync_run_id=${extraRunId}`),
    ),
  ).toBeTruthy()
})
