import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router"
import { AxiosError } from "axios"
import { Building2 } from "lucide-react"
import { useLayoutEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { SetupService } from "@/client"
import { AuthLayout } from "@/components/Common/AuthLayout"
import { SetupError } from "@/components/Setup/SetupError"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LoadingButton } from "@/components/ui/loading-button"
import { PasswordInput } from "@/components/ui/password-input"
import { i18n } from "@/i18n"

export const Route = createFileRoute("/setup")({
  component: Initialize,
  head: () => ({ meta: [{ title: i18n.t("setup.page.title") }] }),
})

function Initialize() {
  const { t } = useTranslation()
  const hash = useLocation({ select: (location) => location.hash })
  const [token, setToken] = useState(() =>
    new URLSearchParams(window.location.hash.slice(1)).get("token"),
  )
  const navigate = useNavigate()
  const client = useQueryClient()
  const [confirmationError, setConfirmationError] = useState("")
  const mutation = useMutation({
    mutationFn: async (form: FormData) =>
      (
        await SetupService.initializeOrganization({
          body: {
            token: token!,
            org_name: String(form.get("org_name")).trim(),
            admin_username: String(form.get("admin_username")).trim(),
            admin_full_name: String(form.get("admin_full_name")).trim() || null,
            admin_password: String(form.get("admin_password")),
          },
        })
      ).data,
    onSuccess: (data) => {
      localStorage.setItem("access_token", data.access_token)
      localStorage.setItem("current_org_id", data.org_id)
      client.clear()
      navigate({ to: "/", replace: true })
    },
  })
  const { reset } = mutation
  useLayoutEffect(() => {
    if (!hash || !window.location.hash) return
    setToken(new URLSearchParams(hash.replace(/^#/, "")).get("token"))
    reset()
    setConfirmationError("")
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    )
  }, [hash, reset])
  const detail =
    mutation.error instanceof AxiosError
      ? mutation.error.response?.data?.detail
      : undefined
  const invalid =
    !token ||
    (mutation.error instanceof AxiosError &&
      mutation.error.response?.status === 400 &&
      typeof detail === "string" &&
      (detail === "初始化链接无效或已过期，请联系部署人员重新获取" || // i18n-ignore: 匹配后端返回的中文初始化链接失效提示
        detail.toLowerCase().includes("initialization link")))
  return (
    <AuthLayout>
      <header className="mb-5 flex items-center gap-3 border-b border-surface-border pb-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Building2 className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-xl font-semibold">{t("setup.page.heading")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("setup.page.subtitle")}
          </p>
        </div>
      </header>
      {invalid ? (
        <p role="alert">{t("setup.page.invalidLink")}</p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (mutation.isPending) return
            const form = new FormData(event.currentTarget)
            if (form.get("admin_password") !== form.get("confirmation")) {
              setConfirmationError(t("setup.page.passwordMismatch"))
              return
            }
            setConfirmationError("")
            mutation.mutate(form)
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="org_name">{t("setup.page.orgNameLabel")}</Label>
            <Input id="org_name" name="org_name" required maxLength={100} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin_username">
              {t("setup.page.adminEmailLabel")}
            </Label>
            <Input
              id="admin_username"
              name="admin_username"
              type="email"
              placeholder="admin@example.com"
              required
              maxLength={255}
              autoComplete="username"
              aria-describedby="admin-hint"
            />
            <p id="admin-hint" className="text-xs text-muted-foreground">
              {t("setup.page.adminEmailHint")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin_full_name">
              {t("setup.page.fullNameLabel")}
            </Label>
            <Input
              id="admin_full_name"
              name="admin_full_name"
              maxLength={255}
              autoComplete="name"
            />
          </div>
          {(
            [
              ["admin_password", t("setup.page.passwordLabel")],
              ["confirmation", t("setup.page.confirmPasswordLabel")],
            ] as const
          ).map(([name, label]) => (
            <div key={name} className="space-y-2">
              <Label htmlFor={name}>{label}</Label>
              <PasswordInput
                id={name}
                name={name}
                required
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
              />
            </div>
          ))}
          {confirmationError && (
            <p role="alert" className="text-sm text-destructive">
              {confirmationError}
            </p>
          )}
          <SetupError error={mutation.error} />
          <LoadingButton
            type="submit"
            loading={mutation.isPending}
            className="w-full"
          >
            {t("setup.page.submit")}
          </LoadingButton>
        </form>
      )}
    </AuthLayout>
  )
}
