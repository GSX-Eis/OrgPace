import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { CapacityService, type WorkloadPublic } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import i18n, { getLocale } from "@/i18n"
import { formatDate } from "@/i18n/format"
import { overlaps, parseIsoDateUtc, weekdaysIso, weekRange } from "./dateUtils"
import { invalidateWorkloadMutation } from "./queries"
import { weekLabel } from "./shared"

const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri"] as const

function weekdaysOf(mondayIso: string, locale: string = getLocale()) {
  const days = weekdaysIso(mondayIso)
  if (!days.length) return []
  const translate = i18n.getFixedT(locale)
  return days.map((iso, index) => {
    const key = WEEKDAY_KEYS[index]
    const datePart =
      locale === "en"
        ? formatDate(iso, { month: "numeric", day: "numeric" })
        : iso.slice(5).replace("-", "/")
    return {
      date: iso,
      label: `${translate(`capacity.team.weekdays.${key}`)} ${datePart}`,
    }
  })
}

function weekLeaveDates(workload: WorkloadPublic, targetWeek: string) {
  return weekdaysOf(targetWeek)
    .map((day) => day.date)
    .filter((day) =>
      (workload.unavailabilities ?? []).some(
        (item) => item.start_date <= day && day <= item.end_date,
      ),
    )
}

