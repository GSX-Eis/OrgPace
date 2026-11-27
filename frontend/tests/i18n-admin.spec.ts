import { expect, test } from "@playwright/test"
import { checkI18n } from "../scripts/check-i18n"
import type { AuditEventPublic, JsonValue } from "../src/client"
import {
  actorLabels,
  auditLabels,
  auditSummary,
  targetLabels,
} from "../src/components/Admin/auditLabels"
import {
  accountLabels,
  employmentLabels,
  roleLabels,
} from "../src/components/Admin/labels"
import { employeeFieldLabels } from "../src/components/Roster/EmployeeFields"
import { changeLabels } from "../src/components/Roster/RosterPreview"
import { i18n } from "../src/i18n"
import { expectEnglishCopy } from "./utils/copy"

const CJK = /[\u4e00-\u9fff]/

test.use({ storageState: { cookies: [], origins: [] } })

test("shared admin, audit, and roster label maps translate every key to English", async () => {
  const real = checkI18n()
  expect(real.errors).toEqual([])

  const previous = i18n.language
  await i18n.changeLanguage("en")
  try {
    const records: Record<string, Record<string, string>> = {
      accountLabels,
      employmentLabels,
      roleLabels,
      auditLabels,
      actorLabels,
      targetLabels,
      employeeFieldLabels,
      changeLabels,
    }
    for (const [mapName, record] of Object.entries(records)) {
      for (const [key, value] of Object.entries(record)) {
        expect(value.trim(), `${mapName}.${key} should be non-empty`).not.toBe(
          "",
        )
        expect(
          value,
          `${mapName}.${key} still has Chinese: ${value}`,
        ).not.toMatch(CJK)
      }
    }

    const sampleDetails: Record<string, JsonValue> = {
      old_name: "Old Corp",
      new_name: "Acme Corp",
      capability_count: 5,
      step_key: "model",
      added: 1,
      updated: 2,
      policy_version: 2,
      source: "cli",
    }
    for (const action of Object.keys(auditLabels)) {
      const event: AuditEventPublic = {
        id: "audit-1",
        created_at: "2026-01-01T00:00:00Z",
        actor_type: "user",
        actor: null,
        action,
        target_type: "organization",
        target_id: "org-1",
        target_label: "Acme Corp",
        details: sampleDetails,
      }
      const summary = auditSummary(event)
      expect(
        summary,
        `auditSummary(${action}) still has Chinese: ${summary}`,
      ).not.toMatch(CJK)
    }
    expect(
      auditSummary({
        id: "audit-2",
        created_at: "2026-01-01T00:00:00Z",
        actor_type: "user",
        actor: null,
        action: "roster.imported",
        target_type: "roster_import",
        target_id: null,
        target_label: null,
        details: { added: 2, updated: 1 },
      }),
    ).toContain("Added")
  } finally {
    await i18n.changeLanguage(previous)
  }
})

