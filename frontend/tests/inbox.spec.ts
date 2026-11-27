import { expect, test } from "@playwright/test"
import type { EmployeeAccount } from "../src/client"
import { expectChineseCopy } from "./utils/copy"
import { seedLegacyAcceptedDemand } from "./utils/legacyCapacity"
import { logInUser, logOutUser } from "./utils/user"

test.use({ storageState: { cookies: [], origins: [] } })
const username = "employee.algorithm@demo.example.com"
const password = process.env.DEMO_USER_PASSWORD!

test("employee answers a real question on mobile and updates unread count", async ({
  page,
  request,
}) => {
  const login = await request.post("/api/v1/login/access-token", {
    form: { username, password },
  })
  const headers = {
    Authorization: `Bearer ${(await login.json()).access_token}`,
  }
  const memberships = await request.get("/api/v1/me/memberships", { headers })
  const [membership] = await memberships.json()
  const base = `/api/v1/orgs/${membership.org.id}/me`
  const questions = await request.get(`${base}/questions`, { headers })
  const question = (await questions.json()).data[0]
  expect(question).toBeTruthy()
  const inbox = await request.get(`${base}/inbox`, { headers })
  const before = await inbox.json()
  await logInUser(page, "employee.platform@demo.example.com", password)
  await expect(page).toHaveURL("/assistant")
  await page.goto("/inbox")
  await expect(
    page
      .getByRole("complementary", { name: "消息列表" })
      .getByText("初始画像待确认", { exact: true }),
  ).toBeVisible()
  await logOutUser(page)
  await logInUser(page, username, password)
  await expect(page).toHaveURL("/assistant")
  await page.goto("/inbox")
  await expect(
    page.getByRole("link", {
      name: `收件箱 ${before.unread_count}`,
      exact: true,
    }),
  ).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  const row = page.getByRole("listitem").filter({ hasText: question.question })
  await row.getByRole("button").click()
  const detail = page.getByRole("region", { name: "消息详情" })
  const replies = detail
    .getByRole("group", { name: "快捷答复" })
    .getByRole("button")
  const answer = detail.getByLabel("你的回答")
  await expect(replies).toHaveCount(3)
  await replies.first().click()
  await expect(replies.first()).toHaveAttribute("aria-pressed", "true")
  await expect(answer).toBeFocused()
  await expect(answer).toHaveValue("情况属实，我独立负责了相关工作")
  await replies.nth(1).click()
  await expect(replies.first()).toHaveAttribute("aria-pressed", "false")
  await expect(answer).toHaveValue("仅参与协作支持，非主要负责人")
  const stillOpen = await request.get(`${base}/questions/${question.id}`, {
    headers,
  })
  expect((await stillOpen.json()).status).toBe("open")
  await answer.fill(
    "仅参与协作支持，非主要负责人。我完成了合成案例中的排查，并用回归测试验证结果。",
  )
  await expect(replies.nth(1)).toHaveAttribute("aria-pressed", "false")
  await detail.getByRole("button", { name: "提交回答", exact: true }).click()
  await expect(detail.getByRole("status")).toContainText(
    "已回答，已保存为受限自述证据",
  )
  await expect(answer).toHaveCount(0)
  await expect(
    page.getByRole("status").filter({ hasText: "条未读" }),
  ).toHaveText(
    `${before.unread_count - 1} 条未读 · ${before.pending_count - 1} 条待办`,
  )
  const answered = await request.get(`${base}/questions/${question.id}`, {
    headers,
  })
  const result = await answered.json()
  expect(result.status).toBe("answered")
  const evidence = await request.get(
    `/api/v1/orgs/${membership.org.id}/evidence/${result.answer_evidence_id}`,
    { headers },
  )
  const record = await evidence.json()
  expect(record.visibility).toBe("restricted")
  expect(record.content.text).toContain("回归测试")
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()
  await expectChineseCopy(page)
  await page.screenshot({
    path: "test-results/inbox-mobile.png",
    fullPage: true,
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(
    page.getByRole("link", {
      name:
        before.unread_count > 1
          ? `收件箱 ${before.unread_count - 1}`
          : "收件箱",
      exact: true,
    }),
  ).toBeVisible()
})

test("without todos home opens assistant; empty inbox and errors are readable", async ({
  page,
}) => {
  await page.route("**/me/inbox?*", (route) =>
    route.fulfill({
      json: {
        data: [],
        count: 0,
        total_count: 0,
        unread_count: 0,
        pending_count: 0,
        filtered_unread_count: 0,
      },
    }),
  )
  await logInUser(page, username, password)
  await expect(page).toHaveURL("/assistant")
  await page.getByRole("link", { name: "收件箱", exact: true }).click()
  await expect(page.getByText("暂无消息")).toBeVisible()
  await page.route("**/me/inbox?*", (route) =>
    route.fulfill({ status: 500, json: { detail: "合成故障" } }),
  )
  await page.reload()
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "重试", exact: true }),
  ).toBeVisible()
})

