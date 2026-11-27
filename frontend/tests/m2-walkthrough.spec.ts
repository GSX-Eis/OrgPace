import { readFileSync } from "node:fs"
import path from "node:path"
import type { ChangeRequestsPublic, EvidenceList } from "../src/client"
import { configureModel, expect, test } from "./utils/model"
import { importRoster } from "./utils/roster"
import {
  activateTemplate,
  addDraftingEvidence,
  createSourcesOrg,
  saveCloud,
  syncJira,
} from "./utils/sources"
import { logOutUser } from "./utils/user"

test.use({ storageState: { cookies: [], origins: [] } })

test("M2: roster, Jira and PLM, identities, model, employee evidence", async ({
  page,
  modelUrl,
}, info) => {
  test.setTimeout(180000)
  await createSourcesOrg(page)
  await importRoster(
    page,
    Buffer.from(
      readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../examples/test-enterprises/qiguang-aiot/roster.csv",
        ),
        "utf8",
      ).replace(/@/g, `+${crypto.randomUUID()}@`),
    ),
  )
  await activateTemplate(page, "aiot-hardware")
  await page.goto("/admin/people?tab=accounts")
  await page.getByRole("button", { name: "发放账号", exact: true }).click()
  await page.getByRole("button", { name: "确认生成并下载" }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click()
  await page.goto("/admin/data-ai?tab=sources")
  await page
    .getByRole("button", { name: "配置 Jira Cloud", exact: true })
    .click()
  await saveCloud(
    page,
    process.env.JIRA_TEST_URL ?? "http://mock-jira:8080/qiguang-aiot",
    "jira-admin@example.com",
    "mock-cloud-token",
  )
  await syncJira(page)
  await page.getByRole("button", { name: "关闭", exact: true }).click()
  await page
    .getByRole("button", { name: "导入 CSV / Excel 工作记录", exact: true })
    .click()
  await page
    .getByLabel("选择工作记录文件")
    .setInputFiles(
      path.resolve(
        import.meta.dirname,
        "../../examples/test-enterprises/qiguang-aiot/work_records.csv",
      ),
    )
  await expect(page.getByText("文件导入：成功", { exact: true })).toBeVisible({
    timeout: 60000,
  })
  await page.screenshot({
    path: info.outputPath("sources.png"),
    animations: "disabled",
    fullPage: true,
  })
  await page.goto("/admin/people?tab=identities")
  await page.getByLabel("按来源筛选").selectOption("")
  await page
    .getByRole("checkbox", { name: /选择账号/ })
    .first()
    .waitFor()
  for (const box of await page
    .getByRole("checkbox", { name: /选择账号/ })
    .all()) {
    if (await box.isEnabled()) await box.check()
  }
  await page.getByRole("button", { name: /确认所选候选/ }).click()
  await expect(page.getByRole("status")).toContainText("已补充")
  await page.goto("/")
  await expect(page).toHaveURL(/\/assistant\?mode=admin&session=/)
  await page.getByRole("button", { name: "完成模型配置", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("模型")
  await configureModel(page, modelUrl)
  await page.getByRole("button", { name: "完成模型配置", exact: true }).click()
  await page.goto("/admin/rules?tab=approval")
  await expect(
    page.getByRole("link", { name: "审批规则", exact: true }),
  ).toHaveAttribute("aria-current", "page")
  await expect(page.getByLabel("默认需要经理审批")).toBeChecked()
  await expect(page.getByLabel("员工确认期限（天）")).toHaveValue("14")
  await page.goto("/admin/data-ai?tab=model")
  await addDraftingEvidence(page)
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "重新起草全部", exact: true }).click()
  await expect(
    page.getByText("已处理 26 人，已生成初稿 26 人，暂无内容 0 人。"),
  ).toBeVisible({ timeout: 60000 })
  const { base, headers } = await page.evaluate(() => ({
    base: `/api/v1/orgs/${localStorage.getItem("current_org_id")}`,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("access_token")}`,
    },
  }))
  const accounts = await (
    await page.request.get(`${base}/accounts?limit=100`, { headers })
  ).json()
  const account = accounts.data.find(
    (row: { employee_code: string }) => row.employee_code === "QG008",
  ).account
  const reset = await (
    await page.request.post(
      `${base}/accounts/${account.user_id}/reset-password`,
      { headers },
    )
  ).json()
  await logOutUser(page)
  await page.getByTestId("email-input").fill(account.username)
  await page.getByTestId("password-input").fill(reset.initial_password)
  await page.getByRole("button", { name: "登录", exact: true }).click()
  await expect(page).toHaveURL("/change-password")
  await page
    .getByLabel("当前密码", { exact: true })
    .fill(reset.initial_password)
  await page
    .getByLabel("新密码", { exact: true })
    .fill("synthetic-new-password-2026")
  await page
    .getByLabel("确认新密码", { exact: true })
    .fill("synthetic-new-password-2026")
  await page.getByRole("button", { name: "保存密码" }).click()
  await expect(page).toHaveURL("/assistant")
  await page.getByRole("link", { name: "组织", exact: true }).click()
  await page.locator("summary", { hasText: /待你确认：初始画像草稿/ }).click()
  await expect(
    page.getByRole("heading", { name: "待你确认：初始画像草稿" }),
  ).toBeVisible()
  const initialItem = page.getByRole("region", { name: /^草稿改动：/ }).first()
  await expect(initialItem.getByRole("heading")).toBeVisible()
  await expect(initialItem).toContainText("修改后：")
  await expect(initialItem.getByText("工作记录", { exact: false })).toHaveCount(
    0,
  )
  const employeeHeaders = await page.evaluate(() => ({
    Authorization: `Bearer ${localStorage.getItem("access_token")}`,
  }))
  const evidence = await page.request.get(
    `${base}/me/evidence?kind=work_record`,
    { headers: employeeHeaders },
  )
  expect(evidence.ok()).toBeTruthy()
  const records: EvidenceList = await evidence.json()
  expect(records.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "work_record",
        source: "jira",
        status: "active",
      }),
    ]),
  )
  await page.screenshot({
    path: info.outputPath("employee-profile.png"),
    animations: "disabled",
    fullPage: true,
  })
  const readRequests = async (): Promise<ChangeRequestsPublic["data"]> =>
    (
      await (
        await page.request.get(`${base}/me/requests?status=all`, {
          headers: employeeHeaders,
        })
      ).json()
    ).data
  const initial = (await readRequests()).find(
    (request) => request.origin === "initial_sync",
  )!
  const proposal = initial.items![0]
  const jira = records.data.find(
    (entry) =>
      entry.source === "jira" &&
      proposal.evidence?.some((ref) => ref.evidence_id === entry.id),
  )!
  expect(jira).toBeDefined()

  await page.setViewportSize({ width: 390, height: 844 })
  const checkWidth = async () =>
    expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(390)
  const editor = page.getByRole("dialog", { name: "更新我的画像" })
  const preview = page.getByRole("dialog", { name: "变更预览" })
  const evidenceSheet = page.getByRole("dialog", {
    name: jira.title,
    exact: true,
  })
  const checkJira = async () => {
    await expect(evidenceSheet).toContainText(jira.source_ref)
    await evidenceSheet
      .getByRole("button", { name: "关闭", exact: true })
      .click()
    await expect(evidenceSheet).toBeHidden()
  }

  await initialItem.getByRole("button", { name: "修改", exact: true }).click()
  await editor
    .getByRole("textbox", { name: /^补充说明/ })
    .fill("本人验证过分页边界")
  await editor.getByRole("button", { name: "预览并提交" }).click()
  await preview.getByRole("button", { name: "确认提交" }).click()

  const explanation = page.getByRole("region", { name: "画像说明" })
  await expect(explanation).toContainText("初始画像尚未发布，正在等待经理审批")
  await page.locator("summary", { hasText: /^其他待处理请求/ }).click()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "撤回", exact: true }).click()
  await expect(explanation).toContainText(
    "你已撤回初始画像请求，初始画像尚未发布",
  )
  await expect(explanation).not.toContainText("初始画像已由你确认")
  await expect(explanation).toContainText("可从原请求复制判断、等级和证据引用")
  await checkWidth()

  const directClone = explanation.getByRole("button", {
    name: "从原请求复制并编辑重提",
  })
  await directClone.click()
  await expect(editor.getByRole("textbox", { name: "能力说明" })).toHaveValue(
    proposal.after!.statement,
  )
  await editor.getByRole("button", { name: "关闭", exact: true }).click()
  await expect(editor).toBeHidden()
  expect(
    (await readRequests()).map(({ id, status }) => ({ id, status })),
  ).toEqual([{ id: initial.id, status: "withdrawn" }])

  await page.locator("summary", { hasText: /^已处理请求/ }).click()
  const processed = page.getByRole("region", { name: "已处理请求" })
  await expect(processed).toContainText("已撤回 · 1 项改动")
  await expect(
    processed.getByRole("heading", { name: proposal.capability.name }),
  ).toBeVisible()
  await expect(processed).toContainText(proposal.after!.statement)
  await processed.getByRole("button", { name: "展开全文" }).click()
  await processed.getByRole("button", { name: jira.title }).click()
  await checkJira()
  await checkWidth()
  await processed
    .getByRole("button", { name: "复制并编辑重提", exact: true })
    .click()
  await expect(editor.getByRole("combobox", { name: /^等级/ })).toHaveValue(
    proposal.after!.level!,
  )
  const notes = editor.getByRole("textbox", { name: /^补充说明/ })
  await expect(notes).toHaveValue("本人验证过分页边界")
  await expect(editor.getByRole("textbox", { name: "异议原因" })).toBeVisible()
  const selected = editor.getByRole("list", { name: "已选证据" })
  await expect(selected.getByRole("listitem")).toHaveCount(
    proposal.evidence!.length,
  )
  await selected
    .getByRole("listitem")
    .filter({ hasText: jira.title })
    .getByRole("button", { name: "查看", exact: true })
    .click()
  await checkJira()
  await expect(notes).toHaveValue("本人验证过分页边界")
  await checkWidth()

  await notes.fill("补充说明，已在内网验证迁移")
  await editor.getByRole("button", { name: "预览并提交" }).click()
  await expect(preview).toContainText("补充说明，已在内网验证迁移")
  await preview.getByRole("button", { name: jira.title, exact: true }).click()
  await checkJira()
  await checkWidth()
  await expect(preview).toBeVisible()
  await preview.getByRole("button", { name: "确认提交" }).click()
  await expect(preview).toBeHidden()
  const final = await readRequests()
  const original = final.find(({ id }) => id === initial.id)
  expect(original?.status).toBe("withdrawn")
  expect(original?.items?.[0].evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "self_report", status: "retracted" }),
    ]),
  )
  const replacement = final.find(({ id }) => id !== initial.id)
  expect(replacement?.status).toBe("pending_review")
  expect(replacement?.items?.[0].evidence).toEqual(
    expect.arrayContaining(
      proposal.evidence!.map(({ evidence_id, relation }) =>
        expect.objectContaining({ evidence_id, relation, status: "active" }),
      ),
    ),
  )
  expect(
    replacement?.items?.[0].evidence?.every(
      ({ status }) => status === "active",
    ),
  ).toBe(true)
})
