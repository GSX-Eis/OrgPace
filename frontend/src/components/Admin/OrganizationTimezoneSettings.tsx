import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { DraftingSettingsService } from "@/client"
import { HelpTip, SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { i18n } from "@/i18n"
import { handleError } from "@/utils"

const timezoneIds = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Pacific/Auckland",
  "UTC",
] as const

export function timezoneLabel(timezone: string) {
  if ((timezoneIds as readonly string[]).includes(timezone)) {
    return i18n.t(`admin.timezone.zones.${timezone}`)
  }
  return timezone
}

export function useOrganizationTimezone(orgId: string) {
  return useQuery({
    queryKey: ["org-timezone", orgId],
    queryFn: async () =>
      (
        await DraftingSettingsService.settingsGetOrgTimezone({
          path: { org_id: orgId },
        })
      ).data,
  })
}

export function OrganizationTimezoneSettings({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const settings = useOrganizationTimezone(orgId)
  const save = useMutation({
    mutationFn: (timezone: string) =>
      DraftingSettingsService.settingsPutOrgTimezone({
        path: { org_id: orgId },
        body: { timezone },
      }),
    onSuccess: ({ data }) => {
      client.setQueryData(["org-timezone", orgId], data)
      setSelected(null)
      setMessage(t("admin.timezone.savedMessage"))
    },
    onError: (error) => handleError.call(setMessage, error),
  })
  if (settings.isPending) return <ProfileLoading />
  if (settings.isError) return <ProfileError retry={() => settings.refetch()} />
  const timezone = selected ?? settings.data.timezone
  return (
    <SectionCard
      className="space-y-3 p-3"
      aria-label={t("admin.timezone.sectionAriaLabel")}
    >
      <div className="flex items-center gap-2">
        <Label htmlFor="org-timezone" className="font-semibold">
          {t("admin.timezone.label")}
        </Label>
        <HelpTip
          label={t("admin.timezone.tipLabel")}
          content={t("admin.timezone.tipContent")}
        />
      </div>
      <Select
        value={timezone}
        disabled={save.isPending}
        onValueChange={(value) => {
          setSelected(value)
          setMessage("")
        }}
      >
        <SelectTrigger
          id="org-timezone"
          size="sm"
          title={timezone}
          className="w-full sm:max-w-md"
        >
          <SelectValue>{timezoneLabel(timezone)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {timezoneIds.map((value) => (
            <SelectItem key={value} value={value}>
              {t("admin.timezone.optionWithId", {
                label: timezoneLabel(value),
                value,
              })}
            </SelectItem>
          ))}
          {!(timezoneIds as readonly string[]).includes(timezone) && (
            <SelectItem value={timezone}>{timezone}</SelectItem>
          )}
        </SelectContent>
      </Select>
      {message && <p role={save.isError ? "alert" : "status"}>{message}</p>}
      <Button
        type="button"
        size="sm"
        onClick={() => save.mutate(timezone)}
        disabled={save.isPending || timezone === settings.data.timezone}
      >
        {save.isPending
          ? t("admin.common.saving")
          : t("admin.timezone.saveButton")}
      </Button>
    </SectionCard>
  )
}
