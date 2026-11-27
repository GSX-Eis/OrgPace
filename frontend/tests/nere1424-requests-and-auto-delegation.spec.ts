import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, type Page, type TestInfo, test } from "@playwright/test"
import type {
  AuditEventPublic,
  EmployeeAccount,
  InboxList,
} from "../src/client"
import { expectChineseCopy } from "./utils/copy"

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
})

async function captureDesktop(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const shot = await page.screenshot({ animations: "disabled" })
  await testInfo.attach(name, { body: shot, contentType: "image/png" })
  if (!process.env.CI) {
    const dir = path.join(tmpdir(), "nere1427-screenshots")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${name}.png`), shot)
  }
}

test("NERE-1424：紧凑卡片与红色被拒重提 + 组织架构多级上级自动代理审批端到端回归", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000)
  const password = "synthetic-nere1424-password-2026"
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
    if (response.status() === 204) return null
    return response.headers()["content-type"]?.includes("application/json")
      ? response.json()
      : null
  }

  const setup = await api("/api/v1/private/setup-tokens", {
    purpose: "new_org",
  })
  const admin = await api("/api/v1/setup/initialize", {
    token: setup.token,
    org_name: "合成协同验收企业",
    admin_username: `nere1424-${crypto.randomUUID()}@example.com`,
    admin_password: password,
    admin_full_name: "合成管理员",
  })
  const base = `/api/v1/orgs/${admin.org_id}`
  const adminHeaders = { Authorization: `Bearer ${admin.access_token}` }

  // 3-level hierarchy: 总公司(张总) -> 研发部(李总监) -> 后端组(王经理 -> 赵工)
  // Plus sibling branch: 总公司/市场部(陈经理) for cross-branch isolation check.
  const roster = await request.post(`${base}/roster/imports`, {
    headers: adminHeaders,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          [
            "工号,姓名,部门,职位,上级工号,邮箱",
            `G01,张总,总公司,总经理,,g01-${crypto.randomUUID()}@example.com`,
            `D01,李总监,总公司/研发部,研发总监,G01,d01-${crypto.randomUUID()}@example.com`,
            `M01,王经理,总公司/研发部/后端组,后端经理,D01,m01-${crypto.randomUUID()}@example.com`,
            `E01,赵工,总公司/研发部/后端组,后端工程师,M01,e01-${crypto.randomUUID()}@example.com`,
            `P01,陈经理,总公司/市场部,市场经理,G01,p01-${crypto.randomUUID()}@example.com`,
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
      definitions: [1, 2, 3, 4].map((num) => ({
        key: `skill_${num}`,
        name: `合成能力${num}`,
        category: "工程能力",
        description: `合成能力${num}描述`,
        level_rubric: {
          levels: [
            {
              key: "routine",
              label: "独立完成",
              description: "能独立承担并完成对应交付工作",
            },
          ],
        },
      })),
    },
    admin.access_token,
  )

  await api(`${base}/accounts/issue`, {}, admin.access_token)
  const accounts: EmployeeAccount[] = (
    await api(`${base}/accounts`, undefined, admin.access_token)
  ).data
  const person = (code: string) =>
    accounts.find((row) => row.employee_code === code)!

  const grants: Record<string, string> = {}
  for (const code of ["G01", "D01", "M01", "P01"]) {
    const grant = await api(
      `${base}/role-grants`,
      {
        user_id: person(code).account!.user_id,
        role: "dept_manager",
        department_id: person(code).department!.id,
      },
      admin.access_token,
    )
    grants[code] = grant.id
  }

  const tokens = new Map<string, string>()
  for (const code of ["G01", "D01", "M01", "E01", "P01"]) {
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
      {
        current_password: reset.initial_password,
        new_password: password,
      },
      (await login.json()).access_token,
      "PATCH",
    )
    tokens.set(code, changed.access_token)
  }

  const enter = async (accessToken: string, dest: string) => {
    await page.goto("/login")
    await page.evaluate(
      ({ token, orgId }) => {
        localStorage.setItem("access_token", token)
        localStorage.setItem("current_org_id", orgId)
      },
      { token: accessToken, orgId: admin.org_id },
    )
    await page.goto(dest)
  }

  const empToken = tokens.get("E01")!
  const mgrToken = tokens.get("M01")!
  const vpToken = tokens.get("D01")!
  const ceoToken = tokens.get("G01")!
  const peerToken = tokens.get("P01")!

  // Scenario 1 setup: pending request (skill_1), fully rejected request (skill_2),
  // mixed approved+rejected request (skill_3 approved, skill_4 rejected) + resolved historical appeal.
  const submitForEmp = async (
    items: Array<{
      capability_key: string
      statement: string
      owner_statement: string
    }>,
  ) => {
    const draft = await api(
      `${base}/me/requests`,
      {
        items: items.map((entry) => ({
          op: "add",
          level: "routine",
          ...entry,
        })),
      },
      empToken,
    )
    const submitted = await api(
      `${base}/me/requests/${draft.id}/submit`,
      { revision: draft.revision },
      empToken,
    )
    return { draft, submitted }
  }

  const { draft: pendingReq } = await submitForEmp([
    {
      capability_key: "skill_1",
      statement: "独立完成核心服务重构与性能优化",
      owner_statement: "主导完成核心链路延迟优化",
    },
  ])

  const { draft: rejectedReq, submitted: rejectedSub } = await submitForEmp([
    {
      capability_key: "skill_2",
      statement: "参与数据库分表方案评审",
      owner_statement: "参与了方案讨论会议",
    },
  ])
  await api(
    `${base}/reviews/${rejectedReq.id}/decisions`,
    {
      revision: rejectedSub.revision,
      decisions: [
        {
          item_id: rejectedReq.items[0].id,
          decision: "rejected",
          reason: "请补充具体的项目产出依据",
        },
      ],
    },
    mgrToken,
  )

  const { draft: mixedReq, submitted: mixedSub } = await submitForEmp([
    {
      capability_key: "skill_3",
      statement: "独立搭建自动化发布流水线",
      owner_statement: "已落地生产发布流程",
    },
    {
      capability_key: "skill_4",
      statement: "负责高并发缓存一致性治理",
      owner_statement: "协助排查过缓存问题",
    },
  ])
  await api(
    `${base}/reviews/${mixedReq.id}/decisions`,
    {
      revision: mixedSub.revision,
      decisions: [
        { item_id: mixedReq.items[0].id, decision: "approved" },
        {
          item_id: mixedReq.items[1].id,
          decision: "rejected",
          reason: "缺少独立交付与线上稳定性依据",
        },
      ],
    },
    mgrToken,
  )

  // Verify new appeal creation is disabled (410 Gone).
  const createAppealRes = await request.post(`${base}/appeals`, {
    headers: { Authorization: `Bearer ${empToken}` },
    data: {
      request_id: rejectedReq.id,
      item_id: rejectedReq.items[0].id,
      reason: "申请恢复申诉",
    },
  })
  expect(createAppealRes.status()).toBe(410)

  // Seed a historical appeal on mixedReq's rejected item and resolve it read-only.
  const legacyAppeal = await api(
    `/api/v1/private/orgs/${admin.org_id}/legacy-appeals`,
    {
      request_id: mixedReq.id,
      item_id: mixedReq.items[1].id,
      reason: "历史遗留申诉原因",
    },
    admin.access_token,
  )
  await api(
    `${base}/appeals/${legacyAppeal.id}/resolve`,
    {
      status: "upheld",
      reason: "历史维持原决定说明",
    },
    admin.access_token,
  )

  // Scenario 1 UI verification: compact multi-column cards, red rejected styling, no appeal button, resubmit.
  await enter(empToken, `/employees/${person("E01").id}`)
  await page.locator("summary", { hasText: /^其他待处理请求/ }).click()
  await page.locator("summary", { hasText: /^已处理请求/ }).click()

  const pendingRegion = page.getByRole("region", { name: "其他待处理请求" })
  const processedRegion = page.getByRole("region", { name: "已处理请求" })
  await expect(pendingRegion).toBeVisible()
  await expect(processedRegion).toBeVisible()

  const rejectedCard = page.locator(`[id="request-${rejectedReq.id}"]`)
  const mixedCard = page.locator(`[id="request-${mixedReq.id}"]`)
  await expect(rejectedCard).toBeVisible()
  await expect(mixedCard).toBeVisible()

  // Verify desktop multi-column compact card layout (two cards side-by-side).
  const rejectedBox = await rejectedCard.boundingBox()
  const mixedBox = await mixedCard.boundingBox()
  expect(rejectedBox).not.toBeNull()
  expect(mixedBox).not.toBeNull()
  expect(Math.abs(rejectedBox!.y - mixedBox!.y)).toBeLessThan(20)
  expect(Math.abs(rejectedBox!.x - mixedBox!.x)).toBeGreaterThan(200)

  // Verify red rejected card styling and reasons.
  await expect(rejectedCard).toHaveClass(/border-destructive\/40/)
  await expect(rejectedCard).toHaveClass(/bg-destructive\/5/)
  await expect(rejectedCard).toContainText("被拒绝 · 1 项改动")
  await expect(rejectedCard).toContainText("原因：请补充具体的项目产出依据")
  await expect(
    rejectedCard.getByRole("button", { name: "修改重提", exact: true }),
  ).toBeVisible()
  await expect(rejectedCard.getByRole("button", { name: /申诉/ })).toHaveCount(
    0,
  )

  // Verify mixed partial-rejection red item highlight and read-only historical appeal.
  await expect(mixedCard).toContainText("1 项批准、1 项被拒绝")
  await expect(mixedCard).toContainText("合成能力4：被拒绝")
  await expect(mixedCard).toContainText("原因：缺少独立交付与线上稳定性依据")
  await expect(mixedCard).toContainText("申诉：维持原决定 · 历史维持原决定说明")
  await expect(
    mixedCard.getByRole("button", { name: "修改重提", exact: true }),
  ).toBeVisible()
  await expect(mixedCard.getByRole("button", { name: /申诉/ })).toHaveCount(0)

  await expectChineseCopy(page)
  await rejectedCard.scrollIntoViewIfNeeded()
  await captureDesktop(page, testInfo, "01-my-profile-compact-rejected-cards")

  // Verify CapabilityDetailDialog has no appeal button and shows historical appeal read-only.
  await page
    .getByRole("article", { name: "合成能力4", exact: true })
    .getByRole("button", { name: "合成能力4", exact: true })
    .click()
  const capabilityDialog = page.getByRole("dialog", { name: "合成能力4" })
  await expect(capabilityDialog).toBeVisible()
  await expect(capabilityDialog).toContainText("提交被拒绝")
  await expect(capabilityDialog).toContainText(
    "经理理由：缺少独立交付与线上稳定性依据",
  )
  await expect(capabilityDialog).toContainText("历史申诉")
  await expect(capabilityDialog).toContainText(
    "申诉：维持原决定 · 历史维持原决定说明",
  )
  await expect(
    capabilityDialog.getByRole("button", { name: /申诉/ }),
  ).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(capabilityDialog).toBeHidden()

  // Resubmit via 「修改重提」 on the rejected card: reuse draft across repeated opens, then chain from latest.
  await rejectedCard
    .getByRole("button", { name: "修改重提", exact: true })
    .click()
  const editor = page.getByRole("dialog")
  await expect(editor).toBeVisible()
  await editor
    .getByRole("textbox", { name: "能力说明", exact: true })
    .fill("首次重提草稿陈述（待二次打开复用）")
  await editor.getByRole("button", { name: "保存草稿", exact: true }).click()
  await expect(editor.getByRole("status")).toHaveText("草稿已保存")
  await editor.getByRole("button", { name: "关闭", exact: true }).click()
  await expect(editor).toBeHidden()

  const empRequestsAfterSave = (
    await api(`${base}/me/requests`, undefined, empToken)
  ).data as Array<{
    id: string
    parent_request_id: string | null
    status: string
  }>
  expect(
    empRequestsAfterSave.filter(
      (row) =>
        row.parent_request_id === rejectedReq.id && row.status !== "withdrawn",
    ),
  ).toHaveLength(1)

  await rejectedCard
    .getByRole("button", { name: "修改重提", exact: true })
    .click()
  await expect(
    editor.getByRole("textbox", { name: "能力说明", exact: true }),
  ).toHaveValue("首次重提草稿陈述（待二次打开复用）")
  await editor
    .getByRole("textbox", { name: "能力说明", exact: true })
    .fill("独立完成核心订单库分库分表方案设计与压测落地")
  await editor
    .getByRole("textbox", { name: "补充说明", exact: true })
    .fill("已补充压测报告与上线验证结果")
  await editor.getByRole("button", { name: "预览并提交", exact: true }).click()
  await expect(editor).toContainText("王经理（直属上级）")
  await editor.getByRole("button", { name: "确认提交", exact: true }).click()
  await expect(editor).toBeHidden()

  const empRequests = (await api(`${base}/me/requests`, undefined, empToken))
    .data as Array<{
    id: string
    parent_request_id: string | null
    status: string
    revision: number
    items: Array<{ id: string }>
  }>
  const resubmitted1 = empRequests.find(
    (row) =>
      row.parent_request_id === rejectedReq.id &&
      row.status === "pending_review",
  )
  expect(resubmitted1).toBeTruthy()
  expect(
    empRequests.filter(
      (row) =>
        row.parent_request_id === rejectedReq.id && row.status !== "withdrawn",
    ),
  ).toHaveLength(1)
  await expect(rejectedCard.getByText("已重提", { exact: true })).toBeVisible()
  await expect(
    rejectedCard.getByRole("button", { name: "修改重提", exact: true }),
  ).toHaveCount(0)
  await expect(rejectedCard).toContainText("原因：请补充具体的项目产出依据")
  await expect(
    rejectedCard.getByRole("button", { name: "查看最新一单", exact: true }),
  ).toBeVisible()

  // Reject resubmitted1 so D-088 verifies continuing from the latest card while keeping original reason.
  await api(
    `${base}/reviews/${resubmitted1!.id}/decisions`,
    {
      revision: resubmitted1!.revision,
      decisions: [
        {
          item_id: resubmitted1!.items[0].id,
          decision: "rejected",
          reason: "二轮拒绝：请补充压测回滚预案",
        },
      ],
    },
    mgrToken,
  )
  await page.reload()
  await page.locator("summary", { hasText: /^已处理请求/ }).click()
  await expect(rejectedCard.getByText("已重提", { exact: true })).toBeVisible()
  await expect(
    rejectedCard.getByRole("button", { name: "修改重提", exact: true }),
  ).toHaveCount(0)
  await expect(rejectedCard).toContainText("原因：请补充具体的项目产出依据")
  await rejectedCard
    .getByRole("button", { name: "查看最新一单", exact: true })
    .click()
  const resubmitted1Card = page.locator(`[id="request-${resubmitted1!.id}"]`)
  await expect(resubmitted1Card).toBeVisible()
  await expect(resubmitted1Card).toContainText(
    "原因：二轮拒绝：请补充压测回滚预案",
  )
  await resubmitted1Card
    .getByRole("button", { name: "修改重提", exact: true })
    .click()
  await editor
    .getByRole("textbox", { name: "能力说明", exact: true })
    .fill("独立完成分库分表压测与回滚预案落地")
  await editor.getByRole("button", { name: "预览并提交", exact: true }).click()
  await editor.getByRole("button", { name: "确认提交", exact: true }).click()
  await expect(editor).toBeHidden()

  const empRequestsAfterChain = (
    await api(`${base}/me/requests`, undefined, empToken)
  ).data as Array<{
    id: string
    parent_request_id: string | null
    status: string
  }>
  const resubmitted = empRequestsAfterChain.find(
    (row) =>
      row.parent_request_id === resubmitted1!.id &&
      row.status === "pending_review",
  )
  expect(resubmitted).toBeTruthy()
  await expect(
    resubmitted1Card.getByText("已重提", { exact: true }),
  ).toBeVisible()
  await rejectedCard
    .getByRole("button", { name: "查看最新一单", exact: true })
    .click()
  await expect(page.locator(`[id="request-${resubmitted!.id}"]`)).toBeVisible()

  // Partial rejection (mixedReq) D-088: withdraw auto-draft to test manual-save draft reuse + 已重提 + appeal retention.
  const mixedAutoDraft = empRequestsAfterChain.find(
    (row) => row.parent_request_id === mixedReq.id && row.status === "draft",
  )
  expect(mixedAutoDraft).toBeTruthy()
  await api(`${base}/me/requests/${mixedAutoDraft!.id}/withdraw`, {}, empToken)
  await page.reload()
  await page.locator("summary", { hasText: /^已处理请求/ }).click()
  await mixedCard.getByRole("button", { name: "修改重提", exact: true }).click()
  await editor
    .getByRole("textbox", { name: "能力说明", exact: true })
    .fill("独立完成高并发缓存一致性治理改造")
  await editor.getByRole("button", { name: "保存草稿", exact: true }).click()
  await expect(editor.getByRole("status")).toHaveText("草稿已保存")
  await editor.getByRole("button", { name: "关闭", exact: true }).click()
  await expect(editor).toBeHidden()

  await mixedCard.getByRole("button", { name: "修改重提", exact: true }).click()
  await expect(
    editor.getByRole("textbox", { name: "能力说明", exact: true }),
  ).toHaveValue("独立完成高并发缓存一致性治理改造")
  await editor.getByRole("button", { name: "预览并提交", exact: true }).click()
  await editor.getByRole("button", { name: "确认提交", exact: true }).click()
  await expect(editor).toBeHidden()

  const empRequestsAfterMixed = (
    await api(`${base}/me/requests`, undefined, empToken)
  ).data as Array<{
    id: string
    parent_request_id: string | null
    status: string
  }>
  const mixedResubmitted = empRequestsAfterMixed.filter(
    (row) =>
      row.parent_request_id === mixedReq.id && row.status !== "withdrawn",
  )
  expect(mixedResubmitted).toHaveLength(1)
  expect(mixedResubmitted[0].status).toBe("pending_review")
  await expect(mixedCard.getByText("已重提", { exact: true })).toBeVisible()
  await expect(
    mixedCard.getByRole("button", { name: "修改重提", exact: true }),
  ).toHaveCount(0)
  await expect(mixedCard).toContainText("原因：缺少独立交付与线上稳定性依据")
  await expect(mixedCard).toContainText("申诉：维持原决定 · 历史维持原决定说明")
  await mixedCard
    .getByRole("button", { name: "查看最新一单", exact: true })
    .click()
  await expect(
    page.locator(`[id="request-${mixedResubmitted[0].id}"]`),
  ).toBeVisible()

  // Scenario 2a: Settings -> 偏好与代理 read-only auto-delegation view.
  await enter(mgrToken, "/settings?section=preferences")
  const delegationCard = page.getByRole("region", { name: "代理审批" })
  await expect(delegationCard).toContainText("代理审批已改为按组织架构自动设置")
  const autoList = page.getByRole("region", { name: "自动代审上级" })
  await expect(autoList).toContainText("李总监")
  await expect(autoList).toContainText("直属上级")
  await expect(autoList).toContainText("上级部门经理（研发部）")
  await expect(autoList).toContainText("张总")
  await expect(autoList).toContainText("汇报线上级")
  await expect(autoList).toContainText("上级部门经理（总公司）")
  await expect(page.getByLabel("代理人")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "保存代理", exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "撤销代理", exact: true }),
  ).toHaveCount(0)
  await expectChineseCopy(page)
  await captureDesktop(page, testInfo, "02-settings-auto-delegation-readonly")

  // Scenario 2b: Department manager cannot approve own request.
  const mgrDraft = await api(
    `${base}/me/requests`,
    {
      items: [
        {
          op: "add",
          capability_key: "skill_1",
          statement: "经理本人能力声明",
          level: "routine",
          owner_statement: "本人自述依据",
        },
      ],
    },
    mgrToken,
  )
  const mgrSubmitted = await api(
    `${base}/me/requests/${mgrDraft.id}/submit`,
    { revision: mgrDraft.revision },
    mgrToken,
  )
  const mgrOwnReviews = (await api(`${base}/reviews`, undefined, mgrToken))
    .data as Array<{ id: string }>
  expect(mgrOwnReviews.some((r) => r.id === mgrDraft.id)).toBeFalsy()
  const selfDecideRes = await request.post(
    `${base}/reviews/${mgrDraft.id}/decisions`,
    {
      headers: { Authorization: `Bearer ${mgrToken}` },
      data: {
        revision: mgrSubmitted.revision,
        decisions: [{ item_id: mgrDraft.items[0].id, decision: "approved" }],
      },
    },
  )
  expect(selfDecideRes.status()).toBe(403)

  // Scenario 2c: Cross-branch manager (市场部陈经理) cannot see or review 研发部/后端组 requests.
  const peerReviews = (await api(`${base}/reviews`, undefined, peerToken))
    .data as Array<{ id: string }>
  expect(peerReviews.some((r) => r.id === pendingReq.id)).toBeFalsy()
  const peerDetailRes = await request.get(`${base}/reviews/${pendingReq.id}`, {
    headers: { Authorization: `Bearer ${peerToken}` },
  })
  expect(peerDetailRes.status()).toBe(403)

  // Scenario 2d: Direct superior (李总监) & skip-level superior (张总) can see and act on 王经理's pending reviews.
  await enter(vpToken, "/reviews")
  await expect(
    page.locator(`a[href="/reviews/${pendingReq.id}"]`),
  ).toBeVisible()
  await expect(
    page.locator(`a[href="/reviews/${resubmitted!.id}"]`),
  ).toBeVisible()
  await page.locator(`a[href="/reviews/${pendingReq.id}"]`).click()
  await expect(page.getByText("代王经理审批", { exact: true })).toBeVisible()

  await enter(ceoToken, "/reviews")
  await expect(
    page.locator(`a[href="/reviews/${pendingReq.id}"]`),
  ).toBeVisible()
  await page.locator(`a[href="/reviews/${pendingReq.id}"]`).click()
  await expect(page.getByText("代王经理审批", { exact: true })).toBeVisible()
  await expectChineseCopy(page)
  await captureDesktop(page, testInfo, "03-superior-delegated-review")

  // Skip-level superior (张总) completes delegated approval.
  await page
    .getByRole("group", { name: "合成能力1的审批意见" })
    .getByRole("button", { name: "批准", exact: true })
    .click()
  await page.getByRole("button", { name: "提交审批" }).click()
  await page.getByRole("button", { name: "确认提交" }).click()
  await expect(page.getByRole("status")).toContainText("审批已提交")

  // Original reviewer (王经理) receives callback notification & audit records org_hierarchy delegation.
  const mgrInbox: InboxList = await api(`${base}/me/inbox`, undefined, mgrToken)
  expect(
    mgrInbox.data.some(
      (item) =>
        item.request_id === pendingReq.id &&
        item.message.includes("已由上级 张总 代为审批"),
    ),
  ).toBeTruthy()
  const audits: { data: AuditEventPublic[] } = await api(
    `${base}/audit-events?action=change_request.decided`,
    undefined,
    admin.access_token,
  )
  expect(
    audits.data.some(
      (event) =>
        event.target_id === pendingReq.id &&
        event.details?.acting_for_user_id === person("M01").account!.user_id &&
        event.details?.delegation_mode === "org_hierarchy",
    ),
  ).toBeTruthy()

  // Scenario 2e: Org change immediately revokes superior auto-delegation.
  await api(
    `${base}/role-grants/${grants.G01}`,
    undefined,
    admin.access_token,
    "DELETE",
  )
  const transferPreview = await api(
    `${base}/roster/single-change`,
    {
      kind: "transfer",
      employee_id: person("D01").id,
      department: "总公司/研发部",
      title: "研发总监",
      manager_id: null,
    },
    admin.access_token,
  )
  await api(
    `${base}/roster/imports/${transferPreview.id}/apply`,
    {
      base_revision: transferPreview.base_revision,
      confirm_mass_deactivation: true,
    },
    admin.access_token,
  )

  await enter(ceoToken, "/reviews")
  await expect(
    page.locator(`a[href="/reviews/${resubmitted!.id}"]`),
  ).toHaveCount(0)
  await page.goto(`/reviews/${resubmitted!.id}`)
  await expect(page.getByRole("alert")).toContainText(
    "该申请已处理、已撤回，或你没有审批权限",
  )

  // Direct superior (李总监) retains delegated access, and 王经理's settings card updates immediately.
  await enter(mgrToken, "/settings?section=preferences")
  await expect(autoList).toContainText("李总监")
  await expect(autoList).not.toContainText("张总")

  await enter(vpToken, "/reviews")
  await expect(
    page.locator(`a[href="/reviews/${resubmitted!.id}"]`),
  ).toBeVisible()
})

import type { APIRequestContext } from "@playwright/test"
import { seedLegacyAcceptedDemand } from "./utils/legacyCapacity"

type BootstrapOrgOptions = {
  orgName: string
  rosterRows: string[]
  managerCodes: string[]
  loginCodes: string[]
  capabilityKeys: string[]
}

async function bootstrapSyntheticOrg(
  page: Page,
  request: APIRequestContext,
  options: BootstrapOrgOptions,
) {
  const password = "synthetic-nere1434-password-2026"
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
    if (response.status() === 204) return null
    return response.headers()["content-type"]?.includes("application/json")
      ? response.json()
      : null
  }
  const setup = await api("/api/v1/private/setup-tokens", {
    purpose: "new_org",
  })
  const admin = await api("/api/v1/setup/initialize", {
    token: setup.token,
    org_name: options.orgName,
    admin_username: `nere1434-${crypto.randomUUID()}@example.com`,
    admin_password: password,
    admin_full_name: "合成管理员",
  })
  const base = `/api/v1/orgs/${admin.org_id}`
  const adminHeaders = { Authorization: `Bearer ${admin.access_token}` }
  const roster = await request.post(`${base}/roster/imports`, {
    headers: adminHeaders,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          ["工号,姓名,部门,职位,上级工号,邮箱", ...options.rosterRows].join(
            "\n",
          ),
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
  const definitions = options.capabilityKeys.map((key, idx) => ({
    key,
    name: `合成能力${idx + 1}`,
    category: "工程能力",
    description: `${key} 描述`,
    level_rubric: {
      levels: [
        {
          key: "routine",
          label: "独立完成",
          description: "能独立承担并完成对应交付工作",
        },
      ],
    },
  }))
  await api(
    `${base}/capabilities/versions`,
    { expected_version: 0, definitions },
    admin.access_token,
  )
  await api(`${base}/accounts/issue`, {}, admin.access_token)
  const accounts: EmployeeAccount[] = (
    await api(`${base}/accounts`, undefined, admin.access_token)
  ).data
  const person = (code: string) =>
    accounts.find((row) => row.employee_code === code)!
  for (const code of options.managerCodes) {
    await api(
      `${base}/role-grants`,
      {
        user_id: person(code).account!.user_id,
        role: "dept_manager",
        department_id: person(code).department!.id,
      },
      admin.access_token,
    )
  }
  const tokens = new Map<string, string>()
  for (const code of options.loginCodes) {
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
      {
        current_password: reset.initial_password,
        new_password: password,
      },
      (await login.json()).access_token,
      "PATCH",
    )
    tokens.set(code, changed.access_token)
  }
  const enter = async (accessToken: string, dest: string) => {
    await page.goto("/login")
    await page.evaluate(
      ({ token, orgId }) => {
        localStorage.setItem("access_token", token)
        localStorage.setItem("current_org_id", orgId)
      },
      { token: accessToken, orgId: admin.org_id },
    )
    await page.goto(dest)
  }
  return { admin, base, api, person, tokens, enter, definitions }
}

test("NERE-1434 D-086：延期代审回执与历史回执按当前权限展示，权限外仅收通用提醒", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const { admin, base, api, person, tokens, enter } =
    await bootstrapSyntheticOrg(page, request, {
      orgName: "合成D086延期回执企业",
      rosterRows: [
        `A01,客户经理,总公司/市场部,市场经理,,a01-${crypto.randomUUID()}@example.com`,
        `D01,李总监,总公司/研发部,研发总监,,d01-${crypto.randomUUID()}@example.com`,
        `M01,王经理,总公司/研发部/后端组,后端经理,D01,m01-${crypto.randomUUID()}@example.com`,
        `E01,赵工,总公司/研发部/后端组,后端工程师,M01,e01-${crypto.randomUUID()}@example.com`,
      ],
      managerCodes: ["A01", "D01", "M01"],
      loginCodes: ["A01", "D01", "M01", "E01"],
      capabilityKeys: ["delivery"],
    })
  const root = admin.access_token
  const aToken = tokens.get("A01")!
  const vpToken = tokens.get("D01")!
  const mgrToken = tokens.get("M01")!
  const empToken = tokens.get("E01")!

  await api(`${base}/capacity-settings`, { enabled: true }, root, "PUT")
  const demand = await api(
    `${base}/capacity/demands`,
    {
      requesting_department_id: person("A01").department!.id,
      target_department_id: person("D01").department!.id,
      capability_key: "delivery",
      headcount: 1,
      allocation_percent: 30,
      window_start: "2026-12-01",
      window_end: "2026-12-31",
      description: "合成D086协作需求",
    },
    aToken,
  )
  await api(
    `${base}/capacity/demands/${demand.id}/reply`,
    {
      revision: demand.revision,
      outcome: "can_do",
      start_date: "2026-12-01",
      end_date: "2026-12-31",
      text: "可以承接",
    },
    vpToken,
  )
  await seedLegacyAcceptedDemand(request, admin.org_id, demand.id, root)
  await api(
    `${base}/capacity/weeks`,
    {
      items: [{ employee_id: person("E01").id, other_percent: 0 }],
      start_week: "2026-11-30",
      end_week: "2027-01-04",
    },
    vpToken,
    "PUT",
  )
  const assignment = await api(
    `${base}/capacity/demands/${demand.id}/assignments`,
    {
      employee_id: person("E01").id,
      allocation_percent: 30,
      start_date: "2026-12-01",
      outside_basis: true,
      due_date: "2026-12-20",
    },
    vpToken,
  )

  // 1. Authorized original reviewer (M01 in 后端组 under 研发部) receives openable receipt.
  const ext1 = await api(
    `${base}/capacity/assignments/${assignment.id}/extension-requests`,
    { requested_due_date: "2026-12-22", reason: "D086_ALLOWED_REASON" },
    empToken,
  )
  await enter(vpToken, "/capacity?tab=approvals")
  await page
    .getByRole("region", { name: "延期审批" })
    .getByText("赵工 · 合成能力1", { exact: true })
    .click()
  const extForm = page.getByRole("form", { name: "赵工的延期申请" })
  await expect(extForm).toContainText("代 王经理 审批")
  await extForm.getByRole("button", { name: "同意延期" }).click()
  await expect(extForm).toHaveCount(0)

  await enter(mgrToken, "/inbox")
  const inboxList = page.getByRole("complementary", { name: "消息列表" })
  const allowedReceiptText =
    "员工 赵工 的延期申请（合成能力1，已同意）已由上级 李总监 代为审批"
  const allowedRow = inboxList
    .getByRole("listitem")
    .filter({ hasText: allowedReceiptText })
  await expect(allowedRow).toBeVisible()
  await allowedRow.getByRole("button").click()
  const detailRegion = page.getByRole("region", { name: "消息详情" })
  await expect(detailRegion).toContainText("合成能力1")
  await expect(detailRegion).toContainText("D086_ALLOWED_REASON")
  await expect(detailRegion).toContainText("2026-12-20 → 新完成日期 2026-12-22")

  const mgrInbox1: InboxList = await api(
    `${base}/me/inbox`,
    undefined,
    mgrToken,
  )
  const allowedReceipt = mgrInbox1.data.find(
    (item) => item.extension_request_id === ext1.id,
  )
  expect(allowedReceipt).toBeTruthy()
  const beforeExt2Ids = new Set(mgrInbox1.data.map((item) => item.id))

  // 2. Transfer M01 outside 研发部 (to 市场部) while keeping dept_manager on 后端组:
  //    historical receipt must now project to generic reminder and hide details.
  const moveOutPreview = await api(
    `${base}/roster/single-change`,
    {
      kind: "transfer",
      employee_id: person("M01").id,
      department: "总公司/市场部",
      title: "跨部门经理",
    },
    root,
  )
  await api(
    `${base}/roster/imports/${moveOutPreview.id}/apply`,
    { base_revision: moveOutPreview.base_revision },
    root,
  )

  await page.reload()
  const genericText =
    "一条延期申请已由上级代为审批，受承接部门可见范围限制，暂不展示详情"
  await expect(inboxList).not.toContainText("D086_ALLOWED_REASON")
  await expect(inboxList).not.toContainText("员工 赵工 的延期申请")
  await expect(inboxList.getByText(genericText, { exact: true })).toHaveCount(1)
  await inboxList
    .getByRole("listitem")
    .filter({ hasText: genericText })
    .getByRole("button")
    .click()
  await expect(detailRegion).toContainText(genericText)
  await expect(detailRegion).not.toContainText("D086_ALLOWED_REASON")
  await expect(detailRegion).not.toContainText("合成能力1")

  const revokedDetail = await api(
    `${base}/me/inbox/${allowedReceipt!.id}`,
    undefined,
    mgrToken,
  )
  expect(revokedDetail.item.extension_request_id).toBeNull()
  expect(revokedDetail.item.message).toBe(genericText)
  expect(revokedDetail.extension_request).toBeNull()

  // 3. New delegated decision while M01 is out of target dept scope sends only generic reminder.
  const ext2 = await api(
    `${base}/capacity/assignments/${assignment.id}/extension-requests`,
    { requested_due_date: "2026-12-25", reason: "D086_SECRET_REASON" },
    empToken,
  )
  await api(
    `${base}/capacity/extension-requests/${ext2.id}/decision`,
    { approve: false, note: "D086_SECRET_NOTE" },
    vpToken,
  )

  await page.reload()
  await expect(inboxList.getByText(genericText, { exact: true })).toHaveCount(2)
  await expect(inboxList).not.toContainText("赵工")
  await expect(inboxList).not.toContainText("D086_SECRET_REASON")

  const mgrInbox2: InboxList = await api(
    `${base}/me/inbox`,
    undefined,
    mgrToken,
  )
  const newItems = mgrInbox2.data.filter((item) => !beforeExt2Ids.has(item.id))
  expect(newItems).toHaveLength(1)
  expect(newItems[0].extension_request_id).toBeNull()
  expect(newItems[0].message).toBe(genericText)
  const newItemJson = JSON.stringify(newItems[0])
  for (const forbidden of [
    ext2.id,
    "赵工",
    "合成能力1",
    "D086_SECRET_REASON",
    "D086_SECRET_NOTE",
  ]) {
    expect(newItemJson).not.toContain(forbidden)
  }

  // 4. Restoring M01 back into 后端组 restores historical receipt detail for ext1, while unlinked ext2 stays generic.
  const moveBackPreview = await api(
    `${base}/roster/single-change`,
    {
      kind: "transfer",
      employee_id: person("M01").id,
      department: "总公司/研发部/后端组",
      title: "后端经理",
    },
    root,
  )
  await api(
    `${base}/roster/imports/${moveBackPreview.id}/apply`,
    { base_revision: moveBackPreview.base_revision },
    root,
  )
  await page.reload()
  await expect(allowedRow).toBeVisible()
  await allowedRow.getByRole("button").click()
  await expect(detailRegion).toContainText("D086_ALLOWED_REASON")
  await expect(inboxList.getByText(genericText, { exact: true })).toHaveCount(1)
})

test("NERE-1434 D-087：临时代审上级仅可见本单送审能力证据关联，完结或撤权后立即回收", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const { admin, base, api, person, tokens, enter, definitions } =
    await bootstrapSyntheticOrg(page, request, {
      orgName: "合成D087代审证据企业",
      rosterRows: [
        `D01,李总监,总公司/研发部,研发总监,,d01-${crypto.randomUUID()}@example.com`,
        `S01,周顾问,总公司/质控部,质控顾问,D01,s01-${crypto.randomUUID()}@example.com`,
        `M01,王经理,总公司/研发部/后端组,后端经理,S01,m01-${crypto.randomUUID()}@example.com`,
        `E01,赵工,总公司/研发部/后端组,后端工程师,M01,e01-${crypto.randomUUID()}@example.com`,
      ],
      managerCodes: ["D01", "M01"],
      loginCodes: ["S01", "M01", "E01"],
      capabilityKeys: ["skill_1", "skill_2", "skill_3"],
    })
  const root = admin.access_token
  const supToken = tokens.get("S01")!
  const mgrToken = tokens.get("M01")!
  const empToken = tokens.get("E01")!

  // Publish skill_1 and skill_3 in v1 sharing the same restricted self_report evidence.
  const init1 = await api(
    `${base}/me/requests`,
    {
      items: [
        {
          op: "add",
          capability_key: "skill_1",
          statement: "能力1初始陈述",
          level: "routine",
          owner_statement: "D087共享受限依据正文",
        },
      ],
    },
    empToken,
  )
  const sub1 = await api(
    `${base}/me/requests/${init1.id}/submit`,
    { revision: init1.revision },
    empToken,
  )
  await api(
    `${base}/reviews/${init1.id}/decisions`,
    {
      revision: sub1.revision,
      decisions: [{ item_id: init1.items[0].id, decision: "approved" }],
    },
    mgrToken,
  )

  const sharedEv = (
    await api(`${base}/me/evidence?kind=self_report`, undefined, empToken)
  ).data[0]
  expect(sharedEv).toBeTruthy()

  const init3 = await api(
    `${base}/me/requests`,
    {
      items: [
        {
          op: "add",
          capability_key: "skill_3",
          statement: "能力3初始陈述",
          level: "routine",
          evidence_ids: [sharedEv.id],
        },
      ],
    },
    empToken,
  )
  const sub3 = await api(
    `${base}/me/requests/${init3.id}/submit`,
    { revision: init3.revision },
    empToken,
  )
  await api(
    `${base}/reviews/${init3.id}/decisions`,
    {
      revision: sub3.revision,
      decisions: [{ item_id: init3.items[0].id, decision: "approved" }],
    },
    mgrToken,
  )

  // Bump dictionary to v2 and submit two pending requests sharing sharedEv (skill_1 & skill_3).
  await api(
    `${base}/capabilities/versions`,
    { expected_version: 1, definitions },
    root,
  )
  const submitWithSharedEv = async (
    op: "modify" | "add",
    capabilityKey: string,
    statement: string,
  ) => {
    const draft = await api(
      `${base}/me/requests`,
      {
        items: [
          {
            op,
            capability_key: capabilityKey,
            statement,
            level: "routine",
            evidence_ids: [sharedEv.id],
          },
        ],
      },
      empToken,
    )
    const submitted = await api(
      `${base}/me/requests/${draft.id}/submit`,
      { revision: draft.revision },
      empToken,
    )
    return {
      id: draft.id as string,
      revision: submitted.revision as number,
      itemId: draft.items[0].id as string,
    }
  }
  const req1 = await submitWithSharedEv(
    "modify",
    "skill_1",
    "换版后能力1更新陈述",
  )
  const req3 = await submitWithSharedEv(
    "modify",
    "skill_3",
    "换版后能力3更新陈述",
  )

  // 1. Pure reporting-line delegate (S01) sees only req1's capability in req1 drawer, and only req3's in req3 drawer.
  await enter(supToken, `/reviews/${req1.id}`)
  await expect(page.getByText("代王经理审批", { exact: true })).toBeVisible()
  const changesRegion = page.getByRole("region", { name: "待审批变更项" })
  await changesRegion.getByRole("button", { name: sharedEv.title }).click()
  const drawer = page.getByRole("dialog")
  await expect(drawer).toContainText("D087共享受限依据正文")
  await expect(drawer).toContainText("合成能力1 · 支持")
  await expect(drawer).not.toContainText("合成能力3")
  await drawer.getByRole("button", { name: "关闭", exact: true }).click()

  await page.goto(`/reviews/${req3.id}`)
  await changesRegion.getByRole("button", { name: sharedEv.title }).click()
  await expect(drawer).toContainText("D087共享受限依据正文")
  await expect(drawer).toContainText("合成能力3 · 支持")
  await expect(drawer).not.toContainText("合成能力1")
  await drawer.getByRole("button", { name: "关闭", exact: true }).click()

  // Routine manager M01 continues to see both linked claims.
  await enter(mgrToken, `/reviews/${req1.id}`)
  await changesRegion.getByRole("button", { name: sharedEv.title }).click()
  await expect(drawer).toContainText("合成能力1 · 支持")
  await expect(drawer).toContainText("合成能力3 · 支持")
  await drawer.getByRole("button", { name: "关闭", exact: true }).click()

  // 2. Approving req1 & req3 revokes S01's review/evidence access; pure ADD req2 reveals zero unrelated claims.
  for (const r of [req1, req3]) {
    await api(
      `${base}/reviews/${r.id}/decisions`,
      {
        revision: r.revision,
        decisions: [{ item_id: r.itemId, decision: "approved" }],
      },
      mgrToken,
    )
  }
  await enter(supToken, `/reviews/${req1.id}`)
  await expect(page.getByRole("alert")).toContainText(
    "该申请已处理、已撤回，或你没有审批权限",
  )
  const evAfterDone = await request.get(`${base}/evidence/${sharedEv.id}`, {
    headers: { Authorization: `Bearer ${supToken}` },
  })
  expect(evAfterDone.status()).toBe(404)

  const addReq = await submitWithSharedEv("add", "skill_2", "新增能力2共享依据")
  await page.goto(`/reviews/${addReq.id}`)
  await changesRegion.getByRole("button", { name: sharedEv.title }).click()
  await expect(drawer).toContainText("D087共享受限依据正文")
  await expect(drawer).toContainText("暂无引用。")
  await expect(drawer).not.toContainText("合成能力1")
  await expect(drawer).not.toContainText("合成能力3")
  await drawer.getByRole("button", { name: "关闭", exact: true }).click()

  // 3. Removing reporting line immediately revokes temporary review and evidence access.
  const detachPreview = await api(
    `${base}/roster/single-change`,
    {
      kind: "transfer",
      employee_id: person("M01").id,
      department: "总公司/研发部/后端组",
      title: "后端经理",
      manager_id: null,
    },
    root,
  )
  await api(
    `${base}/roster/imports/${detachPreview.id}/apply`,
    { base_revision: detachPreview.base_revision },
    root,
  )
  await page.goto(`/reviews/${addReq.id}`)
  await expect(page.getByRole("alert")).toContainText(
    "该申请已处理、已撤回，或你没有审批权限",
  )
  const evAfterDetach = await request.get(`${base}/evidence/${sharedEv.id}`, {
    headers: { Authorization: `Bearer ${supToken}` },
  })
  expect(evAfterDetach.status()).toBe(404)
})
