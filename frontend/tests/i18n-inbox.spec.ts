import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test"
import { checkNoChinese } from "../scripts/check-no-chinese"
import type { EmployeeAccount, InboxList } from "../src/client"
import { expectEnglishCopy } from "./utils/copy"
import { seedLegacyAcceptedDemand } from "./utils/legacyCapacity"

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
})

test("check-no-chinese passes on repo src and rejects hardcoded Chinese and reasonless ignores", () => {
  const real = checkNoChinese()
  expect(real.errors).toEqual([])
  expect(real.fileCount).toBeGreaterThan(0)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-no-chinese-"))
  try {
    const srcDir = path.join(root, "src")
    fs.mkdirSync(path.join(srcDir, "i18n", "locales", "zh-CN"), {
      recursive: true,
    })
    fs.mkdirSync(path.join(srcDir, "client"), { recursive: true })
    // Excluded paths must not fail.
    fs.writeFileSync(
      path.join(srcDir, "i18n", "locales", "zh-CN", "common.json"),
      JSON.stringify({ ok: "中文" }),
    )
    fs.writeFileSync(
      path.join(srcDir, "client", "sdk.gen.ts"),
      'export const x = "中文"',
    )
    fs.writeFileSync(
      path.join(srcDir, "sample.test.ts"),
      'export const x = "中文"',
    )
    // Valid exemptions with reasons pass (inline EOL, standalone next-line, inline & standalone JSX).
    fs.writeFileSync(
      path.join(srcDir, "Valid.tsx"),
      [
        'export const a = "合法" // i18n-ignore: 业务协议字段',
        "// i18n-ignore: 独立行注释豁免下一行",
        'export const next = "独立注释下一行"',
        "export function View() {",
        "  return (",
        "    <div>",
        "      <span>{/* i18n-ignore: 仅作协议占位 */}示例</span>",
        "      <p>",
        "        {/* i18n-ignore: 独立 JSX 注释豁免下一行 */}",
        "        独立JSX换行示例",
        "      </p>",
        "    </div>",
        "  )",
        "}",
      ].join("\n"),
    )
    // Violations: string/template/JSX literals, reasonless ignore, adjacent lines after trailing
    // ignores, blank-line-separated standalone ignore, and fake ignore markers inside strings/JSX text.
    fs.writeFileSync(
      path.join(srcDir, "Broken.tsx"),
      [
        'export const s = "新增硬编码中文"',
        `export const t = \`模板\${"${1}"}中文\``,
        "export const bare = '豁免无原因' // i18n-ignore",
        'export const prevProtocol = "旧协议文案" // i18n-ignore: 仅豁免本行旧协议',
        'export const leakedNextLine = "紧邻未注释界面文案"',
        "// i18n-ignore: 空行隔断后不能豁免",
        "",
        'export const afterBlankLine = "空行后未注释中文"',
        'export const fakeInlineMarker = "字符串假注释 {/* i18n-ignore: 假理由 */}"',
        "export const fakeTemplateMarker = `多行模板中文",
        "// i18n-ignore: 模板字面量内假注释",
        "`",
        'export const fakeMissingReasonText = "示例 // i18n-ignore"',
        "export function Broken() {",
        "  return (",
        "    <div>",
        "      <p>未国际化文本</p>",
        "      <span>旧JSX协议</span> {/* i18n-ignore: JSX行末仅管本行 */}",
        "      <span>JSX紧邻未注释</span>",
        "      <p>JSX文本伪注释 // i18n-ignore: 假理由</p>",
        "    </div>",
        "  )",
        "}",
      ].join("\n"),
    )

    const result = checkNoChinese({ srcDir })
    expect(result.ignoreCount).toBe(6)
    expect(result.errors.some((e) => e.includes("新增硬编码中文"))).toBe(true)
    expect(result.errors.some((e) => e.includes("模板"))).toBe(true)
    expect(result.errors.some((e) => e.includes("紧邻未注释界面文案"))).toBe(
      true,
    )
    expect(result.errors.some((e) => e.includes("空行后未注释中文"))).toBe(true)
    expect(result.errors.some((e) => e.includes("字符串假注释"))).toBe(true)
    expect(result.errors.some((e) => e.includes("多行模板中文"))).toBe(true)
    expect(result.errors.some((e) => e.includes("示例 // i18n-ignore"))).toBe(
      true,
    )
    expect(result.errors.some((e) => e.includes("未国际化文本"))).toBe(true)
    expect(result.errors.some((e) => e.includes("JSX紧邻未注释"))).toBe(true)
    expect(result.errors.some((e) => e.includes("JSX文本伪注释"))).toBe(true)
    expect(result.errors.some((e) => e.includes("旧协议文案"))).toBe(false)
    expect(result.errors.some((e) => e.includes("旧JSX协议"))).toBe(false)
    expect(
      result.errors.filter((e) => e.includes("Missing reason for i18n-ignore")),
    ).toHaveLength(1)
    expect(result.errors.some((e) => e.includes("Valid.tsx"))).toBe(false)
    expect(result.errors.some((e) => e.includes("sdk.gen.ts"))).toBe(false)
    expect(result.errors.some((e) => e.includes("sample.test.ts"))).toBe(false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function setupInboxOrg(request: APIRequestContext) {
  const password = "synthetic-i18n-inbox-2026"
  const api = async (
    url: string,
    token?: string,
    data?: object,
    method = data ? "POST" : "GET",
  ) => {
    const res = await request.fetch(url, {
      method,
      data,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    expect(res.ok(), await res.text()).toBeTruthy()
    return res.json()
  }

  const setupToken = await api("/api/v1/private/setup-tokens", undefined, {
    purpose: "new_org",
  })
  const admin = await api("/api/v1/setup/initialize", undefined, {
    token: setupToken.token,
    org_name: "Acme Inbox Org",
    admin_username: `inbox-admin-${crypto.randomUUID()}@example.com`,
    admin_password: password,
    admin_full_name: "Alex Admin",
  })
  const base = `/api/v1/orgs/${admin.org_id}`
  const root = admin.access_token as string

  const rosterRes = await request.post(`${base}/roster/imports`, {
    headers: { Authorization: `Bearer ${root}` },
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          [
            "工号,姓名,部门,职位,上级工号,邮箱",
            `A01,Riley Req,Acme/Marketing,Product Lead,,a01-${crypto.randomUUID()}@example.com`,
            `D01,Victor VP,Acme/Engineering,VP Engineering,,d01-${crypto.randomUUID()}@example.com`,
            `M01,Morgan Mgr,Acme/Engineering/Backend,Backend Lead,D01,m01-${crypto.randomUUID()}@example.com`,
            `E01,Carol Eng,Acme/Engineering/Backend,Backend Engineer,M01,e01-${crypto.randomUUID()}@example.com`,
            `L01,Lena Lender,Acme/Support,Support Lead,,l01-${crypto.randomUUID()}@example.com`,
            `B01,Ben Support,Acme/Support,Support Engineer,L01,b01-${crypto.randomUUID()}@example.com`,
          ].join("\n"),
        ),
      },
    },
  })
  expect(rosterRes.ok(), await rosterRes.text()).toBeTruthy()
  const preview = await rosterRes.json()
  await api(`${base}/roster/imports/${preview.id}/apply`, root, {
    base_revision: preview.base_revision,
  })

  await api(`${base}/capabilities/versions`, root, {
    expected_version: 0,
    definitions: [
      {
        key: "delivery",
        name: "Delivery",
        category: "Engineering",
        description: "End-to-end service delivery",
        level_rubric: {
          levels: [
            {
              key: "routine",
              label: "Handles routine tasks",
              description: "Delivers tasks independently",
            },
          ],
        },
      },
    ],
  })

  const issueRes = await request.post(`${base}/accounts/issue`, {
    headers: { Authorization: `Bearer ${root}` },
    data: {},
  })
  expect(issueRes.ok(), await issueRes.text()).toBeTruthy()
  const accounts: EmployeeAccount[] = (await api(`${base}/accounts`, root)).data
  const person = (code: string) =>
    accounts.find((item) => item.employee_code === code)!

  for (const code of ["A01", "D01", "M01", "L01"]) {
    await api(`${base}/role-grants`, root, {
      user_id: person(code).account!.user_id,
      role: "dept_manager",
      department_id: person(code).department!.id,
    })
  }

  const tokens = new Map<string, string>()
  for (const code of ["A01", "D01", "M01", "E01", "L01", "B01"]) {
    const reset = await api(
      `${base}/accounts/${person(code).account!.user_id}/reset-password`,
      root,
      {},
    )
    const loginRes = await request.post("/api/v1/login/access-token", {
      form: { username: reset.username, password: reset.initial_password },
    })
    expect(loginRes.ok(), await loginRes.text()).toBeTruthy()
    await api(
      "/api/v1/users/me/password",
      (await loginRes.json()).access_token,
      { current_password: reset.initial_password, new_password: password },
      "PATCH",
    )
    const finalLogin = await request.post("/api/v1/login/access-token", {
      form: { username: reset.username, password },
    })
    expect(finalLogin.ok(), await finalLogin.text()).toBeTruthy()
    tokens.set(code, (await finalLogin.json()).access_token)
  }

  await api(
    `${base}/employees/${person("B01").id}/profile/direct-edits`,
    root,
    {
      base_revision: null,
      items: [
        {
          op: "add",
          capability_key: "delivery",
          statement: "Delivery experience",
          level: "routine",
        },
      ],
    },
  )
  await api(
    `${base}/capacity-settings`,
    root,
    { enabled: true, requester_policy: "everyone" },
    "PUT",
  )

  return { admin, base, root, api, person, tokens }
}

async function openAs(
  page: Page,
  orgId: string,
  token: string,
  locale: "zh-CN" | "en",
  dest: string,
) {
  await page.goto("/login")
  await page.evaluate(
    ({ accessToken, currentOrgId, nextLocale }) => {
      localStorage.setItem("access_token", accessToken)
      localStorage.setItem("current_org_id", currentOrgId)
      localStorage.setItem("locale", nextLocale)
    },
    { accessToken: token, currentOrgId: orgId, nextLocale: locale },
  )
  await page.goto(dest)
}

test("inbox language switch, English capacity links, and redacted delegated extension receipt work end-to-end", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const { admin, base, root, api, person, tokens } =
    await setupInboxOrg(request)
  const reqToken = tokens.get("A01")!
  const vpToken = tokens.get("D01")!
  const mgrToken = tokens.get("M01")!
  const empToken = tokens.get("E01")!
  const lenderToken = tokens.get("L01")!

  const meWeeks = await api(`${base}/capacity/workloads/me`, mgrToken)
  const monday = meWeeks.weeks[0].week_start as string
  const addDays = (iso: string, days: number) =>
    new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86400000)
      .toISOString()
      .slice(0, 10)

  // 1. Employee submits a workload adjustment request -> manager receives bilingual inbox notification.
  const wlReq = await api(`${base}/capacity/workloads/me/requests`, empToken, {
    requested_percent: 45,
    reason: "Q4 platform delivery",
    start_week: monday,
    end_week: monday,
  })

  // Open /inbox in zh-CN and keep the workload approval notice open.
  await openAs(page, admin.org_id, mgrToken, "zh-CN", "/inbox")
  const inboxList = page.getByRole("complementary", { name: "消息列表" })
  const zhWorkloadItem = inboxList
    .getByRole("listitem")
    .filter({ hasText: "有负荷调整申请等你审批" })
    .first()
  await expect(zhWorkloadItem).toBeVisible()
  await zhWorkloadItem.getByRole("button").click()
  const zhDetail = page.getByRole("region", { name: "消息详情" })
  await expect(zhDetail).toContainText("有负荷调整申请等你审批")

  // Switch to EN right inside /inbox without reload: list item and open detail must refetch & render in English.
  await page.getByTestId("language-switch-en").click()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")

  const enInboxList = page.getByRole("complementary", { name: "Messages" })
  const enWorkloadItem = enInboxList
    .getByRole("listitem")
    .filter({
      hasText: "You have a workload adjustment request awaiting approval",
    })
    .first()
  await expect(enWorkloadItem).toBeVisible()

  const enDetail = page.getByRole("region", { name: "Message details" })
  await expect(enDetail).toContainText(
    "You have a workload adjustment request awaiting approval",
  )
  await expectEnglishCopy(page.locator("main"))

  // English workload approval notification routes to /reviews?type=workload.
  await enDetail.getByRole("link", { name: "View pending reviews" }).click()
  await expect(page).toHaveURL(/\/reviews\?type=workload/)

  // Approve workload request and verify InboxApprovalDetail also refetches immediately when switching zh-CN -> EN.
  await api(
    `${base}/capacity/workload-requests/${wlReq.id}/decision`,
    mgrToken,
    {
      approve: true,
      note: "Approved for Q4",
    },
  )
  await openAs(page, admin.org_id, empToken, "zh-CN", "/inbox")
  const zhResultItem = inboxList
    .getByRole("listitem")
    .filter({ hasText: "负荷调整申请已同意" })
    .first()
  await expect(zhResultItem).toBeVisible()
  await zhResultItem.getByRole("button").click()
  await expect(zhDetail).toContainText("负荷调整申请已同意")
  await expect(zhDetail).toContainText("已同意")
  await expect(zhDetail).toContainText("Q4 platform delivery")

  await page.getByTestId("language-switch-en").click()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(enDetail).toContainText(
    "Your workload adjustment request was approved",
  )
  await expect(enDetail).toContainText("Approved")
  await expect(enDetail).toContainText("Request reason: Q4 platform delivery")
  await expectEnglishCopy(page.locator("main"))

  // 2. Borrow request notification in EN routes to /reviews?type=borrow.
  await api(
    `${base}/capacity/weeks`,
    lenderToken,
    {
      items: [{ employee_id: person("B01").id, other_percent: 0 }],
      start_week: monday,
      end_week: addDays(monday, 14),
    },
    "PUT",
  )
  const borrowDemand = await api(`${base}/capacity/demands`, reqToken, {
    requesting_department_id: person("A01").department!.id,
    target_department_id: person("M01").department!.id,
    capability_key: "delivery",
    headcount: 1,
    allocation_percent: 70,
    window_start: monday,
    window_end: addDays(monday, 13),
    description: "Need support capacity for release",
  })
  const planCase = await api(
    `${base}/planning/demands/${borrowDemand.id}/cases`,
    mgrToken,
    {},
  )
  const borrowOption = planCase.options.find(
    (option: { kind: string }) => option.kind === "borrow",
  )
  expect(borrowOption).toBeTruthy()
  await api(`${base}/capacity/demands/${borrowDemand.id}/reply`, mgrToken, {
    option_id: borrowOption.id,
    revision: borrowDemand.revision,
    outcome: "partial",
    text: "Borrow one engineer from Support",
    lender_department_id: person("L01").department!.id,
    borrow_headcount: 1,
  })

  await openAs(page, admin.org_id, lenderToken, "en", "/inbox")
  const enBorrowItem = enInboxList
    .getByRole("listitem")
    .filter({ hasText: "Borrow request (Delivery," })
    .first()
  await expect(enBorrowItem).toBeVisible()
  await enBorrowItem.getByRole("button").click()
  await expectEnglishCopy(page.locator("main"))
  await enDetail.getByRole("link", { name: "View pending reviews" }).click()
  await expect(page).toHaveURL(/\/reviews\?type=borrow/)

  // 3. Restricted delegated extension receipt in EN shows only the English redacted text.
  const extDemand = await api(`${base}/capacity/demands`, reqToken, {
    requesting_department_id: person("A01").department!.id,
    target_department_id: person("D01").department!.id,
    capability_key: "delivery",
    headcount: 1,
    allocation_percent: 30,
    window_start: monday,
    window_end: addDays(monday, 20),
    description: "Backend extension scope test",
  })
  await api(`${base}/capacity/demands/${extDemand.id}/reply`, vpToken, {
    revision: extDemand.revision,
    outcome: "can_do",
    start_date: monday,
    end_date: addDays(monday, 20),
    text: "Engineering can take this",
  })
  await seedLegacyAcceptedDemand(request, admin.org_id, extDemand.id, root)
  await api(
    `${base}/capacity/weeks`,
    vpToken,
    {
      items: [{ employee_id: person("E01").id, other_percent: 0 }],
      start_week: monday,
      end_week: addDays(monday, 28),
    },
    "PUT",
  )
  const assignment = await api(
    `${base}/capacity/demands/${extDemand.id}/assignments`,
    vpToken,
    {
      employee_id: person("E01").id,
      allocation_percent: 30,
      start_date: monday,
      outside_basis: true,
      due_date: addDays(monday, 10),
    },
  )

  // Move M01 out of Acme/Engineering to Acme/Marketing while E01 still reports to M01.
  const movePreview = await api(`${base}/roster/single-change`, root, {
    kind: "transfer",
    employee_id: person("M01").id,
    department: "Acme/Marketing",
    title: "Cross-dept Manager",
  })
  await api(`${base}/roster/imports/${movePreview.id}/apply`, root, {
    base_revision: movePreview.base_revision,
  })

  const extReq = await api(
    `${base}/capacity/assignments/${assignment.id}/extension-requests`,
    empToken,
    {
      requested_due_date: addDays(monday, 14),
      reason: "SECRET_EXTENSION_REASON",
    },
  )
  await api(
    `${base}/capacity/extension-requests/${extReq.id}/decision`,
    vpToken,
    { approve: false, note: "SECRET_EXTENSION_NOTE" },
  )

  const redactedEn =
    "An extension request was reviewed on your behalf by a senior reviewer; details are hidden due to target department visibility scope."
  await openAs(page, admin.org_id, mgrToken, "en", "/inbox")
  const redactedItem = enInboxList
    .getByRole("listitem")
    .filter({ hasText: redactedEn })
    .first()
  await expect(redactedItem).toBeVisible()
  await redactedItem.getByRole("button").click()
  await expect(enDetail).toContainText(redactedEn)
  await expect(enInboxList).not.toContainText("Carol Eng")
  await expect(enInboxList).not.toContainText("SECRET_EXTENSION_REASON")
  await expect(enDetail).not.toContainText("Carol Eng")
  await expect(enDetail).not.toContainText("SECRET_EXTENSION_REASON")
  await expect(enDetail).not.toContainText("SECRET_EXTENSION_NOTE")
  await expectEnglishCopy(page.locator("main"))

  const mgrInboxRes = await request.get(`${base}/me/inbox`, {
    headers: { Authorization: `Bearer ${mgrToken}`, "Accept-Language": "en" },
  })
  expect(mgrInboxRes.ok()).toBeTruthy()
  const mgrInbox: InboxList = await mgrInboxRes.json()
  const redactedApiItem = mgrInbox.data.find(
    (entry) => entry.message === redactedEn,
  )
  expect(redactedApiItem).toBeTruthy()
  expect(redactedApiItem?.extension_request_id).toBeNull()
  const detailRes = await request.get(
    `${base}/me/inbox/${redactedApiItem!.id}`,
    {
      headers: { Authorization: `Bearer ${mgrToken}`, "Accept-Language": "en" },
    },
  )
  expect(detailRes.ok()).toBeTruthy()
  const detailJson = await detailRes.json()
  expect(detailJson.item.message).toBe(redactedEn)
  expect(detailJson.item.extension_request_id).toBeNull()
  expect(detailJson.extension_request).toBeNull()
})