test("inbox filters across pages, marks matching unread and keeps the last-page answer visible", async ({
  page,
}) => {
  const otherTodos = Array.from({ length: 20 }, (_, index) => ({
    id: `todo-${index}`,
    kind: "initial_review",
    message: `合成初始画像待办 ${index}`,
  }))
  const rows = [
    {
      id: "task",
      question_id: "task",
      kind: "question",
      message: "合成待确认通知",
    },
    ...otherTodos,
    ...Array.from({ length: 24 }, (_, index) => ({
      id: `notice-${index}`,
      kind: "profile_edited",
      message: `合成画像通知 ${index}`,
    })),
    { id: "read", kind: "profile_edited", message: "已读画像通知" },
  ].reverse()
  const read = new Set(["read", ...otherTodos.map((row) => row.id)])
  let answered = false
  const timestamp = new Date().toISOString()
  await page.route("**/me/inbox?*", (route) => {
    const params = new URL(route.request().url()).searchParams
    const skip = Number(params.get("skip"))
    const limit = Number(params.get("limit"))
    const kind = params.get("kind")
    const matches = rows.filter(
      (row) =>
        (!kind || row.kind === kind) &&
        (params.get("pending_only") !== "true" ||
          row.kind === "initial_review" ||
          (row.id === "task" && !answered)) &&
        (params.get("unread_only") !== "true" || !read.has(row.id)),
    )
    return route.fulfill({
      json: {
        count: matches.length,
        total_count: rows.length,
        unread_count: rows.length - read.size,
        pending_count: otherTodos.length + (answered ? 0 : 1),
        filtered_unread_count: matches.filter((row) => !read.has(row.id))
          .length,
        data: matches.slice(skip, skip + limit).map((row) => ({
          ...row,
          created_at: timestamp,
          read_at: read.has(row.id) ? timestamp : null,
          done_at: row.id === "task" && answered ? timestamp : null,
        })),
      },
    })
  })
  await page.route("**/me/inbox/read-all", (route) => {
    const filters = route.request().postDataJSON()
    expect(filters).toEqual({
      pending_only: false,
      unread_only: true,
      kind: "profile_edited",
    })
    for (const row of rows) {
      if (row.kind === filters.kind) read.add(row.id)
    }
    return route.fulfill({ json: { updated_count: 24 } })
  })
  await page.route("**/me/inbox/*/read", (route) => {
    const parts = route.request().url().split("/")
    const id = parts[parts.length - 2] ?? ""
    read.add(id)
    const row = rows.find((entry) => entry.id === id)
    return route.fulfill({
      json: {
        ...row,
        created_at: timestamp,
        read_at: timestamp,
        done_at: row?.id === "task" && answered ? timestamp : null,
      },
    })
  })
  await page.route("**/me/questions/task", (route) =>
    route.fulfill({
      json: { reason: "核对合成任务", status: answered ? "answered" : "open" },
    }),
  )
  await page.route("**/me/questions/task/answer", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      answer: "我补充了合成任务的分工。",
    })
    answered = true
    read.add("task")
    return route.fulfill({ json: { status: "answered" } })
  })
  await logInUser(page, username, password)
  await page.goto("/inbox")
  const list = page.getByRole("complementary", { name: "消息列表" })
  await expect(list.getByRole("listitem")).toHaveCount(20)
  await expect(list.getByText("合成待确认通知")).toHaveCount(0)
  await list.getByRole("button", { name: /^待办/ }).click()
  const pagination = list.getByRole("navigation", { name: "收件箱分页" })
  await expect(pagination).toContainText("第 1 页 · 共 21 条")
  await expect(list.getByRole("listitem")).toHaveCount(20)
  await expect(list.getByRole("button", { name: /^全部/ })).toHaveText("全部46")
  await list.getByRole("button", { name: /^全部/ }).click()
  await expect(page.getByRole("button", { name: "全部标为已读" })).toBeEnabled()
  await list.getByRole("button", { name: "筛选" }).click()
  await page.getByRole("menuitemradio", { name: "画像已更新" }).click()
  await expect(
    list.getByRole("navigation", { name: "收件箱分页" }),
  ).toContainText("第 1 页 · 共 25 条")
  await list.getByRole("button", { name: "筛选" }).click()
  await page.getByRole("menuitemcheckbox", { name: "仅看未读" }).click()
  await expect(pagination).toContainText("第 1 页 · 共 24 条")
  await pagination.getByRole("button", { name: "下一页" }).click()
  await expect(pagination).toContainText("第 2 页 · 共 24 条")
  await expect(list.getByRole("listitem")).toHaveCount(4)
  const firstPage = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname.endsWith("/me/inbox") &&
      url.searchParams.get("skip") === "0" &&
      url.searchParams.get("unread_only") === "true" &&
      url.searchParams.get("kind") === "profile_edited"
    )
  })
  const markFiltered = page.getByRole("button", { name: "当前筛选标为已读" })
  await expect(markFiltered).toHaveAttribute(
    "title",
    "标记所有符合当前筛选条件的未读消息",
  )
  await markFiltered.click()
  await firstPage
  const counts = page.getByRole("status").filter({ hasText: "条未读" })
  await expect(counts).toHaveText("1 条未读 · 21 条待办")
  expect(read.has("task")).toBe(false)
  await expect(markFiltered).toBeDisabled()
  await expect(list.getByRole("listitem")).toHaveCount(0)
  await page.reload()
  await list.getByRole("button", { name: /^待办/ }).click()
  await pagination.getByRole("button", { name: "下一页" }).click()
  await expect(pagination).toContainText("第 2 页 · 共 21 条")
  await expect(list.getByRole("listitem")).toHaveCount(1)
  await page.setViewportSize({ width: 390, height: 844 })
  await list.getByRole("button", { name: /合成待确认通知/ }).click()
  const detail = page.getByRole("region", { name: "消息详情" })
  await detail.getByLabel("你的回答").fill("我补充了合成任务的分工。")
  const refreshedTodos = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname.endsWith("/me/inbox") &&
      url.searchParams.get("skip") === "0" &&
      url.searchParams.get("pending_only") === "true"
    )
  })
  await detail.getByRole("button", { name: "提交回答" }).click()
  await refreshedTodos
  await expect(counts).toHaveText("0 条未读 · 20 条待办")
  const success = detail.getByRole("status")
  await expect(success).toHaveText("已回答，已保存为受限自述证据")
  await expect(success).toBeVisible()
  await page.getByRole("button", { name: "返回消息列表" }).click()
  await expect(list.getByRole("listitem")).toHaveCount(20)
  await expect(list.getByText("合成待确认通知")).toHaveCount(0)
  await expect(success).toHaveCount(0)
})

