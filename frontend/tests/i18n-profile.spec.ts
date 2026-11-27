import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test"
import type {
  ChangeRequestPublic,
  EmployeeAccount,
  ProfileItem,
} from "../src/client"
import { expectEnglishCopy } from "./utils/copy"
import { seedLegacyAcceptedDemand } from "./utils/legacyCapacity"

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
})

async function setEnglishSession(page: Page, token: string) {
  await page.addInitScript((accessToken) => {
    window.localStorage.setItem("locale", "en")
    window.localStorage.setItem("access_token", accessToken)
  }, token)
}

async function setupSyntheticEnglishOrg(request: APIRequestContext) {
  const password = "synthetic-i18n-profile-2026"
  const tokenRes = await request.post("/api/v1/private/setup-tokens", {
    data: { purpose: "new_org" },
  })
  expect(tokenRes.ok(), await tokenRes.text()).toBeTruthy()
  const adminEmail = `i18n-admin-${crypto.randomUUID()}@example.com`
  const initRes = await request.post("/api/v1/setup/initialize", {
    data: {
      token: (await tokenRes.json()).token,
      org_name: "Acme Engineering",
      admin_username: adminEmail,
      admin_password: password,
      admin_full_name: "Alex Admin",
    },
  })
  expect(initRes.ok(), await initRes.text()).toBeTruthy()
  const admin = await initRes.json()
  const base = `/api/v1/orgs/${admin.org_id}`
  const adminHeaders = { Authorization: `Bearer ${admin.access_token}` }

  const mgrEmail = `i18n-mgr-${crypto.randomUUID()}@example.com`
  const empEmail = `i18n-emp-${crypto.randomUUID()}@example.com`
  const reqEmail = `i18n-req-${crypto.randomUUID()}@example.com`
  const rosterRes = await request.post(`${base}/roster/imports`, {
    headers: adminHeaders,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          [
            "工号,姓名,部门,职位,上级工号,邮箱",
            `A01,Riley Requester,Client Ops,Product Lead,,${reqEmail}`,
            `M01,Morgan Manager,Engineering/Platform,Engineering Manager,,${mgrEmail}`,
            `E01,Taylor Engineer,Engineering/Platform,Backend Engineer,M01,${empEmail}`,
          ].join("\n"),
        ),
      },
    },
  })
  expect(rosterRes.ok(), await rosterRes.text()).toBeTruthy()
  const preview = await rosterRes.json()
  const applyRes = await request.post(
    `${base}/roster/imports/${preview.id}/apply`,
    {
      headers: adminHeaders,
      data: { base_revision: preview.base_revision },
    },
  )
  expect(applyRes.ok(), await applyRes.text()).toBeTruthy()

  const dictRes = await request.post(`${base}/capabilities/versions`, {
    headers: adminHeaders,
    data: {
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
                description: "Builds standard endpoints with tests",
              },
              {
                key: "independent_complex",
                label: "Leads complex tasks",
                description: "Designs distributed APIs end-to-end",
              },
            ],
          },
        },
        {
          key: "mentoring",
          name: "Technical Mentoring",
          category: "Collaboration",
          description: "Coaching peers and reviewing designs",
          level_rubric: {
            levels: [
              {
                key: "routine",
                label: "Handles routine tasks",
                description: "Guides onboarding engineers",
              },
            ],
          },
        },
      ],
    },
  })
  expect(dictRes.ok(), await dictRes.text()).toBeTruthy()

  const issueRes = await request.post(`${base}/accounts/issue`, {
    headers: adminHeaders,
    data: {},
  })
  expect(issueRes.ok(), await issueRes.text()).toBeTruthy()

  const accounts: EmployeeAccount[] = (
    await (
      await request.get(`${base}/accounts`, { headers: adminHeaders })
    ).json()
  ).data
  const empRow = accounts.find((v) => v.employee_code === "E01")!
  const mgrRow = accounts.find((v) => v.employee_code === "M01")!
  const reqRow = accounts.find((v) => v.employee_code === "A01")!

  const grantRes = await request.post(`${base}/role-grants`, {
    headers: adminHeaders,
    data: {
      user_id: mgrRow.account!.user_id,
      role: "dept_manager",
      department_id: mgrRow.department!.id,
    },
  })
  expect(grantRes.ok(), await grantRes.text()).toBeTruthy()

  const activateAccount = async (account: EmployeeAccount) => {
    const reset = await (
      await request.post(
        `${base}/accounts/${account.account!.user_id}/reset-password`,
        { headers: adminHeaders },
      )
    ).json()
    const tokenResp = await (
      await request.post("/api/v1/login/access-token", {
        form: { username: reset.username, password: reset.initial_password },
      })
    ).json()
    await request.patch("/api/v1/users/me/password", {
      headers: { Authorization: `Bearer ${tokenResp.access_token}` },
      data: {
        current_password: reset.initial_password,
        new_password: password,
      },
    })
    const loginResp = await (
      await request.post("/api/v1/login/access-token", {
        form: { username: reset.username, password },
      })
    ).json()
    return loginResp.access_token as string
  }

  const empToken = await activateAccount(empRow)
  const mgrToken = await activateAccount(mgrRow)
  const reqToken = await activateAccount(reqRow)

  return {
    orgId: admin.org_id as string,
    base,
    adminToken: admin.access_token as string,
    empToken,
    mgrToken,
    reqToken,
    empRow,
    mgrRow,
    reqRow,
  }
}

