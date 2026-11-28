import type { ComponentProps, ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { WeekLoad, WorkloadPublic } from "@/client"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/useMobile"
import i18n from "@/i18n"
import { formatDate } from "@/i18n/format"
import { cn } from "@/lib/utils"
import { addWeeks, type DateRange, overlaps, weekRange } from "./dateUtils"
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
  UtilizationBadge,
  unavailableStripes,
  weekBand,
  weekLabel,
  weekLoadLabel,
} from "./shared"

export { type DateRange, overlaps, weekRange }

const timelineWidth = "min-w-[52rem]"
const segmentKinds = {
  committed: {
    labelKey: "capacity.gantt.segments.committed",
    color:
      "border-blue-300 bg-blue-100 text-blue-950 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100",
  },
  borrow: {
    labelKey: "capacity.gantt.segments.borrow",
    color:
      "border-violet-300 bg-violet-100 text-violet-950 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-100",
  },
  hold: {
    labelKey: "capacity.gantt.segments.hold",
    color:
      "border-dashed border-amber-600 bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100",
  },
  unavailable: {
    labelKey: "capacity.gantt.segments.unavailable",
    color: unavailableStripes,
  },
} as const
const baseline = "bg-teal-500 dark:bg-teal-400"

function taskSegmentsFor(row: WorkloadPublic) {
  return [
    ...(row.assignments ?? []).map((item) => ({
      ...item,
      end_date: item.due_date,
      label: `${item.kind === "borrow" ? i18n.t("capacity.gantt.borrowPrefix") : ""}${item.title} · ${formatCapacityPercent(item.allocation_percent)}`,
      note: item.legacy_start ? i18n.t("capacity.workload.legacyStart") : null,
    })),
    ...(row.holds ?? []).map((item, index) => ({
      ...item,
      id: `hold-${item.proposal_id}-${index}`,
      kind: "hold" as const,
      label: `${i18n.t("capacity.gantt.holdPrefix")}${item.title} · ${formatCapacityPercent(item.allocation_percent)}`,
      note: i18n.t("capacity.gantt.holdPendingExpiry", {
        date: formatDate(item.expires_at, {
          dateStyle: "short",
          timeStyle: "medium",
        }),
      }),
    })),
  ]
}

export type WorkloadSelection = {
  row: WorkloadPublic
  range: DateRange
  title: string
  week: string
}

function otherWork(week: WeekLoad) {
  return week.other_percent === null
    ? i18n.t("capacity.gantt.otherWorkUnconfirmed")
    : i18n.t("capacity.gantt.otherWorkValue", {
        percent: formatCapacityPercent(week.other_percent),
      })
}

export function WorkloadLegend() {
  const { t } = useTranslation()
  const entries = [
    ...Object.entries(loadColors).map(([band, color]) => ({
      key: band,
      label:
        band === "overloaded"
          ? t("capacity.gantt.overloadLegend")
          : loadBandLabel(band as WorkloadPublic["band"]),
      color: color.bar,
    })),
    ...Object.entries(segmentKinds).map(([kind, { labelKey, color }]) => ({
      key: kind,
      label: t(labelKey),
      color,
    })),
    {
      key: "other",
      label: t("capacity.gantt.otherWork"),
      color: `border-transparent ${baseline}`,
    },
    {
      key: "forecast",
      label: t("capacity.gantt.forecastBaseline"),
      color: forecastSurface,
    },
  ]
  return (
    <ul
      aria-label={t("capacity.gantt.legendAria")}
      className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs"
    >
      {entries.map(({ key, label, color }) => (
        <li key={key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("h-2.5 w-3.5 rounded-xs border", color)}
          />
          {label}
        </li>
      ))}
    </ul>
  )
}

