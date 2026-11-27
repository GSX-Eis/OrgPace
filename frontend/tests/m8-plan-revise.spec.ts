import { expect, test } from "@playwright/test"
import { expectChineseCopy } from "./utils/copy"
import { setupPlans } from "./utils/plans"

test.use({ storageState: { cookies: [], origins: [] } })

test("B 方经理点击人员卡片或添加卡片，在弹窗调整投入分段并重新模拟", async ({
  page,
  request,
}) => {
  test.setTimeout(120000)
  const { person, m, demand, open } = await setupPlans(page, request, true)
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/planning/demands/${demand.id}/cases`) &&
      response.request().method() === "POST",
  )
  await open(m)
  await expect(page.getByRole("button", { name: "关闭方案" })).toBeVisible()
  const created = await (await createdResponse).json()
  const direct = created.options.find(
    (option: { kind: string }) => option.kind === "direct",
  )
  expect(direct.verdict).toBe("infeasible")
  const card = page.getByRole("article", { name: "直接安排方案" })
  await expect(card.getByText("快捷修改")).toHaveCount(0)
  await expect(card.getByText("需要谁确认")).toHaveCount(0)

  // 1. 点击人员卡片打开「调整投入分段」弹窗并换人
  await card.getByRole("button", { name: "调整 合成研发甲 的人员安排" }).click()
  const dialog = page.getByRole("dialog", { name: "调整投入分段" })
  await expect(dialog).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.screenshot({
    path: test.info().outputPath("02-segment-dialog-desktop.png"),
    animations: "disabled",
  })
  const editor = dialog.getByRole("form", { name: "编辑投入分段" })
  await editor.getByLabel("人员").first().selectOption(person("B3").id)
  await editor.getByRole("button", { name: "模拟调整后的安排" }).click()
  await expect(dialog).toHaveCount(0)

  const revised = page.getByRole("article", { name: "自定方案方案" })
  await expect(revised).toContainText("合成研发丙")
  await expect(revised).toContainText("投入 50%")

  // 2. 点击「+ 添加人员安排」预增一行空白分段，并校验 422 与投入比例范围提示
  await revised.getByRole("button", { name: "+ 添加人员安排" }).click()
  await expect(dialog).toBeVisible()
  await expect(editor.getByLabel("人员")).toHaveCount(3)
  await editor.getByRole("button", { name: "移除此段" }).last().click()
  await expect(editor.getByLabel("人员")).toHaveCount(2)

  await page.route("**/planning/cases/*/options", (route) =>
    route.fulfill({
      status: 422,
      json: {
        detail: [
          { msg: "投入比例必须在允许范围内" },
          { msg: "请检查修改内容" },
        ],
      },
    }),
  )
  await editor.getByRole("button", { name: "模拟调整后的安排" }).click()
  await expect
    .soft(dialog.getByRole("alert"))
    .toHaveText("投入比例必须在允许范围内；请检查修改内容")
  await page.unroute("**/planning/cases/*/options")

  await editor.getByLabel("投入比例（%）").first().fill("5")
  await editor.getByRole("button", { name: "模拟调整后的安排" }).click()
  const invalid = await editor
    .getByLabel("投入比例（%）")
    .first()
    .evaluate((el) => !(el as HTMLInputElement).validity.valid)
  expect(invalid).toBe(true)

  await editor.getByLabel("投入比例（%）").first().fill("80")
  await editor.getByRole("button", { name: "模拟调整后的安排" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(revised).toContainText("投入 80%")
  await revised.getByRole("button", { name: /展开其余 \d+ 条/ }).click()
  await expect(revised).toContainText("合成研发丙：2 周超出常规配额")

  const snapshots: string[] = []
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes(`/planning/demands/${demand.id}/cases`)
    )
      snapshots.push(req.url())
  })
  await page.reload()
  const optionTabs = page.getByRole("tablist", { name: "可选方案" })
  await optionTabs
    .getByRole("tab", { name: /自定方案/ })
    .last()
    .click()
  await expect(
    page.getByRole("article", { name: "自定方案方案" }),
  ).toContainText("投入 80%")
  expect.soft(snapshots).toHaveLength(0)
  await expectChineseCopy(page)
  expect(await page.locator("body").textContent()).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )
})
