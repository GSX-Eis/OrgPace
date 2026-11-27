import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import type { EmployeeAccount } from "../src/client"
import { departmentOptions } from "../src/components/Admin/departments"
import { expectChineseCopy } from "./utils/copy"
import { logInUser } from "./utils/user"

test.use({ storageState: { cookies: [], origins: [] } })

test("account filtering, issuance, regeneration guard and atomic conflict", async ({
  page,
  request,
}) => {
  await logInUser(
    page,
    "admin@demo.example.com",
    process.env.DEMO_USER_PASSWORD!,
  )
  await expect(page).toHaveURL(
    /\/assistant\?mode=admin(?:&session=[0-9a-f-]+)?$/,
  )
  await page.getByRole("link", { name: "组织", exact: true }).click()
  await page.getByRole("link", { name: "员工", exact: true }).click()
  const rows = page.getByRole("row")
  const row = (name: string) =>
    rows.filter({ has: page.getByRole("link", { name, exact: true }) })
  const filter = async (name: string, option: string) => {
    await page.getByRole("combobox", { name }).click()
    await page.getByRole("option", { name: option, exact: true }).click()
  }
  await expect(row("许知夏")).toContainText("未开通")
  const headers = await page.locator("thead th").allInnerTexts()
  expect(headers).not.toContain("工号")
  expect(headers[headers.length - 1]).toBe("操作")
  await expectChineseCopy(page)
  await page.screenshot({
    path: "test-results/admin-accounts-list.png",
    fullPage: true,
  })
  await row("许知夏").getByRole("button", { name: "更多", exact: true }).click()
  await page.getByRole("menuitem", { name: "发放账号", exact: true }).click()
  const singleIssue = page.getByRole("dialog", { name: "发放账号" })
  const selectedEmployee = singleIssue
    .getByRole("row")
    .filter({ hasText: "E03" })
  await expect(selectedEmployee).toBeVisible()
  await selectedEmployee.getByRole("cell", { name: "E03", exact: true }).click()
  await expect(singleIssue).toBeVisible()
  await expect(page.getByRole("dialog", { name: "员工快速预览" })).toHaveCount(
    0,
  )
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click()
  await filter("账号状态筛选", "未开通")
  await expect(row("许知夏")).toBeVisible()
  await expect(row("林澈")).toHaveCount(0)
  await filter("账号状态筛选", "全部账号状态")
  await page.getByRole("textbox", { name: "搜索姓名或工号" }).fill("E02")
  await expect(page.getByText("共 1 名员工", { exact: false })).toBeVisible()
  await expect(
    rows.filter({ hasText: "张伟" }).filter({ hasText: "平台研发部" }),
  ).toBeVisible()
  await page.getByRole("textbox", { name: "搜索姓名或工号" }).clear()
  await expect(row("许知夏")).toBeVisible()
  await filter("部门筛选", "平台研发部")
  await expect(row("许知夏")).toBeVisible()
  await expect(row("陆星遥")).toHaveCount(0)
  await filter("部门筛选", "全部部门")
  await page
    .locator("header")
    .getByRole("button", { name: "发放账号", exact: true })
    .click()
  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByText(/将为 \d+ 名未开通账号的在职员工发放账号/),
  ).toBeVisible()
  await expectChineseCopy(page)
  await page.screenshot({
    path: "test-results/admin-accounts-range.png",
    fullPage: true,
  })
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  for (const code of ["E06", "E07"])
    await page
      .getByRole("checkbox", { name: `选择 ${code}`, exact: true })
      .check()
  await page.getByRole("button", { name: "发放账号（已选 2 人）" }).click()
  const regenerate = dialog.getByRole("checkbox")
  if (await regenerate.count()) {
    await expect(
      dialog.getByRole("button", { name: "确认生成并下载" }),
    ).toBeDisabled()
    await regenerate.check()
  }
  const downloadEvent = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "确认生成并下载" }).click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toMatch(/^账号-.*\.xlsx$/)
  expect(await download.failure()).toBeNull()
  await expect(dialog).toContainText("已生成 2 个账号。")
  await expect(dialog).toContainText("账号表仅支持下载一次")
  await expectChineseCopy(page)
  await page.screenshot({
    path: "test-results/admin-accounts-issued.png",
    fullPage: true,
  })
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click()
  for (const name of ["陆星遥", "陈予安"])
    await expect(row(name)).toContainText("待首次登录")
  await page.getByRole("checkbox", { name: "选择 E06", exact: true }).check()
  await page.getByRole("button", { name: "发放账号（已选 1 人）" }).click()
  await expect(
    dialog.getByRole("button", { name: "确认生成并下载" }),
  ).toBeDisabled()
  await expect(dialog).toContainText("请勾选重新生成")
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  await filter("在职状态筛选", "在职")
  await expect(page.getByText("已选 0 人", { exact: false })).toBeVisible()
  const credentials = {
    username: "employee04@demo.example.com",
    password: "conflict-password-2026",
  }
  const existing = await request.post("/api/v1/login/access-token", {
    form: credentials,
  })
  if (!existing.ok()) {
    const created = await request.post("/api/v1/private/users/", {
      data: credentials,
    })
    expect(created.ok()).toBeTruthy()
  }
  await page.getByRole("checkbox", { name: "选择 E04", exact: true }).check()
  await page.getByRole("button", { name: "发放账号（已选 1 人）" }).click()
  await dialog.getByRole("button", { name: "确认生成并下载" }).click()
  await expect(dialog.getByRole("alert")).toContainText("本次未发放任何账号")
  await expect(
    dialog.getByRole("row").filter({ hasText: "邮箱已被占用" }),
  ).toContainText("E04")
  await expectChineseCopy(page)
  await page.screenshot({
    path: "test-results/admin-accounts-conflict.png",
    fullPage: true,
  })
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  await expect(row("顾岚")).toContainText("未开通")
})

