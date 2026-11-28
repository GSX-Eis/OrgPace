import { useTranslation } from "react-i18next"
import type { DepartmentPublic } from "@/client"
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
import { cn } from "@/lib/utils"
import {
  formatRetentionPreview,
  ORG_SCOPE_VALUE,
  type PolicyDraft,
  RECOMMENDED_RETENTION_RATES,
} from "./ForecastPolicyShared"

export function ForecastPolicyForm({
  mode,
  title,
  draft,
  editableDepartments,
  jobFamilies,
  isPending,
  validationError,
  submitError,
  onChange,
  onClearValidation,
  onCancel,
  onSubmit,
}: {
  mode: "admin" | "manager"
  title: string
  draft: PolicyDraft
  editableDepartments: DepartmentPublic[]
  jobFamilies: string[]
  isPending: boolean
  validationError: string | null
  submitError: Error | null
  onChange: (updater: (prev: PolicyDraft) => PolicyDraft) => void
  onClearValidation: () => void
  onCancel: () => void
  onSubmit: (event: React.FormEvent) => void
}) {
  const { t } = useTranslation()
  const parsedRetention = Number(draft.retentionRate.trim())
  const activeHintKey =
    draft.retentionRate.trim() !== "" && Number.isFinite(parsedRetention)
      ? RECOMMENDED_RETENTION_RATES.find(
          (item) => item.rate === parsedRetention,
        )?.hintKey
      : undefined

  return (
    <form
      aria-label={title}
      className="space-y-3 rounded-md border bg-muted/20 p-3"
      onSubmit={onSubmit}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isPending}
          onClick={onCancel}
        >
          {t("capacity.common.cancel")}
        </Button>
      </div>

      <fieldset disabled={isPending} className="min-w-0 space-y-3">
        <div className="grid gap-3 @sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="policy-department">
              {t("capacity.forecastPolicy.deptLabel")}
            </Label>
            <Select
              value={draft.departmentValue}
              onValueChange={(value) =>
                onChange((prev) => ({ ...prev, departmentValue: value }))
              }
            >
              <SelectTrigger id="policy-department" className="w-full">
                <SelectValue
                  placeholder={t("capacity.forecastPolicy.deptPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {mode === "admin" && (
                  <SelectItem value={ORG_SCOPE_VALUE}>
                    {t("capacity.forecastPolicy.scopeOrgDefault")}
                  </SelectItem>
                )}
                {editableDepartments.map((dept) => (
                  <SelectItem key={dept.id} value={dept.id}>
                    {dept.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="policy-job-family">
              {t("capacity.forecastPolicy.jobFamilyLabel")}
            </Label>
            <Input
              id="policy-job-family"
              list="policy-job-family-options"
              maxLength={50}
              placeholder={t("capacity.forecastPolicy.jobFamilyPlaceholder")}
              value={draft.jobFamily}
              onChange={(e) =>
                onChange((prev) => ({ ...prev, jobFamily: e.target.value }))
              }
            />
            <datalist id="policy-job-family-options">
              {jobFamilies.map((jf) => (
                <option key={jf} value={jf} />
              ))}
            </datalist>
            {jobFamilies.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                <button
                  type="button"
                  className={cn(
                    "rounded border px-1.5 py-0.5 text-[11px]",
                    !draft.jobFamily.trim()
                      ? "border-primary bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                  onClick={() =>
                    onChange((prev) => ({ ...prev, jobFamily: "" }))
                  }
                >
                  {t("capacity.forecastPolicy.unlimitedJobFamily")}
                </button>
                {jobFamilies.map((jf) => (
                  <button
                    key={jf}
                    type="button"
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[11px]",
                      draft.jobFamily.trim() === jf
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                    onClick={() =>
                      onChange((prev) => ({ ...prev, jobFamily: jf }))
                    }
                  >
                    {jf}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium">
            {t("capacity.forecastPolicy.recommendedLabel")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {RECOMMENDED_RETENTION_RATES.map((item) => {
              const selected =
                draft.retentionRate.trim() !== "" &&
                parsedRetention === item.rate
              return (
                <Button
                  key={item.value}
                  type="button"
                  size="sm"
                  variant={selected ? "default" : "outline"}
                  aria-pressed={selected}
                  onClick={() => {
                    onClearValidation()
                    onChange((prev) => ({
                      ...prev,
                      retentionRate: item.value,
                    }))
                  }}
                >
                  {t(item.labelKey)}
                </Button>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {activeHintKey
              ? t(activeHintKey)
              : t("capacity.forecastPolicy.recommendedFallbackHint")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="policy-retention-rate">
            {t("capacity.forecastPolicy.retentionRateLabel")}
          </Label>
          <Input
            id="policy-retention-rate"
            type="number"
            min={0}
            max={1}
            step="0.05"
            required
            value={draft.retentionRate}
            onChange={(e) =>
              onChange((prev) => ({ ...prev, retentionRate: e.target.value }))
            }
          />
          <p className="text-[11px] text-muted-foreground">
            {t("capacity.forecastPolicy.retentionRateHint")}
          </p>
          <output
            aria-label={t("capacity.forecastPolicy.previewAria")}
            className="block rounded-md border border-dashed bg-background px-2.5 py-1.5 text-xs text-muted-foreground tabular-nums"
          >
            {formatRetentionPreview(draft.retentionRate)}
          </output>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="policy-note">
            {t("capacity.forecastPolicy.policyNoteLabel")}
          </Label>
          <Input
            id="policy-note"
            maxLength={200}
            placeholder={t("capacity.forecastPolicy.policyNotePlaceholder")}
            value={draft.note}
            onChange={(e) =>
              onChange((prev) => ({ ...prev, note: e.target.value }))
            }
          />
        </div>

        {validationError && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
          >
            {validationError}
          </p>
        )}
        <SetupError error={submitError} />

        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit">
            {isPending
              ? t("capacity.common.saving")
              : t("capacity.forecastPolicy.savePolicyBtn")}
          </Button>
          <Button size="sm" type="button" variant="outline" onClick={onCancel}>
            {t("capacity.common.cancel")}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
