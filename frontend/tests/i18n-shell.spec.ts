import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { checkI18n } from "../scripts/check-i18n"
import { expectEnglishCopy } from "./utils/copy"
import { createUser } from "./utils/privateApi"
import { randomEmail, randomPassword } from "./utils/random"

test.use({ storageState: { cookies: [], origins: [] } })

test("check-i18n passes on repo locales and fails on missing, extra, placeholder, and unknown key", () => {
  const real = checkI18n()
  expect(real.errors).toEqual([])
  expect(real.keyCount).toBeGreaterThan(0)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-i18n-"))
  try {
    const srcDir = path.join(root, "src")
    const localesDir = path.join(srcDir, "i18n", "locales")
    fs.mkdirSync(path.join(localesDir, "zh-CN"), { recursive: true })
    fs.mkdirSync(path.join(localesDir, "en"), { recursive: true })
    fs.writeFileSync(
      path.join(localesDir, "zh-CN", "common.json"),
      JSON.stringify({ greeting: "你好 {{name}}", onlyZh: "仅中文" }),
    )
    fs.writeFileSync(
      path.join(localesDir, "en", "common.json"),
      JSON.stringify({ greeting: "Hello {{user}}", onlyEn: "Extra" }),
    )
    fs.writeFileSync(path.join(localesDir, "en", "extra.json"), "{}")
    fs.writeFileSync(
      path.join(srcDir, "App.tsx"),
      'export const x = t("common.missingKey")',
    )
    const broken = checkI18n({ localesDir, srcDir })
    expect(broken.errors.some((e) => e.includes("Extra en locale file"))).toBe(
      true,
    )
    expect(broken.errors.some((e) => e.includes("Missing key in en"))).toBe(
      true,
    )
    expect(broken.errors.some((e) => e.includes("Extra key in en"))).toBe(true)
    expect(broken.errors.some((e) => e.includes("Placeholder mismatch"))).toBe(
      true,
    )
    expect(broken.errors.some((e) => e.includes("common.missingKey"))).toBe(
      true,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("expectEnglishCopy rejects Chinese text, ignores hidden nodes, and respects allow", async ({
  page,
}) => {
  await page.setContent(
    '<p>Hello Acme Corp</p><p hidden>隐藏中文</p><div data-testid="language-switch"><button>中文</button><button>EN</button></div>',
  )
  await expectEnglishCopy(page)
  await page.setContent("<p>张</p><p>Hello 张伟</p>")
  await expectEnglishCopy(page, { allow: ["张", "张伟"] })
  await page.setContent("<p>Hello 未翻译</p>")
  await expect(expectEnglishCopy(page)).rejects.toThrow(/未翻译/)
})

test("bilingual switch and preference persistence end-to-end", async ({
  page,
  browser,
  baseURL,
}) => {
  const email = randomEmail()
  const password = randomPassword()
  await createUser({ email, password })

  // 1. Fresh visit defaults to zh-CN.
  await page.goto("/login")
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN")
  await expect(page).toHaveTitle("登录 - 知程")
  await expect(page.getByRole("button", { name: "登录" })).toBeVisible()

  // 2. Switch to EN on login page immediately without reload.
  await page.getByTestId("language-switch-en").click()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(page).toHaveTitle("Sign in - OrgPace")
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
  await expectEnglishCopy(page)
  expect(await page.evaluate(() => localStorage.getItem("locale"))).toBe("en")

  // Refreshing login page keeps English with no Chinese flash.
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(page).toHaveTitle("Sign in - OrgPace")
  await expectEnglishCopy(page)

  // Trigger an English backend validation error on unauthenticated login.
  await page.getByTestId("email-input").fill(email)
  await page.getByTestId("password-input").fill("wrong-password-123")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByText("Incorrect email or password")).toBeVisible()

  // 3. Switch back to Chinese, log in, then toggle to EN in main topbar to persist to backend.
  await page.getByTestId("language-switch-zh-CN").click()
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN")
  await page.getByTestId("password-input").fill(password)
  await page.getByRole("button", { name: "登录" }).click()
  await expect(page).not.toHaveURL(/\/login/)

  const allowUser = ["测", "测试员工"]

  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/users/me/preferences") &&
        res.request().method() === "PATCH" &&
        res.ok(),
    ),
    page.getByTestId("language-switch-en").click(),
  ])
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expectEnglishCopy(page, { allow: allowUser })

  // Verify settings page, change-password modal, integrations tab, and 404 page in EN.
  await page.goto("/settings")
  await expect(page).toHaveTitle("Settings - OrgPace")
  await expect(
    page.getByRole("region", { name: "Personal Information" }),
  ).toContainText(email)
  await expectEnglishCopy(page, { allow: allowUser })

  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click()
  const passwordDialog = page.getByRole("dialog", { name: "Change Password" })
  await expect(passwordDialog).toBeVisible()
  await passwordDialog.getByRole("button", { name: "Save password" }).click()
  await expect(
    passwordDialog.getByText("Please enter your password").first(),
  ).toBeVisible()
  await expectEnglishCopy(passwordDialog, { allow: allowUser })
  await page.keyboard.press("Escape")

  await page.goto("/settings?section=integrations")
  await expect(
    page.getByRole("heading", {
      name: "Chat Accounts & External Work Identities",
    }),
  ).toBeVisible()
  await expectEnglishCopy(page, { allow: allowUser })

  await page.goto("/unknown-page")
  await expect(page.getByTestId("not-found")).toBeVisible()
  await expect(page).toHaveTitle("Page Not Found - OrgPace")
  await expectEnglishCopy(page, { allow: allowUser })

  await page.goto("/settings")
  // Reloading keeps EN without Chinese flash.
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(page).toHaveTitle("Settings - OrgPace")
  await expectEnglishCopy(page, { allow: allowUser })

  // Logout preserves localStorage.locale in EN.
  await page.getByTestId("user-menu").click()
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await page.waitForURL(/\/login/)
  expect(await page.evaluate(() => localStorage.getItem("locale"))).toBe("en")
  await expect(page.locator("html")).toHaveAttribute("lang", "en")

  // 4. New browser context (empty localStorage) restores EN from user.preferred_locale.
  const freshContext = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  })
  const freshPage = await freshContext.newPage()
  await freshPage.goto("/login")
  await expect(freshPage.locator("html")).toHaveAttribute("lang", "zh-CN")
  await freshPage.getByTestId("email-input").fill(email)
  await freshPage.getByTestId("password-input").fill(password)
  await freshPage.getByRole("button", { name: "登录" }).click()
  await expect(freshPage).not.toHaveURL(/\/login/)
  await expect(freshPage.locator("html")).toHaveAttribute("lang", "en")
  expect(await freshPage.evaluate(() => localStorage.getItem("locale"))).toBe(
    "en",
  )
  await freshPage.goto("/settings")
  await expectEnglishCopy(freshPage, { allow: allowUser })

  // Switch back to Chinese and confirm logout preserves localStorage.locale and new context restores zh-CN.
  await Promise.all([
    freshPage.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/users/me/preferences") &&
        res.request().method() === "PATCH" &&
        res.ok(),
    ),
    freshPage.getByTestId("language-switch-zh-CN").click(),
  ])
  await expect(freshPage.locator("html")).toHaveAttribute("lang", "zh-CN")
  await freshPage.getByTestId("user-menu").click()
  await freshPage.getByRole("menuitem", { name: "退出登录" }).click()
  await freshPage.waitForURL("/login")
  expect(await freshPage.evaluate(() => localStorage.getItem("locale"))).toBe(
    "zh-CN",
  )
  await freshContext.close()

  const zhContext = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  })
  const zhPage = await zhContext.newPage()
  await zhPage.goto("/login")
  await zhPage.getByTestId("email-input").fill(email)
  await zhPage.getByTestId("password-input").fill(password)
  await zhPage.getByRole("button", { name: "登录" }).click()
  await expect(zhPage).not.toHaveURL(/\/login/)
  await expect(zhPage.locator("html")).toHaveAttribute("lang", "zh-CN")
  await zhContext.close()
})