export function Adjustment({
  orgId,
  workload,
  week,
  initialPercent,
  close,
}: {
  orgId: string
  workload: WorkloadPublic
  week: string
  initialPercent?: number
  close: () => void
}) {
  const { t, i18n: activeI18n } = useTranslation()
  const locale = activeI18n.resolvedLanguage ?? activeI18n.language
  const client = useQueryClient()
  const [start, setStart] = useState(week)
  const [end, setEnd] = useState(week)
  const activeWeek = parseIsoDateUtc(start) ? start : week
  const currentWeekLoad = workload.weeks.find(
    (item) => item.week_start === activeWeek,
  )
  const weekDays = useMemo(
    () => weekdaysOf(activeWeek, locale),
    [activeWeek, locale],
  )
  const initialLeaveDates = useMemo(
    () => weekLeaveDates(workload, activeWeek),
    [workload, activeWeek],
  )
  const initialCap = currentWeekLoad?.capacity_percent ?? 100
  const initialLeave =
    initialCap < 100 ||
    initialLeaveDates.length > 0 ||
    (workload.unavailabilities ?? []).some((item) =>
      overlaps(weekRange(activeWeek), item),
    )
  const [percent, setPercent] = useState(
    String(
      initialPercent ??
        currentWeekLoad?.other_percent ??
        workload.last_confirmed?.percent ??
        "",
    ),
  )
  const [capacityCap, setCapacityCap] = useState(String(initialCap))
  const [onLeave, setOnLeave] = useState(initialLeave)
  const [selectedLeaveDates, setSelectedLeaveDates] =
    useState<string[]>(initialLeaveDates)
  const [leaveModified, setLeaveModified] = useState(false)
  const [dateError, setDateError] = useState<string | null>(null)
  const isSingleWeek = start === end
  const parsedCap = Number(capacityCap)
  const validCap =
    capacityCap !== "" &&
    Number.isFinite(parsedCap) &&
    parsedCap >= 0 &&
    parsedCap <= 100 &&
    parsedCap % 20 === 0
  const requiredDays = validCap ? (100 - parsedCap) / 20 : null
  const showWeekdayPicker =
    isSingleWeek && (leaveModified || initialLeaveDates.length > 0)
  const addedDays = selectedLeaveDates.filter(
    (day) => !initialLeaveDates.includes(day),
  )
  const removedDays = initialLeaveDates.filter(
    (day) => !selectedLeaveDates.includes(day),
  )
  const sep = t("capacity.common.listSeparator")
  const semi = t("capacity.common.semicolonSeparator")
  const save = useMutation({
    mutationFn: () =>
      CapacityService.setCapacityWeeks({
        path: { org_id: orgId },
        body: {
          items: [
            {
              employee_id: workload.employee_id,
              other_percent: Number(percent),
              ...(isSingleWeek && leaveModified
                ? {
                    capacity_percent: Number(capacityCap),
                    on_leave: onLeave,
                    leave_dates: selectedLeaveDates,
                  }
                : {}),
            },
          ],
          start_week: start,
          end_week: end,
        },
      }),
    onSuccess: () => {
      void invalidateWorkloadMutation(client, orgId, {
        inbox: true,
        unavailability: true,
      })
      close()
    },
  })
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!isSingleWeek && leaveModified) {
          setDateError(t("capacity.team.crossWeekError"))
          return
        }
        if (
          isSingleWeek &&
          leaveModified &&
          requiredDays !== null &&
          selectedLeaveDates.length !== requiredDays
        ) {
          setDateError(
            t("capacity.team.leaveDaysMismatchError", {
              cap: parsedCap,
              required: requiredDays,
              selected: selectedLeaveDates.length,
            }),
          )
          return
        }
        setDateError(null)
        save.mutate()
      }}
    >
      <fieldset disabled={save.isPending} className="space-y-4">
        <div className="grid gap-3 min-[420px]:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="start-week">
              {t("capacity.workload.startWeek")}
            </Label>
            <Input
              id="start-week"
              type="date"
              min="1970-01-05"
              step={7}
              required
              value={start}
              onChange={(event) => {
                const next = event.target.value
                setStart(next)
                setDateError(null)
                if (end < next) setEnd(next)
                if (parseIsoDateUtc(next)) {
                  const nextLoad = workload.weeks.find(
                    (item) => item.week_start === next,
                  )
                  const nextDates = weekLeaveDates(workload, next)
                  const nextCap = nextLoad?.capacity_percent ?? 100
                  setCapacityCap(String(nextCap))
                  setOnLeave(nextCap < 100 || nextDates.length > 0)
                  setSelectedLeaveDates(nextDates)
                  setLeaveModified(false)
                }
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="end-week">{t("capacity.workload.endWeek")}</Label>
            <Input
              id="end-week"
              type="date"
              min={start}
              step={7}
              required
              value={end}
              onChange={(event) => {
                setEnd(event.target.value)
                setDateError(null)
              }}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="base-percent">
            {t("capacity.team.basePercentLabel")}
          </Label>
          <Input
            id="base-percent"
            type="number"
            min={0}
            max={200}
            step={1}
            required
            value={percent}
            onChange={(event) => setPercent(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="capacity-percent">
            {t("capacity.team.capPercentLabel")}
          </Label>
          <Input
            id="capacity-percent"
            type="number"
            min={0}
            max={100}
            step={20}
            required
            disabled={!isSingleWeek}
            value={capacityCap}
            onChange={(event) => {
              const next = event.target.value
              setCapacityCap(next)
              setLeaveModified(true)
              setDateError(null)
              const parsed = Number(next)
              if (next !== "" && Number.isFinite(parsed)) {
                setOnLeave(parsed < 100)
                if (parsed >= 100) {
                  setSelectedLeaveDates([])
                } else if (parsed === initialCap) {
                  setSelectedLeaveDates(initialLeaveDates)
                }
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            {t("capacity.team.capHint")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="on-leave"
            checked={onLeave}
            disabled={!isSingleWeek}
            onCheckedChange={(checked) => {
              const next = checked === true
              setOnLeave(next)
              setLeaveModified(true)
              setDateError(null)
              if (next && Number(capacityCap) >= 100) {
                setCapacityCap("80")
              } else if (!next) {
                setCapacityCap("100")
                setSelectedLeaveDates([])
              }
            }}
          />
          <Label htmlFor="on-leave">{t("capacity.team.onLeaveLabel")}</Label>
        </div>
        {showWeekdayPicker && (
          <fieldset
            aria-label={t("capacity.team.leavePickerAria")}
            className="space-y-2 rounded-md border bg-muted/30 p-3"
          >
            <legend className="px-1 text-xs font-medium">
              {t("capacity.team.leavePickerLegend", {
                week: weekLabel(activeWeek),
              })}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {weekDays.map((day) => {
                const checked = selectedLeaveDates.includes(day.date)
                return (
                  <div
                    key={day.date}
                    className="flex items-center gap-2 text-xs"
                  >
                    <Checkbox
                      id={`leave-day-${day.date}`}
                      checked={checked}
                      aria-label={day.label}
                      onCheckedChange={(value) => {
                        const isChecked = value === true
                        const nextDates = weekDays
                          .map((d) => d.date)
                          .filter((d) =>
                            isChecked
                              ? d === day.date || selectedLeaveDates.includes(d)
                              : d !== day.date &&
                                selectedLeaveDates.includes(d),
                          )
                        setSelectedLeaveDates(nextDates)
                        setLeaveModified(true)
                        setDateError(null)
                        setCapacityCap(String(100 - nextDates.length * 20))
                        setOnLeave(nextDates.length > 0)
                      }}
                    />
                    <Label
                      htmlFor={`leave-day-${day.date}`}
                      className="cursor-pointer text-xs font-normal"
                    >
                      {day.label}
                    </Label>
                  </div>
                )
              })}
            </div>
            {leaveModified &&
              requiredDays !== null &&
              selectedLeaveDates.length !== requiredDays && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {selectedLeaveDates.length < requiredDays
                    ? t("capacity.team.leaveNeedMore", {
                        count: requiredDays - selectedLeaveDates.length,
                        selected: selectedLeaveDates.length,
                        required: requiredDays,
                      })
                    : t("capacity.team.leaveNeedLess", {
                        count: selectedLeaveDates.length - requiredDays,
                        selected: selectedLeaveDates.length,
                        required: requiredDays,
                      })}
                </p>
              )}
            {leaveModified &&
              (addedDays.length > 0 || removedDays.length > 0) && (
                <p className="text-xs text-muted-foreground">
                  {addedDays.length > 0 &&
                    t("capacity.team.leaveAdded", {
                      days: addedDays.join(sep),
                    })}
                  {addedDays.length > 0 && removedDays.length > 0 && semi}
                  {removedDays.length > 0 &&
                    t("capacity.team.leaveRemoved", {
                      days: removedDays.join(sep),
                    })}
                </p>
              )}
          </fieldset>
        )}
        {!isSingleWeek && (
          <p className="text-xs text-muted-foreground">
            {t("capacity.team.crossWeekNote")}
          </p>
        )}
        {dateError && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 p-3 text-xs text-destructive"
          >
            {dateError}
          </div>
        )}
        <SetupError error={save.error} />
        <Button type="submit">
          {save.isPending
            ? t("capacity.common.saving")
            : t("capacity.team.confirmSettingsBtn")}
        </Button>
      </fieldset>
    </form>
  )
}

export function ForecastAdjustment({
  orgId,
  workload,
  week,
  close,
}: {
  orgId: string
  workload: WorkloadPublic
  week: string
  close: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const currentWeekLoad = workload.weeks.find(
    (item) => item.week_start === week,
  )
  const [start, setStart] = useState(week)
  const [end, setEnd] = useState(week)
  const [percent, setPercent] = useState(
    String(
      currentWeekLoad?.forecast_other_percent ??
        workload.last_confirmed?.percent ??
        "",
    ),
  )
  const [note, setNote] = useState("")
  const save = useMutation({
    mutationFn: () =>
      CapacityService.overrideCapacityForecasts({
        path: { org_id: orgId },
        body: {
          employee_id: workload.employee_id,
          start_week: start,
          end_week: end,
          forecast_other_percent: Number(percent),
          note: note.trim() ? note.trim() : null,
        },
      }),
    onSuccess: () => {
      void invalidateWorkloadMutation(client, orgId)
      close()
    },
  })
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <fieldset disabled={save.isPending} className="space-y-4">
        <div className="grid gap-3 min-[420px]:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="forecast-start-week">
              {t("capacity.workload.startWeek")}
            </Label>
            <Input
              id="forecast-start-week"
              type="date"
              min="1970-01-05"
              step={7}
              required
              value={start}
              onChange={(event) => {
                const next = event.target.value
                setStart(next)
                if (end < next) setEnd(next)
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="forecast-end-week">
              {t("capacity.workload.endWeek")}
            </Label>
            <Input
              id="forecast-end-week"
              type="date"
              min={start}
              step={7}
              required
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="forecast-other-percent">
            {t("capacity.team.forecastOtherLabel")}
          </Label>
          <Input
            id="forecast-other-percent"
            type="number"
            min={0}
            max={200}
            step={1}
            required
            value={percent}
            onChange={(event) => setPercent(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="forecast-note">
            {t("capacity.team.forecastNoteLabel")}
          </Label>
          <Input
            id="forecast-note"
            maxLength={200}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <SetupError error={save.error} />
        <Button type="submit">
          {save.isPending
            ? t("capacity.common.saving")
            : t("capacity.team.saveForecastBtn")}
        </Button>
      </fieldset>
    </form>
  )
}
