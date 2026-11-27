import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { KeyRound } from "lucide-react"
import { useTranslation } from "react-i18next"
import { UsersService } from "@/client"
import { AuthLayout } from "@/components/Common/AuthLayout"
import ChangePassword from "@/components/UserSettings/ChangePassword"
import { isLoggedIn } from "@/hooks/useAuth"
import i18n, { syncUserLocale } from "@/i18n"

import { safeNext } from "@/utils"

export const Route = createFileRoute("/change-password")({
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: search.next === undefined ? undefined : safeNext(search.next),
  }),
  beforeLoad: async ({ search }) => {
    if (!isLoggedIn())
      throw redirect({ to: "/login", search: { next: search.next } })
    const { data: user } = await UsersService.readUserMe()
    syncUserLocale(user.preferred_locale)
    if (!user.must_change_password)
      throw redirect({ href: safeNext(search.next) })
  },
  component: ChangePasswordPage,
  head: () => ({
    meta: [{ title: i18n.t("account.changePasswordPageTitle") }],
  }),
})

function ChangePasswordPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { next } = Route.useSearch()
  return (
    <AuthLayout>
      <header className="mb-5 flex flex-col items-center gap-2 text-center">
        <span className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
          <KeyRound className="size-5" aria-hidden="true" />
        </span>
        <h1 className="text-xl font-semibold">
          {t("account.changePasswordTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("account.changePasswordSubtitle")}
        </p>
      </header>
      <ChangePassword onSuccess={() => navigate({ href: safeNext(next) })} />
    </AuthLayout>
  )
}
