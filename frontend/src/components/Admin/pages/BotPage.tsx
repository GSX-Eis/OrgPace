import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type BotSettings,
  BotSettingsService,
  ModelSettingService,
} from "@/client"
import { ChangeHistory } from "@/components/Admin/ChangeHistory"
import { DraftField } from "@/components/AdminAssistant/DraftField"
import { PageDraft } from "@/components/AdminAssistant/PageDraft"
import { usePageDraft } from "@/components/AdminAssistant/usePageDraft"
import {
  SectionCard,
  WorkspacePage,
} from "@/components/Common/WorkbenchPrimitives"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useOrg } from "@/hooks/useOrg"

export function BotPage() {
  const { t } = useTranslation()
  const { org, roles } = useOrg()
  if (!org) return <OrgState />
  if (!roles.includes("org_admin"))
    return <p role="alert">{t("admin.common.orgAdminRequired")}</p>
  return <Settings key={org.id} orgId={org.id} />
}

function Settings({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const path = { org_id: orgId }
  const [draft, setDraft] = useState<BotSettings | null>(null)
  const setting = useQuery({
    queryKey: ["bot-settings", orgId],
    queryFn: async () =>
      (await BotSettingsService.settingsGetBotSettings({ path })).data,
  })
  const model = useQuery({
    queryKey: ["model-setting", orgId],
    queryFn: async () =>
      (await ModelSettingService.settingGetModelSetting({ path })).data,
  })
  const save = useMutation({
    mutationFn: () =>
      BotSettingsService.settingsPutBotSettings({
        path,
        body: draft ?? setting.data ?? {},
      }),
    onSuccess: ({ data }) => {
      client.setQueryData(["bot-settings", orgId], data)
      setDraft(null)
    },
  })
  const resetManual = useCallback(() => setDraft(null), [])
  const pageDraft = usePageDraft(orgId, "update_bot_settings", resetManual)
  if (setting.isPending || model.isPending) return <ProfileLoading />
  if (setting.isError || model.isError)
    return (
      <ProfileError
        retry={() => {
          setting.refetch()
          model.refetch()
        }}
      />
    )
  const value = pageDraft.values(draft ?? setting.data)
  return (
    <WorkspacePage
      variant="form"
      className="grid items-start gap-4 min-[1100px]:grid-cols-[minmax(0,65fr)_minmax(0,35fr)]"
    >
      <h1 className="sr-only">{t("admin.botPage.heading")}</h1>
      <SectionCard
        aria-label={t("admin.botPage.configAriaLabel")}
        className="space-y-3"
      >
        <PageDraft
          orgId={orgId}
          draft={pageDraft.draft}
          error={pageDraft.error}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <fieldset
            className="min-w-0 space-y-3 text-sm"
            disabled={pageDraft.blocked || save.isPending}
          >
            <DraftField changed={pageDraft.changed("question_guide")}>
              <label className="block space-y-1 font-medium">
                {t("admin.botPage.questionGuideLabel")}
                <textarea
                  aria-label={t("admin.botPage.questionGuideLabel")}
                  className="min-h-28 w-full rounded-md border bg-background p-2 font-normal"
                  maxLength={4000}
                  value={value.question_guide ?? ""}
                  disabled={save.isPending}
                  onChange={(event) => {
                    setDraft({ ...value, question_guide: event.target.value })
                    save.reset()
                  }}
                  placeholder={t("admin.botPage.questionGuidePlaceholder")}
                />
              </label>
            </DraftField>
            <p className="text-sm text-muted-foreground">
              {t("admin.botPage.questionGuideHint")}
            </p>
            <details className="space-y-2 rounded-md border border-surface-border p-3">
              <summary className="cursor-pointer font-medium">
                {t("admin.botPage.retentionSummary")}
              </summary>
              <DraftField changed={pageDraft.changed("retention_days")}>
                <label
                  className="block space-y-1 font-medium"
                  htmlFor="bot-retention"
                >
                  {t("admin.botPage.retentionDaysLabel")}
                  <Input
                    id="bot-retention"
                    type="number"
                    min={0}
                    max={30}
                    step={1}
                    required
                    value={value.retention_days ?? 0}
                    disabled={save.isPending}
                    onChange={(event) => {
                      setDraft({
                        ...value,
                        retention_days: Number(event.target.value),
                      })
                      save.reset()
                    }}
                  />
                </label>
              </DraftField>
              <p className="text-sm text-muted-foreground">
                {t("admin.botPage.retentionHint")}
              </p>
            </details>
            <SetupError error={save.error} />
            <Button size="sm" disabled={save.isPending}>
              {save.isPending
                ? t("admin.common.saving")
                : t("admin.common.save")}
            </Button>
            {save.isSuccess && <p role="status">{t("admin.botPage.saved")}</p>}
          </fieldset>
        </form>
      </SectionCard>
      <aside className="min-w-0">
        <SectionCard
          className="space-y-3 text-sm"
          aria-label={t("admin.botPage.modelAsideAriaLabel")}
        >
          <h2 className="font-semibold">
            {t("admin.botPage.currentModelTitle")}
          </h2>
          <p className="[overflow-wrap:anywhere] font-medium">
            {model.data.enabled
              ? model.data.model
              : t("admin.botPage.modelDisabledHint")}
          </p>
          {model.data.enabled && model.data.kind === "chatgpt_subscription" && (
            <p className="text-muted-foreground">
              {t("admin.botPage.chatgptQuotaHint")}
            </p>
          )}
          <p className="text-muted-foreground">
            {t("admin.botPage.rateLimitHint")}
          </p>
          <div className="flex flex-wrap items-center gap-2 border-t border-surface-border pt-3">
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/model">
                {t("admin.botPage.goToModelSettings")}
              </Link>
            </Button>
            <ChangeHistory targetType="bot_setting" variant="drawer" />
          </div>
        </SectionCard>
      </aside>
    </WorkspacePage>
  )
}
