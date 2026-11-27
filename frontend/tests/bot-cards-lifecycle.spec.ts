import { expect, test } from "@playwright/test"
import { createUser } from "./utils/privateApi"
import { logInUser, logOutUser } from "./utils/user"

test.use({ storageState: { cookies: [], origins: [] } })

for (const width of [1440, 390]) {
  test(`thinking indicator, single card in-place update, and aligned 409 alert at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const email = `cards-lifecycle-${width}-${crypto.randomUUID()}@example.com`
    const password = "synthetic-password-2026"
    await createUser({ email, password, withEmptyProfile: true })
    await logInUser(page, email, password)

    const requestId = crypto.randomUUID()
    const previewCard = {
      type: "preview_card",
      request_id: requestId,
      revision: 1,
      policy_version: 0,
      items: [
        {
          before: {
            id: crypto.randomUUID(),
            statement: "原陈述",
            level: "routine",
            level_name: "能完成常规任务",
            assessment_status: "confirmed",
            confidence: "medium",
            explanation: null,
            generated_by: { actor_type: "system" },
            evidence: [],
          },
          after: {
            id: crypto.randomUUID(),
            op: "modify",
            capability: {
              key: "solution_arch",
              name: "解决方案架构与售前演示",
            },
            after: {
              statement: "新陈述",
              level: "advanced",
              level_name: "能独立完成复杂任务",
              assessment_status: "tentative",
            },
            explanation: null,
            uncertainty: null,
            owner_statement: null,
            objection: null,
            decision: null,
          },
          warning: null,
          submission_notice: "提交后需经理确认",
        },
      ],
      reviewers: [{ name: "林疏影", role: "直属上级" }],
      requires_manager: true,
      partial_auto_publish: false,
      actions: [
        {
          action: "confirm_submit",
          request_id: requestId,
          revision: 1,
          policy_version: 0,
        },
        {
          action: "continue_editing",
          request_id: requestId,
          revision: 1,
        },
      ],
    }
    const statusPending = {
      type: "status_card",
      id: requestId,
      revision: 2,
      status: "pending_review",
      items: [
        {
          op: "modify",
          capability: { key: "solution_arch", name: "解决方案架构与售前演示" },
          after: {
            statement: "新陈述",
            level: "advanced",
            level_name: "能独立完成复杂任务",
            assessment_status: "tentative",
          },
          explanation: null,
          uncertainty: null,
          owner_statement: null,
          objection: null,
          decision: null,
        },
      ],
      reviewers: [{ name: "林疏影", role: "直属上级" }],
      actions: [{ action: "withdraw", request_id: requestId, revision: 2 }],
    }
    const statusWithdrawn = {
      ...statusPending,
      revision: 3,
      status: "withdrawn",
      actions: [],
    }

    let phase: "initial" | "pending" | "withdrawn" | "stale" = "initial"
    await page.route("**/bot/sessions/*/messages?org_id=*", (route) =>
      route.fulfill({ json: [] }),
    )
    await page.route("**/bot/sessions/*/turns?org_id=*", async (route) => {
      await new Promise((r) => setTimeout(r, 300))
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({
          type: "final",
          response: {
            messages: [
              { type: "text", text: "请核对以下修改预览：" },
              previewCard,
            ],
            steps: [],
          },
        })}\n`,
      })
    })
    await page.route("**/bot/sessions/*/actions?org_id=*", async (route) => {
      const body = route.request().postDataJSON()
      if (phase === "stale") {
        await route.fulfill({
          status: 409,
          json: { detail: "内容已更新，请重新预览" },
        })
        return
      }
      if (body.action === "confirm_submit") {
        phase = "pending"
        await route.fulfill({ json: { messages: [statusPending], steps: [] } })
        return
      }
      phase = "withdrawn"
      await route.fulfill({ json: { messages: [statusWithdrawn], steps: [] } })
    })

    const panel = page.getByRole("region", { name: "助手", exact: true })
    await panel
      .getByLabel("发给助手的消息")
      .fill("帮我修改解决方案架构与售前演示")
    await panel.getByRole("button", { name: "发送", exact: true }).click()

    const thinking = panel.getByRole("status").filter({ hasText: "正在思考…" })
    await expect(thinking).toBeVisible()
    const listContainer = panel
      .locator('[data-role="user"]')
      .first()
      .locator("..")
    const thinkingBox = await thinking.boundingBox()
    const listBox = await listContainer.boundingBox()
    await page.screenshot({
      path: testInfo.outputPath(`thinking-alignment-${width}.png`),
      animations: "disabled",
    })
    expect(Math.abs(thinkingBox!.x - listBox!.x)).toBeLessThanOrEqual(4)

    await expect(panel.getByRole("region", { name: "变更预览" })).toHaveCount(1)
    await panel.getByRole("button", { name: "确认提交", exact: true }).click()
    await expect(
      panel.getByRole("heading", { name: "变更预览 · 已提交", exact: true }),
    ).toBeVisible()
    await expect(panel.getByRole("region")).toHaveCount(1)
    await expect(
      panel.getByRole("button", { name: "撤回", exact: true }),
    ).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath(`in-place-submitted-${width}.png`),
      animations: "disabled",
    })

    await panel.getByRole("button", { name: "撤回", exact: true }).click()
    await expect(
      panel.getByRole("heading", { name: "变更预览 · 已撤回", exact: true }),
    ).toBeVisible()
    await expect(panel.getByRole("region")).toHaveCount(1)
    await expect(
      panel.getByRole("button", { name: "撤回", exact: true }),
    ).toHaveCount(0)

    // Trigger a 409 stale alert and verify alignment with message container
    phase = "stale"
    await panel.getByLabel("发给助手的消息").fill("再次修改")
    await panel.getByRole("button", { name: "发送", exact: true }).click()
    await panel
      .getByRole("button", { name: "确认提交", exact: true })
      .last()
      .click()
    const alertBox = await panel
      .getByRole("alert")
      .filter({ hasText: "内容已更新" })
      .boundingBox()
    const rePreviewBtn = panel.getByRole("button", { name: "重新预览" })
    const btnBox = await rePreviewBtn.boundingBox()
    await page.screenshot({
      path: testInfo.outputPath(`stale-alert-alignment-${width}.png`),
      animations: "disabled",
    })
    expect(Math.abs(alertBox!.x - listBox!.x)).toBeLessThanOrEqual(4)
    expect(Math.abs(btnBox!.x - listBox!.x)).toBeLessThanOrEqual(4)
  })
}

