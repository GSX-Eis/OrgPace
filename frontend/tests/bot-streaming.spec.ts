import { expect, test } from "@playwright/test"
import { mockAssistantStream } from "./utils/assistantStream"
import { createUser } from "./utils/privateApi"
import { logInUser } from "./utils/user"

test.use({
  storageState: { cookies: [], origins: [] },
  permissions: ["clipboard-read", "clipboard-write"],
})

test("bot streams, folds tool progress, stops and sends again", async ({
  page,
}) => {
  const email = `stream-${crypto.randomUUID()}@example.com`
  const password = "synthetic-password-2026"
  await createUser({ email, password, withEmptyProfile: true })
  await mockAssistantStream(page, "bot")
  await logInUser(page, email, password)
  const panel = page.getByRole("region", { name: "助手", exact: true })
  const input = panel.getByLabel("发给助手的消息")
  await expect(input).toBeEnabled()
  await input.fill("合成问题")
  await input.press("Shift+Enter")
  await expect(input).toHaveValue("合成问题\n")
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true })
  await expect(input).toHaveValue("合成问题\n")
  await expect(
    panel.getByRole("button", { name: "停止", exact: true }),
  ).toHaveCount(0)
  await input.press("Enter")
  await expect(panel.getByRole("log")).toContainText("合成问题")
  await expect(panel.getByText("第一段", { exact: true })).toBeVisible()
  await expect(
    panel.getByText("第一段第二段第三段", { exact: true }),
  ).toHaveCount(0)
  await page.evaluate(() => {
    window.reply.emit({
      type: "tool",
      name: "查看我的正式画像",
      phase: "start",
      ok: true,
    })
  })
  await expect(
    panel.getByText("正在查看我的正式画像…", { exact: true }),
  ).toBeVisible()
  await page.evaluate(() => {
    window.reply.emit({
      type: "tool",
      name: "查看我的正式画像",
      phase: "end",
      ok: true,
    })
    window.reply.emit({
      type: "tool",
      name: "查看请求进度",
      phase: "start",
      ok: true,
    })
    window.reply.emit({
      type: "tool",
      name: "查看请求进度",
      phase: "end",
      ok: true,
    })
    window.reply.emit({ type: "text", text: "第二段" })
  })
  await expect(panel.getByText("第一段第二段", { exact: true })).toBeVisible()
  const toggle = panel.getByText("已完成 2 步操作", { exact: true })
  await expect(
    panel.getByText("查看我的正式画像：成功", { exact: true }),
  ).toBeHidden()
  await toggle.click()
  await expect(
    panel.getByText("查看我的正式画像：成功", { exact: true }),
  ).toBeVisible()
  await toggle.click()
  await expect(
    panel.getByText("查看我的正式画像：成功", { exact: true }),
  ).toBeHidden()
  await page.evaluate(() => {
    window.reply.emit({ type: "text", text: "第三段" })
    window.reply.emit({
      type: "final",
      response: {
        messages: [{ type: "text", text: "第一段第二段第三段" }],
        steps: [
          { name: "查看我的正式画像", ok: true },
          { name: "查看请求进度", ok: true },
        ],
      },
    })
    window.reply.finish()
  })
  await expect(
    panel.getByText("第一段第二段第三段", { exact: true }),
  ).toBeVisible()
  const userMessage = panel.locator('[data-role="user"]').first()
  const assistantMessage = panel.locator('[data-role="assistant"]').first()
  const userBox = await userMessage.boundingBox()
  const assistantBox = await assistantMessage.boundingBox()
  expect(userBox!.x).toBeGreaterThan(assistantBox!.x)
  expect(userBox!.width).toBeLessThanOrEqual(assistantBox!.width * 0.7 + 1)
  await expect(assistantMessage).toContainText("耗时")
  await assistantMessage
    .getByRole("button", { name: "复制", exact: true })
    .click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "第一段第二段第三段",
  )
  await toggle.click()
  await expect(
    panel.getByText("查看请求进度：成功", { exact: true }),
  ).toBeVisible()
  await toggle.click()
  await expect(input).toBeEnabled()
  const sendButton = panel.getByRole("button", { name: "发送", exact: true })
  expect(
    await sendButton.evaluate((button) =>
      parseFloat(getComputedStyle(button).borderRadius),
    ),
  ).toBeGreaterThan(100)
  await input.fill("停止这轮")
  await input.press("Enter")
  await expect(panel.getByText("第一段", { exact: true })).toBeVisible()
  await expect(
    panel.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible()
  await panel.getByRole("button", { name: "停止", exact: true }).click()
  await expect(panel.getByText("已停止", { exact: true })).toBeVisible()
  await expect(panel.getByText("第一段", { exact: true })).toHaveCount(0)
  await expect(panel.getByText("停止这轮", { exact: true })).toHaveCount(0)
  await input.fill("再发一条")
  await input.press("Enter")
  await expect(panel.getByText("第一段", { exact: true })).toBeVisible()
  await page.evaluate(() => {
    window.reply.emit({
      type: "final",
      response: { messages: [{ type: "text", text: "继续回复成功" }] },
    })
    window.reply.finish()
  })
  await expect(panel.getByText("继续回复成功", { exact: true })).toBeVisible()
  await expect(input).toBeEnabled()
})

test("bot steps remain after leaving the assistant and reloading", async ({
  page,
}) => {
  const email = `steps-${crypto.randomUUID()}@example.com`
  const password = "synthetic-password-2026"
  await createUser({ email, password, withEmptyProfile: true })
  const steps = [
    { name: "查看我的正式画像", ok: true },
    { name: "查看请求进度", ok: false },
  ]
  const response = { messages: [{ type: "text", text: "合成历史步骤" }], steps }
  let completed = false
  await page.route("**/bot/sessions/*/messages?*", (route) =>
    route.fulfill({
      json: completed ? [{ role: "assistant", payload: response }] : [],
    }),
  )
  await page.route("**/bot/sessions/*/turns?*", (route) => {
    completed = true
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: `${[
        ...steps.flatMap((step) => [
          { type: "tool", ...step, phase: "start" },
          { type: "tool", ...step, phase: "end" },
        ]),
        { type: "final", response },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    })
  })
  await logInUser(page, email, password)
  await page.waitForURL(/\/assistant$/)
  const panel = page.getByRole("region", { name: "助手", exact: true })
  await panel.getByLabel("发给助手的消息").fill("查看进度")
  await panel.getByLabel("发给助手的消息").press("Enter")
  await expect(panel.getByText("合成历史步骤", { exact: true })).toBeVisible()
  await expect(panel.getByLabel("发给助手的消息")).toBeEnabled()
  await expect(
    panel.getByText("已完成 2 步操作", { exact: true }),
  ).toBeVisible()
  await panel.getByText("已完成 2 步操作", { exact: true }).click()
  await expect(
    panel.getByText("查看我的正式画像：成功", { exact: true }),
  ).toBeVisible()
  await expect(
    panel.getByText("查看请求进度：失败", { exact: true }),
  ).toBeVisible()
  await page.getByRole("link", { name: "组织", exact: true }).click()
  await page.getByRole("link", { name: /^协同/ }).click()
  await expect(
    panel.getByText("已完成 2 步操作", { exact: true }),
  ).toBeVisible()
  await page.reload()
  await expect(
    panel.getByText("已完成 2 步操作", { exact: true }),
  ).toBeVisible()
  await panel.getByText("已完成 2 步操作", { exact: true }).click()
  await expect(
    panel.getByText("查看请求进度：失败", { exact: true }),
  ).toBeVisible()
})
