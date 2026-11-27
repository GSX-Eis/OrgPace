import fs from "node:fs"
import { createServer } from "node:http"
import { networkInterfaces } from "node:os"
import path from "node:path"
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test"
import type { EmployeeAccount } from "../src/client"
import { expectEnglishCopy } from "./utils/copy"
import { createUser } from "./utils/privateApi"
import { randomEmail, randomPassword } from "./utils/random"

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
})

const SCREENSHOT_DIR = path.resolve(
  import.meta.dirname,
  "../test-results/nere1443-screenshots",
)

async function saveScreenshot(page: Page, filename: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, filename),
    fullPage: false,
  })
}

async function openAs(
  page: Page,
  orgId: string,
  token: string,
  locale: "zh-CN" | "en",
  dest: string,
): Promise<void> {
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

interface MockModelHandle {
  url: string
  sawEnglishInstruction: () => boolean
  close: () => Promise<void>
}

async function startMockEnglishModelServer(
  baseURL?: string,
): Promise<MockModelHandle> {
  let englishInstructionSeen = false
  const server = createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const payload = JSON.parse(raw) as {
      model?: string
      messages?: Array<{ role?: string; content?: unknown }>
    }
    const systemMessages = (payload.messages ?? [])
      .filter((msg) => msg.role === "system")
      .map((msg) =>
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content),
      )
      .join("\n")
    if (systemMessages.includes("请始终用英文回复用户")) {
      englishInstructionSeen = true
    }

    res.writeHead(200, { "Content-Type": "text/event-stream" })
    const firstChunk = {
      id: "nere1443-mock-completion",
      object: "chat.completion.chunk",
      created: 1,
      model: payload.model ?? "synthetic",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content:
              "I reviewed your capability profile and recent updates. Everything looks up to date in English.",
          },
          finish_reason: null,
        },
      ],
    }
    const doneChunk = {
      ...firstChunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }
    res.write(`data: ${JSON.stringify(firstChunk)}\n\n`)
    res.end(`data: ${JSON.stringify(doneChunk)}\n\ndata: [DONE]\n\n`)
  })

  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve))
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Missing mock model server address")
  }
  const host =
    process.env.MODEL_TEST_HOST ??
    (baseURL?.includes("backend:")
      ? Object.values(networkInterfaces())
          .flat()
          .find((network) => network?.family === "IPv4" && !network.internal)
          ?.address
      : "localhost")

  return {
    url: `http://${host}:${address.port}/v1`,
    sawEnglishInstruction: () => englishInstructionSeen,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}

