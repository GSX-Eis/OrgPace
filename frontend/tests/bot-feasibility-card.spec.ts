import { expect, test } from "@playwright/test"
import type { TurnResponse } from "../src/client"
import { createUser } from "./utils/privateApi"
import { logInUser } from "./utils/user"

test.use({ storageState: { cookies: [], origins: [] } })

test("shows department feasibility inline and restores it on reload", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const email = `feasibility-${crypto.randomUUID()}@example.com`
  const password = "synthetic-password-2026"
  await createUser({ email, password, withEmptyProfile: true })
  await logInUser(page, email, password)

  const text = "这次评估覆盖前端开发和测试验证。"
  const window = { window_start: "2026-11-30", window_end: "2026-12-06" }
  const response: TurnResponse = {
    messages: [
      { type: "text", text },
      {
        type: "feasibility_card",
        capability_key: "frontend",
        capability_name: "前端开发",
        allocation_cap_percent: 70,
        ...window,
        departments: [
          {
            department_name: "前端组",
            conclusion: "can_do",
            load_level: "low",
            department_load_percent: 48,
            regular_used_percent: 48,
            elastic_used_percent: 0,
            regular_headroom_percent: 22,
            elastic_headroom_percent: 30,
            earliest_start_date: "2026-11-30",
            is_estimated: false,
            exceeds_regular_cap: false,
            needs_elastic: false,
            data_source: "confirmed",
          },
          {
            department_name: "交付组",
            conclusion: "needs_confirmation",
            load_level: "withheld",
            department_load_percent: 73,
            regular_used_percent: 70,
            elastic_used_percent: 3,
            regular_headroom_percent: 10,
            elastic_headroom_percent: 20,
            exceeds_regular_cap: true,
            needs_elastic: true,
          },
        ],
      },
      {
        type: "feasibility_card",
        capability_key: "testing",
        capability_name: "测试验证",
        allocation_cap_percent: 70,
        window_start: "2027-01-01",
        window_end: "2027-01-07",
        departments: [
          {
            department_name: "质量保障组",
            conclusion: "cannot_do",
            load_level: "very_high",
            department_load_percent: 126,
            regular_used_percent: 70,
            elastic_used_percent: 56,
            regular_headroom_percent: 0,
            elastic_headroom_percent: 0,
            is_estimated: true,
            exceeds_regular_cap: true,
            needs_elastic: false,
            data_source: "mixed",
          },
          {
            department_name: "测试平台组",
            conclusion: "can_do",
            load_level: "high",
            department_load_percent: 75,
            regular_used_percent: 70,
            elastic_used_percent: 5,
            regular_headroom_percent: 0,
            elastic_headroom_percent: 25,
            earliest_start_date: "2027-01-01",
            is_estimated: true,
            exceeds_regular_cap: true,
            needs_elastic: true,
            data_source: "forecast_baseline",
          },
        ],
      },
    ],
    steps: [],
  }
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
      body: `${JSON.stringify({ type: "final", response })}\n`,
    })
  })

  await page
    .getByLabel("发给助手的消息")
    .fill("下周有部门能做前端开发和测试验证吗？")
  await page.getByRole("button", { name: "发送", exact: true }).click()

  const log = page.getByRole("log")
  const frontend = log.getByRole("region", { name: "前端开发跨部门可行性" })
  const testing = log.getByRole("region", { name: "测试验证跨部门可行性" })
  await expect(log.getByText(text, { exact: true })).toBeVisible()
  await expect(frontend).toContainText(
    "2026-11-30 至 2026-12-06 · 常规配额 70% / 弹性空间 30%",
  )
  const available = frontend.getByRole("listitem").filter({ hasText: "前端组" })
  await expect(available).toContainText("48%")
  await expect(available).toContainText(
    "常规配额（上限 70%）：已用 48% · 余量 22%",
  )
  await expect(available).toContainText("弹性空间（30%）：已用 0% · 余量 30%")
  await expect(available).toContainText("有空承接")
  await expect(available).toContainText("已确认排期")
  await expect(available).not.toContainText("已突破常规上限")
  await expect(available).not.toContainText("需动用弹性空间")
  await expect(available.locator('svg line[data-cap="70"]')).toHaveCount(1)
  await expect(available).toContainText("最早可能开始：2026-11-30")
  await expect(testing).toContainText("126%")
  const overloaded = testing
    .getByRole("listitem")
    .filter({ hasText: "质量保障组" })
  await expect(overloaded).toContainText("已确认+预测基线")
  await expect(overloaded).toContainText("已突破常规上限（动用弹性 56%）")
  await expect(overloaded.locator("svg circle").last()).toHaveAttribute(
    "stroke-dasharray",
    "100 100",
  )
  const withheld = frontend.getByRole("listitem").filter({ hasText: "交付组" })
  await expect(withheld).toContainText("整体负荷暂不展示")
  await expect(withheld).toContainText("最早可能开始：待目标部门确认")
  await expect(withheld).not.toContainText("%")
  await expect(withheld).not.toContainText("常规配额")
  await expect(withheld).not.toContainText("弹性空间")
  await expect(withheld).not.toContainText("已突破常规上限")
  await expect(withheld).not.toContainText("需动用弹性空间")
  await expect(withheld.locator("svg circle")).toHaveCount(1)
  await expect(withheld.locator("svg line")).toHaveCount(0)
  await expect(testing).toContainText("最早可能开始：近期暂无空档")
  const future = testing.getByRole("listitem").filter({ hasText: "测试平台组" })
  await expect(future).toContainText("75%")
  await expect(future).toContainText("常规配额（上限 70%）：已用 70% · 余量 0%")
  await expect(future).toContainText("弹性空间（30%）：已用 5% · 余量 25%")
  await expect(future).toContainText("有空承接")
  await expect(future).toContainText("预测基线")
  await expect(future).toContainText("已突破常规上限（动用弹性 5%）")
  await expect(future).toContainText("需动用弹性空间")
  await expect(future.locator('svg line[data-cap="70"]')).toHaveCount(1)
  await expect(future).toContainText("最早可能开始：2027-01-01")
  const notice =
    "提示：预测基线由系统基于历史排期与在途工作自动估算；动用弹性空间需目标部门经理最终确认。"
  await expect(testing).toContainText(notice)
  await expect(frontend).not.toContainText(notice)
  await testing.scrollIntoViewIfNeeded()
  await testInfo.attach("feasibility-desktop", {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  })

  await page.getByRole("link", { name: "组织", exact: true }).click()
  await page.getByRole("link", { name: /^协同/ }).click()
  await expect(frontend).toBeVisible()
  await page.reload()
  await expect(frontend).toBeVisible()
  await expect(testing).toBeVisible()
  await expect(testing).toContainText(notice)
  await page.setViewportSize({ width: 390, height: 900 })
  for (const card of [frontend, testing]) {
    expect(
      await card.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1)
  }
})

