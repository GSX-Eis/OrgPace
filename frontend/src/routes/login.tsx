import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { UsersRound } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"

import type { Body_login_login_access_token as AccessToken } from "@/client"
import { SetupService } from "@/client"
import { AuthLayout } from "@/components/Common/AuthLayout"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { LoadingButton } from "@/components/ui/loading-button"
import { PasswordInput } from "@/components/ui/password-input"
import useAuth, { isLoggedIn } from "@/hooks/useAuth"
import i18n from "@/i18n"

import { safeNext } from "@/utils"

type FormData = AccessToken

export const Route = createFileRoute("/login")({
  component: Login,
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: search.next === undefined ? undefined : safeNext(search.next),
  }),
  beforeLoad: async ({ search }) => {
    if (isLoggedIn()) {
      throw redirect({
        href: safeNext(search.next),
      })
    }
  },
  head: () => ({
    meta: [
      {
        title: i18n.t("account.loginPageTitle"),
      },
    ],
  }),
})

function Login() {
  const { t } = useTranslation()
  const [loggedOut, setLoggedOut] = useState(false)
  useEffect(() => {
    if (sessionStorage.getItem("logged_out")) {
      sessionStorage.removeItem("logged_out")
      setLoggedOut(true)
    }
  }, [])
  const status = useQuery({
    queryKey: ["setup-status"],
    queryFn: async () => (await SetupService.readStatus()).data,
  })
  const { next } = Route.useSearch()
  const { loginMutation } = useAuth(next)
  const formSchema = useMemo(
    () =>
      z.object({
        username: z
          .string()
          .trim()
          .min(1, { message: t("account.validation.emailRequired") }),
        password: z
          .string()
          .min(1, { message: t("account.validation.passwordRequired") })
          .min(8, { message: t("account.validation.passwordMin") }),
      }) satisfies z.ZodType<AccessToken>,
    [t],
  )
  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    mode: "onBlur",
    criteriaMode: "all",
    defaultValues: {
      username: "",
      password: "",
    },
  })

  const onSubmit = (data: FormData) => {
    if (loginMutation.isPending) return
    loginMutation.mutate(data)
  }

  return (
    <AuthLayout showLanguageSwitch>
      {loggedOut && (
        <p role="status" className="mb-6 rounded-lg border p-4 text-sm">
          {t("account.loggedOutNotice")}
        </p>
      )}
      {status.data?.initialized === false && (
        <p role="status" className="mb-6 rounded-lg border p-4 text-sm">
          {t("account.notInitializedNotice")}
        </p>
      )}
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col gap-6"
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
              <UsersRound className="size-5" aria-hidden="true" />
            </span>
            <h1 className="text-xl font-semibold">{t("account.loginTitle")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("account.loginSubtitle")}
            </p>
          </div>

          <div className="grid gap-4">
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("account.emailLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      data-testid="email-input"
                      placeholder="name@company.com"
                      type="text"
                      autoComplete="username"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center">
                    <FormLabel>{t("account.passwordLabel")}</FormLabel>
                  </div>
                  <FormControl>
                    <PasswordInput
                      data-testid="password-input"
                      autoComplete="current-password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />

            <LoadingButton type="submit" loading={loginMutation.isPending}>
              {t("account.loginButton")}
            </LoadingButton>
          </div>

          <p className="text-center text-sm text-muted-foreground">
            {t("account.forgotPasswordHint")}
          </p>
        </form>
      </Form>
    </AuthLayout>
  )
}