test("setup, employees, rules, data-ai, sources, and audit pages render cleanly in English", async ({
  page,
  request,
}) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem("locale", "en")
  })

  // 1. Setup page: invalid link state + live initialization token form
  await page.goto("/setup")
  await expect(
    page.getByText(
      "The initialization link is invalid or expired. Please contact your deployment administrator.",
    ),
  ).toBeVisible()
  await expectEnglishCopy(page)

  const tokenRes = await request.post("/api/v1/private/setup-tokens", {
    data: { purpose: "new_org" },
  })
  expect(tokenRes.ok()).toBeTruthy()
  const { token } = (await tokenRes.json()) as { token: string }

  const adminEmail = `i18n-admin-${crypto.randomUUID()}@example.com`
  const adminPassword = "synthetic-password-2026"
  await page.goto(`/setup#token=${token}`)
  await expect(
    page.getByRole("heading", { name: "Initialize Organization" }),
  ).toBeVisible()
  await page.getByLabel("Organization Name", { exact: true }).fill("Acme Corp")
  await page.getByLabel("Administrator Email", { exact: true }).fill(adminEmail)
  await page
    .getByLabel("Full Name (optional)", { exact: true })
    .fill("Ada Admin")
  await page.getByLabel("Password", { exact: true }).fill(adminPassword)
  await page
    .getByLabel("Confirm Password", { exact: true })
    .fill("mismatch-123")
  await page
    .getByRole("button", { name: "Create Organization & Continue" })
    .click()
  await expect(page.getByText("The two passwords do not match")).toBeVisible()
  await expectEnglishCopy(page)

  // Fill matching password and submit
  await page.getByLabel("Confirm Password", { exact: true }).fill(adminPassword)
  const [initRes] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/v1/setup/initialize") &&
        res.request().method() === "POST",
    ),
    page
      .getByRole("button", { name: "Create Organization & Continue" })
      .click(),
  ])
  expect(initRes.ok()).toBeTruthy()
  const { org_id: orgId, access_token: accessToken } =
    (await initRes.json()) as { org_id: string; access_token: string }
  await expect(page).toHaveURL(/\/assistant\?mode=admin/)

  const headers = { Authorization: `Bearer ${accessToken}` }
  const base = `/api/v1/orgs/${orgId}`

  // Persist EN preference on the newly created synthetic admin user.
  const prefRes = await request.patch("/api/v1/users/me/preferences", {
    headers,
    data: { preferred_locale: "en" },
  })
  expect(prefRes.ok()).toBeTruthy()

  // Seed English employees & capability dictionary for rich interactive UI coverage.
  for (const emp of [
    {
      employee_code: "E01",
      display_name: "Alice Chen",
      email: `alice-${crypto.randomUUID()}@example.com`,
      department: "Engineering/Platform",
      title: "Staff Engineer",
    },
    {
      employee_code: "E02",
      display_name: "Bob Lin",
      email: `bob-${crypto.randomUUID()}@example.com`,
      department: "Product",
      title: "Product Manager",
    },
  ]) {
    const previewRes = await request.post(`${base}/roster/single-change`, {
      headers,
      data: { kind: "onboard", ...emp },
    })
    expect(previewRes.ok()).toBeTruthy()
    const preview = (await previewRes.json()) as {
      id: string
      base_revision: number
    }
    const applyRes = await request.post(
      `${base}/roster/imports/${preview.id}/apply`,
      { headers, data: { base_revision: preview.base_revision } },
    )
    expect(applyRes.ok()).toBeTruthy()
  }

  const dictRes = await request.put(`${base}/capabilities`, {
    headers,
    data: {
      expected_version: 0,
      definitions: [
        {
          key: "sys_arch",
          name: "System Architecture",
          category: "Engineering",
          description: "Designs resilient distributed systems",
          level_rubric: {
            levels: [
              {
                key: "basic",
                label: "Foundational",
                description: "Contributes to well-scoped designs",
              },
            ],
          },
        },
      ],
    },
  })
  expect(dictRes.ok()).toBeTruthy()

  // 2. Employees & account dialogs (/employees -> /admin/people)
  await page.goto("/employees")
  await expect(
    page.getByRole("heading", { name: "Employees", exact: true }),
  ).toBeVisible()
  await expect(
    page
      .getByRole("table")
      .getByRole("link", { name: "Alice Chen", exact: true }),
  ).toBeVisible()
  await expectEnglishCopy(page)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1440)

  // Profile fields dialog
  await page
    .getByRole("button", { name: "Profile Fields", exact: true })
    .click()
  const fieldsDialog = page.getByRole("dialog", { name: "Profile Fields" })
  await expect(fieldsDialog).toBeVisible()
  await expectEnglishCopy(fieldsDialog)
  await page.keyboard.press("Escape")

  // Personnel onboard dialog + preview
  await page.getByRole("button", { name: "Add Employee", exact: true }).click()
  const onboardDialog = page.getByRole("dialog")
  await expect(
    onboardDialog.getByRole("heading", { name: "Add Employee" }),
  ).toBeVisible()
  await onboardDialog.getByLabel("Employee ID", { exact: true }).fill("E03")
  await onboardDialog.getByLabel("Name", { exact: true }).fill("Cara Wu")
  await onboardDialog
    .getByLabel("Email", { exact: true })
    .fill(`cara-${crypto.randomUUID()}@example.com`)
  await onboardDialog.getByLabel("Department", { exact: true }).fill("Design")
  await onboardDialog.getByRole("button", { name: "Preview Changes" }).click()
  await expect(
    onboardDialog.getByRole("region", { name: "Roster preview" }),
  ).toBeVisible()
  await expectEnglishCopy(onboardDialog)
  await page.keyboard.press("Escape")

  // Issue accounts dialog
  await page
    .getByRole("button", { name: "Issue Accounts", exact: true })
    .click()
  const issueDialog = page.getByRole("dialog", { name: "Issue Accounts" })
  await expect(issueDialog).toBeVisible()
  await expectEnglishCopy(issueDialog)
  await issueDialog
    .getByRole("button", { name: "Generate & Download", exact: true })
    .click()
  await expect(issueDialog.getByText(/Generated \d+ account/)).toBeVisible()
  await expectEnglishCopy(issueDialog)
  await issueDialog
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click()

  // Row more menu -> Reset Password & Disable confirm dialogs
  const aliceLink = page
    .getByRole("table")
    .getByRole("link", { name: "Alice Chen", exact: true })
  const aliceHref = await aliceLink.getAttribute("href")
  const aliceRow = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Alice Chen", exact: true }),
  })
  await aliceRow.getByRole("button", { name: "More", exact: true }).click()
  await page.getByRole("menuitem", { name: "Reset Password" }).click()
  const resetDialog = page.getByRole("dialog", { name: /Reset Password/ })
  await expect(resetDialog).toBeVisible()
  await expectEnglishCopy(resetDialog)
  await page.keyboard.press("Escape")

  await aliceRow.getByRole("button", { name: "More", exact: true }).click()
  await page.getByRole("menuitem", { name: "Disable" }).click()
  const disableDialog = page.getByRole("dialog", { name: "Disable" })
  await expect(disableDialog).toBeVisible()
  await expectEnglishCopy(disableDialog)
  await page.keyboard.press("Escape")

  // Grant role dialog & Transfer (personnel edit) dialog (rendered on employee detail page)
  expect(aliceHref).toBeTruthy()
  await page.goto(`${aliceHref}?tab=account`)
  await page.getByRole("button", { name: "Grant Role", exact: true }).click()
  const grantDialog = page.getByRole("dialog", { name: "Grant Role" })
  await expect(grantDialog).toBeVisible()
  await expectEnglishCopy(grantDialog)
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Transfer", exact: true }).click()
  const transferDialog = page.getByRole("dialog", { name: /Transfer/ })
  await expect(transferDialog).toBeVisible()
  await expectEnglishCopy(transferDialog)
  await page.keyboard.press("Escape")

  // Unlinked accounts scope
  await page.goto("/employees?filter=account-only")
  await expect(
    page.getByText(
      "These accounts are not linked to an employee profile and only support viewing roles.",
    ),
  ).toBeVisible()
  await expectEnglishCopy(page)

  // 3. Rules: Capability Dictionary + Editor + Approval Rules + Reminders
  await page.goto("/admin/rules?tab=dictionary")
  await expect(page.getByText("System Architecture")).toBeVisible()
  await expectEnglishCopy(page)
  await page.getByRole("button", { name: "Change History" }).click()
  const historyDialog = page.getByRole("dialog", { name: "Change History" })
  await expect(historyDialog).toBeVisible()
  await expectEnglishCopy(historyDialog)
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Edit Dictionary" }).click()
  await expect(
    page.getByRole("region", { name: "Capability dictionary editor" }),
  ).toBeVisible()
  await expectEnglishCopy(page)

  await page.goto("/admin/rules?tab=approval")
  await expect(
    page.getByRole("region", { name: "Active Rules Summary" }),
  ).toBeVisible()
  await expectEnglishCopy(page)

  await page.goto("/admin/rules?tab=reminders")
  await expect(
    page.getByRole("button", { name: "Save Timezone" }),
  ).toBeVisible()
  await expectEnglishCopy(page)

  // 4. Data & AI tabs: Sources (+ drawers + identities), Work Records, Model, Bot, IM
  await page.goto("/admin/data-ai?tab=sources")
  await expect(
    page.getByRole("region", { name: "Jira Cloud", exact: true }),
  ).toBeVisible()
  await expectEnglishCopy(page)

  await page
    .getByRole("region", { name: "Jira Cloud", exact: true })
    .getByRole("button", { name: "Configure" })
    .click()
  const jiraDrawer = page.getByRole("dialog", { name: /Jira Cloud/ })
  await expect(jiraDrawer).toBeVisible()
  await expectEnglishCopy(jiraDrawer)
  await page.keyboard.press("Escape")

  await page
    .getByRole("region", { name: "CSV / Excel Work Records" })
    .getByRole("button", { name: "Import" })
    .click()
  const csvDrawer = page.getByRole("dialog", {
    name: /CSV \/ Excel Work Records/,
  })
  await expect(csvDrawer).toBeVisible()
  await expectEnglishCopy(csvDrawer)
  await page.keyboard.press("Escape")

  await page.goto("/admin/identities")
  await expect(
    page.getByRole("tablist", { name: "Account link status" }),
  ).toBeVisible()
  await expectEnglishCopy(
    page.getByRole("dialog", { name: "Unmatched Jira Accounts" }),
  )
  await expectEnglishCopy(page)

  await page.goto("/admin/data-ai?tab=work-records")
  await expect(
    page.getByRole("heading", { name: "Work Records", exact: true }),
  ).toBeVisible()
  await expectEnglishCopy(page)

  await page.goto("/admin/data-ai?tab=model")
  await expect(
    page.getByRole("region", { name: "Model Configuration", exact: true }),
  ).toBeVisible()
  await expectEnglishCopy(page)

  await page.goto("/admin/data-ai?tab=bot")
  await expect(
    page.getByRole("heading", { name: "Built-in Assistant", exact: true }),
  ).toBeVisible()
  await expectEnglishCopy(page)

  await page.goto("/admin/data-ai?tab=im")
  await expect(
    page.getByRole("heading", { name: "IM Channels", exact: true }),
  ).toBeVisible()
  await expectEnglishCopy(page)

  // 5. Audit log table, filter, and detail drawer
  await page.goto("/admin/audit")
  await expect(
    page.getByRole("heading", { name: "Audit Logs", exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Activate capability dictionary")).toBeVisible()
  await expectEnglishCopy(page, { allow: ["人员变动"] })
  await page
    .getByRole("row")
    .filter({ hasText: "Activate capability dictionary" })
    .first()
    .click()
  const auditDrawer = page.getByRole("dialog", { name: "Audit Event Details" })
  await expect(auditDrawer).toBeVisible()
  await expectEnglishCopy(auditDrawer)
  await page.keyboard.press("Escape")

  // 6. Admin Overview (Action Items section)
  await page.goto("/admin")
  const actionItems = page.getByRole("region", { name: "Action Items" })
  await expect(
    actionItems.getByRole("heading", { name: "Action Items", exact: true }),
  ).toBeVisible()
  await expectEnglishCopy(actionItems)
})

test("switching language refreshes backend copy live without losing unsaved drafts or recreating plan snapshots", async ({
  page,
  request,
}) => {
  test.setTimeout(120000)

  const api = async (
    url: string,
    token?: string,
    data?: object,
    method = data ? "POST" : "GET",
  ) => {
    const response = await request.fetch(url, {
      method,
      data,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    expect(
      response.ok(),
      `${method} ${url}: ${await response.text()}`,
    ).toBeTruthy()
    return response.headers()["content-type"]?.includes("application/json")
      ? response.json()
      : null
  }

  const setup = await api("/api/v1/private/setup-tokens", undefined, {
    purpose: "new_org",
  })
  const adminPassword = "synthetic-live-refresh-2026"
  const admin = await api("/api/v1/setup/initialize", undefined, {
    token: setup.token,
    org_name: "Live Refresh Org",
    admin_username: `live-refresh-${crypto.randomUUID()}@example.com`,
    admin_password: adminPassword,
    admin_full_name: "Live Admin",
  })
  const base = `/api/v1/orgs/${admin.org_id}`

  const preview = await request.post(`${base}/roster/imports`, {
    headers: { Authorization: `Bearer ${admin.access_token}` },
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          [
            "工号,姓名,部门,上级工号,邮箱",
            `E01,Alice Client,Client,,alice-${crypto.randomUUID()}@example.com`,
            `E02,Bob Lead,Engineering,,bob-${crypto.randomUUID()}@example.com`,
          ].join("\n"),
        ),
      },
    },
  })
  expect(preview.ok(), await preview.text()).toBeTruthy()
  const rosterPreview = await preview.json()
  await api(
    `${base}/roster/imports/${rosterPreview.id}/apply`,
    admin.access_token,
    { base_revision: rosterPreview.base_revision },
  )
  await api(`${base}/accounts/issue`, admin.access_token, {})
  const accounts = (await api(`${base}/accounts`, admin.access_token))
    .data as Array<{
    id: string
    employee_code: string
    department?: { id: string } | null
    account?: { user_id: string } | null
  }>
  const alice = accounts.find((a) => a.employee_code === "E01")!
  const bob = accounts.find((a) => a.employee_code === "E02")!
  await api(`${base}/role-grants`, admin.access_token, {
    user_id: bob.account!.user_id,
    role: "dept_manager",
    department_id: bob.department!.id,
  })
  await api(`${base}/capabilities/versions`, admin.access_token, {
    expected_version: 0,
    definitions: [
      {
        key: "sys_arch",
        name: "System Architecture",
        category: "Engineering",
        description: "Designs resilient systems",
        level_rubric: {
          levels: [
            {
              key: "basic",
              label: "Foundational",
              description: "Independent execution",
            },
          ],
        },
      },
    ],
  })
  await api(
    `${base}/capacity-settings`,
    admin.access_token,
    { enabled: true, requester_policy: "everyone" },
    "PUT",
  )

  const userToken = async (userId: string) => {
    const reset = await api(
      `${base}/accounts/${userId}/reset-password`,
      admin.access_token,
      {},
    )
    const loginRes = await request.post("/api/v1/login/access-token", {
      form: { username: reset.username, password: reset.initial_password },
    })
    expect(loginRes.ok()).toBeTruthy()
    const changed = await api(
      "/api/v1/users/me/password",
      (await loginRes.json()).access_token,
      {
        current_password: reset.initial_password,
        new_password: adminPassword,
      },
      "PATCH",
    )
    return changed.access_token as string
  }

  const aliceToken = await userToken(alice.account!.user_id)
  const bobToken = await userToken(bob.account!.user_id)
  const start = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const end = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
  const demand = await api(`${base}/capacity/demands`, aliceToken, {
    requesting_department_id: alice.department!.id,
    target_department_id: bob.department!.id,
    capability_key: "sys_arch",
    window_start: start,
    window_end: end,
    headcount: 1,
    allocation_percent: 50,
    description: "Architecture support for Q4",
  })

  const openAs = async (token: string, path: string, locale = "zh-CN") => {
    if (page.url().startsWith("http")) {
      await page.evaluate(() => localStorage.clear())
    }
    await page.goto("/login")
    await page.evaluate(
      ({ authToken, orgId, nextLocale }) => {
        localStorage.setItem("access_token", authToken)
        localStorage.setItem("current_org_id", orgId)
        localStorage.setItem("locale", nextLocale)
      },
      { authToken: token, orgId: admin.org_id, nextLocale: locale },
    )
    await page.goto(path)
  }

  // 1. Admin overview: backend card summaries & fix steps refresh immediately on language switch without leaving page.
  await openAs(admin.access_token, "/assistant?mode=admin", "zh-CN")
  const feishuCardZh = page.getByRole("article", { name: "飞书", exact: true })
  const modelCardZh = page.getByRole("article", {
    name: "AI 模型",
    exact: true,
  })
  await expect(feishuCardZh).toContainText("尚未开启")
  await expect(modelCardZh).toContainText(
    "尚未启用模型，自动起草与 AI 助手暂不可用",
  )
  await expect(modelCardZh).toContainText(
    "打开模型设置，填写并启用模型，再测试连接。",
  )

  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().endsWith("/admin/overview") &&
        res.request().method() === "GET" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-en").click(),
  ])
  await expect(page).toHaveURL(/\/assistant\?mode=admin/)
  const feishuCardEn = page.getByRole("article", {
    name: "Feishu",
    exact: true,
  })
  const modelCardEn = page.getByRole("article", {
    name: "AI Model",
    exact: true,
  })
  await expect(feishuCardEn).toContainText("Not enabled")
  await expect(modelCardEn).toContainText(
    "Model is not enabled; auto-drafting and AI Assistant are unavailable",
  )
  await expect(modelCardEn).toContainText(
    "Open model settings, configure and enable the model, then test the connection.",
  )

  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().endsWith("/admin/overview") &&
        res.request().method() === "GET" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-zh-CN").click(),
  ])
  await expect(page).toHaveURL(/\/assistant\?mode=admin/)
  await expect(feishuCardZh).toContainText("尚未开启")
  await expect(modelCardZh).toContainText(
    "尚未启用模型，自动起草与 AI 助手暂不可用",
  )

  // Enable a model so the admin assistant composer is active, and verify its draft survives live language switch.
  await api(
    `${base}/model-setting`,
    admin.access_token,
    {
      enabled: true,
      kind: "openai_compatible",
      provider: "openai-compatible",
      model: "synthetic",
      base_url: "http://127.0.0.1:11434/v1",
      api_key: "synthetic-key",
    },
    "PUT",
  )
  await page.reload()
  const assistantInput = page.locator("#admin-assistant-input")
  await expect(assistantInput).toBeEnabled()
  await assistantInput.fill("保留的助手草稿")

  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().endsWith("/admin/overview") &&
        res.request().method() === "GET" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-en").click(),
  ])
  await expect(feishuCardEn).toContainText("Not enabled")
  await expect(assistantInput).toHaveValue("保留的助手草稿")

  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().endsWith("/admin/overview") &&
        res.request().method() === "GET" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-zh-CN").click(),
  ])
  await expect(feishuCardZh).toContainText("尚未开启")
  await expect(assistantInput).toHaveValue("保留的助手草稿")

  // 2. Admin assistant page draft form (BotPage) keeps unsaved edits across language switch.
  await page.goto("/admin/data-ai?tab=bot")
  await page.getByLabel("提问指南").fill("保留的提问指南草稿")
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/users/me/preferences") &&
        res.request().method() === "PATCH" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-en").click(),
  ])
  await expect(page.getByLabel("Question Guide")).toHaveValue(
    "保留的提问指南草稿",
  )

  // 3. DictionaryEditor keeps unsaved edits across language switch.
  await page.goto("/admin/rules?tab=dictionary")
  await page.getByRole("button", { name: "Edit Dictionary" }).click()
  await page
    .getByLabel("Description")
    .first()
    .fill("Unsaved dictionary description")
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/users/me/preferences") &&
        res.request().method() === "PATCH" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-zh-CN").click(),
  ])
  await expect(page.getByLabel("能力说明").first()).toHaveValue(
    "Unsaved dictionary description",
  )

  // 4. ChangeRequestEditor keeps unsaved edits across language switch.
  await openAs(bobToken, `/employees/${bob.id}`, "zh-CN")
  await page.getByRole("button", { name: "添加能力", exact: true }).click()
  await page
    .getByRole("button", { name: "System Architecture", exact: true })
    .click()
  await page.getByRole("button", { name: "手动编辑", exact: true }).click()
  const requestDialog = page.getByRole("dialog", { name: "更新我的画像" })
  await requestDialog
    .getByRole("textbox", { name: "能力说明", exact: true })
    .fill("保留的能力说明草稿")
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/users/me/preferences") &&
        res.request().method() === "PATCH" &&
        res.ok(),
    ),
    page
      .getByTestId("language-switch-en")
      .evaluate((el) => (el as HTMLButtonElement).click()),
  ])
  await expect(
    page
      .getByRole("dialog", { name: "Update My Profile" })
      .getByRole("textbox", { name: "Capability statement", exact: true }),
  ).toHaveValue("保留的能力说明草稿")
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Discard", exact: true }).click()

  // 5. Planning workbench keeps existing snapshot (no POST createCase, stale remains false) across language switch.
  const caseUrl = `/capacity?tab=incoming&demand=${demand.id}&plans=1`
  const [initialCaseRes] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/planning/demands/") &&
        res.url().endsWith("/cases") &&
        res.request().method() === "POST" &&
        res.ok(),
    ),
    page.goto(caseUrl),
  ])
  const initialCase = (await initialCaseRes.json()) as {
    snapshot_id: string
    stale: boolean
  }
  await expect(
    page.getByRole("heading", { name: "Internal Plans" }),
  ).toBeVisible()

  let postCaseCount = 0
  page.on("request", (req) => {
    if (
      req.url().includes("/planning/") &&
      req.url().endsWith("/cases") &&
      req.method() === "POST"
    ) {
      postCaseCount += 1
    }
  })
  const [refetchCaseRes] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/planning/cases/") &&
        res.request().method() === "GET" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-zh-CN").click(),
  ])
  const refetchedCase = (await refetchCaseRes.json()) as {
    snapshot_id: string
    stale: boolean
  }
  expect(postCaseCount).toBe(0)
  expect(refetchedCase.snapshot_id).toBe(initialCase.snapshot_id)
  expect(refetchedCase.stale).toBe(false)
  await expect(page.getByRole("heading", { name: "内部方案" })).toBeVisible()
})