test("legacy collaboration notices link to the matching workspace", async ({
  page,
}) => {
  const notices = [
    ["收到新的协作需求", "/reviews?type=demand"],
    ["协作需求收到追问", "/reviews?type=demand"],
    ["协作需求已收到答复", "/capacity?tab=outgoing"],
  ]
  await page.route("**/me/inbox?*", (route) =>
    route.fulfill({
      json: {
        data: notices.map(([message], index) => ({
          id: String(index),
          kind: "capacity",
          message,
          created_at: "2026-11-22T00:00:00Z",
          read_at: "2026-11-22T00:00:00Z",
          done_at: null,
        })),
        count: notices.length,
        total_count: notices.length,
        unread_count: 0,
        pending_count: 0,
        filtered_unread_count: 0,
      },
    }),
  )
  await logInUser(page, username, password)
  await page.goto("/inbox")
  const detail = page.getByRole("region", { name: "消息详情" })
  for (const [title, href] of notices) {
    await page
      .getByRole("listitem")
      .filter({ hasText: title })
      .getByRole("button")
      .click()
    await expect(
      detail.getByRole("link", { name: "查看详情" }),
    ).toHaveAttribute("href", href)
  }
})

test("approval result notifications mark read immediately and display details directly in inbox", async ({
  page,
  request,
}) => {
  test.setTimeout(120000)
  const syntheticPassword = "synthetic-inbox-password-2026"
  const token = await request.post("/api/v1/private/setup-tokens", {
    data: { purpose: "new_org" },
  })
  const adminEmail = `inbox-admin-${crypto.randomUUID()}@example.com`
  const initialized = await request.post("/api/v1/setup/initialize", {
    data: {
      token: (await token.json()).token,
      org_name: "合成收件箱企业",
      admin_username: adminEmail,
      admin_password: syntheticPassword,
      admin_full_name: "合成管理员",
    },
  })
  expect(initialized.ok()).toBeTruthy()
  const admin = await initialized.json()
  const base = `/api/v1/orgs/${admin.org_id}`
  const adminHeaders = { Authorization: `Bearer ${admin.access_token}` }

  const mgrEmail = `inbox-mgr-${crypto.randomUUID()}@example.com`
  const empEmail = `inbox-emp-${crypto.randomUUID()}@example.com`
  const reqEmail = `inbox-req-${crypto.randomUUID()}@example.com`
  const roster = await request.post(`${base}/roster/imports`, {
    headers: adminHeaders,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          `工号,姓名,部门,职位,上级工号,邮箱\nA,合成需求方,客户部,需求方,,${reqEmail}\nM,合成经理,研发部,经理,,${mgrEmail}\nE,合成员工,研发部,工程师,M,${empEmail}\n`,
        ),
      },
    },
  })
  const preview = await roster.json()
  await request.post(`${base}/roster/imports/${preview.id}/apply`, {
    headers: adminHeaders,
    data: { base_revision: preview.base_revision },
  })

  await request.post(`${base}/capabilities/versions`, {
    headers: adminHeaders,
    data: {
      expected_version: 0,
      definitions: [
        {
          key: "skill_mod",
          name: "后端架构",
          category: "技术",
          description: "服务端架构能力",
          level_rubric: {
            levels: [
              { key: "l1", label: "L1 了解", description: "了解基础" },
              { key: "l2", label: "L2 熟练", description: "独立负责" },
            ],
          },
        },
        {
          key: "skill_add",
          name: "技术带教",
          category: "协同",
          description: "团队带教能力",
          level_rubric: {
            levels: [
              { key: "l1", label: "L1 了解", description: "参与带教" },
              { key: "l2", label: "L2 熟练", description: "主导带教" },
            ],
          },
        },
      ],
    },
  })

  expect(
    (
      await request.post(`${base}/accounts/issue`, {
        headers: adminHeaders,
        data: {},
      })
    ).ok(),
  ).toBeTruthy()
  const accounts: EmployeeAccount[] = (
    await (
      await request.get(`${base}/accounts`, { headers: adminHeaders })
    ).json()
  ).data
  const empRow = accounts.find((value) => value.employee_code === "E")!
  const mgrRow = accounts.find((value) => value.employee_code === "M")!
  const reqRow = accounts.find((value) => value.employee_code === "A")!
  expect(
    (
      await request.post(`${base}/role-grants`, {
        headers: adminHeaders,
        data: {
          user_id: mgrRow.account!.user_id,
          role: "dept_manager",
          department_id: mgrRow.department!.id,
        },
      })
    ).ok(),
  ).toBeTruthy()

  const activateAccount = async (account: EmployeeAccount) => {
    const reset = await (
      await request.post(
        `${base}/accounts/${account.account!.user_id}/reset-password`,
        { headers: adminHeaders },
      )
    ).json()
    const tokenRes = await (
      await request.post("/api/v1/login/access-token", {
        form: { username: reset.username, password: reset.initial_password },
      })
    ).json()
    await request.patch("/api/v1/users/me/password", {
      headers: { Authorization: `Bearer ${tokenRes.access_token}` },
      data: {
        current_password: reset.initial_password,
        new_password: syntheticPassword,
      },
    })
    const finalLogin = await (
      await request.post("/api/v1/login/access-token", {
        form: { username: reset.username, password: syntheticPassword },
      })
    ).json()
    return { Authorization: `Bearer ${finalLogin.access_token}` }
  }

  const empHeaders = await activateAccount(empRow)
  const mgrHeaders = await activateAccount(mgrRow)
  const reqHeaders = await activateAccount(reqRow)

  // Seed an existing claim via direct edit so modify has a real "before" state.
  await request.post(`${base}/employees/${empRow.id}/profile/direct-edits`, {
    headers: mgrHeaders,
    data: {
      items: [
        {
          op: "add",
          capability_key: "skill_mod",
          level: "l1",
          statement: "能够编写基础接口并完成单测",
        },
      ],
    },
  })

  // Employee submits mixed request (modify + add).
  const draft = await (
    await request.post(`${base}/me/requests`, {
      headers: empHeaders,
      data: {
        items: [
          {
            op: "modify",
            capability_key: "skill_mod",
            level: "l2",
            statement: "主导核心网关重构并保障线上稳定",
          },
          {
            op: "add",
            capability_key: "skill_add",
            level: "l2",
            statement: "带教新人完成两个季度交付",
          },
        ],
      },
    })
  ).json()
  const submitted = await (
    await request.post(`${base}/me/requests/${draft.id}/submit`, {
      headers: empHeaders,
      data: { revision: draft.revision },
    })
  ).json()

  // Manager approves one and returns the other with explicit reasons.
  await request.post(`${base}/reviews/${submitted.id}/decisions`, {
    headers: mgrHeaders,
    data: {
      revision: submitted.revision,
      comment: "网关能力达标，带教部分请补充材料",
      decisions: [
        {
          item_id: submitted.items.find(
            (i: { capability: { key: string } }) =>
              i.capability.key === "skill_mod",
          ).id,
          decision: "approved",
          reason: "线上架构表现稳定，同意升级为熟练",
        },
        {
          item_id: submitted.items.find(
            (i: { capability: { key: string } }) =>
              i.capability.key === "skill_add",
          ).id,
          decision: "rejected",
          reason: "请补充带教周报或评审记录",
        },
      ],
    },
  })

  // Also test workload & extension approval results in inbox.
  expect(
    (
      await request.put(`${base}/capacity-settings`, {
        headers: adminHeaders,
        data: { enabled: true, requester_policy: "everyone" },
      })
    ).ok(),
  ).toBeTruthy()
  const myWorkload = await (
    await request.get(`${base}/capacity/workloads/me`, { headers: empHeaders })
  ).json()
  const mondayStr: string = myWorkload.weeks[0].week_start
  const monday = new Date(`${mondayStr}T00:00:00Z`)
  const windowEnd = new Date(monday.getTime() + 14 * 86400000)
    .toISOString()
    .slice(0, 10)
  expect(
    (
      await request.put(`${base}/capacity/weeks`, {
        headers: mgrHeaders,
        data: {
          start_week: mondayStr,
          end_week: windowEnd,
          items: [{ employee_id: empRow.id, other_percent: 25 }],
        },
      })
    ).ok(),
  ).toBeTruthy()
  const wlReqRes = await request.post(
    `${base}/capacity/workloads/me/requests`,
    {
      headers: empHeaders,
      data: {
        requested_percent: 60,
        reason: "本周配合重点版本发布",
        start_week: mondayStr,
        end_week: mondayStr,
      },
    },
  )
  expect(wlReqRes.ok(), await wlReqRes.text()).toBeTruthy()
  const wlReq = await wlReqRes.json()
  expect(
    (
      await request.post(
        `${base}/capacity/workload-requests/${wlReq.id}/decision`,
        {
          headers: mgrHeaders,
          data: { approve: true, note: "发布周同意调整负荷上限" },
        },
      )
    ).ok(),
  ).toBeTruthy()

  const demandRes = await request.post(`${base}/capacity/demands`, {
    headers: reqHeaders,
    data: {
      requesting_department_id: reqRow.department!.id,
      target_department_id: empRow.department!.id,
      capability_key: "skill_mod",
      headcount: 1,
      allocation_percent: 30,
      window_start: mondayStr,
      window_end: windowEnd,
      description: "核心架构支持",
    },
  })
  expect(demandRes.ok(), await demandRes.text()).toBeTruthy()
  const demand = await demandRes.json()
  const replyRes = await request.post(
    `${base}/capacity/demands/${demand.id}/reply`,
    {
      headers: mgrHeaders,
      data: {
        revision: demand.revision,
        outcome: "can_do",
        start_date: mondayStr,
        end_date: windowEnd,
        text: "可以承接",
      },
    },
  )
  expect(replyRes.ok(), await replyRes.text()).toBeTruthy()
  await seedLegacyAcceptedDemand(
    request,
    admin.org_id,
    demand.id,
    admin.access_token,
  )
  const dueBefore = new Date(monday.getTime() + 7 * 86400000)
    .toISOString()
    .slice(0, 10)
  const dueAfter = new Date(monday.getTime() + 14 * 86400000)
    .toISOString()
    .slice(0, 10)
  const assignmentRes = await request.post(
    `${base}/capacity/demands/${demand.id}/assignments`,
    {
      headers: mgrHeaders,
      data: {
        employee_id: empRow.id,
        allocation_percent: 30,
        start_date: mondayStr,
        due_date: dueBefore,
      },
    },
  )
  expect(assignmentRes.ok(), await assignmentRes.text()).toBeTruthy()
  const assignment = await assignmentRes.json()
  const extReqRes = await request.post(
    `${base}/capacity/assignments/${assignment.id}/extension-requests`,
    {
      headers: empHeaders,
      data: {
        requested_due_date: dueAfter,
        reason: "等待接口联调确认",
      },
    },
  )
  expect(extReqRes.ok(), await extReqRes.text()).toBeTruthy()
  const extReq = await extReqRes.json()
  expect(
    (
      await request.post(
        `${base}/capacity/extension-requests/${extReq.id}/decision`,
        {
          headers: mgrHeaders,
          data: { approve: false, note: "请先完成内部自测后再申请延期" },
        },
      )
    ).ok(),
  ).toBeTruthy()

  await logInUser(page, empEmail, syntheticPassword)
  await page.goto("/inbox")
  const detail = page.getByRole("region", { name: "消息详情" })
  const empInboxBefore = await (
    await request.get(`${base}/me/inbox`, { headers: empHeaders })
  ).json()
  const initialUnread: number = empInboxBefore.unread_count
  await expect(
    page.getByRole("link", {
      name: `收件箱 ${initialUnread}`,
      exact: true,
    }),
  ).toBeVisible()

  // 1) Open profile approval result notification
  const decidedRow = page
    .getByRole("listitem")
    .filter({ hasText: "画像请求已完成审批" })
    .first()
  await expect(decidedRow.getByText("未读", { exact: true })).toBeVisible()
  await decidedRow.getByRole("button").click()
  await expect(decidedRow.getByText("未读", { exact: true })).toHaveCount(0)
  await expect(
    page.getByRole("link", {
      name: `收件箱 ${initialUnread - 1}`,
      exact: true,
    }),
  ).toBeVisible()

  await expect(detail).toContainText("后端架构")
  await expect(detail).toContainText("能够编写基础接口并完成单测")
  await expect(detail).toContainText("主导核心网关重构并保障线上稳定")
  await expect(detail).toContainText("线上架构表现稳定，同意升级为熟练")
  await expect(detail).toContainText("技术带教")
  await expect(detail).toContainText("带教新人完成两个季度交付")
  await expect(detail).toContainText("请补充带教周报或评审记录")
  await expect(detail).toContainText("网关能力达标，带教部分请补充材料")
  await expect(detail.getByRole("link", { name: "查看详情" })).toHaveAttribute(
    "href",
    `/employees/${empRow.id}`,
  )
  await expectChineseCopy(page)

  // 2) Open workload result notification
  const wlRow = page
    .getByRole("listitem")
    .filter({ hasText: "负荷调整申请已同意" })
    .first()
  await wlRow.getByRole("button").click()
  await expect(wlRow.getByText("未读", { exact: true })).toHaveCount(0)
  await expect(detail).toContainText("改前 25% → 改后 60%")
  await expect(detail).toContainText("本周配合重点版本发布")
  await expect(detail).toContainText("发布周同意调整负荷上限")
  await expect(detail.getByRole("link", { name: "查看详情" })).toHaveAttribute(
    "href",
    "/capacity",
  )

  // 3) Open extension result notification on mobile viewport
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "返回消息列表" }).click()
  const extRow = page
    .getByRole("listitem")
    .filter({ hasText: "延期申请已退回" })
    .first()
  await extRow.getByRole("button").click()
  await expect(extRow.getByText("未读", { exact: true })).toHaveCount(0)
  await expect(detail).toContainText("后端架构")
  await expect(detail).toContainText(
    `原完成日期 ${dueBefore} → 申请延至 ${dueAfter}`,
  )
  await expect(detail).toContainText("等待接口联调确认")
  await expect(detail).toContainText("请先完成内部自测后再申请延期")
  await expect(detail.getByRole("link", { name: "查看详情" })).toHaveAttribute(
    "href",
    "/capacity",
  )
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()
  await page.setViewportSize({ width: 1280, height: 800 })

  // Verify read states and sidebar badge persisted on reload
  await page.reload()
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "画像请求已完成审批" })
      .first()
      .getByText("未读", { exact: true }),
  ).toHaveCount(0)
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "负荷调整申请已同意" })
      .first()
      .getByText("未读", { exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("link", {
      name: `收件箱 ${initialUnread - 3}`,
      exact: true,
    }),
  ).toBeVisible()
})

