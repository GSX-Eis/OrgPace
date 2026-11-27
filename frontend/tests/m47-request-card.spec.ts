import { expect, test } from "@playwright/test"
import type { ChangeRequestPublic, ItemInput, ProfileItem } from "../src/client"
import { logInUser } from "./utils/user"

test.use({ storageState: { cookies: [], origins: [] } })
const password = process.env.DEMO_USER_PASSWORD!

for (const [decision, summary] of [
  ["changes_requested", "1 项批准、2 项被拒绝"],
  ["rejected", "1 项批准、2 项被拒绝"],
  ["approved", "已批准 · 3 项改动"],
] as const) {
  test(`request summary matches item decisions: ${decision}`, async ({
    page,
  }) => {
    await page.route(
      "**/employees/*/change-requests?status=all",
      async (route) => {
        const body = await (await route.fetch()).json()
        const original: ChangeRequestPublic = body.data.find(
          (r: ChangeRequestPublic) => r.origin === "initial_sync",
        )
        const item = original.items![0]
        await route.fulfill({
          json: {
            count: 1,
            data: [
              {
                ...original,
                status: "approved",
                items: ["approved", decision, decision].map((value, index) => ({
                  ...item,
                  id: crypto.randomUUID(),
                  decision: value,
                  capability: {
                    ...item.capability,
                    name: `合成能力${index + 1}`,
                  },
                })),
              },
            ],
          },
        })
      },
    )
    await logInUser(page, "employee.platform@demo.example.com", password)
    await page.getByRole("link", { name: "组织", exact: true }).click()
    await page.locator("summary", { hasText: /^已处理请求/ }).click()
    const processed = page.getByRole("region", { name: "已处理请求" })
    await expect(processed).toContainText(summary)
    await expect(processed).toContainText("合成能力1：批准")
    await expect(processed).toContainText(
      `合成能力2：${decision === "approved" ? "批准" : "被拒绝"}`,
    )
  })
}

for (const role of ["employee", "manager"] as const) {
  test(`${role} sees review reasons on the compact profile`, async ({
    page,
  }) => {
    const decisions = [
      {
        status: "changes_requested",
        label: "被拒绝",
        reason: "请补充交付结果和你的具体贡献",
      },
      {
        status: "rejected",
        label: "被拒绝",
        reason: "这项工作不属于该能力的范围",
      },
    ] as const
    await page.route(
      "**/employees/*/change-requests?status=all",
      async (route) => {
        const response = await route.fetch()
        expect(response.ok()).toBeTruthy()
        const { data } = await response.json()
        const initial: ChangeRequestPublic = data.find(
          (request: ChangeRequestPublic) => request.origin === "initial_sync",
        )
        const item = initial.items![0]
        await route.fulfill({
          response,
          json: {
            count: decisions.length,
            data: decisions.map(({ status, reason }) => ({
              ...initial,
              id: crypto.randomUUID(),
              status,
              submitted_via: "admin_handover",
              items: [
                {
                  ...item,
                  id: crypto.randomUUID(),
                  decision: status,
                  decision_reason: reason,
                },
              ],
            })),
          },
        })
      },
    )
    await logInUser(page, `${role}.platform@demo.example.com`, password)
    if (role === "manager") {
      await page.goto("/employees")
      await page.getByRole("combobox", { name: "部门筛选" }).click()
      await page
        .getByRole("option", { name: "平台研发部", exact: true })
        .click()
      await page.getByRole("link", { name: "张伟", exact: true }).click()
    } else {
      await page.getByRole("link", { name: "组织", exact: true }).click()
    }
    await expect(
      page.getByRole("heading", { name: "张伟", exact: true }),
    ).toBeVisible()
    await page.locator("summary", { hasText: "已处理请求" }).click()
    const section = page.getByRole("region", {
      name: "已处理请求",
      exact: true,
    })
    for (const { label, reason } of decisions) {
      await expect(section).toContainText(`${label} · 1 项改动`)
      await expect(
        section.getByText(`原因：${reason}`, { exact: true }),
      ).toBeVisible()
      await expect(
        section.getByText("请求时间线", { exact: true }),
      ).toHaveCount(0)
      await expect(
        section.getByText("员工未确认", { exact: false }),
      ).toHaveCount(0)
    }
    await expect(page.getByRole("tab", { name: "证据与历史" })).toHaveCount(0)
    const capability = page.getByRole("article", { name: "后端 API 开发" })
    await expect(capability).toBeVisible()
    await expect(
      capability.getByText("相关证据", { exact: false }),
    ).toHaveCount(0)
  })
}

