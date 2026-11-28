import { type ReactNode, useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { WorkloadPublic } from "@/client"
import { useIsMobile } from "@/hooks/useMobile"
import { cn } from "@/lib/utils"
import {
  forecastSurface,
  loadBandLabel,
  loadColors,
  UtilizationBadge,
} from "./shared"
import {
  baseline,
  segmentKinds,
  timelineWidth,
  type WorkloadSelection,
} from "./WorkloadGanttShared"
import { CurrentWeekLine, Timeline, WeekHeader } from "./WorkloadTimeline"

export { WorkloadDetails } from "./WorkloadDetails"
export type { WorkloadSelection } from "./WorkloadGanttShared"

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
  const groups = useMemo(() => {
    const map = new Map<string | null, WorkloadPublic[]>()
    for (const row of rows) {
      const group = map.get(row.department_id)
      if (group) group.push(row)
      else map.set(row.department_id, [row])
    }
    return map
  }, [rows])
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