test("renders legacy NERE-1315 feasibility card JSON without error", async ({
  page,
}) => {
  const email = `feasibility-legacy-${crypto.randomUUID()}@example.com`
  const password = "synthetic-password-2026"
  await createUser({ email, password, withEmptyProfile: true })
  await logInUser(page, email, password)

  const legacyResponse = {
    messages: [
      {
        type: "feasibility_card",
        capability_key: "design",
        capability_name: "交互设计",
        window_start: "2027-01-01",
        window_end: "2027-01-07",
        departments: [
          {
            department_name: "设计部",
            conclusion: "can_do",
            load_level: "low",
            department_load_percent: 25,
            earliest_start_date: "2027-01-01",
            is_estimated: true,
            unscheduled_beyond_horizon: true,
          },
        ],
      },
    ],
    steps: [],
  }
  await page.route("**/bot/sessions/*/messages?*", (route) =>
    route.fulfill({
      json: [{ role: "assistant", payload: legacyResponse }],
    }),
  )
  await page.route("**/bot/sessions/*/turns?*", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ type: "final", response: legacyResponse })}\n`,
    }),
  )

  await page.getByLabel("发给助手的消息").fill("查看历史评估")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  const card = page
    .getByRole("log")
    .getByRole("region", { name: "交互设计跨部门可行性" })
  await expect(card).toContainText("25%")
  await expect(card).toContainText("有空承接")
  await expect(card).toContainText("估算参考")
})