test("switching language while initial admin-overview request is in flight still resolves target language", async ({
  page,
  request,
}) => {
  const setupRes = await request.post("/api/v1/private/setup-tokens", {
    data: { purpose: "new_org" },
  })
  expect(setupRes.ok()).toBeTruthy()
  const { token } = (await setupRes.json()) as { token: string }

  const initRes = await request.post("/api/v1/setup/initialize", {
    data: {
      token,
      org_name: "Inflight Overview Org",
      admin_username: `inflight-${crypto.randomUUID()}@example.com`,
      admin_password: "synthetic-inflight-password-2026",
      admin_full_name: "Inflight Admin",
    },
  })
  expect(initRes.ok()).toBeTruthy()
  const admin = (await initRes.json()) as {
    org_id: string
    access_token: string
  }

  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let firstStarted!: () => void
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve
  })
  const seenAcceptLanguages: string[] = []
  let requestCount = 0

  await page.route("**/admin/overview", async (route) => {
    requestCount += 1
    seenAcceptLanguages.push(route.request().headers()["accept-language"] ?? "")
    if (requestCount === 1) {
      firstStarted()
      await firstGate
    }
    const response = await route.fetch()
    await route.fulfill({ response })
  })

  await page.goto("/login")
  await page.evaluate(
    ({ authToken, orgId }) => {
      localStorage.setItem("access_token", authToken)
      localStorage.setItem("current_org_id", orgId)
      localStorage.setItem("locale", "zh-CN")
    },
    { authToken: admin.access_token, orgId: admin.org_id },
  )

  await page.goto("/assistant?mode=admin")
  await firstStartedPromise

  const actionItemsRegion = page.getByRole("region", { name: "待办事项" })
  await expect(actionItemsRegion.getByRole("status")).toHaveText("加载中…")

  const [enOverviewRes] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().endsWith("/admin/overview") &&
        res.request().headers()["accept-language"] === "en" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-en").click(),
  ])
  expect(enOverviewRes.ok()).toBeTruthy()

  await expect(
    page.getByRole("article", { name: "Feishu", exact: true }),
  ).toContainText("Not enabled")
  await expect(
    page.getByRole("article", { name: "AI Model", exact: true }),
  ).toContainText(
    "Model is not enabled; auto-drafting and AI Assistant are unavailable",
  )

  // Release the delayed first zh-CN response and ensure it does not overwrite the English cache.
  releaseFirst()
  await page.waitForResponse(
    (res) =>
      res.url().endsWith("/admin/overview") &&
      res.request().headers()["accept-language"] === "zh-CN",
  )
  await expect(
    page.getByRole("article", { name: "Feishu", exact: true }),
  ).toContainText("Not enabled")
  await expect(
    page.getByRole("article", { name: "AI Model", exact: true }),
  ).toContainText(
    "Model is not enabled; auto-drafting and AI Assistant are unavailable",
  )
  expect(seenAcceptLanguages).toEqual(["zh-CN", "en"])
})