test("profile, people, org-chart, reviews, and inbox render complete English UI", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const env = await setupSyntheticEnglishOrg(request)
  const adminHeaders = { Authorization: `Bearer ${env.adminToken}` }
  const mgrHeaders = { Authorization: `Bearer ${env.mgrToken}` }
  const empHeaders = { Authorization: `Bearer ${env.empToken}` }
  const reqHeaders = { Authorization: `Bearer ${env.reqToken}` }

  // Seed direct edit + employee mixed request + capacity workload/extension/demand notifications.
  await request.post(
    `${env.base}/employees/${env.empRow.id}/profile/direct-edits`,
    {
      headers: mgrHeaders,
      data: {
        items: [
          {
            op: "add",
            capability_key: "backend_api",
            level: "routine",
            statement: "Maintains REST APIs with full test coverage.",
          },
        ],
      },
    },
  )

  const draft = await (
    await request.post(`${env.base}/me/requests`, {
      headers: empHeaders,
      data: {
        items: [
          {
            op: "modify",
            capability_key: "backend_api",
            level: "independent_complex",
            statement: "Led gateway redesign and zero-downtime rollout.",
          },
          {
            op: "add",
            capability_key: "mentoring",
            level: "routine",
            statement: "Mentored two junior engineers across Q3.",
          },
        ],
      },
    })
  ).json()
  const submitted = await (
    await request.post(`${env.base}/me/requests/${draft.id}/submit`, {
      headers: empHeaders,
      data: { revision: draft.revision },
    })
  ).json()

  // Enable capacity and seed workload + extension + incoming demand for reviews & inbox.
  await request.put(`${env.base}/capacity-settings`, {
    headers: adminHeaders,
    data: { enabled: true, requester_policy: "everyone" },
  })
  const myWorkload = await (
    await request.get(`${env.base}/capacity/workloads/me`, {
      headers: empHeaders,
    })
  ).json()
  const mondayStr: string = myWorkload.weeks[0].week_start
  const monday = new Date(`${mondayStr}T00:00:00Z`)
  const windowEnd = new Date(monday.getTime() + 14 * 86400000)
    .toISOString()
    .slice(0, 10)
  await request.put(`${env.base}/capacity/weeks`, {
    headers: mgrHeaders,
    data: {
      start_week: mondayStr,
      end_week: windowEnd,
      items: [{ employee_id: env.empRow.id, other_percent: 25 }],
    },
  })
  const wlReq = await (
    await request.post(`${env.base}/capacity/workloads/me/requests`, {
      headers: empHeaders,
      data: {
        requested_percent: 60,
        reason: "Supporting Q4 release launch",
        start_week: mondayStr,
        end_week: mondayStr,
      },
    })
  ).json()
  await request.post(
    `${env.base}/capacity/workload-requests/${wlReq.id}/decision`,
    {
      headers: mgrHeaders,
      data: { approve: true, note: "Approved for launch week" },
    },
  )

  const demand = await (
    await request.post(`${env.base}/capacity/demands`, {
      headers: reqHeaders,
      data: {
        requesting_department_id: env.reqRow.department!.id,
        target_department_id: env.empRow.department!.id,
        capability_key: "backend_api",
        headcount: 1,
        allocation_percent: 30,
        window_start: mondayStr,
        window_end: windowEnd,
        description: "Core gateway support",
      },
    })
  ).json()
  await request.post(`${env.base}/capacity/demands/${demand.id}/reply`, {
    headers: mgrHeaders,
    data: {
      revision: demand.revision,
      outcome: "can_do",
      start_date: mondayStr,
      end_date: windowEnd,
      text: "Available to support",
    },
  })
  await seedLegacyAcceptedDemand(request, env.orgId, demand.id, env.adminToken)
  const dueBefore = new Date(monday.getTime() + 7 * 86400000)
    .toISOString()
    .slice(0, 10)
  const dueAfter = new Date(monday.getTime() + 14 * 86400000)
    .toISOString()
    .slice(0, 10)
  const assignment = await (
    await request.post(
      `${env.base}/capacity/demands/${demand.id}/assignments`,
      {
        headers: mgrHeaders,
        data: {
          employee_id: env.empRow.id,
          allocation_percent: 30,
          start_date: mondayStr,
          due_date: dueBefore,
        },
      },
    )
  ).json()
  const extReq = await (
    await request.post(
      `${env.base}/capacity/assignments/${assignment.id}/extension-requests`,
      {
        headers: empHeaders,
        data: {
          requested_due_date: dueAfter,
          reason: "Waiting for integration test sign-off",
        },
      },
    )
  ).json()
  await request.post(
    `${env.base}/capacity/extension-requests/${extReq.id}/decision`,
    {
      headers: mgrHeaders,
      data: { approve: false, note: "Finish unit tests before extending" },
    },
  )

  // 1. Manager views /reviews?type=profile and /reviews/$requestId in EN.
  await setEnglishSession(page, env.mgrToken)
  await page.goto("/reviews?type=profile")
  await expect(page).toHaveTitle("Reviews - OrgPace")
  await expect(
    page.getByRole("link", { name: "View & review", exact: true }),
  ).toBeVisible()
  await expectEnglishCopy(page.locator("main"))

  await page.getByRole("link", { name: "View & review", exact: true }).click()
  await expect(page).toHaveURL(`/reviews/${submitted.id}`)
  await expect(page).toHaveTitle("Review Request - OrgPace")
  await expect(
    page.getByRole("heading", { name: "Review Decisions", exact: true }),
  ).toBeVisible()
  await expectEnglishCopy(page.locator("main"))

  // Decide items (1 approve, 1 reject) in EN.
  await page
    .getByRole("group", { name: "Review decision for Backend API Design" })
    .getByRole("button", { name: "Approve", exact: true })
    .click()
  const mentoringGroup = page.getByRole("group", {
    name: "Review decision for Technical Mentoring",
  })
  await mentoringGroup
    .getByRole("button", { name: "Reject", exact: true })
    .click()
  await mentoringGroup
    .getByRole("textbox", { name: "Reason for Technical Mentoring" })
    .fill("Please attach peer mentoring notes")
  await page.getByRole("button", { name: "Submit review", exact: true }).click()
  const confirmDialog = page.getByRole("dialog", {
    name: "Confirm Review Submission",
  })
  await expect(confirmDialog).toBeVisible()
  await expectEnglishCopy(confirmDialog)
  await confirmDialog
    .getByRole("button", { name: "Confirm & submit", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "Review Submitted", exact: true }),
  ).toBeVisible()
  await expectEnglishCopy(page.locator("main"))

  // 2. Manager checks /employees (toolbar, table, export menu, quick peek drawer) in EN.
  await page.goto("/employees")
  await expect(page).toHaveTitle("Employees - OrgPace")
  await expect(page.getByText("2 employees")).toBeVisible()
  await expectEnglishCopy(page.locator("table"))
  await page
    .getByRole("row")
    .filter({ hasText: "Taylor Engineer" })
    .getByRole("cell", { name: "Backend Engineer", exact: true })
    .click()
  const quickPeek = page.getByRole("dialog", { name: "Employee Quick Peek" })
  await expect(quickPeek).toBeVisible()
  await expectEnglishCopy(quickPeek)
  await quickPeek.getByRole("link", { name: "View full profile" }).click()
  await expect(page).toHaveURL(`/employees/${env.empRow.id}`)
  await expect(page).toHaveTitle("Employee Details - OrgPace")

  // Check capability detail drawer & DirectEditDialog in EN.
  const apiCard = page.getByRole("article", {
    name: "Backend API Design",
    exact: true,
  })
  await apiCard.getByRole("button", { name: "Backend API Design" }).click()
  const capDetail = page.getByRole("dialog", { name: "Backend API Design" })
  await expect(capDetail).toBeVisible()
  await expectEnglishCopy(capDetail)
  await capDetail.getByRole("button", { name: "Direct edit" }).click()
  const directEdit = page.getByRole("dialog", {
    name: 'Direct edit "Backend API Design"',
  })
  await expect(directEdit).toBeVisible()
  await expectEnglishCopy(directEdit)
  await directEdit.getByRole("button", { name: "Preview changes" }).click()
  await expect(
    directEdit.getByRole("button", { name: "Confirm & publish" }),
  ).toBeVisible()
  await expectEnglishCopy(directEdit)
  await page.keyboard.press("Escape")

  // 3. Manager checks /org-chart (Tree + Members + Department Capabilities) in EN.
  await page.goto("/org-chart")
  await expect(page).toHaveTitle("Org Chart - OrgPace")
  await expect(
    page.getByRole("heading", { name: "Department Common Capabilities" }),
  ).toBeVisible()
  await expectEnglishCopy(page.locator("main"))
  await page.getByRole("button", { name: "Members", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Department members" }),
  ).toBeVisible()
  await expectEnglishCopy(page.locator("main"))

  // 4. Admin checks Evidence & Version History tabs + AutoDraftSetting + OrgChart DepartmentActions in EN.
  await setEnglishSession(page, env.adminToken)
  await page.goto(`/employees/${env.empRow.id}?tab=versions`)
  await expect(
    page.getByRole("tab", { name: "Evidence & History", selected: true }),
  ).toBeVisible()
  const evidencePanel = page.getByRole("tabpanel", {
    name: "Evidence & History",
  })
  await expect(
    evidencePanel.getByRole("heading", { name: "Version History" }),
  ).toBeVisible()
  await expectEnglishCopy(evidencePanel)

  await page.goto("/org-chart")
  await page.getByRole("button", { name: /Rename/ }).click()
  const renameDialog = page.getByRole("dialog")
  await expect(renameDialog).toBeVisible()
  await expectEnglishCopy(renameDialog)
  await page.keyboard.press("Escape")

  // 5. Find People fallback in EN.
  await page.route("**/bot/sessions?*", (route) =>
    route.fulfill({ json: { data: [], count: 0, model_available: false } }),
  )
  await page.route("**/admin-assistant/sessions?*", (route) =>
    route.fulfill({ json: { data: [], count: 0, model_available: false } }),
  )
  await page.route("**/admin-assistant/availability?*", (route) =>
    route.fulfill({ json: { available: false, reason: "Disabled" } }),
  )
  await page.goto("/find-people")
  const findFallback = page
    .locator("details")
    .filter({ hasText: "Find people by capability" })
  await expect(findFallback).toBeVisible()
  await expectEnglishCopy(findFallback)
  await findFallback
    .locator("#people-search-capability_key")
    .selectOption("backend_api")
  await findFallback
    .getByRole("button", { name: "Search", exact: true })
    .click()
  await expect(
    findFallback.getByText("Found 1 matching record(s)"),
  ).toBeVisible()
  await expectEnglishCopy(findFallback)

  // 6. Employee checks /inbox (Profile, Workload, Extension details) & own profile in EN.
  await setEnglishSession(page, env.empToken)
  // Route inbox messages to synthetic English text since backend notification translation is T06.
  await page.route("**/me/inbox?*", async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    const translated = body.data.map(
      (item: {
        kind: string
        message: string
        workload_request_id?: string | null
        extension_request_id?: string | null
      }) => {
        if (item.kind === "decided")
          return { ...item, message: "Profile request review completed" }
        if (item.workload_request_id)
          return { ...item, message: "Workload adjustment request approved" }
        if (item.extension_request_id)
          return { ...item, message: "Extension request returned" }
        return { ...item, message: "Profile updated" }
      },
    )
    await route.fulfill({ json: { ...body, data: translated } })
  })

  await page.goto("/inbox")
  await expect(page).toHaveTitle("Inbox - OrgPace")
  const inboxList = page.getByRole("complementary", { name: "Messages" })
  await inboxList
    .getByRole("listitem")
    .filter({ hasText: "Profile request review completed" })
    .first()
    .getByRole("button")
    .click()
  const inboxDetail = page.getByRole("region", { name: "Message details" })
  await expect(inboxDetail).toContainText("Backend API Design")
  await expectEnglishCopy(page.locator("main"))

  await inboxList
    .getByRole("listitem")
    .filter({ hasText: "Workload adjustment request approved" })
    .first()
    .getByRole("button")
    .click()
  await expect(inboxDetail).toContainText("Before 25% → After 60%")
  await expectEnglishCopy(page.locator("main"))

  await inboxList
    .getByRole("listitem")
    .filter({ hasText: "Extension request returned" })
    .first()
    .getByRole("button")
    .click()
  await expect(inboxDetail).toContainText(
    `Previous due ${dueBefore} → Requested ${dueAfter}`,
  )
  await expectEnglishCopy(page.locator("main"))

  // Employee checks own profile Capabilities tab, ChangeRequestEditor, CapabilityPicker.
  await page.goto(`/employees/${env.empRow.id}`)
  const capTab = page.getByRole("tabpanel", { name: "Capability Profile" })
  await expect(capTab).toBeVisible()
  await expectEnglishCopy(capTab)

  await page.getByRole("button", { name: "Add capability" }).click()
  const pickerDialog = page.getByRole("dialog", { name: "Add Capability" })
  await expect(pickerDialog).toBeVisible()
  await expectEnglishCopy(pickerDialog)
  await page.keyboard.press("Escape")

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()
})

