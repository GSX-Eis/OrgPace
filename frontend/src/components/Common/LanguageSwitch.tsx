import { useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { UsersService } from "@/client"
import { isLoggedIn } from "@/hooks/useAuth"
import { LOCALES, type Locale, refreshLocaleRoutes, setLocale } from "@/i18n"
import { cn } from "@/lib/utils"

export function LanguageSwitch({ className }: { className?: string }) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const active: Locale = i18n.language === "en" ? "en" : "zh-CN"

  const handleSelect = async (nextLocale: Locale) => {
    if (nextLocale === active) return
    if (!isLoggedIn()) {
      await setLocale(nextLocale)
      return
    }
    // Apply locally first, persist before invalidating routes so _layout's /users/me check sees the new preference.
    await setLocale(nextLocale, { invalidate: false })
    await queryClient.cancelQueries({ queryKey: ["currentUser"] })
    try {
      const { data } = await UsersService.updatePreferencesMe({
        body: { preferred_locale: nextLocale },
      })
      queryClient.setQueryData(["currentUser"], data)
      await refreshLocaleRoutes()
    } catch (error) {
      console.warn("Failed to sync language preference to backend", error)
    }
  }

  return (
    <fieldset
      aria-label={t("common.language.label")}
      data-testid="language-switch"
      className={cn(
        "m-0 inline-flex shrink-0 items-center rounded-md border border-surface-border bg-muted/50 p-0.5 text-[11px] sm:text-xs",
        className,
      )}
    >
      {LOCALES.map((locale) => {
        const selected = active === locale
        const label =
          locale === "zh-CN" ? t("common.language.zh") : t("common.language.en")
        return (
          <button
            key={locale}
            type="button"
            aria-label={label}
            aria-pressed={selected}
            data-testid={`language-switch-${locale}`}
            onClick={() => void handleSelect(locale)}
            className={cn(
              "rounded-sm px-1 py-1 leading-none transition-colors focus-visible:outline-2 focus-visible:outline-ring sm:px-2",
              selected
                ? "bg-surface font-medium text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {locale === "zh-CN" ? (
              <>
                <span aria-hidden="true" className="sm:hidden">
                  {label.slice(0, 1)}
                </span>
                <span className="hidden sm:inline">{label}</span>
              </>
            ) : (
              label
            )}
          </button>
        )
      })}
    </fieldset>
  )
}
