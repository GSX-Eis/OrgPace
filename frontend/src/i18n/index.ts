import i18n from "i18next"
import { initReactI18next } from "react-i18next"

export const LOCALES = ["zh-CN", "en"] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = "zh-CN"
export const LOCALE_STORAGE_KEY = "locale"

type LocaleModule = { default: Record<string, unknown> }

function loadLocaleResources(): Record<
  Locale,
  { translation: Record<string, unknown> }
> {
  const resources: Record<Locale, { translation: Record<string, unknown> }> = {
    "zh-CN": { translation: {} },
    en: { translation: {} },
  }

  let viteModules: Record<string, LocaleModule> | null = null
  try {
    viteModules = import.meta.glob<LocaleModule>("./locales/*/*.json", {
      eager: true,
    })
  } catch {
    viteModules = null
  }

  if (viteModules) {
    for (const [path, mod] of Object.entries(viteModules)) {
      const match = path.match(/^\.\/locales\/(zh-CN|en)\/([^/]+)\.json$/)
      if (!match) continue
      const locale = match[1] as Locale
      const namespace = match[2]
      resources[locale].translation[namespace] = mod.default
    }
    return resources
  }

  // Fallback for Node test runners (e.g., Playwright importing utils.ts outside Vite).
  if (
    typeof process !== "undefined" &&
    typeof process.getBuiltinModule === "function"
  ) {
    const fs = process.getBuiltinModule("fs")
    const path = process.getBuiltinModule("path")
    const localesDir = path.resolve(import.meta.dirname, "locales")
    for (const locale of LOCALES) {
      const dir = path.join(localesDir, locale)
      if (!fs.existsSync(dir)) continue
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue
        const namespace = file.slice(0, -".json".length)
        const content = JSON.parse(
          fs.readFileSync(path.join(dir, file), "utf-8"),
        ) as Record<string, unknown>
        resources[locale].translation[namespace] = content
      }
    }
  }

  return resources
}

export function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en"
}

function readStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    return isLocale(stored) ? stored : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

let invalidateRouter: (() => Promise<unknown> | undefined) | null = null

export function registerLocaleRouter(
  invalidate: () => Promise<unknown> | undefined,
): void {
  invalidateRouter = invalidate
}

function applyDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") return
  document.documentElement.lang = locale
  const zhTitle = i18n.t("common.appTitle", { lng: "zh-CN" })
  const enTitle = i18n.t("common.appTitle", { lng: "en" })
  if (document.title === zhTitle || document.title === enTitle) {
    document.title = i18n.t("common.appTitle", { lng: locale })
  }
}

const initialLocale = readStoredLocale()

void i18n.use(initReactI18next).init({
  resources: loadLocaleResources(),
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  returnEmptyString: true,
  initAsync: false,
  interpolation: {
    escapeValue: false,
  },
})

applyDocumentLocale(initialLocale)

export function getLocale(): Locale {
  return isLocale(i18n.language) ? i18n.language : readStoredLocale()
}

export async function refreshLocaleRoutes(): Promise<void> {
  await invalidateRouter?.()
}

export async function setLocale(
  locale: Locale,
  options?: { invalidate?: boolean },
): Promise<void> {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
    } catch {
      // Ignore storage quota / privacy mode failures; in-memory switch still works.
    }
  }
  await i18n.changeLanguage(locale)
  applyDocumentLocale(locale)
  if (options?.invalidate !== false) {
    await refreshLocaleRoutes()
  }
}

export function syncUserLocale(preferredLocale: unknown): void {
  if (isLocale(preferredLocale) && preferredLocale !== getLocale()) {
    void setLocale(preferredLocale)
  }
}

export { i18n }
export default i18n
