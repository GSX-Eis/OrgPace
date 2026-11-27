import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test"
import type { EmployeeAccount } from "../src/client"
import { expectEnglishCopy } from "./utils/copy"
import { seedLegacyAcceptedDemand } from "./utils/legacyCapacity"

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
})

const TEST_PASSWORD = "synthetic-capacity-i18n-2026"

interface RosterRow {
  code: string
  name: string
  dept: string
  managerCode?: string
}

interface OrgFixture {
  admin: { org_id: string; access_token: string }
  base: string
  accounts: EmployeeAccount[]
  tokens: Map<string, string>
  api: (
    url: string,
    token?: string,
    data?: object,
    method?: string,
  ) => Promise<any>
  open: (token: string, path: string) => Promise<void>
}

async function setupEnglishCapacityOrg(
  page: Page,
  request: APIRequestContext,
  orgName: string,
  rows: RosterRow[],
  options: {
    enabled?: boolean
    managerCodes?: string[]
    capabilities?: Array<{ key: string; name: string; category: string }>
  } = {},
): Promise<OrgFixture> {
  await page.addInitScript(() => {
    localStorage.setItem("locale", "en")
  })

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
  const admin = await api("/api/v1/setup/initialize", undefined, {
    token: setup.token,
    org_name: orgName,
    admin_username: `cap-i18n-${crypto.randomUUID()}@example.com`,
    admin_password: TEST_PASSWORD,
  })
  await api(
    "/api/v1/users/me/preferences",
    admin.access_token,
    { preferred_locale: "en" },
    "PATCH",
  )

  const base = `/api/v1/orgs/${admin.org_id}`
  const csv = [
    "工号,姓名,部门,上级工号,邮箱",
    ...rows.map(
      (row) =>
        `${row.code},${row.name},${row.dept},${row.managerCode ?? ""},${row.code.toLowerCase()}-${crypto.randomUUID()}@example.com`,
    ),
  ].join("\n")
  const roster = await request.post(`${base}/roster/imports`, {
    headers: { Authorization: `Bearer ${admin.access_token}` },
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv),
      },
    },
  })
  expect(roster.ok(), await roster.text()).toBeTruthy()
  const preview = await roster.json()
  await api(`${base}/roster/imports/${preview.id}/apply`, admin.access_token, {
    base_revision: preview.base_revision,
  })
  await api(`${base}/accounts/issue`, admin.access_token, {})
  const accounts: EmployeeAccount[] = (
    await api(`${base}/accounts`, admin.access_token)
  ).data
  const byCode = (code: string) =>
    accounts.find((account) => account.employee_code === code)!

  for (const code of options.managerCodes ?? []) {
    const account = byCode(code)
    await api(`${base}/role-grants`, admin.access_token, {
      user_id: account.account!.user_id,
      role: "dept_manager",
      department_id: account.department!.id,
    })
  }

  if (options.capabilities?.length) {
    await api(`${base}/capabilities/versions`, admin.access_token, {
      expected_version: 0,
      definitions: options.capabilities.map((cap) => ({
        key: cap.key,
        name: cap.name,
        category: cap.category,
        description: `${cap.name} capability`,
        level_rubric: {
          levels: [
            {
              key: "routine",
              label: "Routine",
              description: "Independent execution",
            },
          ],
        },
      })),
    })
  }

  if (options.enabled) {
    await api(
      `${base}/capacity-settings`,
      admin.access_token,
      { enabled: true },
      "PUT",
    )
  }

  const tokens = new Map<string, string>()
  for (const row of rows) {
    const account = byCode(row.code)
    const reset = await api(
      `${base}/accounts/${account.account!.user_id}/reset-password`,
      admin.access_token,
      {},
    )
    const login = await request.post("/api/v1/login/access-token", {
      form: { username: reset.username, password: reset.initial_password },
    })
    expect(login.ok()).toBeTruthy()
    const changed = await api(
      "/api/v1/users/me/password",
      (await login.json()).access_token,
      {
        current_password: reset.initial_password,
        new_password: TEST_PASSWORD,
      },
      "PATCH",
    )
    await api(
      "/api/v1/users/me/preferences",
      changed.access_token,
      { preferred_locale: "en" },
      "PATCH",
    )
    tokens.set(row.code, changed.access_token)
  }

  const open = async (token: string, path: string) => {
    await page.goto("/login")
    await page.evaluate(
      ({ authToken, orgId }) => {
        localStorage.setItem("access_token", authToken)
        localStorage.setItem("current_org_id", orgId)
        localStorage.setItem("locale", "en")
      },
      { authToken: token, orgId: admin.org_id },
    )
    await page.goto(path)
  }

  return { admin, base, accounts, tokens, api, open }
}

