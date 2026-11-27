import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { DraftingSettingsService, type UpdateSettingsInput } from "@/client"
import { ChangeHistory } from "@/components/Admin/ChangeHistory"
import { localeRecord } from "@/components/Admin/labels"
import {
  OrganizationTimezoneSettings,
  timezoneLabel,
  useOrganizationTimezone,
} from "@/components/Admin/OrganizationTimezoneSettings"
import { RulesLayout } from "@/components/Admin/RulesLayout"
import { DraftField } from "@/components/AdminAssistant/DraftField"
import { PageDraft } from "@/components/AdminAssistant/PageDraft"
import { usePageDraft } from "@/components/AdminAssistant/usePageDraft"
import { HelpTip, SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { handleError } from "@/utils"

const schedules = localeRecord(
  {
    quarterly: "",
    yearly: "",
    off: "",
  },
  "admin.updateSettings.schedules",
)

export function UpdateSettings({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [changes, setChanges] = useState<UpdateSettingsInput | null>(null)
  const suggestion = usePageDraft(
    orgId,
    "update_update_settings",
    useCallback(() => setChanges(null), []),
  )
  const [message, setMessage] = useState("")
  const settings = useQuery({
    queryKey: ["update-settings", orgId],
    queryFn: async () =>
      (
        await DraftingSettingsService.settingsGetUpdateSettings({
          path: { org_id: orgId },
        })
      ).data,
  })
  const timezone = useOrganizationTimezone(orgId)
  const save = useMutation({
    mutationFn: (body: UpdateSettingsInput) =>
      DraftingSettingsService.settingsPutUpdateSettings({
        path: { org_id: orgId },
        body,
      }),
    onSuccess: ({ data }) => {
      client.setQueryData(["update-settings", orgId], data)
      client.invalidateQueries({ queryKey: ["profile", orgId] })
      setChanges(null)
      setMessage(t("admin.updateSettings.savedMessage"))
    },
    onError: (error) => handleError.call(setMessage, error),
  })
  if (settings.isPending) return <ProfileLoading />
  if (settings.isError) return <ProfileError retry={() => settings.refetch()} />
  const current = suggestion.values(changes ?? settings.data)
  return (
    <RulesLayout
      summary={[
        [
          t("admin.updateSettings.summary.schedule"),
          schedules[settings.data.reminder_schedule ?? "quarterly"],
        ],
        [
          t("admin.updateSettings.summary.staleAfter"),
          t("admin.updateSettings.summary.monthsCount", {
            months: settings.data.stale_after_months ?? 24,
          }),
        ],
        [
          t("admin.updateSettings.summary.timezone"),
          timezone.data ? timezoneLabel(timezone.data.timezone) : "—",
        ],
      ]}
      history={<ChangeHistory targetType="update_setting" variant="compact" />}
    >
      <SectionCard className="space-y-3 p-3" aria-labelledby="updates-title">
        <div className="flex items-center gap-2">
          <h2 id="updates-title" className="text-sm font-semibold">
            {t("admin.updateSettings.sectionTitle")}
          </h2>
          <HelpTip
            label={t("admin.updateSettings.tipLabel")}
            content={t("admin.updateSettings.tipContent")}
          />
        </div>
        <PageDraft
          orgId={orgId}
          draft={suggestion.draft}
          error={suggestion.error}
        />
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (suggestion.blocked) return
            save.mutate({
              reminder_schedule: current.reminder_schedule,
              stale_after_months: current.stale_after_months,
            })
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <DraftField changed={suggestion.changed("reminder_schedule")}>
              <Label htmlFor="reminder-schedule" className="mb-1.5">
                {t("admin.updateSettings.scheduleLabel")}
              </Label>
              <Select
                value={current.reminder_schedule}
                disabled={save.isPending || suggestion.blocked}
                onValueChange={(
                  value: NonNullable<UpdateSettingsInput["reminder_schedule"]>,
                ) => {
                  setChanges({ ...current, reminder_schedule: value })
                  setMessage("")
                }}
              >
                <SelectTrigger
                  id="reminder-schedule"
                  size="sm"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(schedules).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DraftField>
            <DraftField changed={suggestion.changed("stale_after_months")}>
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <Label htmlFor="stale-months">
                  {t("admin.updateSettings.staleMonthsLabel")}
                </Label>
                <HelpTip
                  label={t("admin.updateSettings.staleMonthsTipLabel")}
                  content={t("admin.updateSettings.staleMonthsTipContent")}
                />
              </div>
              <Input
                id="stale-months"
                className="h-8"
                type="number"
                min={6}
                max={120}
                required
                value={current.stale_after_months}
                disabled={save.isPending || suggestion.blocked}
                onChange={(e) => {
                  setChanges({
                    ...current,
                    stale_after_months: Number(e.target.value),
                  })
                  setMessage("")
                }}
              />
            </DraftField>
          </div>
          {message && <p role={save.isError ? "alert" : "status"}>{message}</p>}
          <Button
            size="sm"
            disabled={save.isPending || suggestion.blocked || !changes}
            type="submit"
          >
            {save.isPending
              ? t("admin.common.saving")
              : t("admin.updateSettings.saveButton")}
          </Button>
        </form>
      </SectionCard>
      <OrganizationTimezoneSettings orgId={orgId} />
    </RulesLayout>
  )
}