test("Act 11 rejected red cards, Edit & resubmit, Resubmitted badge, and historical appeal work in EN", async ({
  page,
  request,
}) => {
  const env = await setupSyntheticEnglishOrg(request)
  const mgrHeaders = { Authorization: `Bearer ${env.mgrToken}` }

  await request.post(
    `${env.base}/employees/${env.empRow.id}/profile/direct-edits`,
    {
      headers: mgrHeaders,
      data: {
        items: [
          {
            op: "add",
            capability_key: "backend_api",
            level: "routine",
            statement: "Maintains standard REST APIs.",
          },
        ],
      },
    },
  )

  const rejectedId = crypto.randomUUID()
  const mixedId = crypto.randomUUID()
  const linkedDraftId = crypto.randomUUID()
  const resubmittedReqId = crypto.randomUUID()
  const latestDraftId = crypto.randomUUID()
  const appealId = crypto.randomUUID()

  await page.route(
    "**/employees/*/change-requests?status=all",
    async (route) => {
      const profileResp = await route.fetch({
        url: route
          .request()
          .url()
          .replace(/change-requests\?status=all$/, "profile"),
      })
      const profile: { items: ProfileItem[] } = await profileResp.json()
      const cap1 = profile.items.find(
        (e) => e.capability.key === "backend_api",
      )!
      const cap2 = profile.items.find((e) => e.capability.key === "mentoring")!
      const baseItem = {
        id: crypto.randomUUID(),
        op: "modify" as const,
        capability: cap1.capability,
        target_claim_id: cap1.claim?.id ?? null,
        after: {
          statement: "Updated backend claim",
          level: "independent_complex",
          assessment_status: "tentative" as const,
        },
        explanation: null,
        uncertainty: null,
        evidence: [],
      }
      const data: ChangeRequestPublic[] = [
        {
          id: linkedDraftId,
          origin: "correction",
          status: "draft",
          revision: 1,
          generated_by: {},
          submitted_via: null,
          client_name: null,
          submitted_at: null,
          parent_request_id: rejectedId,
          created_at: "2026-11-10T00:00:00Z",
          updated_at: "2026-11-10T00:00:00Z",
          items: [
            {
              ...baseItem,
              after: {
                statement: "Existing linked draft text",
                level: "routine",
                assessment_status: "tentative",
              },
            },
          ],
        },
        {
          id: rejectedId,
          origin: "manual",
          status: "rejected",
          revision: 1,
          generated_by: {},
          submitted_via: null,
          client_name: null,
          submitted_at: null,
          created_at: "2026-11-09T00:00:00Z",
          updated_at: "2026-11-09T00:00:00Z",
          items: [
            {
              ...baseItem,
              decision: "rejected",
              decision_reason: "Please add measurable outcomes",
            },
          ],
        },
        {
          id: mixedId,
          origin: "manual",
          status: "approved",
          revision: 1,
          generated_by: {},
          submitted_via: null,
          client_name: null,
          submitted_at: null,
          created_at: "2026-11-08T00:00:00Z",
          updated_at: "2026-11-08T00:00:00Z",
          items: [
            {
              ...baseItem,
              decision: "approved",
              decision_reason: null,
            },
            {
              ...baseItem,
              id: crypto.randomUUID(),
              op: "add",
              capability: cap2.capability,
              target_claim_id: null,
              decision: "rejected",
              decision_reason: "Insufficient mentoring evidence",
              appeal_id: appealId,
            },
          ],
        },
        {
          id: resubmittedReqId,
          origin: "correction",
          status: "pending_review",
          revision: 1,
          generated_by: {},
          submitted_via: null,
          client_name: null,
          submitted_at: null,
          parent_request_id: mixedId,
          created_at: "2026-11-11T00:00:00Z",
          updated_at: "2026-11-11T00:00:00Z",
          items: [
            {
              ...baseItem,
              id: crypto.randomUUID(),
              op: "add",
              capability: cap2.capability,
              target_claim_id: null,
            },
          ],
        },
        {
          id: latestDraftId,
          origin: "correction",
          status: "draft",
          revision: 1,
          generated_by: {},
          submitted_via: null,
          client_name: null,
          submitted_at: null,
          parent_request_id: resubmittedReqId,
          created_at: "2026-11-12T00:00:00Z",
          updated_at: "2026-11-12T00:00:00Z",
          items: [
            {
              ...baseItem,
              id: crypto.randomUUID(),
              op: "add",
              capability: cap2.capability,
              target_claim_id: null,
              after: {
                statement: "Chained latest draft statement",
                level: "routine",
                assessment_status: "tentative",
              },
            },
          ],
        },
      ]
      await route.fulfill({ json: { count: data.length, data } })
    },
  )

  await page.route(`**/appeals/${appealId}`, (route) =>
    route.fulfill({
      json: {
        id: appealId,
        request_id: mixedId,
        item_id: crypto.randomUUID(),
        employee_id: env.empRow.id,
        reason: "Historical appeal reason",
        status: "upheld",
        created_at: "2026-11-01T00:00:00Z",
        resolved_at: "2026-11-02T00:00:00Z",
        resolution_note: "Original decision upheld",
      },
    }),
  )

  await page.route("**/me/requests/*/items", (route) =>
    route.fulfill({
      json: {
        id: linkedDraftId,
        employee_id: env.empRow.id,
        origin: "correction",
        status: "draft",
        revision: 2,
        parent_request_id: rejectedId,
        created_at: "2026-11-10T00:00:00Z",
        updated_at: "2026-11-10T00:00:00Z",
        items: [],
      },
    }),
  )

  await page.route("**/me/requests/*/preview", (route) =>
    route.fulfill({
      json: {
        request_id: linkedDraftId,
        revision: 1,
        policy_version: 1,
        requires_manager: true,
        partial_auto_publish: false,
        reviewers: [{ name: "Morgan Manager", role: "Department Manager" }],
        items: [
          {
            before: null,
            after: {
              id: crypto.randomUUID(),
              op: "modify",
              capability: {
                id: crypto.randomUUID(),
                key: "backend_api",
                name: "Backend API Design",
              },
              after: {
                statement: "Existing linked draft text",
                level: "routine",
                assessment_status: "tentative",
              },
              evidence: [],
            },
            current_changed_at: "2026-11-14T08:00:00Z",
            warning: null,
          },
        ],
      },
    }),
  )

  await setEnglishSession(page, env.empToken)
  await page.goto(`/employees/${env.empRow.id}`)

  await page.locator("summary", { hasText: /^Processed requests/ }).click()
  const processed = page.getByRole("region", { name: "Processed requests" })
  await expect(processed).toBeVisible()
  await expectEnglishCopy(processed)

  const rejectedCard = page.locator(`[id="request-${rejectedId}"]`)
  await expect(rejectedCard).toHaveClass(/border-destructive\/40/)
  await expect(rejectedCard).toHaveClass(/bg-destructive\/5/)
  await expect(rejectedCard).toContainText(
    "Reason: Please add measurable outcomes",
  )

  const mixedCard = page.locator(`[id="request-${mixedId}"]`)
  await expect(
    mixedCard.getByText("Resubmitted", { exact: true }),
  ).toBeVisible()
  await expect(
    mixedCard.getByRole("button", { name: "Edit & resubmit", exact: true }),
  ).toHaveCount(0)
  await expect(mixedCard).toContainText(
    "Appeal: Upheld · Original decision upheld",
  )
  await expect(processed.getByRole("button", { name: "Appeal" })).toHaveCount(0)

  // Verify Edit & resubmit opens ChangeRequestEditor with English copy and localized timestamp.
  await rejectedCard
    .getByRole("button", { name: "Edit & resubmit", exact: true })
    .click()
  const editor = page.getByRole("dialog", { name: "Update My Profile" })
  await expect(
    editor.getByRole("textbox", { name: "Capability statement" }),
  ).toHaveValue("Existing linked draft text")
  await expectEnglishCopy(editor)

  // Verify input limit validation and Preview step in English.
  await editor
    .getByRole("textbox", { name: "Capability statement" })
    .fill("x".repeat(205))
  await expect(
    editor.getByText(/Capability statement can be at most 200 characters/),
  ).toBeVisible()
  await expectEnglishCopy(editor)

  await editor
    .getByRole("textbox", { name: "Capability statement" })
    .fill("Updated backend API statement")
  await editor.getByRole("button", { name: "Preview & submit" }).click()
  const previewDialog = page.getByRole("dialog", { name: "Preview Changes" })
  await expect(previewDialog.getByText("Morgan Manager")).toBeVisible()
  await expectEnglishCopy(previewDialog)
  await previewDialog
    .getByRole("button", { name: "Close", exact: true })
    .click()

  await mixedCard
    .getByRole("button", { name: "View latest request", exact: true })
    .click()
  await expect(page.locator(`[id="request-${latestDraftId}"]`)).toBeVisible()
})
