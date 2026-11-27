import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CapacityService, type CapacitySettingsInput } from "@/client"
import { RulesLayout } from "@/components/Admin/RulesLayout"
import { HelpTip, SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
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
import { useOrg } from "@/hooks/useOrg"
import { ForecastPolicyPanel } from "./ForecastPolicyPanel"
import { formatCapacityPercent, useCapacitySettings } from "./shared"

export function CapacitySettings() {
  const { org } = useOrg()
  return org && <SettingsForm key={org.id} orgId={org.id} />
}

function SettingsForm({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const settings = useCapacitySettings(orgId)
  const [changes, setChanges] = useState<CapacitySettingsInput | null>(null)
  const [capInput, setCapInput] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (body: CapacitySettingsInput) =>
      CapacityService.putCapacitySettings({ path: { org_id: orgId }, body }),
    onSuccess: ({ data }) => {
      client.setQueryData(["capacity-settings", orgId], data)
      client.removeQueries({ queryKey: ["capacity", orgId] })
      setChanges(null)
      setCapInput(null)
    },
  })
  if (settings.isPending) return <ProfileLoading />
  if (settings.isError) return <ProfileError retry={() => settings.refetch()} />
  const savedCap = settings.data.default_allocation_cap_percent ?? 70
  const current: CapacitySettingsInput = changes ?? {
    ...settings.data,
    default_allocation_cap_percent: savedCap,
  }
  const displayCap =
    capInput ?? String(current.default_allocation_cap_percent ?? 70)
  const parsedCap = Number(displayCap)
  const validCap =
    displayCap !== "" &&
    Number.isInteger(parsedCap) &&
    parsedCap >= 50 &&
    parsedCap <= 100
  return (
    <RulesLayout
      summary={[
        [
          t("capacity.settings.featureLabel"),
          settings.data.enabled
            ? t("capacity.settings.enabled")
            : t("capacity.settings.disabled"),
        ],
        [
          t("capacity.settings.requesterPolicyLabel"),
          settings.data.requester_policy === "managers"
            ? t("capacity.settings.managersOnly")
            : t("capacity.settings.everyone"),
        ],
        [
          t("capacity.settings.quotaLabel"),
          `${formatCapacityPercent(savedCap)} / ${formatCapacityPercent(100 - savedCap)}`,
        ],
      ]}
      history={
        <SectionCard
          aria-label={t("capacity.settings.impactAria")}
          className="space-y-2 p-3"
        >
          <h2 className="text-sm font-semibold">
            {t("capacity.settings.impactAria")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("capacity.settings.impactDesc")}
          </p>
        </SectionCard>
      }
    >
      <SectionCard className="space-y-3 p-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">
            {t("capacity.settings.cardTitle")}
          </h2>
          <HelpTip
            label={t("capacity.settings.helpLabel")}
            content={t("capacity.settings.helpContent")}
          />
        </div>
        <form
          aria-label={t("capacity.settings.formAria")}
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate(current)
          }}
        >
          <fieldset disabled={save.isPending} className="min-w-0 space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={current.enabled}
                onChange={(event) =>
                  setChanges({ ...current, enabled: event.target.checked })
                }
              />
              {t("capacity.settings.enableCheckbox")}
            </label>
            <div className="space-y-2">
              <Label htmlFor="requester-policy">
                {t("capacity.settings.whoCanRequest")}
              </Label>
              <Select
                value={current.requester_policy}
                onValueChange={(value) =>
                  setChanges({
                    ...current,
                    requester_policy:
                      value === "managers" ? "managers" : "everyone",
                  })
                }
              >
                <SelectTrigger
                  id="requester-policy"
                  size="sm"
                  className="w-full sm:max-w-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="everyone">
                    {t("capacity.settings.everyone")}
                  </SelectItem>
                  <SelectItem value="managers">
                    {t("capacity.settings.managersOnly")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="default-allocation-cap">
                {t("capacity.settings.defaultCapLabel")}
              </Label>
              <Input
                id="default-allocation-cap"
                type="number"
                min={50}
                max={100}
                step={1}
                required
                className="w-full sm:max-w-xs"
                value={displayCap}
                onChange={(event) => {
                  const raw = event.target.value
                  setCapInput(raw)
                  const num = Number(raw)
                  setChanges({
                    ...current,
                    default_allocation_cap_percent: Number.isInteger(num)
                      ? num
                      : (current.default_allocation_cap_percent ?? 70),
                  })
                }}
              />
              <p className="text-xs text-muted-foreground">
                {validCap
                  ? t("capacity.settings.elasticHint", {
                      percent: 100 - parsedCap,
                    })
                  : t("capacity.settings.capError")}
              </p>
            </div>
            <SetupError error={save.error} />
            <Button size="sm" type="submit" disabled={!changes || !validCap}>
              {save.isPending
                ? t("capacity.common.saving")
                : t("capacity.settings.saveBtn")}
            </Button>
          </fieldset>
          {save.isSuccess && !changes && (
            <p role="status">{t("capacity.settings.savedStatus")}</p>
          )}
        </form>
      </SectionCard>
      {settings.data.enabled && (
        <ForecastPolicyPanel orgId={orgId} mode="admin" />
      )}
    </RulesLayout>
  )
}