test("old initial draft previews the current value and submits an edited proposal", async ({
  page,
}) => {
  let draft: ChangeRequestPublic
  let statement = "旧初稿建议"
  let submitted = false
  await page.route(
    "**/employees/*/change-requests?status=all",
    async (route) => {
      if (!draft) {
        const body = await (await route.fetch()).json()
        draft = body.data.find(
          (r: ChangeRequestPublic) => r.origin === "initial_sync",
        )
        draft = { ...draft, items: [draft.items![0]] }
      }
      await route.fulfill({
        json: {
          count: 1,
          data: [
            {
              ...draft,
              status: submitted ? "pending_review" : "pending_owner",
            },
          ],
        },
      })
    },
  )
  const currentId = crypto.randomUUID()
  await page.route("**/me/requests/*/preview", (route) =>
    route.fulfill({
      json: {
        request_id: draft.id,
        revision: draft.revision,
        reviewers: [{ name: "合成经理", role: "部门经理" }],
        items: [
          {
            before: {
              id: currentId,
              statement: "经理已发布的当前判断",
              level: "routine",
              assessment_status: "confirmed",
              confidence: null,
              explanation: null,
              generated_by: { actor_type: "user" },
              evidence: [],
            },
            after: {
              ...draft.items![0],
              op: "modify",
              target_claim_id: currentId,
              after: { ...draft.items![0].after, statement },
            },
            current_changed_at: "2026-11-14T08:00:00Z",
            warning: null,
          },
        ],
      },
    }),
  )
  let saves = 0
  await page.route("**/me/requests/*/items", async (route) => {
    const item: ItemInput = route.request().postDataJSON().items[0]
    if (++saves === 1) {
      await route.fulfill({
        status: 422,
        json: {
          detail: [{ index: 0, message: "等级编码不在该能力的等级中" }],
        },
      })
      return
    }
    statement = item.statement
    await route.fulfill({ json: draft })
  })
  await page.route("**/me/requests/*/submit", async (route) => {
    expect(route.request().postDataJSON().revision).toBe(draft.revision)
    submitted = true
    await route.fulfill({ json: { ...draft, status: "pending_review" } })
  })
  await logInUser(page, "employee.platform@demo.example.com", password)
  await page.getByRole("link", { name: "组织", exact: true }).click()
  await page.locator("summary", { hasText: /待你确认：初始画像草稿/ }).click()
  await page.getByRole("button", { name: "直接提交", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("经理已发布的当前判断")
  await expect(dialog).toContainText(
    "该项已于 2026/11/14 16:00:00 被更新，本次提交将基于最新内容送审。",
  )
  await dialog.getByRole("button", { name: "返回修改" }).click()
  await dialog
    .getByRole("textbox", { name: "能力说明", exact: true })
    .fill("本人基于当前值补充")
  await dialog.getByRole("button", { name: "预览并提交" }).click()
  await expect(dialog.getByRole("alert")).toContainText(
    "第 1 项：等级编码不在该能力的等级中",
  )
  await dialog.getByRole("button", { name: "预览并提交" }).click()
  await expect(dialog).toContainText("本人基于当前值补充")
  await dialog.getByRole("button", { name: "确认提交", exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.locator("summary", { hasText: /^其他待处理请求/ }).click()
  await expect(
    page.getByRole("region", { name: "其他待处理请求" }),
  ).toContainText("待经理审批")
})

test("compact grid, red rejected cards, read-only legacy appeal, and resubmit flows", async ({
  page,
}) => {
  const createdDrafts: Array<Record<string, unknown>> = []
  const updatedDraftIds: string[] = []
  const rejectedId = crypto.randomUUID()
  const changesId = crypto.randomUUID()
  const mixedId = crypto.randomUUID()
  const linkedDraftId = crypto.randomUUID()
  const appealId = crypto.randomUUID()

  await page.route(
    "**/employees/*/change-requests?status=all",
    async (route) => {
      const profileResponse = await route.fetch({
        url: route
          .request()
          .url()
          .replace(/change-requests\?status=all$/, "profile"),
      })
      const profile: { items: ProfileItem[] } = await profileResponse.json()
      const capItem = profile.items.find(
        (entry) => entry.capability.key === "backend_api",
      )!
      const secondCap = profile.items.find(
        (entry) => entry.capability.key !== "backend_api" && !entry.retired,
      )!
      const baseResponse = await route.fetch()
      const baseBody = await baseResponse.json()
      const template: ChangeRequestPublic = baseBody.data[0]
      const templateItem = template.items![0]
      await route.fulfill({
        json: {
          count: 4,
          data: [
            {
              ...template,
              id: linkedDraftId,
              origin: "correction",
              status: "draft",
              parent_request_id: rejectedId,
              items: [
                {
                  ...templateItem,
                  id: crypto.randomUUID(),
                  op: "modify",
                  capability: capItem.capability,
                  target_claim_id: capItem.claim?.id ?? null,
                  decision: null,
                  decision_reason: null,
                  after: {
                    statement: "关联草稿里的已有陈述",
                    level: "routine",
                    assessment_status: "tentative",
                  },
                },
              ],
            },
            {
              ...template,
              id: rejectedId,
              origin: "manual",
              status: "rejected",
              items: [
                {
                  ...templateItem,
                  id: crypto.randomUUID(),
                  op: "modify",
                  capability: capItem.capability,
                  target_claim_id: capItem.claim?.id ?? null,
                  decision: "rejected",
                  decision_reason: "整单被拒：请补充量化成果",
                },
              ],
            },
            {
              ...template,
              id: changesId,
              origin: "manual",
              status: "changes_requested",
              items: [
                {
                  ...templateItem,
                  id: crypto.randomUUID(),
                  op: "add",
                  capability: secondCap.capability,
                  target_claim_id: null,
                  decision: "changes_requested",
                  decision_reason: "历史退回：请补充项目背景",
                  after: {
                    statement: "原退回陈述",
                    level: "routine",
                    assessment_status: "tentative",
                  },
                },
              ],
            },
            {
              ...template,
              id: mixedId,
              origin: "manual",
              status: "approved",
              items: [
                {
                  ...templateItem,
                  id: crypto.randomUUID(),
                  op: "modify",
                  capability: capItem.capability,
                  decision: "approved",
                  decision_reason: null,
                },
                {
                  ...templateItem,
                  id: crypto.randomUUID(),
                  op: "add",
                  capability: secondCap.capability,
                  decision: "rejected",
                  decision_reason: "混合部分拒绝：依据不足",
                  appeal_id: appealId,
                },
              ],
            },
          ],
        },
      })
    },
  )

  await page.route(`**/appeals/${appealId}`, (route) =>
    route.fulfill({
      json: {
        id: appealId,
        request_id: mixedId,
        item_id: crypto.randomUUID(),
        employee_id: crypto.randomUUID(),
        reason: "历史申诉原因",
        status: "upheld",
        created_at: "2026-11-01T00:00:00Z",
        resolved_at: "2026-11-02T00:00:00Z",
        resolution_note: "历史裁决说明",
      },
    }),
  )

  await page.route("**/me/requests", async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON()
      createdDrafts.push(payload)
      await route.fulfill({
        status: 201,
        json: {
          id: crypto.randomUUID(),
          revision: 1,
          status: "draft",
          items: [],
        },
      })
      return
    }
    await route.continue()
  })

  await page.route(`**/me/requests/${linkedDraftId}/items`, async (route) => {
    updatedDraftIds.push(linkedDraftId)
    await route.fulfill({
      json: { id: linkedDraftId, revision: 2, status: "draft", items: [] },
    })
  })

  await logInUser(page, "employee.platform@demo.example.com", password)
  await page.getByRole("link", { name: "组织", exact: true }).click()

  await page.locator("summary", { hasText: /^其他待处理请求/ }).click()
  const pending = page.getByRole("region", { name: "其他待处理请求" })
  await expect(pending.locator(".grid.md\\:grid-cols-2")).toHaveCount(1)

  await page.locator("summary", { hasText: /^已处理请求/ }).click()
  const processed = page.getByRole("region", { name: "已处理请求" })
  await expect(processed.locator(".grid.md\\:grid-cols-2")).toHaveCount(1)

  await expect(processed.getByRole("button", { name: "申诉" })).toHaveCount(0)
  await expect(
    processed.getByText("申诉：维持原决定 · 历史裁决说明"),
  ).toBeVisible()

  const rejectedCard = page.locator(`[id="request-${rejectedId}"]`)
  await expect(rejectedCard).toHaveClass(/border-destructive\/40/)
  await expect(rejectedCard).toHaveClass(/bg-destructive\/5/)
  await expect(rejectedCard).toContainText("原因：整单被拒：请补充量化成果")

  const changesCard = page.locator(`[id="request-${changesId}"]`)
  await expect(changesCard).toHaveClass(/border-destructive\/40/)

  const mixedCard = page.locator(`[id="request-${mixedId}"]`)
  await expect(mixedCard).not.toHaveClass(/border-destructive\/40/)
  await expect(mixedCard).toContainText("原因：混合部分拒绝：依据不足")

  // Reuses existing linked draft without creating a new draft.
  await rejectedCard
    .getByRole("button", { name: "修改重提", exact: true })
    .click()
  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("textbox", { name: "能力说明", exact: true }),
  ).toHaveValue("关联草稿里的已有陈述")
  await dialog.getByRole("button", { name: "保存草稿", exact: true }).click()
  await expect(dialog.getByRole("status")).toHaveText("草稿已保存")
  expect(updatedDraftIds).toEqual([linkedDraftId])
  expect(createdDrafts).toHaveLength(0)
  await dialog.getByRole("button", { name: "关闭", exact: true }).click()

  // Clones when no linked draft exists.
  await changesCard
    .getByRole("button", { name: "修改重提", exact: true })
    .click()
  await expect(
    dialog.getByRole("textbox", { name: "能力说明", exact: true }),
  ).toHaveValue("原退回陈述")
  await dialog.getByRole("button", { name: "保存草稿", exact: true }).click()
  await expect(dialog.getByRole("status")).toHaveText("草稿已保存")
  expect(createdDrafts).toHaveLength(1)
  expect(createdDrafts[0].withdrawn_request_id).toBe(changesId)
})

test("resubmitted card shows 已重提, reuses manual draft, and navigates to latest request", async ({
  page,
}) => {
  const rejectedId = crypto.randomUUID()
  const mixedId = crypto.randomUUID()
  const chainedRejectedId = crypto.randomUUID()
  const chainedLatestDraftId = crypto.randomUUID()
  const createdDraftId = crypto.randomUUID()
  const appealId = crypto.randomUUID()
  const createdDrafts: Array<Record<string, unknown>> = []
  const updatedDraftIds: string[] = []
  let createdSaved = false
  let mixedResubmitted = false

  await page.route(
    "**/employees/*/change-requests?status=all",
    async (route) => {
      const profileResponse = await route.fetch({
        url: route
          .request()
          .url()
          .replace(/change-requests\?status=all$/, "profile"),
      })
      const profile: { items: ProfileItem[] } = await profileResponse.json()
      const capItem = profile.items.find(
        (entry) => entry.capability.key === "backend_api",
      )!
      const secondCap = profile.items.find(
        (entry) => entry.capability.key !== "backend_api" && !entry.retired,
      )!
      const baseResponse = await route.fetch()
      const baseBody = await baseResponse.json()
      const template: ChangeRequestPublic = baseBody.data[0]
      const templateItem = template.items![0]
      const extra: ChangeRequestPublic[] = []
      if (createdSaved) {
        extra.push({
          ...template,
          id: createdDraftId,
          origin: "manual",
          status: "draft",
          parent_request_id: rejectedId,
          items: [
            {
              ...templateItem,
              id: crypto.randomUUID(),
              op: "modify",
              capability: capItem.capability,
              target_claim_id: capItem.claim?.id ?? null,
              decision: null,
              decision_reason: null,
              after: {
                statement: "首次手动保存的重提陈述",
                level: "routine",
                assessment_status: "tentative",
              },
            },
          ],
        })
      }
      extra.push(
        {
          ...template,
          id: rejectedId,
          origin: "manual",
          status: "rejected",
          items: [
            {
              ...templateItem,
              id: crypto.randomUUID(),
              op: "modify",
              capability: capItem.capability,
              target_claim_id: capItem.claim?.id ?? null,
              decision: "rejected",
              decision_reason: "整单拒绝原因：请补充证明",
              after: {
                statement: "原被拒陈述",
                level: "routine",
                assessment_status: "tentative",
              },
            },
          ],
        },
        {
          ...template,
          id: mixedId,
          origin: "manual",
          status: "approved",
          items: [
            {
              ...templateItem,
              id: crypto.randomUUID(),
              op: "modify",
              capability: capItem.capability,
              decision: "approved",
              decision_reason: null,
            },
            {
              ...templateItem,
              id: crypto.randomUUID(),
              op: "add",
              capability: secondCap.capability,
              target_claim_id: null,
              decision: "rejected",
              decision_reason: "混合部分拒绝：补充证据",
              appeal_id: appealId,
              after: {
                statement: "混合被拒陈述",
                level: "routine",
                assessment_status: "tentative",
              },
            },
          ],
        },
        {
          ...template,
          id: mixedResubmitted ? chainedRejectedId : crypto.randomUUID(),
          origin: "correction",
          status: mixedResubmitted ? "pending_review" : "draft",
          parent_request_id: mixedId,
          items: [
            {
              ...templateItem,
              id: crypto.randomUUID(),
              op: "add",
              capability: secondCap.capability,
              target_claim_id: null,
              decision: null,
              decision_reason: null,
              after: {
                statement: "混合自动草稿陈述",
                level: "routine",
                assessment_status: "tentative",
              },
            },
          ],
        },
        {
          ...template,
          id: chainedLatestDraftId,
          origin: "correction",
          status: "draft",
          parent_request_id: chainedRejectedId,
          items: [
            {
              ...templateItem,
              id: crypto.randomUUID(),
              op: "add",
              capability: secondCap.capability,
              target_claim_id: null,
              decision: null,
              decision_reason: null,
              after: {
                statement: "链式最新草稿",
                level: "routine",
                assessment_status: "tentative",
              },
            },
          ],
        },
      )
      await route.fulfill({
        json: { count: extra.length, data: extra },
      })
    },
  )

  await page.route(`**/appeals/${appealId}`, (route) =>
    route.fulfill({
      json: {
        id: appealId,
        request_id: mixedId,
        item_id: crypto.randomUUID(),
        employee_id: crypto.randomUUID(),
        reason: "历史申诉原因",
        status: "upheld",
        created_at: "2026-11-01T00:00:00Z",
        resolved_at: "2026-11-02T00:00:00Z",
        resolution_note: "历史裁决说明",
      },
    }),
  )

  await page.route("**/me/requests", async (route) => {
    if (route.request().method() === "POST") {
      createdDrafts.push(route.request().postDataJSON())
      createdSaved = true
      await route.fulfill({
        status: 201,
        json: {
          id: createdDraftId,
          revision: 1,
          status: "draft",
          parent_request_id: rejectedId,
          items: [],
        },
      })
      return
    }
    await route.continue()
  })

  await page.route("**/me/requests/*/items", async (route) => {
    const id = route.request().url().split("/me/requests/")[1].split("/")[0]
    updatedDraftIds.push(id)
    await route.fulfill({
      json: { id, revision: 2, status: "draft", items: [] },
    })
  })

  await page.route("**/me/requests/*/preview", (route) =>
    route.fulfill({
      json: {
        request_id: mixedId,
        revision: 2,
        policy_version: 1,
        requires_manager: true,
        partial_auto_publish: false,
        reviewers: [],
        items: [],
      },
    }),
  )

  await logInUser(page, "employee.platform@demo.example.com", password)
  await page.getByRole("link", { name: "组织", exact: true }).click()
  await page.locator("summary", { hasText: /^已处理请求/ }).click()

  // 1. First manual save from rejected card creates linked draft; second click reuses it.
  const rejectedCard = page.locator(`[id="request-${rejectedId}"]`)
  await rejectedCard
    .getByRole("button", { name: "修改重提", exact: true })
    .click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "保存草稿", exact: true }).click()
  await expect(dialog.getByRole("status")).toHaveText("草稿已保存")
  await dialog.getByRole("button", { name: "关闭", exact: true }).click()
  expect(createdDrafts).toHaveLength(1)

  await rejectedCard
    .getByRole("button", { name: "修改重提", exact: true })
    .click()
  await expect(
    dialog.getByRole("textbox", { name: "能力说明", exact: true }),
  ).toHaveValue("首次手动保存的重提陈述")
  await dialog.getByRole("button", { name: "保存草稿", exact: true }).click()
  await expect(dialog.getByRole("status")).toHaveText("草稿已保存")
  expect(createdDrafts).toHaveLength(1)
  expect(updatedDraftIds).toEqual([createdDraftId])
  await dialog.getByRole("button", { name: "关闭", exact: true }).click()

  // 2. After submission, mixed card displays 「已重提」, hides 「修改重提」, keeps reason & appeal, and jumps to latest.
  const mixedCard = page.locator(`[id="request-${mixedId}"]`)
  await expect(
    mixedCard.getByRole("button", { name: "修改重提", exact: true }),
  ).toBeVisible()
  mixedResubmitted = true
  await page.reload()
  await page.locator("summary", { hasText: /^已处理请求/ }).click()

  await expect(mixedCard.getByText("已重提", { exact: true })).toBeVisible()
  await expect(
    mixedCard.getByRole("button", { name: "修改重提", exact: true }),
  ).toHaveCount(0)
  await expect(mixedCard).toContainText("原因：混合部分拒绝：补充证据")
  await expect(mixedCard).toContainText("申诉：维持原决定 · 历史裁决说明")

  await mixedCard
    .getByRole("button", { name: "查看最新一单", exact: true })
    .click()
  await expect(
    page.locator(`[id="request-${chainedLatestDraftId}"]`),
  ).toBeVisible()
})
