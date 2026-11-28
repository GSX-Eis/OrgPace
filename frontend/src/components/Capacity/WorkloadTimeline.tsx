import { type ComponentProps, type ReactNode, useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { WeekLoad, WorkloadPublic } from "@/client"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import i18n from "@/i18n"
import { formatDate } from "@/i18n/format"
import { cn } from "@/lib/utils"
import { addWeeks, DAY_MS, overlaps, weekRange } from "./dateUtils"
import {
  forecastOccupiedPercent,
  forecastSourceLabel,
  forecastSurface,
  formatCapacityPercent,
  formatIsoDateRange,
  hasForecast,
  loadBandLabel,
  loadColors,
  occupiedPercent,
  regularCapPercent,
  unavailableStripes,
  weekBand,
  weekLabel,
  weekLoadLabel,
} from "./shared"
import {
  baseline,
  segmentKinds,
  taskSegmentsFor,
  type WorkloadSelection,
} from "./WorkloadGanttShared"

function otherWork(week: WeekLoad) {
  return week.other_percent === null
    ? i18n.t("capacity.gantt.otherWorkUnconfirmed")
    : i18n.t("capacity.gantt.otherWorkValue", {
        percent: formatCapacityPercent(week.other_percent),
      })
}

export function CurrentWeekLine({
  weeks,
  current,
}: {
  weeks: WeekLoad[]
  current: string
}) {
  const index = weeks.findIndex((week) => week.week_start === current)
  return index < 0 ? null : (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 z-10 border-l-2 border-primary"
      style={{ left: `${index * 12.5}%` }}
    />
  )
}

export function WeekHeader({
  weeks,
  current,
}: {
  weeks: WeekLoad[]
  current: string
}) {
  const { t } = useTranslation()
  return (
    <div className="grid grid-cols-8 border-b bg-muted/60">
      {weeks.map(({ week_start }) => (
        <div
          key={week_start}
          className={cn(
            "flex items-center justify-between gap-1 border-r px-2.5 py-2 text-xs font-medium last:border-r-0",
            week_start === current && "bg-primary/10 text-primary",
          )}
        >
          <time dateTime={week_start}>{weekLabel(week_start)}</time>
          {week_start === current && (
            <span className="font-semibold">
              {t("capacity.gantt.thisWeek")}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function TimelineButton({
  tooltip,
  ...props
}: ComponentProps<"button"> & { tooltip: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-haspopup="dialog" {...props} />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-words">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export function Timeline({
  row,
  activeWeek,
  defaultAllocationCapPercent = 70,
  onSelect,
}: {
  row: WorkloadPublic
  activeWeek?: string
  defaultAllocationCapPercent?: number
  onSelect: (selection: WorkloadSelection, opener: HTMLButtonElement) => void
}) {
  const { t } = useTranslation()
  const weeks = row.weeks
  const first = weeks[0].week_start
  const firstMs = useMemo(() => Date.parse(first), [first])
  const end = addWeeks(first, weeks.length)
  const dayIndex = (date: string) => (Date.parse(date) - firstMs) / DAY_MS
  const segments = useMemo(() => taskSegmentsFor(row), [row])
  const sep = t("capacity.common.listSeparator")

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-8">
        {weeks.map((week) => {
          const range = weekRange(week.week_start)
          const label = weekLoadLabel(week)
          const band = weekBand(week)
          const state = loadBandLabel(band)
          const unavailable =
            week.capacity_percent < 100 ||
            (row.unavailabilities ?? []).some((item) => overlaps(range, item))
          const allocation = week.platform_percent - (week.hold_percent ?? 0)
          const forecast = hasForecast(week)
          const forecastTotal = forecast ? forecastOccupiedPercent(week) : null
          const regularCap = regularCapPercent(
            week,
            defaultAllocationCapPercent,
          )
          const forecastTag = forecast
            ? forecastSourceLabel(week.forecast_source)
            : null
          const effectiveTotal = forecast
            ? (forecastTotal ?? 0)
            : week.status === "confirmed"
              ? occupiedPercent(week)
              : 0
          const elasticUsed =
            forecast || week.status === "confirmed"
              ? Math.max(0, effectiveTotal - regularCap)
              : 0
          const forecastEvents = forecast ? (week.forecast_events ?? []) : []
          const forecastTooltip = forecast
            ? [
                t("capacity.gantt.forecastTooltip", {
                  tag: forecastTag ?? "",
                  percent: formatCapacityPercent(
                    week.forecast_other_percent ?? 0,
                  ),
                }),
                t("capacity.gantt.forecastExpected", {
                  total: formatCapacityPercent(forecastTotal ?? 0),
                  cap: formatCapacityPercent(regularCap),
                }),
                week.forecast_policy_label
                  ? t("capacity.gantt.forecastPolicy", {
                      label: week.forecast_policy_label,
                    })
                  : null,
                forecastEvents.length
                  ? t("capacity.gantt.forecastEvents", {
                      events: forecastEvents.join(sep),
                    })
                  : null,
                week.forecast_basis ?? null,
              ]
                .filter(Boolean)
                .join(" · ")
            : otherWork(week)
          return (
            <TimelineButton
              key={week.week_start}
              aria-pressed={week.week_start === activeWeek}
              tooltip={t("capacity.gantt.tooltipSummary", {
                forecast: forecastTooltip,
                alloc: formatCapacityPercent(allocation),
                hold: formatCapacityPercent(week.hold_percent ?? 0),
                elastic:
                  elasticUsed > 0
                    ? t("capacity.gantt.tooltipElasticBreak", {
                        percent: formatCapacityPercent(elasticUsed),
                      })
                    : "",
                leave: unavailable ? t("capacity.gantt.tooltipLeave") : "",
              })}
              aria-label={t("capacity.gantt.ariaFull", {
                week: weekLabel(week.week_start),
                load: label,
                forecast:
                  forecast && forecastTotal !== null
                    ? t("capacity.gantt.ariaForecast", {
                        tag: forecastTag ?? "",
                        total: formatCapacityPercent(forecastTotal),
                        cap: formatCapacityPercent(regularCap),
                      })
                    : "",
                state,
                leave: unavailable ? t("capacity.workload.weekAriaLeave") : "",
              })}
              className={cn(
                "m-0.5 min-w-0 cursor-pointer rounded-md border px-2 py-1.5 text-left text-xs outline-offset-2 hover:border-primary focus-visible:outline-2 focus-visible:outline-primary",
                forecast ? forecastSurface : loadColors[band].surface,
                unavailable && unavailableStripes,
                week.week_start === activeWeek &&
                  "ring-2 ring-primary ring-inset",
              )}
              onClick={(event) =>
                onSelect(
                  {
                    row,
                    range,
                    title: weekLabel(week.week_start),
                    week: week.week_start,
                  },
                  event.currentTarget,
                )
              }
            >
              <span
                className={cn(
                  "block font-semibold tabular-nums",
                  band === "overloaded" && "text-red-700 dark:text-red-300",
                )}
              >
                {label}
              </span>
              {forecast && forecastTag && forecastTotal !== null && (
                <>
                  <span className="mt-0.5 inline-block rounded border border-sky-500/40 bg-sky-500/10 px-1 text-[11px] font-medium text-sky-900 dark:text-sky-200">
                    {forecastTag}
                  </span>
                  <span className="block font-medium tabular-nums text-sky-950 dark:text-sky-100">
                    {t("capacity.gantt.forecastCardLine", {
                      total: formatCapacityPercent(forecastTotal),
                      cap: formatCapacityPercent(regularCap),
                    })}
                  </span>
                </>
              )}
              <span className="block text-muted-foreground">
                {t("capacity.gantt.allocatedLine", {
                  percent: formatCapacityPercent(allocation),
                })}
              </span>
              {elasticUsed > 0 && (
                <span className="mt-0.5 inline-block rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[11px] font-medium text-amber-900 dark:text-amber-200">
                  {t("capacity.gantt.elasticUsedBadge", {
                    percent: formatCapacityPercent(elasticUsed),
                  })}
                </span>
              )}
              {week.holds?.map((hold, index) => (
                <span
                  key={index}
                  className="block text-amber-800 dark:text-amber-300"
                >
                  {t("capacity.gantt.holdLine", {
                    percent: formatCapacityPercent(hold.allocation_percent),
                    date: formatDate(hold.expires_at, {
                      month: "long",
                      day: "numeric",
                    }),
                  })}
                </span>
              ))}
              {unavailable && (
                <span className="mt-0.5 inline-block rounded border border-current/25 bg-background/70 px-1 text-[11px] font-medium">
                  {t("capacity.workload.leaveBtn")}
                </span>
              )}
              {week.capacity_percent < 100 && (
                <span className="block">
                  {t("capacity.workload.availableCap", {
                    percent: week.capacity_percent,
                  })}
                </span>
              )}
              {row.correction_pending[week.week_start] && (
                <span className="block text-amber-700 dark:text-amber-300">
                  {t("capacity.workload.adjustPending")}
                </span>
              )}
              {week.legacy_start && (
                <span className="block">
                  {t("capacity.workload.legacyStart")}
                </span>
              )}
              {(week.other_percent !== null ||
                (forecast && week.forecast_other_percent != null)) && (
                <span
                  aria-hidden="true"
                  className="mt-1 block h-1 rounded-full bg-muted"
                >
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      forecast ? "bg-sky-500/70" : baseline,
                    )}
                    style={{
                      width: `${Math.min(
                        week.other_percent ?? week.forecast_other_percent ?? 0,
                        100,
                      )}%`,
                    }}
                  />
                </span>
              )}
            </TimelineButton>
          )
        })}
      </div>
      {!!segments.length && (
        <div className="grid grid-cols-[repeat(56,minmax(0,1fr))] gap-y-1 bg-[linear-gradient(to_right,transparent_calc(100%_-_1px),var(--border)_0)] bg-size-[12.5%_100%] pb-1.5">
          {segments.map((segment, index) => {
            const startDay = Math.max(0, dayIndex(segment.start_date))
            const endDay = Math.min(56, dayIndex(segment.end_date) + 1)
            if (endDay <= startDay) return null
            const title = segment.label
            const dateRange = formatIsoDateRange(
              segment.start_date,
              segment.end_date,
            )
            return (
              <TimelineButton
                key={segment.id}
                tooltip={
                  <>
                    {t("capacity.gantt.segmentTooltip", {
                      title,
                      range: dateRange,
                    })}
                    {segment.note && <p>{segment.note}</p>}
                  </>
                }
                aria-label={t("capacity.gantt.segmentAria", {
                  kind: t(segmentKinds[segment.kind].labelKey),
                  title,
                  range: dateRange,
                })}
                className={cn(
                  "mx-px flex h-7 min-w-0 cursor-pointer items-center gap-0.5 rounded border px-1 text-left text-xs font-medium hover:ring-1 hover:ring-primary focus-visible:outline-2 focus-visible:outline-primary",
                  segmentKinds[segment.kind].color,
                )}
                style={{
                  gridColumn: `${startDay + 1} / ${endDay + 1}`,
                  gridRow: index + 1,
                }}
                onClick={(event) =>
                  onSelect(
                    {
                      row,
                      range: segment,
                      title,
                      week: weeks[Math.floor(startDay / 7)].week_start,
                    },
                    event.currentTarget,
                  )
                }
              >
                {segment.start_date < first && (
                  <span aria-hidden="true">←</span>
                )}
                <span className="truncate">{title}</span>
                {segment.end_date >= end && (
                  <span aria-hidden="true" className="ml-auto">
                    →
                  </span>
                )}
              </TimelineButton>
            )
          })}
        </div>
      )}
    </div>
  )
}