test("summary-only inbox detail renders notification summary and read state when profile detail is hidden", async ({
  page,
}) => {
  const timestamp = "2026-11-23T01:00:00Z"
  let read = false
  const summaryItem = () => ({
    id: "summary-only-notice",
    kind: "review_requested",
    request_id: "00000000-0000-0000-0000-000000000123",
    question_id: null,
    workload_request_id: null,
    extension_request_id: null,
    message: "有新的画像请求待审批",
    created_at: timestamp,
    read_at: read ? timestamp : null,
    done_at: null,
  })
  await page.route("**/me/inbox?*", (route) =>
    route.fulfill({
      json: {
        data: [summaryItem()],
        count: 1,
        total_count: 1,
        unread_count: read ? 0 : 1,
        pending_count: 1,
        filtered_unread_count: read ? 0 : 1,
      },
    }),
  )
  await page.route("**/me/inbox/summary-only-notice/read", (route) => {
    read = true
    return route.fulfill({ json: summaryItem() })
  })
  await page.route("**/me/inbox/summary-only-notice", (route) =>
    route.fulfill({
      json: {
        item: summaryItem(),
        profile_request: null,
        workload_request: null,
        extension_request: null,
      },
    }),
  )

  await logInUser(page, username, password)
  await page.goto("/inbox")

  const row = page
    .getByRole("listitem")
    .filter({ hasText: "有新的画像请求待审批" })
  await expect(row.getByText("未读", { exact: true })).toBeVisible()
  await row.getByRole("button").click()
  await expect(row.getByText("未读", { exact: true })).toHaveCount(0)

  const detail = page.getByRole("region", { name: "消息详情" })
  await expect(
    detail.getByRole("heading", { name: "有新的画像请求待审批" }),
  ).toBeVisible()
  await expect(detail).toContainText("当前权限仅显示通知摘要")
  await expect(detail.getByRole("link", { name: "查看并审批" })).toHaveCount(0)
  await expectChineseCopy(page)

  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy()
})
