import { expect, type Page, test } from "@playwright/test"
import type { EmployeeAccount } from "../src/client"

test.use({
  viewport: { width: 1440, height: 900 },
  storageState: { cookies: [], origins: [] },
})

async function setAuth(page: Page, accessToken: string, orgId: string) {
  await page.goto("/login")
  await page.evaluate(
    ({ token, org }) => {
      localStorage.setItem("access_token", token)
      localStorage.setItem("current_org_id", org)
    },
    { token: accessToken, org: orgId },
  )
}

test("我的画像：助手与表单提交后即时刷新、待审批卡权限隔离、退回/拒绝理由、3/5级徽标", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000)
  const password = "synthetic-s2-password-2026"
  const tokenRes = await request.post("/api/v1/private/setup-tokens", {
    data: { purpose: "new_org" },
  })
  const initialized = await request.post("/api/v1/setup/initialize", {
    data: {
      token: (await tokenRes.json()).token,
      org_name: "S2画像体验合成企业",
      admin_username: `s2-admin-${crypto.randomUUID()}@example.com`,
      admin_password: password,
      admin_full_name: "合成管理员",
    },
  })
  expect(initialized.ok()).toBeTruthy()
  const admin = await initialized.json()
  const base = `/api/v1/orgs/${admin.org_id}`
  const adminHeaders = { Authorization: `Bearer ${admin.access_token}` }

  const rosterRes = await request.post(`${base}/roster/imports`, {
    headers: adminHeaders,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          `工号,姓名,部门,职位,上级工号,邮箱\nM,合成经理,研发部,经理,,m-${crypto.randomUUID()}@example.com\nE,合成员工,研发部,工程师,M,e-${crypto.randomUUID()}@example.com\n`,
        ),
      },
    },
  })
  const roster = await rosterRes.json()
  expect(
    (
      await request.post(`${base}/roster/imports/${roster.id}/apply`, {
        headers: adminHeaders,
        data: { base_revision: roster.base_revision },
      })
    ).ok(),
  ).toBeTruthy()

  expect(
    (
      await request.post(`${base}/capabilities/versions`, {
        headers: adminHeaders,
        data: {
          expected_version: 0,
          definitions: [
            {
              key: "backend_api",
              name: "后端接口开发",
              category: "工程能力",
              description: "设计与实现服务端接口",
              level_rubric: {
                levels: [
                  {
                    key: "needs_support",
                    label: "需要协助",
                    description: "在指导下完成接口开发",
                  },
                  {
                    key: "routine",
                    label: "能完成常规任务",
                    description: "独立完成常规接口开发",
                  },
                  {
                    key: "independent_complex",
                    label: "能独立完成复杂任务",
                    description: "独立攻克高并发与复杂接口",
                  },
                ],
              },
            },
            {
              key: "system_design",
              name: "系统架构设计",
              category: "工程能力",
              description: "负责系统拆分与架构演进",
              level_rubric: {
                levels: [
                  { key: "l1", label: "入门", description: "理解模块边界" },
                  { key: "l2", label: "基础", description: "能完成单模块设计" },
                  { key: "l3", label: "熟练", description: "能设计跨模块方案" },
                  { key: "l4", label: "精通", description: "能主导核心架构" },
                  {
                    key: "l5",
                    label: "专家",
                    description: "制定企业级架构标准",
                  },
                ],
              },
            },
            {
              key: "ungraded_skill",
              name: "文档沉淀",
              category: "工程能力",
              description: "编写技术文档",
              level_rubric: {
                levels: [
                  {
                    key: "basic",
                    label: "基础",
                    description: "能编写常规文档",
                  },
                ],
              },
            },
          ],
        },
      })
    ).ok(),
  ).toBeTruthy()

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
  const subject = accounts.find((a) => a.employee_code === "E")!
  const manager = accounts.find((a) => a.employee_code === "M")!

  expect(
    (
      await request.post(`${base}/role-grants`, {
        headers: adminHeaders,
        data: {
          user_id: manager.account!.user_id,
          role: "dept_manager",
          department_id: manager.department!.id,
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
    const login = await (
      await request.post("/api/v1/login/access-token", {
        form: { username: reset.username, password: reset.initial_password },
      })
    ).json()
    return (
      await (
        await request.patch("/api/v1/users/me/password", {
          headers: { Authorization: `Bearer ${login.access_token}` },
          data: {
            current_password: reset.initial_password,
            new_password: password,
          },
        })
      ).json()
    ).access_token as string
  }

  const ownerToken = await activateAccount(subject)
  const managerToken = await activateAccount(manager)
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}` }
  const managerHeaders = { Authorization: `Bearer ${managerToken}` }

  // Publish initial backend_api (L1) and ungraded_skill (ungraded) via direct edit by manager.
  expect(
    (
      await request.post(
        `${base}/employees/${subject.id}/profile/direct-edits`,
        {
          headers: managerHeaders,
          data: {
            base_revision: null,
            items: [
              {
                capability_key: "backend_api",
                op: "add",
                statement: "已发布的初始后端陈述",
                level: "needs_support",
              },
              {
                capability_key: "ungraded_skill",
                op: "add",
                statement: "已发布的未定级文档陈述",
                level: null,
              },
            ],
          },
        },
      )
    ).ok(),
  ).toBeTruthy()

  // Step 1: Employee visits 我的画像 first (priming cache), verifies 3-level L1 badge and ungraded gray badge.
  await setAuth(page, ownerToken, admin.org_id)
  await page.goto(`/employees/${subject.id}`)
  const backendCard = page.getByRole("article", {
    name: "后端接口开发",
    exact: true,
  })
  await expect(backendCard).toContainText("已发布的初始后端陈述")
  await expect(backendCard.getByText("L1", { exact: true })).toBeVisible()
  await expect(backendCard.getByText("需要协助", { exact: true })).toBeVisible()
  const ungradedCard = page.getByRole("article", {
    name: "文档沉淀",
    exact: true,
  })
  await expect(ungradedCard.getByText("未定级", { exact: true })).toBeVisible()

  // Step 2: Navigate to AI 助手 without reloading, confirm a bot preview card, then navigate back to 我的画像.
  const assistantDraft = await (
    await request.post(`${base}/me/requests`, {
      headers: ownerHeaders,
      data: {
        items: [
          {
            op: "modify",
            capability_key: "backend_api",
            statement: "助手提交的后端新陈述",
            level: "routine",
          },
          {
            op: "add",
            capability_key: "system_design",
            statement: "助手新增的架构设计陈述",
            level: "l4",
          },
        ],
      },
    })
  ).json()
  const previewPayload = await (
    await request.get(`${base}/me/requests/${assistantDraft.id}/preview`, {
      headers: ownerHeaders,
    })
  ).json()

  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: /^协同/ })
    .click()
  await expect(page).toHaveURL(/\/assistant/)
  await page.route("**/bot/sessions/*/turns?*", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({
        type: "final",
        response: {
          messages: [
            {
              type: "preview_card",
              ...previewPayload,
              actions: [
                {
                  action: "confirm_submit",
                  request_id: assistantDraft.id,
                  revision: assistantDraft.revision,
                  base_revision: previewPayload.base_revision,
                  policy_version: previewPayload.policy_version,
                },
                {
                  action: "continue_editing",
                  request_id: assistantDraft.id,
                  revision: assistantDraft.revision,
                },
              ],
            },
          ],
        },
      })}\n`,
    }),
  )
  await page.route("**/bot/sessions/*/actions?*", async (route) => {
    const payload = route.request().postDataJSON() as {
      request_id: string
      revision: number
      base_revision?: string | null
      policy_version?: number | null
    }
    const submitRes = await request.post(
      `${base}/me/requests/${payload.request_id}/submit`,
      {
        headers: ownerHeaders,
        data: {
          revision: payload.revision,
          base_revision: payload.base_revision ?? null,
          policy_version: payload.policy_version ?? null,
        },
      },
    )
    expect(submitRes.ok()).toBeTruthy()
    const submitted = await submitRes.json()
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            type: "status_card",
            ...submitted,
            actions: [
              {
                action: "withdraw",
                request_id: submitted.id,
                revision: submitted.revision,
              },
            ],
          },
        ],
      }),
    })
  })
  const panel = page.getByRole("region", { name: "助手", exact: true })
  await panel.getByLabel("发给助手的消息").fill("帮我修改后端和新增系统架构")
  await panel.getByRole("button", { name: "发送", exact: true }).click()
  await expect(panel.getByRole("region", { name: "变更预览" })).toBeVisible()
  await panel.getByRole("button", { name: "确认提交", exact: true }).click()
  await expect(panel.getByText("已提交审批，经理审批前可撤回。")).toBeVisible()

  // Navigate back to 我的画像 via sidebar without reload -> must immediately reflect pending changes.
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: /^组织/ })
    .click()
  await expect(page).toHaveURL(new RegExp(`/employees/${subject.id}`))

  await expect(backendCard).toContainText("已发布的初始后端陈述")
  await expect(backendCard).toContainText("待审批")
  await expect(backendCard).toContainText("助手提交的后端新陈述")
  await expect(backendCard.getByText("L1", { exact: true })).toBeVisible()
  await expect(backendCard.getByText("L2", { exact: true })).toBeVisible()

  const designCard = page.getByRole("article", {
    name: "系统架构设计",
    exact: true,
  })
  await expect(designCard).toBeVisible()
  await expect(designCard).toContainText("待审批")
  await expect(designCard).toContainText("助手新增的架构设计陈述")
  await expect(designCard.getByText("L4", { exact: true })).toBeVisible()
  await expect(designCard.getByText("精通", { exact: true })).toBeVisible()
  // Ensure 暂定 is NOT used for pending candidate cards.
  await expect(designCard.getByText("暂定", { exact: true })).toHaveCount(0)

  await page.screenshot({
    path: testInfo.outputPath("my-profile-pending-desktop.png"),
    animations: "disabled",
    fullPage: true,
  })

  // Jump from card to corresponding request, then withdraw via form and verify immediate refresh.
  await backendCard
    .getByRole("button", { name: "查看请求", exact: true })
    .click()
  const requestEl = page.locator(`[id="request-${assistantDraft.id}"]`)
  await expect(requestEl).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await requestEl.getByRole("button", { name: "撤回", exact: true }).click()
  await expect(backendCard.getByText("待审批")).toHaveCount(0)
  await expect(designCard).toHaveCount(0)

  // Step 3: Form submit -> immediate refresh without reload.
  await page.getByRole("button", { name: "添加能力", exact: true }).click()
  const picker = page.getByRole("dialog")
  await picker
    .getByRole("button", { name: "系统架构设计", exact: true })
    .click()
  await page.getByRole("button", { name: "手动编辑", exact: true }).click()
  const editor = page.getByRole("dialog")
  await editor
    .getByRole("textbox", { name: "能力说明", exact: true })
    .fill("表单提交的架构设计陈述")
  await editor.getByLabel("等级").selectOption("l5")
  await editor.getByRole("button", { name: "预览并提交", exact: true }).click()
  await editor.getByRole("button", { name: "确认提交", exact: true }).click()
  await expect(editor).toBeHidden()
  await expect(designCard).toContainText("表单提交的架构设计陈述")
  await expect(designCard.getByText("L5", { exact: true })).toBeVisible()
  await expect(designCard.getByText("专家", { exact: true })).toBeVisible()

  // Step 4: Non-managing org_admin MUST NOT see pending candidate card or unpublished statement/level on profile.
  const adminProfileRes = await request.get(
    `${base}/employees/${subject.id}/profile`,
    { headers: adminHeaders },
  )
  expect(adminProfileRes.ok()).toBeTruthy()
  const adminProfileJson = (await adminProfileRes.json()) as {
    items: { pending_change: unknown; latest_review: unknown }[]
  }
  expect(adminProfileJson.items.every((i) => !i.pending_change)).toBeTruthy()
  expect(adminProfileJson.items.every((i) => !i.latest_review)).toBeTruthy()

  await setAuth(page, admin.access_token, admin.org_id)
  await page.goto(`/employees/${subject.id}`)
  await expect(backendCard).toContainText("已发布的初始后端陈述")
  await expect(page.locator("body")).not.toContainText("表单提交的架构设计陈述")
  await expect(page.locator("body")).not.toContainText("待审批")
  await expect(
    page.locator("article").getByText("专家", { exact: true }),
  ).toHaveCount(0)
  await expect(
    page.locator("article").getByText("L5", { exact: true }),
  ).toHaveCount(0)

  // Step 5: Managing manager sees pending card AND reviews on 经理审批页 (with L1/L5 badges) and returns/rejects.
  await setAuth(page, managerToken, admin.org_id)
  await page.goto(`/employees/${subject.id}`)
  await expect(designCard).toContainText("表单提交的架构设计陈述")
  await expect(designCard.getByText("L5", { exact: true })).toBeVisible()

  // Withdraw that request and submit a 2-item request so manager can return one & reject one.
  const openReqs = await (
    await request.get(`${base}/me/requests`, { headers: ownerHeaders })
  ).json()
  for (const r of openReqs.data) {
    if (r.status === "pending_review") {
      await request.post(`${base}/me/requests/${r.id}/withdraw`, {
        headers: ownerHeaders,
      })
    }
  }
  const reviewDraft = await (
    await request.post(`${base}/me/requests`, {
      headers: ownerHeaders,
      data: {
        items: [
          {
            op: "modify",
            capability_key: "backend_api",
            statement: "第二次提交的后端陈述",
            level: "independent_complex",
          },
          {
            op: "add",
            capability_key: "system_design",
            statement: "第二次提交的架构陈述",
            level: "l3",
          },
        ],
      },
    })
  ).json()
  expect(
    (
      await request.post(`${base}/me/requests/${reviewDraft.id}/submit`, {
        headers: ownerHeaders,
        data: { revision: reviewDraft.revision },
      })
    ).ok(),
  ).toBeTruthy()

  await page.goto(`/reviews/${reviewDraft.id}`)
  const reviewItems = page.getByRole("region", { name: "待审批变更项" })
  await expect(reviewItems.getByText("L1", { exact: true })).toBeVisible()
  await expect(reviewItems.getByText("L3", { exact: true })).toHaveCount(2)
  await page.screenshot({
    path: testInfo.outputPath("review-level-badges-desktop.png"),
    animations: "disabled",
    fullPage: true,
  })
  await page
    .getByRole("group", { name: "后端接口开发的审批意见" })
    .getByRole("button", { name: "拒绝", exact: true })
    .click()
  await page.getByLabel("后端接口开发的原因").fill("请补充接口吞吐量数据")
  await page
    .getByRole("group", { name: "系统架构设计的审批意见" })
    .getByRole("button", { name: "拒绝", exact: true })
    .click()
  await page.getByLabel("系统架构设计的原因").fill("暂无架构评审记录")
  await page.getByRole("button", { name: "提交审批", exact: true }).click()
  await page.getByRole("button", { name: "确认提交", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("审批已提交")

  // Employee checks detail drawer for rejected markers and manager reasons; published content stays intact.
  await setAuth(page, ownerToken, admin.org_id)
  await page.goto(`/employees/${subject.id}`)
  await expect(backendCard).toContainText("已发布的初始后端陈述")
  await expect(backendCard.getByText("L1", { exact: true })).toBeVisible()
  await expect(backendCard).toContainText("提交被拒绝")
  await backendCard
    .getByRole("button", { name: "后端接口开发", exact: true })
    .click()
  const detail = page.getByRole("dialog", { name: "后端接口开发", exact: true })
  await expect(detail).toContainText("提交被拒绝")
  await expect(detail).toContainText("经理理由：请补充接口吞吐量数据")
  await page.screenshot({
    path: testInfo.outputPath("capability-detail-returned-desktop.png"),
    animations: "disabled",
    fullPage: true,
  })
  await detail.getByRole("button", { name: "关闭", exact: true }).click()

  await expect(designCard).toContainText("提交被拒绝")
  await designCard
    .getByRole("button", { name: "系统架构设计", exact: true })
    .click()
  const designDetail = page.getByRole("dialog", {
    name: "系统架构设计",
    exact: true,
  })
  await expect(designDetail).toContainText("提交被拒绝")
  await expect(designDetail).toContainText("经理理由：暂无架构评审记录")
  await designDetail.getByRole("button", { name: "关闭", exact: true }).click()

  // Step 6: 员工总览 QuickPeek & 按能力找人 fallback render LevelBadge L1.
  await setAuth(page, managerToken, admin.org_id)
  await page.goto("/employees")
  await page.getByRole("cell", { name: "E", exact: true }).click()
  const quickPeek = page.getByRole("dialog", { name: "员工快速预览" })
  await expect(quickPeek.getByText("L1", { exact: true })).toBeVisible()
  await expect(quickPeek.getByText("需要协助", { exact: true })).toBeVisible()
  await quickPeek.getByRole("button", { name: "关闭", exact: true }).click()

  await page.route("**/bot/sessions?*", async (route) => {
    const response = await route.fetch()
    return route.fulfill({
      response,
      json: { ...(await response.json()), model_available: false },
    })
  })
  await page.goto("/find-people")
  const searchForm = page.getByRole("form", { name: "按能力找人（只读筛选）" })
  await searchForm
    .getByRole("combobox", { name: "能力（必选）" })
    .selectOption({ label: "后端接口开发" })
  await searchForm.getByRole("button", { name: "查找", exact: true }).click()
  const searchResults = page.getByRole("region", { name: "找人结果" })
  await expect(searchResults.getByText("L1", { exact: true })).toBeVisible()
  await expect(
    searchResults.getByText("需要协助", { exact: true }),
  ).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/employees/${subject.id}`)
  await expect(backendCard).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("my-profile-mobile.png"),
    animations: "disabled",
    fullPage: true,
  })
})