test("management role filtering resets the page and uses the filtered count", async ({
  page,
}) => {
  await logInUser(
    page,
    "admin@demo.example.com",
    process.env.DEMO_USER_PASSWORD!,
  )
  const employees = Array.from(
    { length: 52 },
    (_, i): EmployeeAccount => ({
      id: randomUUID(),
      employee_code: `RoleFilter-${i + 1}`,
      display_name: `筛选测试员工 ${i + 1}`,
      title: null,
      work_email: null,
      employment_status: "active",
      department: null,
      account: null,
      roles:
        i < 50
          ? []
          : [
              {
                id: randomUUID(),
                user_id: randomUUID(),
                username: `manager-${i + 1}`,
                role: "org_admin",
                display_name: null,
                department: null,
              },
            ],
    }),
  )
  const isAccounts = (url: URL) =>
    /^\/api\/v1\/orgs\/[^/]+\/accounts$/.test(url.pathname)
  await page.route(isAccounts, (route) => {
    const params = new URL(route.request().url()).searchParams
    const rows =
      params.get("has_roles") === "true" ? employees.slice(50) : employees
    const skip = Number(params.get("skip"))
    const limit = Number(params.get("limit"))
    return route.fulfill({
      json: { count: rows.length, data: rows.slice(skip, skip + limit) },
    })
  })

  await page.goto("/employees")
  const manager = page.getByRole("link", {
    name: "筛选测试员工 51",
    exact: true,
  })
  const next = page.getByRole("button", { name: "下一页", exact: true })
  await expect(page.getByText("共 52 名员工", { exact: false })).toBeVisible()
  await expect(manager).toHaveCount(0)
  await next.click()
  await expect(manager).toBeVisible()
  await expect(page.getByText(/页码\s*2\s*\/\s*2/)).toBeVisible()

  await page.getByRole("combobox", { name: "员工范围" }).click()
  const filteredResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return isAccounts(url) && url.searchParams.get("has_roles") === "true"
  })
  await page.getByRole("option", { name: "有管理角色", exact: true }).click()
  const response = await filteredResponse
  expect(new URL(response.url()).searchParams.get("skip")).toBe("0")
  await expect(manager).toBeVisible()
  await expect(
    page.getByRole("link", { name: "筛选测试员工 52", exact: true }),
  ).toBeVisible()
  await expect(page.getByText("共 2 名员工", { exact: false })).toBeVisible()
  await expect(page.getByText(/页码\s*1\s*\/\s*1/)).toBeVisible()
  await expect(next).toBeDisabled()
})

test("employee legacy access returns to their allowed landing page", async ({
  page,
}) => {
  await logInUser(
    page,
    "employee.platform@demo.example.com",
    process.env.DEMO_USER_PASSWORD!,
  )
  await expect(page.getByRole("link", { name: "人员" })).toHaveCount(0)
  await page.goto("/admin/accounts")
  await expect(page).toHaveURL("/assistant")
  await expectChineseCopy(page)
})

test("department options include ancestor names", () => {
  const base = { org_id: "org", parent_department_id: null }
  const options = departmentOptions([
    { ...base, id: "root", name: "研发中心" },
    { ...base, id: "child", name: "研发部", parent_department_id: "root" },
  ])
  expect(options.find((d) => d.id === "child")?.name).toBe("研发中心 / 研发部")
})
