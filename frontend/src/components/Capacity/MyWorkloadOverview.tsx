import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { MyWorkload as MyWorkloadData } from "@/client"
import {
  SectionCard,
  SideDrawer,
} from "@/components/Common/WorkbenchPrimitives"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { overlaps, weekRange } from "./dateUtils"
import {
  loadBandLabel,
  loadColors,
  occupiedPercent,
  UtilizationBadge,
  unavailableStripes,
  weekBand,
  weekLabel,
  weekLoadLabel,
} from "./shared"
import { WorkloadLegend } from "./TeamWorkloadGantt"
import { Unavailability } from "./UnavailabilityPanel"
import { WorkloadDetails } from "./WorkloadDetails"

export function MyWorkloadOverview({
  orgId,
  workload,
  isAdmin,
  onLeaveRegistered,
}: {
  orgId: string
  workload: MyWorkloadData
  isAdmin: boolean
  onLeaveRegistered: (overWeeks: string[]) => void
}) {
  const { t } = useTranslation()
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const overload = workload.weeks.find(
    (week) => weekBand(week) === "overloaded",
  )
  const activeWeek = workload.weeks.find(
    (week) => week.week_start === selectedWeek,
  )
  const activeRange = activeWeek ? weekRange(activeWeek.week_start) : null
  const activeTitle = activeWeek ? weekLabel(activeWeek.week_start) : ""
  return (
    <SectionCard
      aria-label={t("capacity.workload.overviewAria")}
      className={cn("space-y-3", activeWeek && "md:pr-[min(380px,38vw)]")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">
          {t("capacity.workload.overviewTitle")}
        </h2>
        {overload && (
          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-700 dark:text-red-300">
            {t("capacity.workload.overloadBadge", {
              week: weekLabel(overload.week_start),
            })}
          </span>
        )}
        <div className="sm:ml-auto">
          <WorkloadLegend />
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("capacity.workload.overviewHint")}
      </p>
      <div className="grid grid-cols-2 gap-2 min-[540px]:grid-cols-4 xl:grid-cols-8">
        {workload.weeks.map((week, index) => {
          const band = weekBand(week)
          const total = occupiedPercent(week)
          const range = weekRange(week.week_start)
          const unavailable =
            week.capacity_percent < 100 ||
            (workload.unavailabilities ?? []).some((dates) =>
              overlaps(range, dates),
            )
          const colors = loadColors[band]
          const selected = selectedWeek === week.week_start
          return (
            <button
              key={week.week_start}
              type="button"
              aria-haspopup="dialog"
              aria-pressed={selected}
              aria-label={t("capacity.workload.weekAriaLabel", {
                week: weekLabel(week.week_start),
                load: weekLoadLabel(week),
                band: loadBandLabel(band),
                leave: unavailable ? t("capacity.workload.weekAriaLeave") : "",
              })}
              className={cn(
                "min-w-0 cursor-pointer space-y-1.5 rounded-md border p-2.5 text-left text-xs outline-offset-2 hover:border-primary focus-visible:outline-2 focus-visible:outline-primary",
                colors.surface,
                unavailable && unavailableStripes,
                selected && "ring-2 ring-primary ring-inset",
              )}
              onClick={(event) => {
                opener.current = event.currentTarget
                setSelectedWeek(week.week_start)
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-1">
                <time className="font-semibold" dateTime={week.week_start}>
                  {index === 0
                    ? t("capacity.workload.thisWeek")
                    : index === 1
                      ? t("capacity.workload.nextWeek")
                      : weekLabel(week.week_start)}
                </time>
                {week.status === "stale" ? (
                  <Badge variant="outline">
                    {t("capacity.workload.statusStale")}
                  </Badge>
                ) : (
                  <UtilizationBadge
                    band={band}
                    percent={total}
                    capacity={week.capacity_percent}
                  />
                )}
              </div>
              {index < 2 && (
                <p className="text-muted-foreground">
                  {weekLabel(week.week_start)}
                </p>
              )}
              <div
                aria-hidden="true"
                className="relative h-1.5 rounded-full bg-foreground/10"
              >
                <span
                  className={cn("block h-full rounded-full", colors.bar)}
                  style={{ width: `${Math.min(total, 100)}%` }}
                />
                <span
                  className="absolute -inset-y-0.5 w-px bg-red-500"
                  style={{ left: `calc(${week.capacity_percent}% - 1px)` }}
                />
              </div>
              {unavailable && (
                <span className="inline-block rounded border border-current/25 bg-background/70 px-1 text-[11px] font-medium">
                  {t("capacity.workload.leaveBtn")}
                </span>
              )}
              {week.capacity_percent < 100 && (
                <p>
                  {t("capacity.workload.availableCap", {
                    percent: week.capacity_percent,
                  })}
                </p>
              )}
              {workload.correction_pending[week.week_start] && (
                <p className="text-amber-700 dark:text-amber-300">
                  {t("capacity.workload.adjustPending")}
                </p>
              )}
              {week.legacy_start && <p>{t("capacity.workload.legacyStart")}</p>}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
        <span>
          {t("capacity.workload.jiraLabel")}
          <span>
            {workload.jira_task_count === null
              ? t("capacity.workload.jiraUnlinked")
              : t("capacity.workload.jiraIncomplete", {
                  count: workload.jira_task_count,
                })}
          </span>
        </span>
      </div>
      <SideDrawer
        open={!!activeWeek}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedWeek(null)
            opener.current?.focus({ preventScroll: true })
          }
        }}
        modal={false}
        showOverlay={false}
        className="max-md:inset-x-0 max-md:top-auto max-md:bottom-0 max-md:h-[55dvh] max-md:w-full max-md:max-w-none md:w-[min(380px,38vw)] md:max-w-none"
        title={
          activeWeek
            ? t("capacity.workload.detailsTitleWithWeek", { week: activeTitle })
            : t("capacity.workload.detailsTitle")
        }
      >
        {activeWeek && activeRange && (
          <div key={activeWeek.week_start} className="space-y-3">
            <WorkloadDetails
              selection={{
                row: workload,
                range: activeRange,
                title: activeTitle,
                week: activeWeek.week_start,
              }}
            />
            <section
              aria-label={t("capacity.workload.weekLeaveAria")}
              className="space-y-2 border-t pt-3"
            >
              <h3 className="text-sm font-medium">
                {t("capacity.workload.weekLeaveTitle")}
              </h3>
              <Unavailability
                orgId={orgId}
                employeeId={workload.employee_id}
                startWeek={activeWeek.week_start}
                weekRange={activeRange}
                knownItems={workload.unavailabilities}
                canWrite={!isAdmin}
                showNote
                idPrefix="week-leave"
                submitLabel={t("capacity.workload.leaveSubmit")}
                onRegistered={onLeaveRegistered}
              />
            </section>
          </div>
        )}
      </SideDrawer>
    </SectionCard>
  )
}
