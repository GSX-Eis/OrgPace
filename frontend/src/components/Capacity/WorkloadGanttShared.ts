import type { WorkloadPublic } from "@/client"
import i18n from "@/i18n"
import { formatDate } from "@/i18n/format"
import type { DateRange } from "./dateUtils"
import { formatCapacityPercent, unavailableStripes } from "./shared"

export const timelineWidth = "min-w-[52rem]"
export const baseline = "bg-teal-500 dark:bg-teal-400"

export const segmentKinds = {
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

export type WorkloadSelection = {
  row: WorkloadPublic
  range: DateRange
  title: string
  week: string
}

export function taskSegmentsFor(row: WorkloadPublic) {
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