test("switching language while cached replan snapshot creation is in flight refreshes read without replaying POST", async ({
  page,
  request,
}) => {
  const password = "synthetic-replan-password-2026"
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
    return response.json()
  }

  const setup = await api("/api/v1/private/setup-tokens", {
    purpose: "new_org",
  })
  const admin = await api("/api/v1/setup/initialize", {
    token: setup.token,
    org_name: "Replan Inflight Org",
    admin_username: `replan-${crypto.randomUUID()}@example.com`,
    admin_password: password,
  })
  const base = `/api/v1/orgs/${admin.org_id}`
  const roster = await request.post(`${base}/roster/imports`, {
    headers: { Authorization: `Bearer ${admin.access_token}` },
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          [
            "工号,姓名,部门,上级工号,邮箱",
            `A,Synthetic Requester,Client,,a-${crypto.randomUUID()}@example.com`,
            `M,Synthetic Manager,R&D,,m-${crypto.randomUUID()}@example.com`,
            `B,Synthetic Worker,R&D,M,b-${crypto.randomUUID()}@example.com`,
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
          name: "Delivery",
          category: "Engineering",
          description: "Synthetic delivery capability",
          level_rubric: {
            levels: [
              {
                key: "routine",
                label: "Independent",
                description: "Works independently",
              },
            ],
          },
        },
      ],
    },
    admin.access_token,
  )
  const issued = await request.post(`${base}/accounts/issue`, {
    data: {},
    headers: { Authorization: `Bearer ${admin.access_token}` },
  })
  expect(issued.ok()).toBeTruthy()
  const accounts = (
    await api(`${base}/accounts`, undefined, admin.access_token)
  ).data as Array<{
    id: string
    employee_code: string
    department?: { id: string } | null
    account?: { user_id: string } | null
  }>
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
    expect(login.ok()).toBeTruthy()
    const changed = await api(
      "/api/v1/users/me/password",
      { current_password: reset.initial_password, new_password: password },
      (await login.json()).access_token,
      "PATCH",
    )
    tokens.set(code, changed.access_token as string)
  }
  const requesterToken = tokens.get("A")!
  const managerToken = tokens.get("M")!

  await api(
    `${base}/employees/${person("B").id}/profile/direct-edits`,
    {
      base_revision: null,
      items: [
        {
          op: "add",
          capability_key: "delivery",
          statement: "Synthetic delivery capability",
          level: "routine",
        },
      ],
    },
    admin.access_token,
  )
  await api(
    `${base}/capacity-settings`,
    { enabled: true, requester_policy: "everyone" },
    admin.access_token,
    "PUT",
  )

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
      items: [{ employee_id: person("B").id, other_percent: 0 }],
      start_week: start,
      end_week: later(14),
    },
    managerToken,
    "PUT",
  )

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
      description: "Synthetic replan demand",
    },
    requesterToken,
  )
  const initialCase = await api(
    `${base}/planning/demands/${demand.id}/cases`,
    {},
    managerToken,
  )
  const initialOption = await api(
    `${base}/planning/cases/${initialCase.id}/options`,
    {
      assignees: [
        {
          employee_id: person("B").id,
          allocation_percent: 50,
          start_date: start,
          end_date: later(13),
        },
      ],
    },
    managerToken,
  )
  const accepted = await api(
    `${base}/capacity/demands/${demand.id}/reply`,
    {
      option_id: initialOption.id,
      revision: demand.revision,
      outcome: "can_do",
      text: "Synthetic commitment",
    },
    managerToken,
  )
  expect(accepted.status).toBe("accepted")
  // Generate the active post-commit planning snapshot before opening the page so initial navigation renders it directly via GET.
  const openedCase = (await api(
    `${base}/planning/demands/${demand.id}/cases`,
    {},
    managerToken,
  )) as { id: string; snapshot_id: string }

  await page.goto("/login")
  await page.evaluate(
    ({ authToken, orgId, demandId, caseId }) => {
      localStorage.setItem("access_token", authToken)
      localStorage.setItem("current_org_id", orgId)
      localStorage.setItem("locale", "zh-CN")
      localStorage.setItem(`planning-case:${orgId}:${demandId}`, caseId)
    },
    {
      authToken: managerToken,
      orgId: admin.org_id,
      demandId: demand.id,
      caseId: openedCase.id,
    },
  )

  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes(`/planning/cases/${openedCase.id}`) &&
        res.request().method() === "GET" &&
        res.ok(),
    ),
    page.goto(`/capacity?tab=incoming&demand=${demand.id}&plans=1`),
  ])
  await expect(page.getByRole("heading", { name: "内部方案" })).toBeVisible()
  await expect(
    page.locator("#capacity-plans").getByRole("checkbox"),
  ).toBeVisible()

  // Make the cached snapshot genuinely stale on the backend so a focus refetch enters create(false).
  await api(
    `${base}/capacity/weeks`,
    {
      items: [{ employee_id: person("B").id, other_percent: 10 }],
      start_week: start,
      end_week: later(14),
    },
    managerToken,
    "PUT",
  )

  let releasePost!: () => void
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve
  })
  let postStarted!: () => void
  const postStartedPromise = new Promise<void>((resolve) => {
    postStarted = resolve
  })
  let postCount = 0

  await page.route("**/planning/demands/*/cases", async (route) => {
    if (route.request().method() === "POST") {
      postCount += 1
      if (postCount === 1) {
        postStarted()
        await postGate
      }
    }
    const response = await route.fetch()
    await route.fulfill({ response })
  })

  // 1. Idle cached replan page with genuinely stale backend snapshot: switching to EN only runs GET and keeps original snapshot_id.
  const enIdleReadPromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/planning/cases/${openedCase.id}`) &&
      res.request().method() === "GET" &&
      res.request().headers()["accept-language"] === "en" &&
      res.ok(),
  )
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/users/me/preferences") &&
        res.request().method() === "PATCH" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-en").click(),
  ])
  const enIdleRead = (await (await enIdleReadPromise).json()) as {
    id: string
    snapshot_id: string
    stale: boolean
  }
  expect(postCount).toBe(0)
  expect(enIdleRead.id).toBe(openedCase.id)
  expect(enIdleRead.snapshot_id).toBe(openedCase.snapshot_id)
  expect(enIdleRead.stale).toBe(true)
  await expect(
    page.getByRole("heading", { name: "Internal Plans" }),
  ).toBeVisible()
  await expect(
    page.locator("#capacity-plans").getByRole("alert"),
  ).toContainText("Data changed; please re-simulate")

  // 2. Focus refetch on cached stale Plans enters create(false) in flight; switching to zh-CN waits for that POST without replaying it.
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
  await postStartedPromise
  expect(postCount).toBe(1)

  const createdCasePromise = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/planning/demands/${demand.id}/cases`) &&
      res.request().method() === "POST" &&
      res.ok(),
  )

  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/users/me/preferences") &&
        res.request().method() === "PATCH" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-zh-CN").click(),
  ])
  expect(postCount).toBe(1)

  const zhReadPromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/planning/cases/${openedCase.id}`) &&
      res.request().method() === "GET" &&
      res.request().headers()["accept-language"] === "zh-CN" &&
      res.ok(),
  )
  releasePost()

  const createdCase = (await (await createdCasePromise).json()) as {
    id: string
    snapshot_id: string
  }
  const zhRead = (await (await zhReadPromise).json()) as {
    id: string
    snapshot_id: string
    stale: boolean
  }
  expect(postCount).toBe(1)
  expect(createdCase.snapshot_id).not.toBe(openedCase.snapshot_id)
  expect(zhRead.id).toBe(createdCase.id)
  expect(zhRead.snapshot_id).toBe(createdCase.snapshot_id)
  expect(zhRead.stale).toBe(false)
  await expect(page.getByRole("heading", { name: "内部方案" })).toBeVisible()

  // 3. Explicit resimulate button still creates a fresh snapshot on user demand.
  const [resimulatedRes] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().endsWith(`/planning/demands/${demand.id}/cases`) &&
        res.request().method() === "POST" &&
        res.ok(),
    ),
    page
      .locator("#capacity-plans")
      .getByRole("button", { name: "重新模拟" })
      .click(),
  ])
  const resimulated = (await resimulatedRes.json()) as { snapshot_id: string }
  expect(postCount).toBe(2)
  expect(resimulated.snapshot_id).not.toBe(createdCase.snapshot_id)
})