async function setupSyntheticOrg(request: APIRequestContext, modelUrl: string) {
  const password = "synthetic-nere1443-2026"
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
    expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBeTruthy()
    return res.headers()["content-type"]?.includes("application/json")
      ? res.json()
      : null
  }

  const setupToken = await api("/api/v1/private/setup-tokens", undefined, {
    purpose: "new_org",
  })
  const admin = await api("/api/v1/setup/initialize", undefined, {
    token: setupToken.token,
    org_name: "Acme Engineering",
    admin_username: `nere1443-admin-${crypto.randomUUID()}@example.com`,
    admin_password: password,
    admin_full_name: "Alex Admin",
  })
  await api(
    "/api/v1/users/me/preferences",
    admin.access_token,
    { preferred_locale: "en" },
    "PATCH",
  )

  const base = `/api/v1/orgs/${admin.org_id}`
  const rosterRes = await request.post(`${base}/roster/imports`, {
    headers: { Authorization: `Bearer ${admin.access_token}` },
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          [
            "工号,姓名,部门,职位,上级工号,邮箱",
            `M01,Morgan Manager,Engineering/Platform,Engineering Manager,,m01-${crypto.randomUUID()}@example.com`,
            `E01,Taylor Engineer,Engineering/Platform,Backend Engineer,M01,e01-${crypto.randomUUID()}@example.com`,
            `A01,Riley Requester,Product,Product Lead,,a01-${crypto.randomUUID()}@example.com`,
          ].join("\n"),
        ),
      },
    },
  })
  expect(rosterRes.ok(), await rosterRes.text()).toBeTruthy()
  const preview = await rosterRes.json()
  await api(`${base}/roster/imports/${preview.id}/apply`, admin.access_token, {
    base_revision: preview.base_revision,
  })

  await api(`${base}/capabilities/versions`, admin.access_token, {
    expected_version: 0,
    definitions: [
      {
        key: "backend_api",
        name: "Backend API Design",
        category: "Engineering",
        description: "Designing and maintaining production backend services",
        level_rubric: {
          levels: [
            {
              key: "routine",
              label: "Handles routine tasks",
              description: "Builds standard endpoints with automated tests",
            },
            {
              key: "independent_complex",
              label: "Leads complex tasks",
              description: "Architects resilient multi-service APIs",
            },
          ],
        },
      },
      {
        key: "mentoring",
        name: "Technical Mentoring",
        category: "Collaboration",
        description: "Coaching peers and reviewing architecture designs",
        level_rubric: {
          levels: [
            {
              key: "routine",
              label: "Handles routine tasks",
              description: "Guides onboarding engineers through code reviews",
            },
          ],
        },
      },
    ],
  })

  await api(`${base}/accounts/issue`, admin.access_token, {})
  const accounts: EmployeeAccount[] = (
    await api(`${base}/accounts`, admin.access_token)
  ).data
  const byCode = (code: string) =>
    accounts.find((item) => item.employee_code === code)!

  await api(`${base}/role-grants`, admin.access_token, {
    user_id: byCode("M01").account!.user_id,
    role: "dept_manager",
    department_id: byCode("M01").department!.id,
  })

  const tokens = new Map<string, string>()
  for (const code of ["M01", "E01", "A01"]) {
    const reset = await api(
      `${base}/accounts/${byCode(code).account!.user_id}/reset-password`,
      admin.access_token,
      {},
    )
    const loginRes = await request.post("/api/v1/login/access-token", {
      form: { username: reset.username, password: reset.initial_password },
    })
    expect(loginRes.ok(), await loginRes.text()).toBeTruthy()
    const firstToken = (await loginRes.json()).access_token as string
    await api(
      "/api/v1/users/me/password",
      firstToken,
      { current_password: reset.initial_password, new_password: password },
      "PATCH",
    )
    const finalLogin = await request.post("/api/v1/login/access-token", {
      form: { username: reset.username, password },
    })
    expect(finalLogin.ok(), await finalLogin.text()).toBeTruthy()
    const finalToken = (await finalLogin.json()).access_token as string
    await api(
      "/api/v1/users/me/preferences",
      finalToken,
      { preferred_locale: "en" },
      "PATCH",
    )
    tokens.set(code, finalToken)
  }

  await api(
    `${base}/capacity-settings`,
    admin.access_token,
    { enabled: true, requester_policy: "everyone" },
    "PUT",
  )
  await api(
    `${base}/model-setting`,
    admin.access_token,
    {
      enabled: true,
      kind: "openai_compatible",
      provider: "openai-compatible",
      model: "synthetic",
      base_url: modelUrl,
      api_key: "synthetic-key",
    },
    "PUT",
  )

  return { admin, base, api, byCode, tokens }
}

