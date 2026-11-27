import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { type BindingCode, ImBindingsService } from "@/client"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useOrg } from "@/hooks/useOrg"
import { formatDate } from "@/i18n/format"
import { handleError } from "@/utils"

type Platform = "telegram" | "feishu" | "wecom"

export function ImBindings() {
  const { t } = useTranslation()
  const { org, employeeId } = useOrg()
  if (!org) return <OrgState />
  if (!employeeId)
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        {t("settings.im.noEmployee")}
      </p>
    )
  return <Bindings key={org.id} orgId={org.id} />
}

function Bindings({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const names: Record<Platform, string> = {
    telegram: t("settings.im.platforms.telegram"),
    feishu: t("settings.im.platforms.feishu"),
    wecom: t("settings.im.platforms.wecom"),
  }
  const client = useQueryClient()
  const [code, setCode] = useState<BindingCode>()
  const [message, setMessage] = useState("")
  const path = { org_id: orgId }
  const queryKey = ["im-bindings", orgId]
  const bindings = useQuery({
    queryKey,
    queryFn: async () =>
      (await ImBindingsService.bindingsReadImBindings({ path })).data,
    refetchInterval: 5000,
  })
  const create = useMutation({
    mutationFn: async () =>
      (await ImBindingsService.bindingsCreateImBindCode({ path })).data,
    onSuccess: (data) => {
      setCode(data)
      setMessage("")
    },
    onError: handleError.bind(setMessage),
  })
  const remove = useMutation({
    mutationFn: (platform: Platform) =>
      ImBindingsService.bindingsDeleteImBinding({
        path: { ...path, platform },
      }),
    onSuccess: () => {
      setCode(undefined)
      setMessage(t("settings.im.unboundMessage"))
      client.invalidateQueries({ queryKey })
    },
    onError: handleError.bind(setMessage),
  })
  const notification = useMutation({
    mutationFn: ({
      platform,
      notify,
    }: {
      platform: Platform
      notify: boolean
    }) =>
      ImBindingsService.bindingsUpdateImBindingNotify({
        path: { ...path, platform },
        body: { notify },
      }),
    onSuccess: () => {
      setMessage(t("settings.im.notifySavedMessage"))
      client.invalidateQueries({ queryKey })
    },
    onError: handleError.bind(setMessage),
  })
  if (bindings.isPending) return <ProfileLoading />
  if (bindings.isError) return <ProfileError retry={bindings.refetch} />
  return (
    <section aria-label={t("settings.im.ariaLabel")}>
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <div>
          <h3 className="text-sm font-medium">{t("settings.im.title")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("settings.im.description")}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={create.isPending}
          onClick={() => {
            setCode(undefined)
            create.mutate()
          }}
        >
          {code
            ? t("settings.im.regenerateCode")
            : t("settings.im.generateCode")}
        </Button>
      </header>
      {code && (
        <div
          className="mx-4 mb-3 space-y-1 rounded-md border bg-muted/30 p-3 text-sm"
          aria-live="polite"
        >
          <p>{t("settings.im.sendInDm")}</p>
          <p
            className="font-mono text-2xl tracking-widest"
            data-testid="im-bind-code"
          >
            {t("settings.im.bindCommand", { code: code.code })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("settings.im.codeHint", {
              expiresAt: formatDate(code.expires_at, { timeStyle: "medium" }),
            })}
          </p>
        </div>
      )}
      <section
        className="divide-y border-t"
        aria-label={t("settings.im.boundAccountsAria")}
      >
        {bindings.data.length === 0 && (
          <p className="px-4 py-2.5 text-sm text-muted-foreground">
            {t("settings.im.empty")}
          </p>
        )}
        {bindings.data.map((row) => (
          <div
            key={row.platform}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <p className="min-w-0 wrap-anywhere font-medium">
                  {names[row.platform]} · {row.external_user_id}
                </p>
                <Badge
                  variant="outline"
                  className={
                    row.active
                      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "text-muted-foreground"
                  }
                >
                  {row.active
                    ? t("settings.im.boundBadge")
                    : t("settings.im.expiredBadge")}
                </Badge>
              </div>
              {!row.active && (
                <p className="text-xs text-muted-foreground">
                  {t("settings.im.expiredHint")}
                </p>
              )}
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
              <label
                className="flex items-center gap-2 text-sm"
                htmlFor={`notify-${row.platform}`}
              >
                <Checkbox
                  id={`notify-${row.platform}`}
                  checked={row.notify}
                  disabled={notification.isPending}
                  onCheckedChange={(checked) =>
                    notification.mutate({
                      platform: row.platform,
                      notify: checked === true,
                    })
                  }
                  aria-label={t("settings.im.notifyAria", {
                    platform: names[row.platform],
                  })}
                />
                {t("settings.im.notifyLabel")}
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={remove.isPending}
                onClick={() => remove.mutate(row.platform)}
                aria-label={t("settings.im.unbindAria", {
                  platform: names[row.platform],
                })}
              >
                {t("settings.im.unbind")}
              </Button>
            </div>
          </div>
        ))}
      </section>
      <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
        {t("settings.im.footerNote")}
      </p>
      {message && (
        <p className="px-4 pb-2.5 text-sm" role="status">
          {message}
        </p>
      )}
    </section>
  )
}
