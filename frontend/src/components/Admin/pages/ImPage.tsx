import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MessagesSquare, Send, Zap } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type ImSettingPublic,
  ImSettingsService,
  type ImSettingUpdate,
} from "@/client"
import { ChangeHistory } from "@/components/Admin/ChangeHistory"
import { DraftField } from "@/components/AdminAssistant/DraftField"
import { PageDraft } from "@/components/AdminAssistant/PageDraft"
import { usePageDraft } from "@/components/AdminAssistant/usePageDraft"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { useOrg } from "@/hooks/useOrg"
import { formatDate } from "@/i18n/format"
import { IntegrationCard } from "./IntegrationCard"

function usePlatforms() {
  const { t } = useTranslation()
  return {
    feishu: {
      name: t("admin.imPage.platforms.feishu.name"),
      icon: (
        <Zap
          aria-hidden="true"
          className="size-8 rounded-lg bg-blue-500/10 p-2 text-blue-600 dark:text-blue-300"
        />
      ),
      description: t("admin.imPage.platforms.feishu.description"),
      fields: {
        app_id: t("admin.imPage.platforms.feishu.fields.app_id"),
        app_secret: t("admin.imPage.platforms.feishu.fields.app_secret"),
      },
    },
    wecom: {
      name: t("admin.imPage.platforms.wecom.name"),
      icon: (
        <MessagesSquare
          aria-hidden="true"
          className="size-8 rounded-lg bg-emerald-500/10 p-2 text-emerald-700 dark:text-emerald-300"
        />
      ),
      description: t("admin.imPage.platforms.wecom.description"),
      fields: {
        bot_id: t("admin.imPage.platforms.wecom.fields.bot_id"),
        secret: t("admin.imPage.platforms.wecom.fields.secret"),
        corp_id: t("admin.imPage.platforms.wecom.fields.corp_id"),
        contact_secret: t("admin.imPage.platforms.wecom.fields.contact_secret"),
      },
    },
    telegram: {
      name: t("admin.imPage.platforms.telegram.name"),
      icon: (
        <Send
          aria-hidden="true"
          className="size-8 rounded-lg bg-sky-500/10 p-2 text-sky-700 dark:text-sky-300"
        />
      ),
      description: t("admin.imPage.platforms.telegram.description"),
      fields: {
        bot_token: t("admin.imPage.platforms.telegram.fields.bot_token"),
      },
    },
  }
}

export function ImPage() {
  const { t } = useTranslation()
  const { org, roles } = useOrg()
  if (!org) return <OrgState />
  if (!roles.includes("org_admin"))
    return <p role="alert">{t("admin.common.orgAdminRequired")}</p>
  return <Settings key={org.id} orgId={org.id} />
}

