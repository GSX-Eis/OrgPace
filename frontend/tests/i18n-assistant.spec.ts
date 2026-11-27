import { expect, test } from "@playwright/test"
import type { TurnResponse } from "../src/client"
import { expectEnglishCopy } from "./utils/copy"
import { createUser } from "./utils/privateApi"
import { randomEmail, randomPassword } from "./utils/random"
import { logInUser } from "./utils/user"

test.use({ storageState: { cookies: [], origins: [] } })

test("work bot renders English UI, cards, and session history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const email = randomEmail()
  const password = randomPassword()
  await createUser({ email, password, withEmptyProfile: true })
  await logInUser(page, email, password)

  await page.getByTestId("language-switch-en").click()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")

  const historySessionId = crypto.randomUUID()
  const cardId = crypto.randomUUID()
  const requestId = crypto.randomUUID()

  await page.route("**/bot/sessions?*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: {
          data: [
            {
              id: historySessionId,
              preview: "Check backend skills",
              last_activity_at: "2026-11-26T09:00:00Z",
            },
          ],
          retention_days: 7,
          model_available: true,
        },
      })
      return
    }
    await route.continue()
  })

  const mockTurn: TurnResponse = {
    messages: [
      {
        type: "text",
        text: "Here is a summary of your requests and feasibility check.",
        review_link: "/reviews",
      },
      {
        type: "feasibility_card",
        capability_key: "frontend",
        capability_name: "Frontend Engineering",
        allocation_cap_percent: 70,
        window_start: "2026-12-01",
        window_end: "2026-12-07",
        departments: [
          {
            department_name: "Platform UI",
            conclusion: "can_do",
            load_level: "low",
            department_load_percent: 45,
            regular_used_percent: 45,
            elastic_used_percent: 0,
            regular_headroom_percent: 25,
            elastic_headroom_percent: 30,
            earliest_start_date: "2026-12-01",
            is_estimated: false,
            exceeds_regular_cap: false,
            needs_elastic: false,
            data_source: "confirmed",
          },
          {
            department_name: "Release Ops",
            conclusion: "needs_confirmation",
            load_level: "high",
            department_load_percent: 82,
            regular_used_percent: 70,
            elastic_used_percent: 12,
            regular_headroom_percent: 0,
            elastic_headroom_percent: 18,
            is_estimated: true,
            exceeds_regular_cap: true,
            needs_elastic: true,
            data_source: "forecast_baseline",
          },
        ],
      },
      {
        type: "project_draft_card",
        project: {
          title: "Mobile Checkout Redesign",
          requesting_department_id: crypto.randomUUID(),
          description: "Cross-department delivery sprint",
          roles: [],
        },
        fields: [{ label: "Requester", value: "Product Operations" }],
        actions: [{ action: "confirm_project_draft", card_id: cardId }],
      },
      {
        type: "question_card",
        id: crypto.randomUUID(),
        status: "open",
        question: "Which backend service did you migrate?",
        reason: "Clarify scope before drafting.",
        actions: ["answer_question"],
      },
      {
        type: "preview_card",
        request_id: requestId,
        revision: 1,
        requires_manager: false,
        partial_auto_publish: false,
        reviewers: [],
        items: [
          {
            before: null,
            after: {
              op: "add",
              capability: { key: "python", name: "Python" },
              after: {
                statement: "Led async API redesign",
                level: "core",
                level_name: "Core",
                assessment_status: "confirmed",
              },
              explanation: null,
              uncertainty: null,
              owner_statement: null,
              objection: null,
            },
            submission_notice: null,
            warning: null,
          },
        ],
        actions: [
          { action: "confirm_submit", request_id: requestId, revision: 1 },
          { action: "continue_editing", request_id: requestId, revision: 1 },
        ],
      },
      {
        type: "profile_edit_card",
        card_id: cardId,
        employee_id: crypto.randomUUID(),
        employee_name: "Alice Smith",
        revision: 1,
        edit: { base_revision: null, items: [] },
        items: [
          {
            capability_key: "python",
            capability_name: "Python",
            before: {
              statement: "Maintained REST endpoints",
              level: "routine",
              level_name: "Routine",
              assessment_status: "confirmed",
            },
            after: {
              statement: "Architected distributed workers",
              level: "core",
              level_name: "Core",
              assessment_status: "confirmed",
            },
          },
        ],
        actions: [
          { action: "confirm_profile_edit", card_id: cardId },
          { action: "continue_profile_edit", card_id: cardId },
        ],
      },
      {
        type: "review_card",
        card_id: cardId,
        id: requestId,
        revision: 2,
        items: [
          {
            before: null,
            jira_only: true,
            approvable: true,
            approval_blocked_reason: null,
            evidence: [{ title: "Jira ticket SEC-12" }],
            after: {
              id: "rev-item-1",
              op: "add",
              capability: { key: "security", name: "Application Security" },
              after: {
                statement: "Completed threat model audit",
                level: "core",
                level_name: "Core",
                assessment_status: "tentative",
              },
            },
          },
        ],
        decisions: [
          {
            item_id: "rev-item-1",
            decision: "approved",
            reason: "Verified against release notes",
          },
        ],
        actions: [
          {
            action: "confirm_review",
            request_id: requestId,
            revision: 2,
            card_id: cardId,
          },
          {
            action: "continue_review",
            request_id: requestId,
            revision: 2,
            card_id: cardId,
          },
        ],
      },
    ],
    steps: [],
  }

  let savedTurn: TurnResponse | null = null
  await page.route("**/bot/sessions/*/messages?*", (route) =>
    route.fulfill({
      json: savedTurn ? [{ role: "assistant", payload: savedTurn }] : [],
    }),
  )
  await page.route("**/bot/sessions/*/turns?*", async (route) => {
    savedTurn = mockTurn
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ type: "final", response: mockTurn })}\n`,
    })
  })

  await page.goto("/assistant?mode=personal")
  const log = page.getByRole("log", { name: "Work Assistant Conversation" })
  await expect(log).toBeVisible()
  await expectEnglishCopy(log)

  const history = page.getByRole("region", { name: "Conversation History" })
  await expect(history).toBeVisible()
  await expect(history.getByText("Retained for 7 days")).toBeVisible()
  await expectEnglishCopy(history)

  const input = page.getByRole("textbox", { name: "Message to Assistant" })
  await input.fill("Show my feasibility and profile cards")
  await page.getByRole("button", { name: "Send", exact: true }).click()

  const feasibility = page.getByRole("region", {
    name: "Frontend Engineering Cross-Department Feasibility",
  })
  await expect(feasibility).toBeVisible()
  await expect(feasibility.getByText("Light load")).toBeVisible()
  await expectEnglishCopy(feasibility)

  const projectDraft = page.getByRole("region", { name: "Project Draft" })
  await expect(projectDraft).toBeVisible()
  await expect(
    projectDraft.getByRole("button", { name: "Confirm & Create Project" }),
  ).toBeVisible()
  await expectEnglishCopy(projectDraft)

  const questionCard = page.getByRole("region", { name: "Pending Question" })
  await expect(questionCard).toBeVisible()
  await expect(
    questionCard.getByRole("button", { name: "Submit Answer" }),
  ).toBeVisible()
  await expectEnglishCopy(questionCard)

  const previewCard = page.getByRole("region", { name: "Change Preview" })
  await expect(previewCard).toBeVisible()
  await expect(
    previewCard.getByRole("button", { name: "Confirm & Submit" }),
  ).toBeVisible()
  await expectEnglishCopy(previewCard)

  const profileEdit = page.getByRole("region", {
    name: "Profile Edit Confirmation",
  })
  await expect(profileEdit).toBeVisible()
  await expect(
    profileEdit.getByRole("button", { name: "Confirm Edit" }),
  ).toBeVisible()
  await expectEnglishCopy(profileEdit)

  const reviewCard = page.getByRole("region", {
    name: "Review Decision Confirmation",
  })
  await expect(reviewCard).toBeVisible()
  await expect(
    reviewCard.getByRole("button", { name: "Confirm Decision" }),
  ).toBeVisible()
  await expectEnglishCopy(reviewCard)

  await expect(page.getByRole("link", { name: "Go to Reviews" })).toBeVisible()
})

test("admin assistant renders English UI, change set card, dictionary diff, table, secret, and file cards", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const sessionId = crypto.randomUUID()
  // Isolate session listing from shared demo admin sessions left by earlier shard tests.
  await page.route("**/admin-assistant/sessions?*", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ json: { session_id: sessionId } })
      return
    }
    await route.fulfill({
      json: { data: [], retention_days: 7, model_available: true },
    })
  })
  await logInUser(
    page,
    "admin@demo.example.com",
    process.env.DEMO_USER_PASSWORD!,
  )

  // Keep demo account's persisted backend locale untouched across parallel tests.
  await page.route("**/users/me/preferences", (route) =>
    route.fulfill({ json: { preferred_locale: "en" } }),
  )
  await page.route("**/users/me", async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: { ...body, preferred_locale: "en" },
    })
  })
  await page.getByTestId("language-switch-en").click()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")

  await page.route("**/admin-assistant/availability?*", (route) =>
    route.fulfill({ json: { available: true, reason: "" } }),
  )

  const draftChangeSetId = crypto.randomUUID()
  const appliedChangeSetId = crypto.randomUUID()
  const draftChangeSet = {
    id: draftChangeSetId,
    revision: 1,
    status: "draft",
    undo_of_id: null,
    items: [
      {
        function: "update_update_settings",
        title: "Update periodic reminder schedule and stale evidence threshold",
        args: { reminder_schedule: "yearly", stale_after_months: 12 },
        before: { reminder_schedule: "quarterly", stale_after_months: 6 },
        after: { reminder_schedule: "yearly", stale_after_months: 12 },
        risk: "high",
        undoable: true,
        testable: true,
        impact: {
          count: 18,
          text: "Affects periodic reminders and stale evidence thresholds for active employees",
          dictionary: {
            added: [
              {
                key: "rust_systems",
                name: "Rust Systems",
                category: "Engineering",
                description: "Systems programming in Rust",
                level_rubric: {
                  levels: [
                    {
                      key: "core",
                      label: "Core",
                      description: "Owns critical crates",
                    },
                  ],
                },
                changed_fields: [],
              },
            ],
            modified: [
              {
                key: "python",
                name: "Python",
                category: "Engineering",
                description: "Updated Python criteria",
                level_rubric: {
                  levels: [
                    {
                      key: "core",
                      label: "Core",
                      description: "Leads architecture",
                    },
                  ],
                },
                changed_fields: ["Description"],
              },
            ],
            removed: [],
          },
        },
      },
    ],
  }
  const appliedChangeSet = {
    id: appliedChangeSetId,
    revision: 1,
    status: "draft",
    undo_of_id: null,
    items: [
      {
        function: "reset_password",
        title: "Reset password",
        args: { user_id: crypto.randomUUID() },
        before: null,
        after: {},
        risk: "normal",
        undoable: false,
      },
    ],
  }
  const appliedResult = {
    ...appliedChangeSet,
    status: "applied",
    one_time: [
      {
        type: "initial_password",
        display_name: "Alice Smith",
        username: "alice@example.com",
        initial_password: "TempPassword!2026",
      },
    ],
  }

  await page.route(
    `**/admin-assistant/change-sets/${draftChangeSetId}*`,
    (route) => route.fulfill({ json: draftChangeSet }),
  )
  let resetApplied = false
  await page.route(
    `**/admin-assistant/change-sets/${appliedChangeSetId}*`,
    (route) =>
      route.fulfill({
        json: resetApplied
          ? { ...appliedChangeSet, status: "applied" }
          : appliedChangeSet,
      }),
  )
  await page.route(
    `**/admin-assistant/change-sets/${appliedChangeSetId}/apply*`,
    (route) => {
      resetApplied = true
      return route.fulfill({ json: appliedResult })
    },
  )

  const reply = {
    messages: [
      { type: "text", text: "Please review the drafted settings and roster." },
      { type: "admin_change_set", change_set: draftChangeSet },
      { type: "admin_change_set", change_set: appliedChangeSet },
      {
        type: "secret_input",
        change_set_id: draftChangeSetId,
        field: "app_secret",
        title: "Enter Feishu App Secret Securely",
      },
      { type: "file_upload", kind: "work_csv" },
      {
        type: "file_preview",
        kind: "work_csv",
        preview: {
          counts: { 记录条数: 10, 涉及人数: 4, 警告: 1, 错误: 0 },
          warnings: [{ location: "Row 2", message: "Optional column blank" }],
          errors: [],
        },
      },
      {
        type: "table",
        title: "View employees and account statuses",
        columns: ["display_name", "employment_status", "role"],
        rows: [["Alice Smith", "active", "org_admin"]],
        total: 1,
        page: "/employees",
        queried_at: "2026-11-26T09:00:00Z",
      },
      { type: "link", title: "Open settings", page: "/admin" },
    ],
  }

  let posted = false
  await page.route("**/admin-assistant/sessions/*/messages?*", (route) =>
    route.fulfill({
      json: posted
        ? [
            {
              id: crypto.randomUUID(),
              role: "assistant",
              payload: reply,
              created_at: new Date().toISOString(),
            },
          ]
        : [],
    }),
  )
  await page.route("**/admin-assistant/sessions/*/turns?*", async (route) => {
    posted = true
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ type: "final", response: reply })}\n`,
    })
  })

  await page.goto("/assistant?mode=admin")
  await expect(
    page.getByRole("heading", { name: "How can I help?" }),
  ).toBeVisible()
  const quickActions = page.getByRole("region", { name: "Common actions" })
  await expectEnglishCopy(quickActions)

  const input = page.getByRole("textbox", {
    name: "Message to Admin Assistant",
  })
  await input.fill("Draft updates and inspect employees")
  await page.getByRole("button", { name: "Send", exact: true }).click()

  const cards = page.getByRole("region", {
    name: "Settings Change Confirmation Card",
  })
  await expect(cards).toHaveCount(2)
  await expect(
    cards.nth(0).getByRole("button", { name: "Confirm & Apply" }),
  ).toBeVisible()
  await expect(
    cards.nth(0).getByRole("region", { name: "Dictionary Change Details" }),
  ).toBeVisible()
  await expectEnglishCopy(cards.nth(0))

  await cards.nth(1).getByRole("button", { name: "Confirm & Apply" }).click()
  await expect(cards.nth(1).getByLabel("Initial Password")).toHaveValue(
    "TempPassword!2026",
  )
  await expectEnglishCopy(cards.nth(1))

  const secretCard = page.getByRole("form", { name: "Secure Input Box" })
  await expect(secretCard).toBeVisible()
  await expect(
    secretCard.getByRole("button", { name: "Submit Securely" }),
  ).toBeVisible()
  await expectEnglishCopy(secretCard)

  const uploadCard = page.getByRole("form", { name: "Upload Work Records" })
  await expect(uploadCard).toBeVisible()
  await expect(
    uploadCard.getByRole("button", { name: "Upload & Preview" }),
  ).toBeVisible()
  await expectEnglishCopy(uploadCard)

  const previewCard = page.getByRole("region", { name: "File Preview" })
  await expect(previewCard).toBeVisible()
  await expect(previewCard.getByText("Records")).toBeVisible()
  await expectEnglishCopy(previewCard)

  const log = page.getByRole("log", { name: "Admin Assistant Conversation" })
  await expect(log.getByText("Organization Administrator")).toBeVisible()
  await expectEnglishCopy(log)
})