function CurrentWeekLine({
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

function WeekHeader({
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

function Timeline({
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
  const end = addWeeks(first, weeks.length)
  const dayIndex = (date: string) =>
    (Date.parse(date) - Date.parse(first)) / 86_400_000
  const segments = taskSegmentsFor(row)
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

export function TeamWorkloadGantt({
  rows,
  current,
  actions,
  activeEmployee,
  activeWeek,
  defaultAllocationCapPercent = 70,
  onSelect,
}: {
  rows: WorkloadPublic[]
  current: string
  actions: (row: WorkloadPublic) => ReactNode
  activeEmployee?: string
  activeWeek?: string
  defaultAllocationCapPercent?: number
  onSelect: (selection: WorkloadSelection, opener: HTMLButtonElement) => void
}) {
  const { t } = useTranslation()
  const mobile = useIsMobile()
  const groups = new Map<string | null, WorkloadPublic[]>()
  for (const row of rows) {
    const group = groups.get(row.department_id)
    if (group) group.push(row)
    else groups.set(row.department_id, [row])
  }
  if (!rows.length)
    return (
      <p className="rounded-xl border p-4 text-sm text-muted-foreground">
        {t("capacity.gantt.empty")}
      </p>
    )

  const identity = (row: WorkloadPublic) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-1.5">
        <p className="min-w-0 break-words text-sm font-semibold">
          {row.employee_name}
        </p>
        <UtilizationBadge band={row.band} percent={row.confirmed_percent} />
      </div>
      {mobile && (
        <p className="text-xs text-muted-foreground">
          {row.department_name ?? t("capacity.gantt.unassignedDept")}
        </p>
      )}
      {actions(row)}
    </div>
  )

  return !mobile ? (
    <div className="overflow-x-auto border-surface-border border-b bg-surface">
      <table className="w-full text-left">
        <caption className="sr-only">
          {t("capacity.gantt.tableCaption")}
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-20 w-44 min-w-44 border-r border-b bg-muted px-3 text-sm"
            >
              {t("capacity.gantt.memberCol")}
            </th>
            <th scope="col" className={cn(timelineWidth, "relative p-0")}>
              <CurrentWeekLine weeks={rows[0].weeks} current={current} />
              <WeekHeader weeks={rows[0].weeks} current={current} />
            </th>
          </tr>
        </thead>
        {Array.from(groups, ([id, group]) => (
          <tbody key={id ?? ""}>
            <tr className="bg-muted/70">
              <th
                scope="rowgroup"
                colSpan={2}
                className="p-0 text-xs font-semibold"
              >
                <span className="sticky left-0 inline-block px-3 py-2">
                  {group[0].department_name ??
                    t("capacity.gantt.unassignedDept")}
                </span>
              </th>
            </tr>
            {group.map((row) => (
              <tr key={row.employee_id} className="border-t align-top">
                <th
                  scope="row"
                  className="sticky left-0 z-20 w-44 border-r bg-surface p-2.5 font-normal"
                >
                  {identity(row)}
                </th>
                <td className="relative p-0">
                  <CurrentWeekLine weeks={row.weeks} current={current} />
                  <Timeline
                    row={row}
                    defaultAllocationCapPercent={defaultAllocationCapPercent}
                    activeWeek={
                      row.employee_id === activeEmployee
                        ? activeWeek
                        : undefined
                    }
                    onSelect={onSelect}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  ) : (
    <div className="space-y-4 p-3">
      {Array.from(groups, ([id, group]) => (
        <section
          key={id ?? ""}
          aria-label={
            group[0].department_name ?? t("capacity.gantt.unassignedDept")
          }
          className="space-y-2"
        >
          <h2 className="text-sm font-semibold">
            {group[0].department_name ?? t("capacity.gantt.unassignedDept")}
          </h2>
          {group.map((row) => (
            <article
              key={row.employee_id}
              aria-label={row.employee_name}
              className="overflow-hidden rounded-lg border bg-surface"
            >
              <div className="space-y-2 p-3">
                {identity(row)}
                <p className="text-xs text-muted-foreground">
                  {t("capacity.gantt.mobileSwipeHint")}
                </p>
              </div>
              <div className="relative border-t">
                <section
                  aria-label={t("capacity.gantt.mobileScheduleAria", {
                    name: row.employee_name,
                  })}
                  className="overflow-x-auto"
                >
                  <div className={cn(timelineWidth, "relative")}>
                    <CurrentWeekLine weeks={row.weeks} current={current} />
                    <WeekHeader weeks={row.weeks} current={current} />
                    <Timeline
                      row={row}
                      defaultAllocationCapPercent={defaultAllocationCapPercent}
                      activeWeek={
                        row.employee_id === activeEmployee
                          ? activeWeek
                          : undefined
                      }
                      onSelect={onSelect}
                    />
                  </div>
                </section>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 right-0 z-10 w-5 bg-linear-to-l from-background/85 to-transparent"
                />
              </div>
            </article>
          ))}
        </section>
      ))}
    </div>
  )
}

export function WorkloadDetails({
  selection: { row, range, title },
  defaultAllocationCapPercent = 70,
}: {
  selection: WorkloadSelection
  defaultAllocationCapPercent?: number
}) {
  const { t } = useTranslation()
  const allSegments = taskSegmentsFor(row)
  const segments = allSegments.filter((segment) => overlaps(segment, range))
  const taskKinds = (["committed", "borrow", "hold"] as const).filter((kind) =>
    segments.some((segment) => segment.kind === kind),
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
        {row.weeks
          .filter((week) => overlaps(weekRange(week.week_start), range))
          .map((week) => {
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
            const currentTotal = forecast
              ? forecastOccupiedPercent(week)
              : total
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
