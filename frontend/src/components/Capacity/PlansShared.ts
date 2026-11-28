import { AxiosError } from "axios"
import type { AssigneeInput, PlanReplyInput } from "@/client"
import i18n, { getLocale } from "@/i18n"
import { formatDate, formatDateRange, formatNumber } from "@/i18n/format"
import { addDaysIso, areConsecutiveWeeks, parseIsoDateUtc } from "./dateUtils"
import { isCapacityAccessDenied } from "./shared"

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : []
}

export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

export function label(
  value: unknown,
  fallback = i18n.t("capacity.common.tbd"),
): string {
  return typeof value === "string" ? value : fallback
}

export function number(value: unknown): string {
  return typeof value === "number"
    ? formatNumber(value)
    : i18n.t("capacity.common.tbd")
}

export function personWeeks(value: unknown): string {
  return typeof value === "number"
    ? formatNumber(value, { maximumFractionDigits: 2, useGrouping: false })
    : i18n.t("capacity.common.tbd")
}

export function errorText(error: Error): string {
  if (isCapacityAccessDenied(error))
    return i18n.t("capacity.plans.noPermission")
  if (error instanceof AxiosError) {
    const detail: unknown = error.response?.data?.detail
    if (typeof detail === "string") return detail
    const messages = records(detail).map((item) => {
      const message = label(item.msg, "")
      if (/[\u3400-\u9fff]/.test(message) || item.type === "value_error")
        return message.replace(/^Value error, /, "")
      if (strings(item.loc).includes("allocation_percent"))
        return i18n.t("capacity.plans.validationPercent")
      return i18n.t("capacity.plans.validationFormat")
    })
    if (messages.length)
      return messages.join(i18n.t("capacity.common.semicolonSeparator"))
  }
  return i18n.t("capacity.plans.loadFailed")
}

const WEEKLY_FINDING_KEYS: Record<string, string> = {
  unconfirmed: "capacity.plans.findings.unconfirmed",
  over_regular_cap: "capacity.plans.findings.over_regular_cap",
  over_capacity: "capacity.plans.findings.over_capacity",
  overload: "capacity.plans.findings.overload",
  elastic_used: "capacity.plans.findings.elastic_used",
}

function formatWeekGroup(weeks: string[]): string {
  const sorted = [...new Set(weeks)].sort()
  const locale = getLocale()
  if (sorted.length === 1) {
    return locale === "en" ? formatDate(sorted[0]) : sorted[0]
  }
  if (areConsecutiveWeeks(sorted)) {
    const lastSunday = addDaysIso(sorted[sorted.length - 1], 6)
    const endIso = lastSunday ?? sorted[sorted.length - 1]
    return locale === "en"
      ? formatDateRange(sorted[0], endIso)
      : `${sorted[0]} 至 ${endIso}` // i18n-ignore: zh-CN 专用 ISO 日期区间连接词（NERE-1438）
  }
  const sameYear = sorted.every((w) => w.slice(0, 4) === sorted[0].slice(0, 4))
  if (locale === "en") {
    return sorted
      .map((w) =>
        formatDate(
          w,
          sameYear
            ? { month: "short", day: "numeric" }
            : { year: "numeric", month: "short", day: "numeric" },
        ),
      )
      .join(", ")
  }
  return sorted.map((w) => (sameYear ? w.slice(5) : w)).join("、")
}

export function summarizeFindings(
  findings: Record<string, unknown>[],
  people: ReadonlyMap<string, string>,
): string[] {
  type Entry =
    | {
        kind: "weekly"
        employeeId: string
        code: string
        fallbackLabel: string
        weeks: string[]
      }
    | { kind: "single"; text: string }

  const entries: Entry[] = []
  const weeklyIndex = new Map<string, number>()
  const seenSingles = new Set<string>()
  const riskFallback = i18n.t("capacity.plans.riskFallback")
  const personFallback = i18n.t("capacity.plans.personFallback")
  const colon = getLocale() === "en" ? ": " : "："

  for (const finding of findings) {
    const employeeId =
      typeof finding.employee_id === "string" ? finding.employee_id : ""
    const weekStart =
      typeof finding.week_start === "string" &&
      parseIsoDateUtc(finding.week_start)
        ? finding.week_start
        : ""
    const code = typeof finding.code === "string" ? finding.code : ""
    const message = label(finding.message, "")

    if (employeeId && weekStart) {
      const groupKey = `${employeeId}\0${code}`
      const existing = weeklyIndex.get(groupKey)
      if (existing !== undefined) {
        const entry = entries[existing]
        if (entry.kind === "weekly" && !entry.weeks.includes(weekStart)) {
          entry.weeks.push(weekStart)
        }
      } else {
        weeklyIndex.set(groupKey, entries.length)
        entries.push({
          kind: "weekly",
          employeeId,
          code,
          fallbackLabel: message || riskFallback,
          weeks: [weekStart],
        })
      }
      continue
    }

    const personPrefix = employeeId
      ? `${people.get(employeeId) ?? personFallback}${colon}`
      : ""
    const text = `${personPrefix}${message || riskFallback}`
    if (!seenSingles.has(text)) {
      seenSingles.add(text)
      entries.push({ kind: "single", text })
    }
  }

  return entries.map((entry) => {
    if (entry.kind === "single") return entry.text
    const person = people.get(entry.employeeId) ?? personFallback
    const riskKey = WEEKLY_FINDING_KEYS[entry.code]
    const riskLabel = riskKey ? i18n.t(riskKey) : entry.fallbackLabel
    const uniqueCount = new Set(entry.weeks).size
    const weeks = formatWeekGroup(entry.weeks)
    if (entry.code === "forecast_week") {
      return i18n.t("capacity.plans.forecastSummary", {
        person,
        count: uniqueCount,
        weeks,
      })
    }
    return i18n.t("capacity.plans.weeklySummary", {
      person,
      count: uniqueCount,
      label: riskLabel,
      weeks,
    })
  })
}

export function createBlankSegment(
  demand: Record<string, unknown> | undefined,
): AssigneeInput {
  return {
    employee_id: "",
    start_date: label(demand?.window_start, ""),
    end_date: label(demand?.committed_end_date ?? demand?.window_end, ""),
    allocation_percent: Number(demand?.allocation_percent ?? 100),
  }
}

export type SelectedPlanReply = Pick<
  PlanReplyInput,
  | "option_id"
  | "outcome"
  | "start_date"
  | "end_date"
  | "outside_basis"
  | "lender_department_id"
  | "borrow_headcount"
>

export function isInDemandWindow(
  start: string | null | undefined,
  end: string | null | undefined,
  windowStart: string,
  windowEnd: string,
) {
  return !!start && !!end && start >= windowStart && end <= windowEnd
}

export function verdictBadgeVariant(
  verdict: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (verdict === "feasible") return "default"
  if (verdict === "infeasible") return "destructive"
  return "secondary"
}
