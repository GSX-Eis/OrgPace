import { expect, type Locator, type Page } from "@playwright/test"

const allowedWords = [
  "Excel",
  "CSV",
  "HTTP",
  "HTTPS",
  "Jira",
  "PDF",
  "xlsx",
  "API",
  "RKNN",
]

/** Ignore addresses, URLs and exact fixture values, and allow named technical terms. */
export async function expectChineseCopy(
  scope: Page | Locator,
  extraAllowedWords: string[] = [],
  fixtureValues: string[] = [],
) {
  const root = "mainFrame" in scope ? scope.locator("body") : scope
  // biome-ignore lint/performance/useDomNodeTextContent: This check must exclude hidden text.
  const visibleText = await root.innerText()
  const text = fixtureValues
    .filter(Boolean)
    .reduce((copy, value) => copy.split(value).join(" "), visibleText)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/导出画像（JSON）/g, "导出画像")
  const allowed = new Set(
    [...allowedWords, ...extraAllowedWords].flatMap(
      (word) => word.toLowerCase().match(/[a-z]{3,}/g) ?? [],
    ),
  )
  const unexpected = [...new Set(text.match(/[A-Za-z]{3,}/g) ?? [])].filter(
    (word) => !allowed.has(word.toLowerCase()),
  )
  expect(unexpected, `页面存在未翻译的英文：${unexpected.join("、")}`).toEqual(
    [],
  )
}

/** Fail if visible text contains Chinese characters outside allowed business fixtures. */
export async function expectEnglishCopy(
  scope: Page | Locator,
  options: { allow?: string[] } = {},
) {
  const root = "mainFrame" in scope ? scope.locator("body") : scope
  // biome-ignore lint/performance/useDomNodeTextContent: This check must exclude hidden text.
  let visibleText = await root.innerText()
  const switchLabels = await root
    .locator('[data-testid="language-switch"]')
    .allInnerTexts()
  for (const label of switchLabels) {
    if (label) visibleText = visibleText.replace(label, " ")
  }
  // Replace longer allowed tokens first so a shared prefix (e.g. avatar initial) cannot break a full-name match.
  const text = [...(options.allow ?? [])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((copy, value) => copy.split(value).join(" "), visibleText)
  const unexpected = [
    ...new Set(text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? []),
  ]
  expect(
    unexpected,
    `Page contains untranslated Chinese copy: ${unexpected.join(", ")}`,
  ).toEqual([])
}
