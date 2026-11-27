import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ModelSettingService } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"

export function ChatGptConnect({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const path = { org_id: orgId }
  const [redirect, setRedirect] = useState("")
  const [now, setNow] = useState(Date.now())
  const status = useQuery({
    queryKey: ["chatgpt", orgId],
    queryFn: async () =>
      (await ModelSettingService.settingPollChatgptLogin({ path })).data,
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 5000 : false),
  })
  useEffect(() => {
    if (status.data?.status !== "pending") return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status.data?.status])
  const start = useMutation({
    mutationFn: () => ModelSettingService.settingStartChatgptLogin({ path }),
    onSuccess: ({ data }) => client.setQueryData(["chatgpt", orgId], data),
  })
  const complete = useMutation({
    mutationFn: () =>
      ModelSettingService.settingCompleteChatgptLogin({
        path,
        body: { input: redirect },
      }),
    onSuccess: ({ data }) => {
      client.setQueryData(["chatgpt", orgId], data)
      setRedirect("")
      client.invalidateQueries({ queryKey: ["model-setting", orgId] })
    },
  })
  const cancel = useMutation({
    mutationFn: () => ModelSettingService.settingCancelChatgptLogin({ path }),
    onSuccess: ({ data }) => {
      client.setQueryData(["chatgpt", orgId], data)
      setRedirect("")
    },
  })
  const disconnect = useMutation({
    mutationFn: () => ModelSettingService.settingDisconnectChatgpt({ path }),
    onSuccess: () => {
      client.setQueryData(["chatgpt", orgId], { status: "none" })
      client.invalidateQueries({ queryKey: ["model-setting", orgId] })
    },
  })
  const data = status.data
  const remaining = data?.expires_at
    ? Math.max(0, Math.ceil((Date.parse(data.expires_at) - now) / 1000))
    : 0
  return (
    <section
      className="space-y-4 rounded-lg border bg-muted/20 p-4"
      aria-label={t("admin.chatGpt.sectionAriaLabel")}
    >
      <SetupError
        error={
          status.error ??
          start.error ??
          complete.error ??
          cancel.error ??
          disconnect.error
        }
      />
      {data?.account?.needs_relogin && (
        <p role="alert">{t("admin.chatGpt.needsRelogin")}</p>
      )}
      {data?.status === "connected" && !data.account?.needs_relogin ? (
        <>
          <p role="status">
            {t("admin.chatGpt.connectedStatus", {
              account: data.account?.email ?? data.account?.account_id ?? "",
              plan: data.account?.plan_type ?? "",
            })}
          </p>
          <p>{t("admin.chatGpt.disconnectNote")}</p>
          <Button
            type="button"
            variant="outline"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {t("admin.chatGpt.disconnect")}
          </Button>
        </>
      ) : data?.status === "pending" && remaining > 0 ? (
        <>
          <p>{t("admin.chatGpt.pendingInstructions")}</p>
          <a
            className="break-all underline"
            href={data.verification_url ?? undefined}
            target="_blank"
            rel="noreferrer"
          >
            {t("admin.chatGpt.openAuthPage")}
          </a>
          <label className="block">
            {t("admin.chatGpt.redirectUrlLabel")}
            <input
              className="w-full rounded border p-2"
              value={redirect}
              onChange={(e) => setRedirect(e.target.value)}
              autoComplete="off"
            />
          </label>
          <Button
            type="button"
            disabled={!redirect || complete.isPending}
            onClick={() => complete.mutate()}
          >
            {t("admin.chatGpt.completeConnect")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={cancel.isPending || complete.isPending}
            onClick={() => cancel.mutate()}
          >
            {t("admin.chatGpt.cancelConnect")}
          </Button>
          <p role="status">
            {t("admin.chatGpt.remainingMinutes", {
              minutes: Math.ceil(remaining / 60),
            })}
          </p>
        </>
      ) : (
        <>
          {data?.message && <p role="alert">{data.message}</p>}
          {(data?.status === "expired" || data?.status === "pending") && (
            <p>{t("admin.chatGpt.expiredNotice")}</p>
          )}
          <Button
            type="button"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {t("admin.chatGpt.connectButton")}
          </Button>
        </>
      )}

      <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
        <li>{t("admin.chatGpt.note1")}</li>
        <li>{t("admin.chatGpt.note2")}</li>
        <li>{t("admin.chatGpt.note3")}</li>
      </ul>
    </section>
  )
}