test("login EN switch, zero-flash refresh, and cross-context preference persistence", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000)
  const email = randomEmail()
  const password = randomPassword()
  await createUser({ email, password, withEmptyProfile: true })
  const allowUser = ["空画像测试企业", "空", "测试员工", "测"]

  // 1. Login page starts in zh-CN; switch to EN immediately without reload.
  await page.goto("/login")
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN")
  await expect(page.getByRole("button", { name: "登录" })).toBeVisible()

  await page.getByTestId("language-switch-en").click()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(page).toHaveTitle("Sign in - OrgPace")
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
  await expectEnglishCopy(page)
  await saveScreenshot(page, "01-login-en.png")

  // Trigger an unauthenticated EN backend validation error.
  await page.getByTestId("email-input").fill(email)
  await page.getByTestId("password-input").fill("wrong-password-123")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByText("Incorrect email or password")).toBeVisible()
  await expectEnglishCopy(page)

  // Log in and verify main interface stays in EN.
  await page.getByTestId("password-input").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page.getByTestId("user-menu")).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expectEnglishCopy(page, { allow: allowUser })

  // Verify refresh keeps EN without any Chinese flash before first paint.
  await page.addInitScript(() => {
    const win = window as Window & {
      __domContentLoadedLang?: string
      __unexpectedHanDuringBoot?: string[]
    }
    win.__unexpectedHanDuringBoot = []
    const allowed = new Set(["空画像测试企业", "空", "测试员工", "测"])
    const checkText = (textNode: Text) => {
      const el = textNode.parentElement
      if (!el?.closest("body")) return
      if (el.closest('[data-testid="language-switch"]')) return
      const raw = (textNode.textContent ?? "").trim()
      if (!raw || allowed.has(raw)) return
      const matches = raw.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g)
      if (!matches) return
      for (const token of matches) {
        if (!allowed.has(token)) win.__unexpectedHanDuringBoot!.push(token)
      }
    }
    const recordNode = (node: Node | null) => {
      if (!node) return
      if (node.nodeType === Node.TEXT_NODE) {
        checkText(node as Text)
        return
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        let cur = walker.nextNode()
        while (cur) {
          checkText(cur as Text)
          cur = walker.nextNode()
        }
      }
    }
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        win.__domContentLoadedLang = document.documentElement.lang
      },
      { once: true },
    )
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) recordNode(added)
      }
    })
    observer.observe(document, {
      childList: true,
      subtree: true,
    })
  })
  await page.reload()
  await expect(page.getByTestId("user-menu")).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  const bootCheck = await page.evaluate(() => {
    const win = window as Window & {
      __domContentLoadedLang?: string
      __unexpectedHanDuringBoot?: string[]
    }
    return {
      domContentLoadedLang: win.__domContentLoadedLang,
      unexpectedHan: win.__unexpectedHanDuringBoot ?? [],
    }
  })
  expect(bootCheck.domContentLoadedLang).toBe("en")
  expect(bootCheck.unexpectedHan).toEqual([])
  await expectEnglishCopy(page, { allow: allowUser })

  // Persist EN preference to backend on the newly created user.
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/users/me/preferences") &&
        res.request().method() === "PATCH" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-zh-CN").click(),
  ])
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN")
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/users/me/preferences") &&
        res.request().method() === "PATCH" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-en").click(),
  ])
  await expect(page.locator("html")).toHaveAttribute("lang", "en")

  // 2. Fresh browser context (empty localStorage) restores EN on login, then restores zh-CN after switching back.
  const enContext = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1440, height: 900 },
  })
  const enPage = await enContext.newPage()
  await enPage.goto("/login")
  expect(await enPage.evaluate(() => localStorage.getItem("locale"))).toBeNull()
  await enPage.getByTestId("email-input").fill(email)
  await enPage.getByTestId("password-input").fill(password)
  await enPage.getByRole("button", { name: "登录" }).click()
  await expect(enPage).not.toHaveURL(/\/login/)
  await expect(enPage.getByTestId("user-menu")).toBeVisible()
  await expect(enPage.locator("html")).toHaveAttribute("lang", "en")
  await expect(
    enPage.getByRole("heading", { name: "Work Assistant" }),
  ).toBeVisible()
  await expect(
    enPage.getByRole("textbox", { name: "Message to Assistant" }),
  ).toBeVisible()
  expect(await enPage.evaluate(() => localStorage.getItem("locale"))).toBe("en")
  await expectEnglishCopy(enPage, { allow: allowUser })

  await Promise.all([
    enPage.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/users/me/preferences") &&
        res.request().method() === "PATCH" &&
        res.ok(),
    ),
    enPage.getByTestId("language-switch-zh-CN").click(),
  ])
  await expect(enPage.locator("html")).toHaveAttribute("lang", "zh-CN")
  await enContext.close()

  const zhContext = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1440, height: 900 },
  })
  const zhPage = await zhContext.newPage()
  await zhPage.goto("/login")
  await zhPage.getByTestId("email-input").fill(email)
  await zhPage.getByTestId("password-input").fill(password)
  await zhPage.getByRole("button", { name: "登录" }).click()
  await expect(zhPage).not.toHaveURL(/\/login/)
  await expect(zhPage.getByTestId("user-menu")).toBeVisible()
  await expect(zhPage.locator("html")).toHaveAttribute("lang", "zh-CN")
  await expect(
    zhPage.getByRole("heading", { name: "工作助手", exact: true }),
  ).toBeVisible()
  await zhContext.close()
})