function Settings({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const platforms = usePlatforms()
  const assistant = usePageDraft(orgId, "update_im_setting")
  const settings = useQuery({
    queryKey: ["im-settings", orgId],
    queryFn: async () =>
      (
        await ImSettingsService.settingsGetImSettings({
          path: { org_id: orgId },
        })
      ).data,
  })
  if (settings.isPending) return <ProfileLoading />
  if (settings.isError) return <ProfileError retry={() => settings.refetch()} />
  return (
    <div className="space-y-4">
      <h1 className="sr-only">{t("admin.imPage.heading")}</h1>
      <TopbarActions>
        <ChangeHistory targetType="im_setting" variant="drawer" />
      </TopbarActions>
      <PageDraft
        orgId={orgId}
        draft={assistant.draft}
        error={assistant.error}
      />
      <p className="text-sm text-muted-foreground">{t("admin.imPage.intro")}</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {settings.data.map((setting) => {
          const platform = platforms[setting.platform]
          const suggestion =
            setting.platform === "feishu" ? assistant : undefined
          return (
            <IntegrationCard
              key={setting.platform}
              name={platform.name}
              icon={platform.icon}
              description={platform.description}
              status={
                setting.enabled
                  ? t("admin.imPage.statusEnabled")
                  : t("admin.imPage.statusDisabled")
              }
              active={setting.enabled}
              detail={
                setting.has_credentials
                  ? t("admin.imPage.credentialsSet")
                  : t("admin.imPage.credentialsUnset")
              }
              suggested={!!suggestion?.draft}
            >
              <PlatformSetting
                key={suggestion?.draft?.id}
                orgId={orgId}
                setting={setting}
                suggestion={suggestion}
              />
            </IntegrationCard>
          )
        })}
      </div>
    </div>
  )
}

function PlatformSetting({
  orgId,
  setting,
  suggestion,
}: {
  orgId: string
  setting: ImSettingPublic
  suggestion?: ReturnType<typeof usePageDraft>
}) {
  const { t } = useTranslation()
  const platforms = usePlatforms()
  const client = useQueryClient()
  const platform = platforms[setting.platform]
  const path = { org_id: orgId, platform: setting.platform }
  const [draft, setDraft] = useState<ImSettingUpdate | null>(null)
  const value = suggestion?.values(draft ?? setting) ?? draft ?? setting
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [acknowledged, setAcknowledged] = useState(false)
  const save = useMutation({
    mutationFn: () =>
      ImSettingsService.settingsPutImSetting({
        path,
        body: {
          enabled: value.enabled,
          email_auto_bind: value.email_auto_bind,
          credentials,
          data_transfer_acknowledged: acknowledged,
        },
      }),
    onSuccess: ({ data }) => {
      client.setQueryData<ImSettingPublic[]>(["im-settings", orgId], (rows) =>
        rows?.map((row) => (row.platform === data.platform ? data : row)),
      )
      setCredentials({})
      setDraft(null)
      setAcknowledged(false)
      test.reset()
    },
  })
  const test = useMutation({
    mutationFn: () => ImSettingsService.settingsTestImConnection({ path }),
  })
  return (
    <form
      className="space-y-4"
      aria-label={platform.name}
      onSubmit={(event) => {
        event.preventDefault()
        if (suggestion?.blocked || (value.enabled && !acknowledged)) return
        save.mutate()
      }}
    >
      <fieldset
        disabled={save.isPending || suggestion?.blocked}
        className="min-w-0 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3">
          <div>
            <p className="text-xs text-muted-foreground">
              {setting.has_credentials
                ? t("admin.imPage.credentialsSet")
                : t("admin.imPage.credentialsUnset")}
              {setting.updated_at &&
                t("admin.imPage.credentialsUpdatedAt", {
                  time: formatDate(setting.updated_at, {
                    dateStyle: "short",
                    timeStyle: "medium",
                  }),
                })}
            </p>
          </div>
          <DraftField changed={suggestion?.changed("enabled") ?? false}>
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor={`${setting.platform}-enabled`}
            >
              <Checkbox
                id={`${setting.platform}-enabled`}
                checked={value.enabled}
                disabled={save.isPending}
                onCheckedChange={(checked) => {
                  setDraft({ ...value, enabled: checked === true })
                  setAcknowledged(false)
                  save.reset()
                }}
              />
              {t("admin.imPage.enableChannel")}
            </label>
          </DraftField>
        </div>
        <p id="im-credentials-help" className="text-xs text-muted-foreground">
          {t("admin.imPage.credentialsHelp")}
        </p>
        <div className="grid gap-3">
          {Object.entries(platform.fields).map(([field, label]) => (
            <div key={field} className="space-y-2 text-sm">
              <label htmlFor={`${setting.platform}-${field}`}>{label}</label>
              <Input
                id={`${setting.platform}-${field}`}
                aria-describedby="im-credentials-help"
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                value={credentials[field] ?? ""}
                placeholder={t("admin.imPage.credentialsPlaceholder")}
                disabled={save.isPending}
                onChange={(event) => {
                  setCredentials({
                    ...credentials,
                    [field]: event.target.value,
                  })
                  save.reset()
                  test.reset()
                }}
              />
            </div>
          ))}
        </div>
        {setting.platform !== "telegram" && (
          <DraftField changed={suggestion?.changed("email_auto_bind") ?? false}>
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor={`${setting.platform}-email`}
            >
              <Checkbox
                id={`${setting.platform}-email`}
                checked={value.email_auto_bind ?? setting.email_auto_bind}
                disabled={save.isPending}
                onCheckedChange={(checked) => {
                  setDraft({ ...value, email_auto_bind: checked === true })
                  save.reset()
                }}
              />
              {t("admin.imPage.autoBindLabel")}
            </label>
            <p className="text-sm text-muted-foreground">
              {t("admin.imPage.autoBindHelp")}
            </p>
          </DraftField>
        )}
        {setting.platform === "wecom" && (
          <p className="text-sm text-muted-foreground">
            {t("admin.imPage.wecomNote")}
          </p>
        )}
        {value.enabled && (
          <aside className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
            <p className="font-medium">{t("admin.imPage.dataTransferTitle")}</p>
            <p>{t("admin.imPage.dataTransferBody")}</p>
            {setting.platform === "telegram" && (
              <p>{t("admin.imPage.telegramLocationNote")}</p>
            )}
            <label
              className="flex items-center gap-2"
              htmlFor={`${setting.platform}-acknowledged`}
            >
              <Checkbox
                id={`${setting.platform}-acknowledged`}
                checked={acknowledged}
                disabled={save.isPending}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              {t("admin.imPage.acknowledgeLabel")}
            </label>
          </aside>
        )}
        <SetupError error={save.error ?? test.error} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={
              save.isPending ||
              test.isPending ||
              (value.enabled && !acknowledged)
            }
          >
            {save.isPending ? t("admin.common.saving") : t("admin.common.save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              !setting.has_credentials ||
              save.isPending ||
              test.isPending ||
              Object.values(credentials).some(Boolean)
            }
            onClick={() => test.mutate()}
          >
            {test.isPending
              ? t("admin.imPage.testPending")
              : setting.platform === "wecom" && setting.enabled
                ? t("admin.imPage.testWecomHeartbeat")
                : t("admin.imPage.testConnection")}
          </Button>
        </div>
        {save.isSuccess && <p role="status">{t("admin.imPage.saved")}</p>}
        {test.data && (
          <p role={test.data.data.ok ? "status" : "alert"}>
            {test.data.data.message}
          </p>
        )}
      </fieldset>
    </form>
  )
}
