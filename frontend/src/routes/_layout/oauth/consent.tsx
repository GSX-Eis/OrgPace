import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { AxiosError } from "axios"
import {
  ArrowLeftRight,
  Check,
  Plug,
  TriangleAlert,
  UsersRound,
} from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { OauthService } from "@/client"
import {
  SectionCard,
  WorkspacePage,
} from "@/components/Common/WorkbenchPrimitives"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"
import { handleError } from "@/utils"

export const Route = createFileRoute("/_layout/oauth/consent")({
  validateSearch: (search: Record<string, unknown>) => ({
    request: typeof search.request === "string" ? search.request : "",
  }),
  component: ConsentPage,
  head: () => ({ meta: [{ title: i18n.t("settings.oauth.pageTitle") }] }),
})

function ConsentPage() {
  const { org, isPending } = useOrg()
  const { request } = Route.useSearch()
  return (
    <WorkspacePage className="grid min-h-[calc(100dvh-3rem)] place-items-center py-6">
      <SectionCard className="w-full max-w-md space-y-4 rounded-xl p-5 shadow-md shadow-black/5 sm:p-6">
        {isPending ? (
          <ProfileLoading />
        ) : org ? (
          <Consent key={org.id + request} orgId={org.id} request={request} />
        ) : (
          <OrgState />
        )}
      </SectionCard>
    </WorkspacePage>
  )
}

function Consent({ orgId, request }: { orgId: string; request: string }) {
  const { t } = useTranslation()
  const [message, setMessage] = useState("")
  const query = { org_id: orgId, request }
  const info = useQuery({
    queryKey: ["oauth-consent", orgId, request],
    queryFn: async () => (await OauthService.readConsent({ query })).data,
    retry: false,
  })
  const decision = useMutation({
    mutationFn: (approve: boolean) =>
      OauthService.consent({
        query: { org_id: orgId },
        body: { request, approve },
      }),
    onSuccess: ({ data }) => window.location.assign(data.redirect_to),
    onError: handleError.bind(setMessage),
  })
  if (info.isPending) return <ProfileLoading />
  if (info.isError) {
    const disabled =
      info.error instanceof AxiosError && info.error.response?.status === 404
    return disabled ? (
      <div className="space-y-2 text-center">
        <h1 className="text-xl font-semibold">
          {t("settings.oauth.disabledTitle")}
        </h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {t("settings.oauth.disabledDesc")}
        </p>
      </div>
    ) : (
      <p role="alert">{t("settings.oauth.invalidOrExpired")}</p>
    )
  }
  return (
    <>
      <header className="space-y-2 text-center">
        <div
          className="mb-3 flex items-center justify-center gap-3"
          aria-hidden="true"
        >
          <span className="grid size-10 place-items-center rounded-lg border border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300">
            <Plug className="size-5" />
          </span>
          <ArrowLeftRight className="size-4 text-muted-foreground" />
          <span className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
            <UsersRound className="size-5" />
          </span>
        </div>
        <h1 className="wrap-anywhere text-xl font-semibold">
          {t("settings.oauth.requestTitle", {
            clientName: info.data.client_name,
          })}
        </h1>
        <p className="text-xs text-muted-foreground">
          {t("settings.oauth.requestSubtitle")}
        </p>
      </header>
      <div className="space-y-1 border-y py-3 text-sm">
        <p className="wrap-anywhere">
          {t("settings.oauth.currentOrg")}
          <strong>{info.data.org_name}</strong>
        </p>
        <p className="wrap-anywhere">
          {t("settings.oauth.callbackHost", { host: info.data.callback_host })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("settings.oauth.switchOrgHint")}
        </p>
      </div>
      <div className="space-y-2 rounded-md border border-surface-border bg-canvas p-3 text-sm">
        <h2 className="font-medium" id="oauth-permissions">
          {t("settings.oauth.permissionsTitle")}
        </h2>
        <ul className="space-y-1.5" aria-labelledby="oauth-permissions">
          {(
            [
              "settings.oauth.perm1",
              "settings.oauth.perm2",
              "settings.oauth.perm3",
            ] as const
          ).map((key) => (
            <li key={key} className="flex items-start gap-2">
              <Check
                className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300"
                aria-hidden="true"
              />
              {t(key)}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          <strong>{t("settings.oauth.dataWarningStrong")}</strong>
          {t("settings.oauth.dataWarningBody")}
        </p>
      </div>
      {info.data.reason && <p role="alert">{info.data.reason}</p>}
      {message && <p role="alert">{message}</p>}
      {!info.data.reason && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            disabled={decision.isPending}
            onClick={() => decision.mutate(false)}
          >
            {t("settings.oauth.deny")}
          </Button>
          <Button
            disabled={decision.isPending}
            onClick={() => decision.mutate(true)}
          >
            {t("settings.oauth.allow")}
          </Button>
        </div>
      )}
      <p className="text-center text-xs text-muted-foreground">
        {t("settings.oauth.revokeHint")}
      </p>
    </>
  )
}
