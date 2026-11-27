import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plug, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AccessTokensService, type McpSettingPublic } from "@/client"
import { ChangeHistory } from "@/components/Admin/ChangeHistory"
import { DraftField } from "@/components/AdminAssistant/DraftField"
import { PageDraft } from "@/components/AdminAssistant/PageDraft"
import { usePageDraft } from "@/components/AdminAssistant/usePageDraft"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { useOrg } from "@/hooks/useOrg"
import { handleError } from "@/utils"
import { IntegrationCard } from "./IntegrationCard"

export function AssistantsPage() {
  const { t } = useTranslation()
  const { org, roles } = useOrg()
  if (!org) return <OrgState />
  if (!roles.includes("org_admin"))
    return <p role="alert">{t("admin.common.orgAdminRequired")}</p>
  return <Settings key={org.id} orgId={org.id} />
}

function Settings({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const suggestion = usePageDraft(orgId, "update_mcp_setting")
  const path = { org_id: orgId }
  const setting = useQuery({
    queryKey: ["mcp-setting", orgId],
    queryFn: async () =>
      (await AccessTokensService.readMcpSetting({ path })).data,
  })
  if (setting.isPending) return <ProfileLoading />
  if (setting.isError) return <ProfileError retry={() => setting.refetch()} />
  const allowedClients = setting.data.allowed_clients?.length ?? 0
  return (
    <div className="space-y-4">
      <h1 className="sr-only">{t("admin.assistantsPage.heading")}</h1>
      <TopbarActions>
        <ChangeHistory targetType="mcp_setting" variant="drawer" />
      </TopbarActions>
      <PageDraft
        orgId={orgId}
        draft={suggestion.draft}
        error={suggestion.error}
      />
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-sm">
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
        />
        <p>{t("admin.assistantsPage.dataWarning")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <IntegrationCard
          name={t("admin.assistantsPage.cardName")}
          icon={
            <Plug
              aria-hidden="true"
              className="size-8 rounded-lg bg-violet-500/10 p-2 text-violet-700 dark:text-violet-300"
            />
          }
          description={t("admin.assistantsPage.cardDesc")}
          status={
            setting.data.enabled
              ? t("admin.assistantsPage.statusEnabled")
              : t("admin.assistantsPage.statusDisabled")
          }
          active={setting.data.enabled}
          detail={
            allowedClients
              ? t("admin.assistantsPage.allowedClientsCount", {
                  count: allowedClients,
                })
              : t("admin.assistantsPage.allowedClientsAll")
          }
          suggested={!!suggestion.draft}
        >
          <AssistantSettings
            key={suggestion.draft?.id}
            orgId={orgId}
            setting={setting.data}
            suggestion={suggestion}
          />
        </IntegrationCard>
      </div>
    </div>
  )
}

function AssistantSettings({
  orgId,
  setting,
  suggestion,
}: {
  orgId: string
  setting: McpSettingPublic
  suggestion: ReturnType<typeof usePageDraft>
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [clients, setClients] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [message, setMessage] = useState("")
  const current = suggestion.values({
    enabled: enabled ?? setting.enabled,
    allowed_clients:
      clients === null ? setting.allowed_clients : clients.split(/[,，]/),
  })
  const requiresAcknowledgement = current.enabled && !setting.enabled
  const save = useMutation({
    mutationFn: () =>
      AccessTokensService.updateMcpSetting({
        path: { org_id: orgId },
        body: {
          enabled: current.enabled,
          allowed_clients: (current.allowed_clients ?? [])
            .map((name) => name.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: ({ data }) => {
      client.setQueryData(["mcp-setting", orgId], data)
      setEnabled(null)
      setClients(null)
      setAcknowledged(false)
      setMessage(t("admin.assistantsPage.saved"))
    },
    onError: handleError.bind(setMessage),
  })
  const blocked = save.isPending || suggestion.blocked
  const joinSep = t("admin.assistantsPage.allowedClientsJoin")
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (blocked || (requiresAcknowledgement && !acknowledged)) return
        save.mutate()
      }}
    >
      <DraftField changed={suggestion.changed("enabled")}>
        <label
          htmlFor="mcp-enabled"
          className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm font-medium"
        >
          <Checkbox
            id="mcp-enabled"
            checked={current.enabled}
            onCheckedChange={(value) => {
              setEnabled(value === true)
              setAcknowledged(false)
              setMessage("")
            }}
            disabled={blocked}
          />
          {t("admin.assistantsPage.allowCheckbox")}
        </label>
      </DraftField>
      <DraftField changed={suggestion.changed("allowed_clients")}>
        <label htmlFor="mcp-clients" className="block space-y-2 text-sm">
          {t("admin.assistantsPage.allowedClientsLabel")}
          <Input
            id="mcp-clients"
            value={
              suggestion.draft
                ? (current.allowed_clients ?? []).join(joinSep)
                : (clients ?? (setting.allowed_clients ?? []).join(joinSep))
            }
            onChange={(event) => {
              setClients(event.target.value)
              setMessage("")
            }}
            placeholder={t("admin.assistantsPage.allowedClientsPlaceholder")}
            disabled={blocked}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {t("admin.assistantsPage.allowedClientsHelp")}
        </p>
      </DraftField>
      {requiresAcknowledgement && (
        <label
          htmlFor="mcp-acknowledged"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
        >
          <Checkbox
            id="mcp-acknowledged"
            className="mt-0.5"
            checked={acknowledged}
            disabled={blocked}
            onCheckedChange={(value) => setAcknowledged(value === true)}
          />
          {t("admin.assistantsPage.acknowledgeCheckbox")}
        </label>
      )}
      <Button disabled={blocked || (requiresAcknowledgement && !acknowledged)}>
        {save.isPending ? t("admin.common.saving") : t("admin.common.save")}
      </Button>
      {message && <p role="status">{message}</p>}
    </form>
  )
}
