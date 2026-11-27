import { expect, test } from "@playwright/test"
import { expectChineseCopy } from "./utils/copy"
import { setupPlans } from "./utils/plans"

test.use({ storageState: { cookies: [], origins: [] } })

test("NERE-1318：方案页默认遵循常规配额上限，勾选允许动用弹性空间后重新模拟并标识占用", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const { api, base, person, a, m, start, later, open } = await setupPlans(
    page,
    request,
  )

  // 将 B1、B2 设为 30% 平台外工作占比，使新需求 50% 落在 70%..100% 弹性区间内
  await api(
    `${base}/capacity/weeks`,
    {
      items: [
        { employee_id: person("B1").id, other_percent: 30 },
        { employee_id: person("B2").id, other_percent: 30 },
      ],
      start_week: start,
      end_week: later(14),
    },
    m,
    "PUT",
  )

  const elasticDemand = await api(
    `${base}/capacity/demands`,
    {
      requesting_department_id: person("A").department!.id,
      target_department_id: person("M").department!.id,
      capability_key: "delivery",
      headcount: 1,
      allocation_percent: 50,
      window_start: later(7),
      window_end: later(13),
      description: "合成弹性配额验证需求",
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
  await page.goto(`/capacity?tab=incoming&demand=${elasticDemand.id}&plans=1`)

  await expect(
    page.getByText("当前模式：遵循企业常规配额上限（70%）"),
  ).toBeVisible()
  const elasticToggle = page.getByRole("checkbox", { name: "允许动用弹性空间" })
  await expect(elasticToggle).not.toBeChecked()

  const directCard = page.getByRole("article", { name: "直接安排方案" })
  await expect(directCard).toContainText("直接安排 · 不可行")
  await expect(directCard).toContainText("超出常规配额")
  await expect(directCard).toContainText(
    "可勾选上方「允许动用弹性空间」重新模拟。",
  )
  await expect(directCard).not.toContainText("已占用弹性配额")

  // 勾选允许动用弹性空间并点击重新模拟
  await elasticToggle.check()
  const elasticRespPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/planning/demands/${elasticDemand.id}/cases`) &&
      response.request().method() === "POST",
  )
  await page.getByRole("button", { name: "重新模拟" }).click()
  const elasticResp = await elasticRespPromise
  expect(elasticResp.ok()).toBeTruthy()
  expect(elasticResp.request().postDataJSON()).toEqual({ allow_elastic: true })

  await expect(
    page.getByText(
      "当前模式：已允许动用弹性空间（常规配额上限 70%，最高不超过员工可用容量）",
    ),
  ).toBeVisible()
  await expect(elasticToggle).toBeChecked()
  await expect(directCard).toContainText("直接安排 · 可行")
  await expect(directCard).toContainText("已占用弹性配额 10%")

  // 刷新页面验证弹性模式持久且不误报过期
  await page.reload()
  await expect(elasticToggle).toBeChecked()
  await expect(page.getByText("数据已变化，请重新模拟")).toHaveCount(0)
  await expect(directCard).toContainText("已占用弹性配额 10%")
  await expectChineseCopy(page)
  expect(await page.locator("body").textContent()).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )
  void open
})