function isoDateDaysFromToday(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function nextWeekdayIso(minDaysAhead = 1): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + minDaysAhead)
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return date.toISOString().slice(0, 10)
}

function mondayIsoDaysFromToday(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  const day = date.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  date.setUTCDate(date.getUTCDate() + diff)
  return date.toISOString().slice(0, 10)
}

test("capacity settings, forecast policies, team workload, my workload, borrows disabled, and approvals render in English", async ({
  page,
  request,
}) => {
  test.setTimeout(120000)
  const fixture = await setupEnglishCapacityOrg(
    page,
    request,
    "Synthetic Capacity Org",
    [
      { code: "M", name: "Bob Lead", dept: "Engineering" },
      { code: "E", name: "Carol Dev", dept: "Engineering", managerCode: "M" },
    ],
    { enabled: false, managerCodes: ["M"] },
  )

  // Disabled state copy
  await fixture.open(fixture.tokens.get("E")!, "/capacity")
  await expect(
    page.getByText(
      "Planning and workload features are not enabled. Contact your organization administrator to enable them.",
    ),
  ).toBeVisible()
  await expectEnglishCopy(page)

  // Admin: capacity settings + forecast policy & fluctuation event validation
  await fixture.open(fixture.admin.access_token, "/admin/rules?tab=capacity")
  const settingsForm = page.getByRole("form", {
    name: "Capacity and demand rules",
  })
  await expect(settingsForm).toBeVisible()
  await settingsForm
    .getByRole("checkbox", { name: "Enable planning & workload features" })
    .check()
  await settingsForm
    .getByLabel("Default recommended allocation cap (quota %)")
    .fill("40")
  await expect(settingsForm).toContainText(
    "Please enter an integer percentage between 50 and 100.",
  )
  await expect(
    settingsForm.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled()
  await settingsForm
    .getByLabel("Default recommended allocation cap (quota %)")
    .fill("80")
  await expect(settingsForm).toContainText("Reserved elastic buffer: 20%")
  await expect(
    settingsForm.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeEnabled()
  await settingsForm
    .getByRole("button", { name: "Save settings", exact: true })
    .click()
  await expect(settingsForm.getByRole("status")).toContainText(
    "Capacity and demand rules saved.",
  )
  await expectEnglishCopy(settingsForm)

  const policySection = page.getByRole("region", {
    name: "Forecast policy configuration",
  })
  const eventSection = page.getByRole("region", {
    name: "Business fluctuation events",
  })
  await expect(policySection).toBeVisible()
  await expect(eventSection).toContainText(
    "No current or upcoming business fluctuation events.",
  )
  await expectEnglishCopy(policySection)
  await expectEnglishCopy(eventSection)

  await eventSection
    .getByRole("button", { name: "Add Event", exact: true })
    .click()
  const addEventForm = eventSection.getByRole("form", { name: "Add Event" })
  await expect(addEventForm).toBeVisible()
  await addEventForm.getByLabel("Event title").fill("   ")
  await addEventForm.getByLabel("Modifier value").fill("0.5")
  await addEventForm.getByLabel("Reason").fill("Peak season")
  await addEventForm
    .getByRole("button", { name: "Save Event", exact: true })
    .click()
  await expect(addEventForm).toContainText(
    "Event title must be 1–100 characters.",
  )
  await expectEnglishCopy(addEventForm)
  await addEventForm
    .getByRole("button", { name: "Cancel", exact: true })
    .first()
    .click()

  // Manager: Team Workload Gantt, legend, toolbar layout, drawers, borrows disabled, mobile view
  await fixture.open(fixture.tokens.get("M")!, "/capacity?tab=team")
  await expect(page).toHaveTitle("Plan - OrgPace")
  const gantt = page.getByRole("table", {
    name: "Team workload, sorted by department and name",
  })
  await expect(gantt).toBeVisible()
  await page
    .getByRole("button", { name: "Team workload guide and legend" })
    .click()
  await expect(
    page.getByText(
      "Shows effort reference for the next 8 weeks. Actual commitment is subject to the department manager's reply.",
    ),
  ).toBeVisible()
  await expectEnglishCopy(page)
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("list", { name: "Gantt chart legend" }),
  ).toContainText("Time off / Unavailable")
  await expect(gantt).toContainText("Bob Lead")
  await expect(gantt).toContainText("Carol Dev")

  // Verify 1440x900 desktop toolbar fits cleanly without horizontal overflow or clipped controls
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
  for (const label of [
    "Prev",
    "This Week",
    "Next",
    "Policies & Events",
    "Refresh Forecasts",
    "Carry Over",
  ]) {
    const box = await page
      .getByRole("button", { name: label, exact: true })
      .boundingBox()
    expect(box, `Missing bounding box for ${label}`).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440)
    expect(box!.height).toBeGreaterThanOrEqual(24)
  }
  await expectEnglishCopy(page)

  // Open Forecast Policy drawer from Team Workload
  await page
    .getByRole("button", { name: "Policies & Events", exact: true })
    .click()
  const policyDrawer = page.getByRole("dialog", { name: "Policies & Events" })
  await expect(policyDrawer).toContainText("Hierarchical Forecast Policies")
  await expectEnglishCopy(policyDrawer)
  await policyDrawer.press("Escape")

  // Set a confirmed week on Team Workload and verify percentage + Carry Over dialog
  await gantt
    .getByRole("row")
    .filter({ hasText: "Carol Dev" })
    .getByRole("button", { name: "Set", exact: true })
    .click()
  const editDrawer = page.getByRole("dialog", {
    name: "Set Weekly Workload · Carol Dev",
  })
  await expect(editDrawer).toBeVisible()
  await editDrawer.getByLabel("Off-platform work (%)").fill("50")
  await expectEnglishCopy(editDrawer)
  await editDrawer
    .getByRole("button", { name: "Save Settings", exact: true })
    .click()
  await expect(editDrawer).toBeHidden()
  await expect(gantt).toContainText("50%")

  await page.getByRole("button", { name: "Carry Over", exact: true }).click()
  const carryDialog = page.getByRole("dialog", {
    name: "Carry Over Previous Configuration",
  })
  await expect(carryDialog).toContainText("Carol Dev")
  await expectEnglishCopy(carryDialog)
  await carryDialog.getByRole("button", { name: "Cancel", exact: true }).click()

  // Disabled cross-department borrows page
  await page.goto("/capacity?tab=borrows")
  await expect(
    page.getByRole("region", { name: "Cross-department borrowing disabled" }),
  ).toContainText("Cross-department borrowing is currently disabled")
  await expect(
    page.getByRole("link", { name: "View Outgoing Demands" }),
  ).toBeVisible()
  await expectEnglishCopy(page)

  // Mobile Team Workload layout
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/capacity?tab=team")
  await expect(
    page
      .getByRole("article", { name: "Carol Dev" })
      .getByText("Swipe horizontally to view 8-week schedule"),
  ).toBeVisible()
  await expectEnglishCopy(page)
  await page.setViewportSize({ width: 1440, height: 900 })

  // Employee: My Workload, compliance notice, time-off registration, adjustment request
  await fixture.open(fixture.tokens.get("E")!, "/capacity?tab=mine")
  await expect(
    page.getByRole("heading", { name: "My Workload", exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Workload data guide" }).click()
  await expect(
    page.getByText(
      "Workload data is for reference only and is not used for performance evaluation or ranking.",
    ),
  ).toBeVisible()
  await expectEnglishCopy(page)
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("region", { name: "Adjustment request history" }),
  ).toContainText("No adjustment requests yet.")
  await expectEnglishCopy(page)

  const leaveDate = nextWeekdayIso(2)
  await page.getByRole("button", { name: "Time off", exact: true }).click()
  const leaveDrawer = page.getByRole("dialog", { name: "Time Off" })
  await leaveDrawer.getByLabel("Start date", { exact: true }).fill(leaveDate)
  await leaveDrawer.getByLabel("End date", { exact: true }).fill(leaveDate)
  await leaveDrawer
    .getByRole("button", { name: "Submit time off", exact: true })
    .click()
  await expect(leaveDrawer).toBeHidden()
  await expect(
    page.getByText(
      "Time off recorded. Your department manager has been notified and available capacity for the week is updated.",
    ),
  ).toBeVisible()
  await expectEnglishCopy(page)

  await page
    .getByRole("button", { name: "Request adjustment", exact: true })
    .click()
  const adjustDrawer = page.getByRole("dialog", { name: "Request Adjustment" })
  await expect(adjustDrawer).toContainText(
    "Will be sent to Bob Lead for approval",
  )
  await adjustDrawer.getByLabel("Requested workload (%)").fill("75")
  await adjustDrawer.getByLabel("Reason").fill("Off-platform client onboarding")
  await expectEnglishCopy(adjustDrawer)
  await adjustDrawer
    .getByRole("button", { name: "Submit request", exact: true })
    .click()
  await expect(adjustDrawer).toBeHidden()
  await expect(
    page.getByRole("region", { name: "Adjustment request history" }),
  ).toContainText("An adjustment request is currently pending approval.")

  // Manager: /capacity?tab=approvals redirects to /reviews?type=workload and handles adjustment approvals
  await fixture.open(fixture.tokens.get("M")!, "/capacity?tab=approvals")
  await page.waitForURL(/\/reviews\?type=workload/)
  const approvalsRegion = page.getByRole("region", {
    name: "Pending workload adjustment requests",
  })
  await expect(approvalsRegion).toContainText("Carol Dev · Requested 75%")
  await expectEnglishCopy(approvalsRegion)
  await approvalsRegion.getByText("Review", { exact: true }).click()
  await expectEnglishCopy(approvalsRegion)
  await approvalsRegion
    .getByRole("button", { name: "Approve", exact: true })
    .click()
  await expect(
    page.getByText("No pending workload adjustment approvals"),
  ).toBeVisible()
})

test("demands, projects, assignments, task tracking, feedback, extensions, and internal plans render in English", async ({
  page,
  request,
}) => {
  test.setTimeout(120000)
  const fixture = await setupEnglishCapacityOrg(
    page,
    request,
    "Synthetic Collab Org",
    [
      { code: "A", name: "Alice Client", dept: "Client" },
      { code: "M", name: "Bob Lead", dept: "Engineering" },
      { code: "B1", name: "Carol Dev", dept: "Engineering", managerCode: "M" },
      { code: "B2", name: "Dan Dev", dept: "Engineering", managerCode: "M" },
    ],
    {
      enabled: true,
      managerCodes: ["M"],
      capabilities: [{ key: "delivery", name: "Delivery", category: "Tech" }],
    },
  )

  // Allow all employees so requester Alice Client can initiate demands/projects
  await fixture.api(
    `${fixture.base}/capacity-settings`,
    fixture.admin.access_token,
    { enabled: true, requester_policy: "everyone" },
    "PUT",
  )

  const start = isoDateDaysFromToday(1)
  const initialDue = isoDateDaysFromToday(6)
  const extendedDue = isoDateDaysFromToday(8)
  const end = isoDateDaysFromToday(10)

  // Requester creates an outgoing demand via UI drawer (with validation + preview)
  await fixture.open(fixture.tokens.get("A")!, "/capacity?tab=outgoing")
  await expect(
    page.getByRole("region", { name: "Outgoing demands" }),
  ).toContainText("Pending Target Dept")
  await page.getByRole("button", { name: "List", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Outgoing demands" }),
  ).toContainText("No outgoing demands yet.")
  await expectEnglishCopy(page)

  await page.getByRole("button", { name: "New Demand", exact: true }).click()
  const demandDrawer = page.getByRole("dialog", {
    name: "New Collaboration Demand",
  })
  await expect(demandDrawer).toBeVisible()
  await demandDrawer
    .getByRole("button", { name: "Assess Target Departments", exact: true })
    .click()
  await expect(demandDrawer).toContainText(
    "Please select a capability and enter a valid date range first.",
  )

  await demandDrawer.getByLabel("Requesting department").selectOption({
    label: "Client",
  })
  await demandDrawer
    .getByLabel("Target department", { exact: true })
    .selectOption({
      label: "Engineering",
    })
  await demandDrawer.getByLabel("Capability").selectOption("delivery")
  await demandDrawer.getByLabel("Start date", { exact: true }).fill(start)
  await demandDrawer.getByLabel("End date", { exact: true }).fill(end)
  await demandDrawer.getByLabel("Demand description").fill("   ")
  await demandDrawer
    .getByRole("button", { name: "Preview Demand", exact: true })
    .click()
  await expect(demandDrawer).toContainText("Please enter a demand description.")

  await demandDrawer
    .getByLabel("Demand description")
    .fill("Need engineering delivery for Q4 release")
  await demandDrawer
    .getByRole("button", { name: "Preview Demand", exact: true })
    .click()

  await expect(
    demandDrawer.getByRole("region", { name: "Demand preview" }),
  ).toContainText("Client → Engineering")
  await expect(
    demandDrawer.getByRole("region", { name: "Demand preview" }),
  ).toContainText("Delivery · Minimum level: Any")
  await expectEnglishCopy(demandDrawer)
  await demandDrawer
    .getByRole("button", { name: "Submit Demand", exact: true })
    .click()
  await page.waitForURL(/\/capacity\?.*tab=outgoing.*demand=/)
  const demandId = new URL(page.url()).searchParams.get("demand")!
  await expect(page.getByText("Event Timeline")).toBeVisible()
  await expectEnglishCopy(page)

  // Switch between Board and List views on Outgoing Demands
  await page.goto("/capacity?tab=outgoing")
  const boardBtn = page.getByRole("button", { name: "Board", exact: true })
  await expect(boardBtn).toHaveAttribute("aria-pressed", "true")
  await page.getByRole("button", { name: "List", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Outgoing demands" }),
  ).toContainText("Need engineering delivery for Q4 release")
  await expect(
    page.getByRole("region", { name: "Outgoing demands" }),
  ).not.toContainText("至")
  await expectEnglishCopy(page)

  // Target manager opens pending demand detail: Internal Plans workbench UI + candidate table
  await fixture.open(
    fixture.tokens.get("M")!,
    `/capacity?tab=incoming&demand=${demandId}`,
  )
  await page
    .getByRole("button", { name: "Generate / Adjust Plans", exact: true })
    .click()
  await expect(page.getByText("Internal Plans")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Re-simulate", exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("checkbox", { name: "Allow elastic buffer" }),
  ).toBeVisible()
  await expect(page.getByText("Matching Department Candidates")).toBeVisible()
  await expectEnglishCopy(
    page.getByRole("complementary", { name: "Demand properties and actions" }),
  )
  await expectEnglishCopy(
    page.getByRole("region", { name: "Matching department candidates" }),
  )

  // Reply and seed legacy acceptance so manager can exercise Department Assignments, Task Tracking, and Feedback
  const b1 = fixture.accounts.find((account) => account.employee_code === "B1")!
  const startWeek = mondayIsoDaysFromToday(0)
  const endWeek = mondayIsoDaysFromToday(21)
  await fixture.api(
    `${fixture.base}/capacity/weeks`,
    fixture.tokens.get("M")!,
    {
      items: [{ employee_id: b1.id, other_percent: 0 }],
      start_week: startWeek,
      end_week: endWeek,
    },
    "PUT",
  )
  const detail = await fixture.api(
    `${fixture.base}/capacity/demands/${demandId}`,
    fixture.tokens.get("M")!,
  )
  await fixture.api(
    `${fixture.base}/capacity/demands/${demandId}/reply`,
    fixture.tokens.get("M")!,
    {
      revision: detail.revision,
      outcome: "can_do",
      start_date: start,
      end_date: end,
      text: "Engineering department can cover this delivery window.",
    },
  )
  await seedLegacyAcceptedDemand(
    request,
    fixture.admin.org_id,
    demandId,
    fixture.admin.access_token,
  )
  await page.reload()
  const assignmentsRegion = page.getByRole("region", {
    name: "Department assignments",
  })
  await expect(assignmentsRegion).toContainText("No assignments yet.")
  await assignmentsRegion
    .getByLabel("Select employee")
    .selectOption({ label: "Carol Dev" })
  await assignmentsRegion.getByLabel("Allocation (%)").fill("40")
  await assignmentsRegion.getByLabel("Start date", { exact: true }).fill(start)
  await assignmentsRegion
    .getByLabel("Expected completion date", { exact: true })
    .fill(initialDue)
  await assignmentsRegion
    .getByRole("checkbox", {
      name: "This employee does not meet profile requirements; I confirm assigning as needed",
    })
    .check()
  await assignmentsRegion
    .getByRole("button", { name: "Confirm Assignment", exact: true })
    .click()

  await expect(assignmentsRegion).toContainText("Carol Dev")
  await expect(assignmentsRegion).toContainText("Active")
  await expect(assignmentsRegion).toContainText("No linked tasks")
  await assignmentsRegion.getByLabel("Task key or title").fill("NONEXISTENT")
  await assignmentsRegion
    .getByRole("button", { name: "Search Tasks", exact: true })
    .click()
  await expect(assignmentsRegion).toContainText(
    "No matching tasks available to link.",
  )
  await expectEnglishCopy(assignmentsRegion)

  // Employee Carol Dev checks My Tasks & Borrow Assignments and submits an Extension Request
  await fixture.open(fixture.tokens.get("B1")!, "/capacity?tab=mine")
  const myAssignments = page.getByRole("region", { name: "My assignments" })
  await expect(myAssignments).toContainText("Delivery")
  await expect(myAssignments).toContainText("Active")
  await myAssignments.getByText("Task Details", { exact: true }).click()
  await expect(myAssignments).toContainText(
    "Need engineering delivery for Q4 release",
  )
  await myAssignments.getByText("Request Extension", { exact: true }).click()
  await expect(myAssignments).toContainText(
    "Will be sent to Bob Lead for approval",
  )
  await myAssignments.getByLabel("Requested completion date").fill(extendedDue)
  await myAssignments
    .getByLabel("Extension reason")
    .fill("Need extra time for end-to-end validation.")
  await expectEnglishCopy(myAssignments)
  await myAssignments
    .getByRole("button", { name: "Submit Extension Request", exact: true })
    .click()
  await expect(myAssignments).toContainText("Extension Request History")
  await expect(myAssignments).toContainText("Pending")

  // Manager reviews Extension Request on /reviews?type=workload
  await fixture.open(fixture.tokens.get("M")!, "/reviews?type=workload")
  const extensionRegion = page.getByRole("region", {
    name: "Extension Approvals",
  })
  await expect(extensionRegion).toContainText("Extension Request")
  await expect(extensionRegion).toContainText("Carol Dev")
  await extensionRegion.getByText("Review", { exact: true }).click()
  await expectEnglishCopy(extensionRegion)
  await extensionRegion
    .getByRole("button", { name: "Approve Extension", exact: true })
    .click()
  await expect(extensionRegion).toContainText("No pending extension requests.")

  // Manager marks assignment Done and submits work feedback
  await page.goto(`/capacity?tab=incoming&demand=${demandId}`)
  const updatedAssignments = page.getByRole("region", {
    name: "Department assignments",
  })
  await updatedAssignments
    .getByRole("button", { name: "Mark Done", exact: true })
    .click()
  await expect(updatedAssignments).toContainText("Done")
  await updatedAssignments
    .getByRole("button", { name: "Write Feedback", exact: true })
    .click()
  await expect(updatedAssignments).toContainText("Work feedback (20–500 chars)")
  await updatedAssignments
    .getByLabel("Work feedback (20–500 chars)")
    .fill("Delivered core integration cleanly with full verification.")
  await expectEnglishCopy(updatedAssignments)
  await updatedAssignments
    .getByRole("button", {
      name: "Send to Employee for Confirmation",
      exact: true,
    })
    .click()
  await expect(updatedAssignments).toContainText("Feedback submitted")

  // Requester creates a multi-phase Project Demand and opens Project Detail
  await fixture.open(fixture.tokens.get("A")!, "/capacity?tab=projects")
  await expect(
    page.getByRole("region", { name: "Project list" }),
  ).toContainText("No project demands yet.")
  await expectEnglishCopy(page)

  await page.getByRole("button", { name: "New Project", exact: true }).click()
  const projectDrawer = page.getByRole("dialog", {
    name: "New Project Demand",
  })

  await projectDrawer
    .getByLabel("Requesting department")
    .selectOption({ label: "Client" })

  const role1 = projectDrawer.getByRole("group", { name: "Role 1" })
  await role1.getByLabel("Role name").fill("Backend API")
  await role1.getByLabel("Primary capability").selectOption("delivery")
  await role1.getByLabel("Start date", { exact: true }).fill(start)
  await role1.getByLabel("End date", { exact: true }).fill(end)
  await role1
    .getByLabel("Demand description")
    .fill("Build core platform service endpoints")
  await role1
    .getByLabel("Target department", { exact: true })
    .selectOption({ label: "Engineering" })

  await projectDrawer.getByLabel("Project name").fill("   ")
  await projectDrawer
    .getByRole("button", { name: "Submit Project Demand", exact: true })
    .click()
  await expect(projectDrawer).toContainText("Please enter a project name.")

  await projectDrawer
    .getByLabel("Project name")
    .fill("Cross-Dept Platform Launch")

  await projectDrawer
    .getByRole("button", { name: "Add Role", exact: true })
    .click()
  const role2 = projectDrawer.getByRole("group", { name: "Role 2" })
  await role2.getByLabel("Role name").fill("Integration QA")
  await role2.getByLabel("Primary capability").selectOption("delivery")
  await role2
    .getByLabel("Start date", { exact: true })
    .fill(isoDateDaysFromToday(11))
  await role2
    .getByLabel("End date", { exact: true })
    .fill(isoDateDaysFromToday(18))
  await role2
    .getByLabel("Demand description")
    .fill("Verify cross-department rollout")
  await role2
    .getByLabel("Target department", { exact: true })
    .selectOption({ label: "Engineering" })
  await role2.getByRole("checkbox", { name: "Backend API" }).check()
  await expectEnglishCopy(projectDrawer)

  await projectDrawer
    .getByRole("button", { name: "Submit Project Demand", exact: true })
    .click()
  await page.waitForURL(/\/capacity\?.*tab=projects.*project=/)
  await expect(
    page.getByRole("region", { name: "Phased timeline" }),
  ).toContainText("Phase 1")
  await expect(
    page.getByRole("region", { name: "Phased timeline" }),
  ).toContainText("Phase 2")
  await expect(
    page.getByRole("complementary", { name: "Project properties" }),
  ).toContainText("Requester · Client")
  await expectEnglishCopy(page)
})