test("isolated synthetic org covers core EN pages, backend error, inbox notice, and mock assistant turn", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(180_000)
  const mockModel = await startMockEnglishModelServer(baseURL)
  try {
    const env = await setupSyntheticOrg(request, mockModel.url)
    const mgrToken = env.tokens.get("M01")!
    const empToken = env.tokens.get("E01")!
    const empRow = env.byCode("E01")

    // Seed published capability via direct edit, pending profile review request, and workload adjustment notice.
    await env.api(
      `${env.base}/employees/${empRow.id}/profile/direct-edits`,
      mgrToken,
      {
        base_revision: null,
        items: [
          {
            op: "add",
            capability_key: "backend_api",
            level: "routine",
            statement:
              "Maintains core REST APIs and automated integration suites.",
          },
        ],
      },
    )

    const draftReq = await env.api(`${env.base}/me/requests`, empToken, {
      items: [
        {
          op: "add",
          capability_key: "mentoring",
          level: "routine",
          statement: "Mentored two onboarding backend engineers in Q4.",
        },
      ],
    })
    const submittedReq = await env.api(
      `${env.base}/me/requests/${draftReq.id}/submit`,
      empToken,
      { revision: draftReq.revision },
    )

    const meWorkload = await env.api(
      `${env.base}/capacity/workloads/me`,
      mgrToken,
    )
    const monday = meWorkload.weeks[0].week_start as string
    const addDays = (iso: string, days: number) =>
      new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86400000)
        .toISOString()
        .slice(0, 10)

    await env.api(
      `${env.base}/capacity/weeks`,
      mgrToken,
      {
        start_week: monday,
        end_week: addDays(monday, 21),
        items: [{ employee_id: empRow.id, other_percent: 25 }],
      },
      "PUT",
    )

    await env.api(`${env.base}/capacity/workloads/me/requests`, empToken, {
      requested_percent: 55,
      reason: "Supporting Q4 platform release readiness",
      start_week: monday,
      end_week: monday,
    })

    // 1. Employee main home (/assistant) + mock-model assistant turn in EN.
    await openAs(page, env.admin.org_id, empToken, "en", "/assistant")
    await expect(page.locator("html")).toHaveAttribute("lang", "en")
    await expect(
      page.getByRole("textbox", { name: "Message to Assistant" }),
    ).toBeVisible()
    await expectEnglishCopy(page)
    await saveScreenshot(page, "02-main-home-en.png")

    await page
      .getByRole("textbox", { name: "Message to Assistant" })
      .fill("Please summarize my capability profile status in English.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(
      page.getByText(
        "I reviewed your capability profile and recent updates. Everything looks up to date in English.",
      ),
    ).toBeVisible({ timeout: 45_000 })
    expect(mockModel.sawEnglishInstruction()).toBe(true)
    await expectEnglishCopy(page)
    await saveScreenshot(page, "07-assistant-en.png")

    // 2. My Profile (/employees/$employeeId as employee).
    await page.goto(`/employees/${empRow.id}`)
    await expect(
      page.getByRole("heading", { name: "Taylor Engineer", exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Backend API Design", exact: true }),
    ).toBeVisible()
    await expectEnglishCopy(page)
    await saveScreenshot(page, "03-my-profile-en.png")

    // 3. Settings (/settings) + authenticated backend validation error in EN.
    await page.goto("/settings")
    await expect(page).toHaveTitle("Settings - OrgPace")
    await expect(
      page.getByRole("region", { name: "Personal Information" }),
    ).toBeVisible()
    await expectEnglishCopy(page)

    await page
      .getByRole("button", { name: "Change password", exact: true })
      .click()
    const pwdDialog = page.getByRole("dialog", { name: "Change Password" })
    await expect(pwdDialog).toBeVisible()
    await pwdDialog
      .getByTestId("current-password-input")
      .fill("wrong-current-password")
    await pwdDialog
      .getByTestId("new-password-input")
      .fill("NewValidPassword!2026")
    await pwdDialog
      .getByTestId("confirm-password-input")
      .fill("NewValidPassword!2026")
    await pwdDialog.getByRole("button", { name: "Save password" }).click()
    await expect(page.getByText("Current password is incorrect")).toBeVisible()
    await expectEnglishCopy(page)
    await page.keyboard.press("Escape")

    // 4. Manager: Inbox (real bilingual notification in EN), Employee Details, Pending Reviews, Capacity.
    await openAs(page, env.admin.org_id, mgrToken, "en", "/inbox")
    const inboxList = page.getByRole("complementary", { name: "Messages" })
    const workloadNotice = inboxList
      .getByRole("listitem")
      .filter({
        hasText: "You have a workload adjustment request awaiting approval",
      })
      .first()
    await expect(workloadNotice).toBeVisible()
    await workloadNotice.getByRole("button").click()
    const detailRegion = page.getByRole("region", { name: "Message details" })
    await expect(detailRegion).toContainText(
      "You have a workload adjustment request awaiting approval",
    )
    await expectEnglishCopy(page)

    await page.goto(`/employees/${empRow.id}`)
    await expect(
      page.getByRole("heading", { name: "Taylor Engineer", exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Backend API Design", exact: true }),
    ).toBeVisible()
    await expectEnglishCopy(page)

    await page.goto("/reviews")
    await expect(page).toHaveTitle("Reviews - OrgPace")
    await expect(page.getByText("Taylor Engineer").first()).toBeVisible()
    await expect(
      page.getByRole("link", { name: "View & review", exact: true }),
    ).toBeVisible()
    await expectEnglishCopy(page)
    await saveScreenshot(page, "04-reviews-en.png")

    await page.goto(`/reviews/${submittedReq.id}`)
    await expect(
      page.getByRole("heading", { name: "Review Decisions", exact: true }),
    ).toBeVisible()
    await expectEnglishCopy(page)

    await page.goto("/capacity?tab=team")
    await expect(page).toHaveTitle("Plan - OrgPace")
    const gantt = page.getByRole("table", {
      name: "Team workload, sorted by department and name",
    })
    await expect(gantt).toBeVisible()
    await expect(gantt).toContainText("Morgan Manager")
    await expect(gantt).toContainText("Taylor Engineer")
    const deptFilter = page.locator("#capacity-department")
    await expect(deptFilter).toContainText("All Departments")
    const deptMetrics = await deptFilter.evaluate((trigger) => {
      const value = trigger.querySelector('[data-slot="select-value"]')
      const icon = trigger.querySelector("svg")
      if (!value || !icon) return null
      const valueRect = value.getBoundingClientRect()
      const iconRect = icon.getBoundingClientRect()
      return {
        scrollWidth: value.scrollWidth,
        clientWidth: value.clientWidth,
        valueRight: valueRect.right,
        iconLeft: iconRect.left,
      }
    })
    expect(deptMetrics).not.toBeNull()
    expect(deptMetrics!.scrollWidth).toBeLessThanOrEqual(
      deptMetrics!.clientWidth,
    )
    expect(deptMetrics!.valueRight).toBeLessThanOrEqual(deptMetrics!.iconLeft)
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1)
    await expectEnglishCopy(page)
    await saveScreenshot(page, "05-capacity-workload-en.png")

    await page.goto("/capacity?tab=mine")
    await expect(page.getByText("My Workload").first()).toBeVisible()
    await expectEnglishCopy(page)

    // 5. Admin Overview (/admin -> /assistant?mode=admin).
    await openAs(page, env.admin.org_id, env.admin.access_token, "en", "/admin")
    const actionItems = page.getByRole("region", { name: "Action Items" })
    await expect(
      actionItems.getByRole("heading", { name: "Action Items", exact: true }),
    ).toBeVisible()
    await expect(actionItems.getByText("Loading...")).toBeHidden()
    await expect(page.getByText("Loading conversations...")).toBeHidden()
    await expect(
      actionItems.getByRole("heading", {
        name: "Background Worker",
        exact: true,
      }),
    ).toBeVisible()
    await expectEnglishCopy(page)
    await saveScreenshot(page, "06-admin-overview-en.png")
  } finally {
    await mockModel.close()
  }
})
