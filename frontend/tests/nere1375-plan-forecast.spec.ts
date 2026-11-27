import { expect, test } from "@playwright/test"
import { expectChineseCopy } from "./utils/copy"
import { setupPlans } from "./utils/plans"

test.use({ storageState: { cookies: [], origins: [] } })

test("NERE-1375：远期需求按预测基线生成可行方案、展示柔和提示并一步确认生效", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const { api, base, person, a, m, later } = await setupPlans(page, request)

  // 远期需求（第 9-10 周，未手工确认，但 B1/B2 有前 3 周历史确认负荷供预测基线延续）
  const futureDemand = await api(
    `${base}/capacity/demands`,
    {
      requesting_department_id: person("A").department!.id,
      target_department_id: person("M").department!.id,
      capability_key: "delivery",
      headcount: 1,
      allocation_percent: 50,
      window_start: later(56),
      window_end: later(69),
      description: "合成远期预测基线内部方案需求",
    },
    a,
  )

  await page.goto("/login")
  await page.evaluate(
    ({ token, org }) => {
      localStorage.setItem("access_token", token)
      localStorage.setItem("current_org_id", org)
    },
    { token: m, org: base.split("/").pop()! },
  )
  await page.goto(`/capacity?tab=incoming&demand=${futureDemand.id}&plans=1`)

  const directCard = page.getByRole("article", { name: "直接安排方案" })
  await expect(directCard).toBeVisible()
  await expect(directCard).toContainText("直接安排 · 可行")
  await expect(directCard).not.toContainText("数据不足")
  await expect(directCard).not.toContainText("去确认团队负荷")

  const forecastBanner = directCard.getByRole("region", {
    name: "预测基线提示",
  })
  await expect(forecastBanner).toBeVisible()
  await expect(forecastBanner).toContainText("2 周使用预测基线")
  await expect(forecastBanner).toContainText("确认方案时将自动确认这些周次负荷")

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator("#capacity-plans").scrollIntoViewIfNeeded()
  await page.locator("#capacity-plans").screenshot({
    path: test.info().outputPath("01-nere1375-forecast-plan-desktop.png"),
    animations: "disabled",
  })

  await expectChineseCopy(page)
  expect(await page.locator("body").textContent()).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )

  // 点击「按此方案答复」并确认提交：应一步生效并自动确认所涉预测周
  await directCard.getByRole("button", { name: "按此方案答复" }).click()
  await page
    .getByRole("form", { name: "答复需求" })
    .getByLabel("答复说明")
    .fill("按预测基线可按期承接")
  await page.getByRole("button", { name: "确认方案并生效分配" }).click()

  // 验证需求状态已直接进入已接收 / 已生效
  await expect
    .poll(async () => {
      const updated = await api(
        `${base}/capacity/demands/${futureDemand.id}`,
        undefined,
        m,
      )
      return updated.status
    })
    .toBe("accepted")
})