test("manager review card remains confirmed after logout and re-login", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const password = "synthetic-review-password-2026"
  const token = await request.post("/api/v1/private/setup-tokens", {
    data: { purpose: "new_org" },
  })
  const initialized = await request.post("/api/v1/setup/initialize", {
    data: {
      token: (await token.json()).token,
      org_name: "审批持久化合成企业",
      admin_username: `review-persist-${crypto.randomUUID()}@example.com`,
      admin_password: password,
      admin_full_name: "合成管理员",
    },
  })
  expect(initialized.ok()).toBeTruthy()
  const admin = await initialized.json()
  const base = `/api/v1/orgs/${admin.org_id}`
  const headers = { Authorization: `Bearer ${admin.access_token}` }
  const roster = await request.post(`${base}/roster/imports`, {
    headers,
    multipart: {
      file: {
        name: "roster.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          `工号,姓名,部门,职位,上级工号,邮箱\nM,林疏影,研发部,经理,,manager-${crypto.randomUUID()}@example.com\nE,陈凯文,研发部,工程师,M,employee-${crypto.randomUUID()}@example.com\n`,
        ),
      },
    },
  })
  const preview = await roster.json()
  await request.post(`${base}/roster/imports/${preview.id}/apply`, {
    headers,
    data: { base_revision: preview.base_revision },
  })
  await request.post(`${base}/capabilities/versions`, {
    headers,
    data: {
      expected_version: 0,
      definitions: [
        {
          key: "skill_1",
          name: "需求澄清",
          category: "合成能力",
          description: "审批测试",
          level_rubric: {
            levels: [
              { key: "routine", label: "独立完成", description: "能独立完成" },
            ],
          },
        },
      ],
    },
  })
  await request.post(`${base}/accounts/issue`, { headers, data: {} })
  const accounts = (
    await (await request.get(`${base}/accounts`, { headers })).json()
  ).data
  const subject = accounts.find(
    (v: { employee_code: string }) => v.employee_code === "E",
  )
  const manager = accounts.find(
    (v: { employee_code: string }) => v.employee_code === "M",
  )
  await request.post(`${base}/role-grants`, {
    headers,
    data: {
      user_id: manager.account.user_id,
      role: "dept_manager",
      department_id: manager.department.id,
    },
  })
  const setPassword = async (account: {
    account: { user_id: string; username: string }
  }) => {
    const reset = await (
      await request.post(
        `${base}/accounts/${account.account.user_id}/reset-password`,
        {
          headers,
        },
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
    ).access_token
  }
  const ownerToken = await setPassword(subject)
  await setPassword(manager)
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}` }
  const draft = await (
    await request.post(`${base}/me/requests`, {
      headers: ownerHeaders,
      data: {
        items: [
          {
            op: "add",
            capability_key: "skill_1",
            statement: "独立完成需求澄清",
            level: "routine",
          },
        ],
      },
    })
  ).json()
  await request.post(`${base}/me/requests/${draft.id}/submit`, {
    headers: ownerHeaders,
    data: { revision: draft.revision },
  })

  const { createServer } = await import("node:http")
  const { networkInterfaces } = await import("node:os")
  const server = createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const last = body.messages.at(-1)
    const toolName = last.role === "tool" ? last.tool_call_id : null
    const result = toolName ? JSON.parse(last.content) : null
    const name = !toolName
      ? "list_pending_reviews"
      : toolName === "list_pending_reviews"
        ? "get_review"
        : "prepare_review_decision"
    const args =
      name === "list_pending_reviews"
        ? {}
        : name === "get_review"
          ? { request_id: result.data[0].id }
          : {
              request_id: result.id,
              revision: result.revision,
              decisions: result.items.map(
                (item: { after: { id: string } }) => ({
                  item_id: item.after.id,
                  decision: "approved",
                }),
              ),
            }
    const done = toolName === "prepare_review_decision"
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(
      `data: ${JSON.stringify({ id: "review", object: "chat.completion.chunk", choices: [{ index: 0, delta: done ? { role: "assistant", content: "请核对决定" } : { role: "assistant", tool_calls: [{ index: 0, id: name, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing model address")
  const host =
    process.env.MODEL_TEST_HOST ??
    (baseURL?.includes("backend:")
      ? Object.values(networkInterfaces())
          .flat()
          .find((network) => network?.family === "IPv4" && !network.internal)
          ?.address
      : "localhost")
  try {
    await request.put(`${base}/model-setting`, {
      headers,
      data: {
        enabled: true,
        kind: "openai_compatible",
        provider: "openai-compatible",
        model: "synthetic",
        base_url: `http://${host}:${address.port}/v1`,
        api_key: "synthetic-key",
      },
    })
    await logInUser(page, manager.account.username, password)
    const panel = page.getByRole("region", { name: "助手", exact: true })
    await panel.getByLabel("发给助手的消息").fill("批准待审批请求")
    await panel.getByRole("button", { name: "发送", exact: true }).click()
    const card = panel.getByRole("region", { name: "审批决定确认" })
    await expect(card).toBeVisible()
    await card.getByRole("button", { name: "确认决定", exact: true }).click()
    await expect(
      card.getByText("审批决定已保存", { exact: false }),
    ).toBeVisible()
    await expect(
      card.getByRole("button", { name: "确认决定", exact: true }),
    ).toHaveCount(0)

    const sessionUrl = page.url()
    await logOutUser(page)
    await logInUser(page, manager.account.username, password)
    await page.goto(sessionUrl)
    const reloadedPanel = page.getByRole("region", {
      name: "助手",
      exact: true,
    })
    const reloadedCard = reloadedPanel.getByRole("region", {
      name: "审批决定确认",
    })
    await expect(reloadedCard).toBeVisible()
    await expect(
      reloadedCard.getByText("审批决定已保存", { exact: false }),
    ).toBeVisible()
    await expect(
      reloadedCard.getByRole("button", { name: "确认决定", exact: true }),
    ).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath("review-card-relogin-confirmed.png"),
      animations: "disabled",
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
