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
import { type EventDraft, ORG_SCOPE_VALUE } from "./ForecastPolicyShared"

export function ForecastEventForm({
  mode,
  draft,
  editableDepartments,
  jobFamilies,
  isPending,
  validationError,
  submitError,
  onChange,
  onCancel,
  onSubmit,
}: {
  mode: "admin" | "manager"
  draft: EventDraft
  editableDepartments: DepartmentPublic[]
  jobFamilies: string[]
  isPending: boolean
  validationError: string | null
  submitError: Error | null
  onChange: (updater: (prev: EventDraft) => EventDraft) => void
  onCancel: () => void
  onSubmit: (event: React.FormEvent) => void
}) {
  const { t } = useTranslation()
  const title = draft.editingId
    ? t("capacity.forecastPolicy.editEventTitle")
    : t("capacity.forecastPolicy.addEventBtn")

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
        <div className="space-y-1.5">
          <Label htmlFor="event-title">
            {t("capacity.forecastPolicy.eventTitleLabel")}
          </Label>
          <Input
            id="event-title"
            maxLength={100}
            required
            placeholder={t("capacity.forecastPolicy.eventTitlePlaceholder")}
            value={draft.title}
            onChange={(e) =>
              onChange((prev) => ({ ...prev, title: e.target.value }))
            }
          />
        </div>

        <div className="grid gap-3 @sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="event-department">
              {t("capacity.forecastPolicy.deptLabel")}
            </Label>
            <Select
              value={draft.departmentValue}
              onValueChange={(value) =>
                onChange((prev) => ({ ...prev, departmentValue: value }))
              }
            >
              <SelectTrigger id="event-department" className="w-full">
                <SelectValue
                  placeholder={t("capacity.forecastPolicy.deptPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {mode === "admin" && (
                  <SelectItem value={ORG_SCOPE_VALUE}>
                    {t("capacity.forecastPolicy.scopeAllOrg")}
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
            <Label htmlFor="event-job-family">
              {t("capacity.forecastPolicy.jobFamilyLabel")}
            </Label>
            <Input
              id="event-job-family"
              list="event-job-family-options"
              maxLength={50}
              placeholder={t(
                "capacity.forecastPolicy.eventJobFamilyPlaceholder",
              )}
              value={draft.jobFamily}
              onChange={(e) =>
                onChange((prev) => ({ ...prev, jobFamily: e.target.value }))
              }
            />
            <datalist id="event-job-family-options">
              {jobFamilies.map((jf) => (
                <option key={jf} value={jf} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="grid gap-3 @sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="event-start-week">
              {t("capacity.forecastPolicy.startWeekMonday")}
            </Label>
            <Input
              id="event-start-week"
              type="date"
              min="1970-01-05"
              step={7}
              required
              value={draft.startWeek}
              onChange={(e) => {
                const next = e.target.value
                onChange((prev) => ({
                  ...prev,
                  startWeek: next,
                  endWeek:
                    prev.endWeek.localeCompare(next) < 0 ? next : prev.endWeek,
                }))
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="event-end-week">
              {t("capacity.forecastPolicy.endWeekMonday")}
            </Label>
            <Input
              id="event-end-week"
              type="date"
              min={draft.startWeek}
              step={7}
              required
              value={draft.endWeek}
              onChange={(e) =>
                onChange((prev) => ({ ...prev, endWeek: e.target.value }))
              }
            />
          </div>
        </div>

        <div className="grid gap-3 @sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="event-modifier-kind">
              {t("capacity.forecastPolicy.modifierKindLabel")}
            </Label>
            <Select
              value={draft.modifierKind}
              onValueChange={(value) =>
                onChange((prev) => ({
                  ...prev,
                  modifierKind: value === "delta" ? "delta" : "multiplier",
                }))
              }
            >
              <SelectTrigger id="event-modifier-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="multiplier">
                  {t("capacity.forecastPolicy.modifierMultiplier")}
                </SelectItem>
                <SelectItem value="delta">
                  {t("capacity.forecastPolicy.modifierDelta")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="event-modifier-value">
              {t("capacity.forecastPolicy.modifierValueLabel")}
            </Label>
            <Input
              id="event-modifier-value"
              type="number"
              min={draft.modifierKind === "multiplier" ? 0 : -100}
              max={draft.modifierKind === "multiplier" ? 2 : 100}
              step={draft.modifierKind === "multiplier" ? "0.05" : "1"}
              required
              placeholder={
                draft.modifierKind === "multiplier"
                  ? t("capacity.forecastPolicy.modifierPlaceholderMultiplier")
                  : t("capacity.forecastPolicy.modifierPlaceholderDelta")
              }
              value={draft.modifierValue}
              onChange={(e) =>
                onChange((prev) => ({ ...prev, modifierValue: e.target.value }))
              }
            />
            <p className="text-[11px] text-muted-foreground">
              {draft.modifierKind === "multiplier"
                ? t("capacity.forecastPolicy.modifierHintMultiplier")
                : t("capacity.forecastPolicy.modifierHintDelta")}
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="event-reason">
            {t("capacity.forecastPolicy.eventReasonLabel")}
          </Label>
          <Input
            id="event-reason"
            maxLength={300}
            required
            placeholder={t("capacity.forecastPolicy.eventReasonPlaceholder")}
            value={draft.reason}
            onChange={(e) =>
              onChange((prev) => ({ ...prev, reason: e.target.value }))
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
              : t("capacity.forecastPolicy.saveEventBtn")}
          </Button>
          <Button size="sm" type="button" variant="outline" onClick={onCancel}>
            {t("capacity.common.cancel")}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
