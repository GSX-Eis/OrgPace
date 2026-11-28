import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { overlaps, weekRange } from "./dateUtils"
import {
  forecastOccupiedPercent,
  forecastSourceLabel,
  formatCapacityPercent,
  formatIsoDateRange,
  hasForecast,
  occupiedPercent,
  regularCapPercent,
  weekLabel,
  weekLoadLabel,
} from "./shared"
import {
  segmentKinds,
  useTaskSegments,
  type WorkloadSelection,
} from "./WorkloadGanttShared"

export function WorkloadDetails({
  selection: { row, range, title },
  defaultAllocationCapPercent = 70,
}: {
  selection: WorkloadSelection
  defaultAllocationCapPercent?: number
}) {
  const { t } = useTranslation()
  const allSegments = useTaskSegments(row)
  const segments = useMemo(
    () => allSegments.filter((segment) => overlaps(segment, range)),
    [allSegments, range],
  )
  const taskKinds = useMemo(
    () =>
      (["committed", "borrow", "hold"] as const).filter((kind) =>
        segments.some((segment) => segment.kind === kind),
      ),
    [segments],
  )
  const matchingWeeks = useMemo(
    () =>
      row.weeks.filter((week) => overlaps(weekRange(week.week_start), range)),
    [row.weeks, range],
  )

  return (
    <>
      <p className="break-words text-sm text-muted-foreground">
        {title} · {formatIsoDateRange(range.start_date, range.end_date)}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("capacity.gantt.jiraLine")}
        {row.jira_task_count === null
          ? t("capacity.gantt.jiraUnlinked")
          : t("capacity.gantt.jiraIncomplete", {
              count: row.jira_task_count,
            })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("capacity.gantt.lastConfirmedLine")}
        {row.last_confirmed
          ? t("capacity.gantt.lastConfirmedValue", {
              percent: formatCapacityPercent(row.last_confirmed.percent),
              week: weekLabel(row.last_confirmed.week_start),
            })
          : t("capacity.gantt.lastConfirmedEmpty")}
      </p>

      <ul className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm">
        {matchingWeeks.map((week) => {
          const dates = weekRange(week.week_start)
          let visibleAssigned = 0
          let visibleHeld = 0
          for (const segment of allSegments) {
            if (!overlaps(dates, segment)) continue
            if (segment.kind === "hold") {
              visibleHeld += segment.allocation_percent
            } else {
              visibleAssigned += segment.allocation_percent
            }
          }
          const held = week.hold_percent ?? 0
          const assigned = week.platform_percent - held
          const total = occupiedPercent(week)
          const remaining = week.capacity_percent - total
          const hasLeave =
            week.capacity_percent < 100 ||
            (row.unavailabilities ?? []).some((item) => overlaps(dates, item))
          const hidden =
            Math.max(0, assigned - visibleAssigned) +
            Math.max(0, held - visibleHeld)
          const forecast = hasForecast(week)
          const regularCap = regularCapPercent(
            week,
            defaultAllocationCapPercent,
          )
          const elasticSpace = Math.max(0, week.capacity_percent - regularCap)
          const currentTotal = forecast ? forecastOccupiedPercent(week) : total
          const elasticUsed =
            week.status === "confirmed" || forecast
              ? Math.max(0, currentTotal - regularCap)
              : 0
          return (
            <li key={week.week_start} className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-1 font-medium">
                <span>{weekLabel(week.week_start)}</span>
                <span className="tabular-nums">{weekLoadLabel(week)}</span>
              </div>
              <dl className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 text-xs tabular-nums">
                <dt className="text-muted-foreground">
                  {t("capacity.gantt.otherWorkLabel")}
                </dt>
                <dd>
                  {week.other_percent === null
                    ? t("capacity.gantt.unconfirmed")
                    : formatCapacityPercent(week.other_percent)}
                </dd>
                <dt className="text-muted-foreground">
                  {t("capacity.gantt.platformAllocLabel")}
                </dt>
                <dd>{formatCapacityPercent(assigned)}</dd>
                {held > 0 && (
                  <>
                    <dt className="text-muted-foreground">
                      {t("capacity.gantt.holdLabel")}
                    </dt>
                    <dd>{formatCapacityPercent(held)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">
                  {t("capacity.gantt.capLabel")}
                </dt>
                <dd>{formatCapacityPercent(week.capacity_percent)}</dd>
                {week.status === "confirmed" && (
                  <>
                    <dt className="text-muted-foreground">
                      {remaining < 0
                        ? t("capacity.gantt.overloadLabel")
                        : t("capacity.gantt.remainingLabel")}
                    </dt>
                    <dd
                      className={cn(
                        "font-medium",
                        remaining < 0 && "text-red-700 dark:text-red-300",
                      )}
                    >
                      {remaining < 0
                        ? `+${formatCapacityPercent(-remaining)}`
                        : formatCapacityPercent(remaining)}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">
                  {t("capacity.gantt.leaveLabel")}
                </dt>
                <dd>
                  {hasLeave
                    ? t("capacity.gantt.leaveYes")
                    : t("capacity.gantt.leaveNo")}
                </dd>
              </dl>
              <p className="text-xs text-muted-foreground tabular-nums">
                {t("capacity.gantt.regularCapLine", {
                  regular: formatCapacityPercent(regularCap),
                  elastic: formatCapacityPercent(elasticSpace),
                })}
              </p>
              {elasticUsed > 0 && (
                <p className="text-xs font-medium text-amber-800 tabular-nums dark:text-amber-300">
                  {t("capacity.gantt.elasticBreakLine", {
                    percent: formatCapacityPercent(elasticUsed),
                  })}
                </p>
              )}
              {forecast && (
                <div className="space-y-1.5 rounded border border-dashed border-sky-500/40 bg-sky-500/5 p-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-1 font-medium text-sky-900 dark:text-sky-200">
                    <span>{forecastSourceLabel(week.forecast_source)}</span>
                    <span className="tabular-nums">
                      {t("capacity.gantt.forecastCardSummary", {
                        other: formatCapacityPercent(
                          week.forecast_other_percent ?? 0,
                        ),
                        total: formatCapacityPercent(
                          forecastOccupiedPercent(week),
                        ),
                      })}
                    </span>
                  </div>
                  {(week.forecast_policy_label ||
                    (week.forecast_events?.length ?? 0) > 0) && (
                    <div className="flex flex-wrap items-center gap-1">
                      {week.forecast_policy_label && (
                        <Badge
                          variant="secondary"
                          className="max-w-full whitespace-normal text-[11px] font-normal"
                        >
                          {t("capacity.gantt.forecastPolicyBadge", {
                            label: week.forecast_policy_label,
                          })}
                        </Badge>
                      )}
                      {week.forecast_events?.map((eventLabel) => (
                        <Badge
                          key={eventLabel}
                          variant="outline"
                          className="max-w-full whitespace-normal border-amber-500/40 bg-amber-500/10 text-[11px] font-normal text-amber-900 dark:text-amber-200"
                        >
                          {t("capacity.gantt.forecastEventBadge", {
                            label: eventLabel,
                          })}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {week.forecast_basis && (
                    <p className="text-muted-foreground">
                      {t("capacity.gantt.forecastSource", {
                        basis: week.forecast_basis,
                      })}
                    </p>
                  )}
                </div>
              )}
              {hidden > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("capacity.gantt.hiddenLoad", {
                    percent: formatCapacityPercent(hidden),
                  })}
                </p>
              )}
            </li>
          )
        })}
      </ul>
      <div className="space-y-3 text-sm">
        {!taskKinds.length && (
          <p className="text-xs text-muted-foreground">
            {t("capacity.gantt.noPlatformTasks")}
          </p>
        )}
        {taskKinds.map((kind) => {
          const matching = segments.filter((segment) => segment.kind === kind)
          const label = t(segmentKinds[kind].labelKey)
          return (
            <section key={kind} aria-label={label} className="space-y-1.5">
              <Badge variant="outline">{label}</Badge>
              <ul className="space-y-1.5">
                {matching.map((segment) => (
                  <li key={segment.id} className="break-words border-l-2 pl-2">
                    <p className="font-medium">{segment.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {segment.requesting_department_name} ·{" "}
                      {formatIsoDateRange(segment.start_date, segment.end_date)}
                      {segment.note && ` · ${segment.note}`}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </>
  )
}
