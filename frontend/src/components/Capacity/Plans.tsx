import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { AxiosError } from "axios"
import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type AssigneeInput,
  type CasePublic,
  PlanningService,
  type PlanReplyInput,
} from "@/client"
import { ProfileLoading } from "@/components/Profile/QueryState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useOrg } from "@/hooks/useOrg"
import i18n, { getLocale } from "@/i18n"
import { formatDate, formatDateRange, formatNumber } from "@/i18n/format"
import { isLocaleReadOnlyPlanningQuery } from "@/i18n/localeQuerySync"
import {
  formatCapacityPercent,
  formatIsoDateRange,
  isCapacityAccessDenied,
} from "./shared"

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : []
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function label(
  value: unknown,
  fallback = i18n.t("capacity.common.tbd"),
): string {
  return typeof value === "string" ? value : fallback
}

function number(value: unknown): string {
  return typeof value === "number"
    ? formatNumber(value)
    : i18n.t("capacity.common.tbd")
}

function personWeeks(value: unknown): string {
  return typeof value === "number"
    ? formatNumber(value, { maximumFractionDigits: 2, useGrouping: false })
    : i18n.t("capacity.common.tbd")
}

function errorText(error: Error): string {
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

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

function parseIsoDateUtc(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date
}

function mondayUtcMs(date: Date): number {
  const day = date.getUTCDay()
  const diffToMonday = day === 0 ? -6 : 1 - day
  return date.getTime() + diffToMonday * DAY_MS
}

function addDaysIso(isoDate: string, days: number): string | null {
  const parsed = parseIsoDateUtc(isoDate)
  if (!parsed) return null
  return new Date(parsed.getTime() + days * DAY_MS).toISOString().slice(0, 10)
}

export function countWeeks(startDate: string, endDate: string): number | null {
  const start = parseIsoDateUtc(startDate)
  const end = parseIsoDateUtc(endDate)
  if (!start || !end || start.getTime() > end.getTime()) return null
  return Math.round((mondayUtcMs(end) - mondayUtcMs(start)) / WEEK_MS) + 1
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
  let continuous = true
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = parseIsoDateUtc(sorted[i - 1])
    const curr = parseIsoDateUtc(sorted[i])
    if (!prev || !curr || curr.getTime() - prev.getTime() !== WEEK_MS) {
      continuous = false
      break
    }
  }
  if (continuous) {
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

function createBlankSegment(
  demand: Record<string, unknown> | undefined,
): AssigneeInput {
  return {
    employee_id: "",
    start_date: label(demand?.window_start, ""),
    end_date: label(demand?.committed_end_date ?? demand?.window_end, ""),
    allocation_percent: Number(demand?.allocation_percent ?? 100),
  }
}

function SegmentEditor({
  plan,
  orgId,
  initial,
  onCancel,
  onSaved,
}: {
  plan: CasePublic
  orgId: string
  initial: AssigneeInput[]
  onCancel: () => void
  onSaved: (optionId: string) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const id = useId()
  const [segments, setSegments] = useState(initial)
  const save = useMutation({
    mutationFn: async () =>
      (
        await PlanningService.createOption({
          path: { org_id: orgId, case_id: plan.id },
          body: { assignees: segments },
        })
      ).data,
    onSuccess: (created) => onSaved(created.id),
  })
  const demand = records([plan.data.demand])[0]
  const update = (index: number, changes: Partial<AssigneeInput>) =>
    setSegments((previous) =>
      previous.map((segment, i) =>
        i === index ? { ...segment, ...changes } : segment,
      ),
    )
  return (
    <form
      className="space-y-3"
      aria-label={t("capacity.plans.editorAria")}
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <fieldset className="space-y-3" disabled={save.isPending}>
        {segments.map((segment, index) => (
          <div
            key={index}
            className="grid gap-2 rounded-lg bg-muted/30 p-3 sm:grid-cols-2"
          >
            <label>
              <span>{t("capacity.plans.employeeLabel")}</span>
              <select
                className="block h-9 w-full rounded-md border bg-background px-3"
                required
                value={segment.employee_id}
                onChange={(event) =>
                  update(index, { employee_id: event.target.value })
                }
              >
                <option value="">{t("capacity.plans.selectEmployee")}</option>
                {plan.people.map((person) => (
                  <option key={person.employee_id} value={person.employee_id}>
                    {person.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${id}-percent-${index}`}>
              {t("capacity.plans.allocationLabel")}
              <Input
                id={`${id}-percent-${index}`}
                type="number"
                min={10}
                max={100}
                required
                value={segment.allocation_percent}
                onChange={(event) =>
                  update(index, {
                    allocation_percent: Number(event.target.value),
                  })
                }
              />
            </label>
            <label htmlFor={`${id}-start-${index}`}>
              {t("capacity.plans.startDate")}
              <Input
                id={`${id}-start-${index}`}
                type="date"
                required
                value={segment.start_date}
                onChange={(event) =>
                  update(index, { start_date: event.target.value })
                }
              />
            </label>
            <label htmlFor={`${id}-end-${index}`}>
              {t("capacity.plans.endDate")}
              <Input
                id={`${id}-end-${index}`}
                type="date"
                required
                value={segment.end_date}
                min={segment.start_date}
                onChange={(event) =>
                  update(index, { end_date: event.target.value })
                }
              />
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setSegments((previous) =>
                  previous.filter((_, i) => i !== index),
                )
              }
            >
              {t("capacity.plans.removeSegment")}
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setSegments((previous) => [
                ...previous,
                createBlankSegment(demand),
              ])
            }
          >
            {t("capacity.plans.addSegment")}
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("capacity.common.cancel")}
            </Button>
            <Button type="submit" disabled={!segments.length}>
              {t("capacity.plans.simulateAdjusted")}
            </Button>
          </div>
        </div>
      </fieldset>
      {save.error && <p role="alert">{errorText(save.error)}</p>}
    </form>
  )
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

function verdictBadgeVariant(
  verdict: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (verdict === "feasible") return "default"
  if (verdict === "infeasible") return "destructive"
  return "secondary"
}

function OptionCard({
  option,
  plan,
  orgId,
  selected = false,
  onRevised,
  onReply,
}: {
  option: CasePublic["options"][number]
  plan: CasePublic
  orgId: string
  selected?: boolean
  onRevised: (createdOptionId?: string) => Promise<unknown>
  onReply?: (reply: SelectedPlanReply) => void
}) {
  const { t } = useTranslation()
  const { employeeId } = useOrg()
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorKey, setEditorKey] = useState(0)
  const [editorInitial, setEditorInitial] = useState<AssigneeInput[]>([])
  const [risksExpanded, setRisksExpanded] = useState(false)

  const demand = records([plan.data.demand])[0]
  const people = new Map(
    plan.people.map((person) => [person.employee_id, person.display_name]),
  )
  const assignments = new Map(
    records(plan.data.assignments).map((item) => [item.assignment_id, item]),
  )
  const assignees = records(option.params.assignees)
  const grouped = new Map<string, Record<string, unknown>[]>()
  for (const person of assignees) {
    const id = label(person.employee_id)
    const parts = grouped.get(id) ?? []
    parts.push(person)
    grouped.set(id, parts)
  }
  const start = assignees
    .map((person) => label(person.start_date, ""))
    .sort()[0]
  const end = assignees
    .map((person) => label(person.end_date, ""))
    .sort()
    .pop()
  const direct =
    !demand?.change &&
    isInDemandWindow(
      start,
      end,
      label(demand?.window_start, ""),
      label(demand?.window_end, ""),
    )
  const forSchedule = (value: unknown) =>
    !direct ||
    typeof value !== "string" ||
    (!value.includes("需求方") && !/\brequester\b/i.test(value)) // i18n-ignore: 过滤后端返回的中文需求方提示关键词
  const findings = option.findings.filter((finding) =>
    forSchedule(finding.message),
  )
  const forecastSummaries = summarizeFindings(
    findings.filter((finding) => finding.code === "forecast_week"),
    people,
  )
  const riskSummaries = summarizeFindings(
    findings.filter((finding) => finding.code !== "forecast_week"),
    people,
  )
  const visibleRisks = risksExpanded ? riskSummaries : riskSummaries.slice(0, 2)
  const conditions = strings(option.summary.conditions).filter(forSchedule)
  const affectedWorks = strings(option.summary.affected_assignment_ids)
    .map((id) => ({ id, work: assignments.get(id) }))
    .filter(
      (entry): entry is { id: string; work: Record<string, unknown> } =>
        !!entry.work,
    )
  const matchedExtras = records([option.summary.matched_extra_capabilities])[0]
  const locks = new Set(strings(option.params.locked_employee_ids))
  const unconfirmedFindings = option.findings.filter(
    (finding) => finding.code === "unconfirmed",
  )
  const unconfirmedIncludesSelf =
    !!employeeId &&
    unconfirmedFindings.some((finding) => finding.employee_id === employeeId)
  const usesElastic = option.summary.uses_elastic === true
  const elasticUsedPercent =
    typeof option.summary.elastic_used_percent === "number"
      ? option.summary.elastic_used_percent
      : 0
  const snapshotAllowElastic =
    records([plan.data.rules])[0]?.allow_elastic === true
  const overRegularCapFindings = option.findings.filter(
    (finding) => finding.code === "over_regular_cap",
  )
  const canEdit = !!onReply && !plan.stale

  const openEditor = (appendBlank: boolean) => {
    const baseSegments: AssigneeInput[] = assignees.map((segment) => ({
      employee_id: label(segment.employee_id, ""),
      start_date: label(segment.start_date, ""),
      end_date: label(segment.end_date, ""),
      allocation_percent: Number(segment.allocation_percent),
    }))
    setEditorInitial(
      appendBlank
        ? [...baseSegments, createBlankSegment(demand)]
        : baseSegments,
    )
    setEditorKey((prev) => prev + 1)
    setEditorOpen(true)
  }

  return (
    <article
      id={`plan-option-${option.id}`}
      tabIndex={-1}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      className={`scroll-mt-20 space-y-4 rounded-lg border bg-surface p-4 text-sm ${
        selected ? "border-primary bg-primary/5 ring-2 ring-primary/30" : ""
      }`}
      aria-label={
        option.kind === "optimized"
          ? option.kind_label
          : t("capacity.plans.optionAriaSuffix", { kind: option.kind_label })
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-base font-semibold">
              {option.kind_label}
              <span className="sr-only"> · {option.verdict_label}</span>
            </h4>
            <Badge variant={verdictBadgeVariant(option.verdict)}>
              {option.verdict_label}
            </Badge>
            {usesElastic && (
              <span className="inline-flex items-center rounded-md border border-amber-600/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300">
                {t("capacity.plans.elasticUsedBadge", {
                  percent: formatCapacityPercent(elasticUsedPercent),
                })}
              </span>
            )}
            {selected && (
              <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {t("capacity.plans.currentOptionBadge")}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground sm:text-sm">
            {t("capacity.plans.summaryLine", {
              finish: label(option.summary.finish_date),
              headcount: number(option.summary.covered_headcount),
              gap: personWeeks(option.summary.gap_person_weeks),
            })}
          </p>
        </div>
        {onReply && ["feasible", "conditional"].includes(option.verdict) && (
          <Button
            disabled={plan.stale || !assignees.length}
            title={
              !assignees.length
                ? t("capacity.plans.noAssigneesTooltip")
                : undefined
            }
            onClick={() =>
              onReply({
                outside_basis: option.findings.some(
                  (finding) => finding.code === "outside_basis",
                ),
                option_id: option.id,
                outcome: option.verdict === "feasible" ? "can_do" : "partial",
                start_date: start || null,
                end_date: end || null,
              })
            }
          >
            {demand?.change
              ? t("capacity.plans.proposeByPlanBtn")
              : t("capacity.plans.replyByPlanBtn")}
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <h5 className="font-medium">{t("capacity.plans.teamSectionTitle")}</h5>
        {!assignees.length && !canEdit ? (
          <p className="text-muted-foreground">
            {t("capacity.plans.noAssigneesYet")}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from(grouped, ([empId, parts]) => {
              const personName =
                people.get(empId) ?? t("capacity.plans.personFallback")
              const extras = matchedExtras ? strings(matchedExtras[empId]) : []
              const content = (
                <>
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-foreground">
                        {personName}
                        {locks.has(empId) && (
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                            {t("capacity.plans.lockedBadge")}
                          </span>
                        )}
                      </span>
                      {parts.length === 1 && (
                        <Badge variant="secondary">
                          {t("capacity.plans.allocationBadge", {
                            percent:
                              typeof parts[0].allocation_percent === "number"
                                ? formatCapacityPercent(
                                    parts[0].allocation_percent,
                                  )
                                : number(parts[0].allocation_percent),
                          })}
                        </Badge>
                      )}
                    </div>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      {parts.map((part, index) => {
                        const segStart = label(part.start_date)
                        const segEnd = label(part.end_date)
                        const weeks = countWeeks(segStart, segEnd)
                        return (
                          <div
                            key={index}
                            className="flex flex-wrap items-center justify-between gap-1.5"
                          >
                            <span>
                              {weeks !== null && (
                                <>
                                  <strong className="font-semibold text-foreground">
                                    {t("capacity.plans.weeksCount", {
                                      count: weeks,
                                    })}
                                  </strong>{" "}
                                  ·{" "}
                                </>
                              )}
                              {formatIsoDateRange(segStart, segEnd)}
                            </span>
                            {parts.length > 1 && (
                              <Badge variant="secondary">
                                {t("capacity.plans.allocationBadge", {
                                  percent:
                                    typeof part.allocation_percent === "number"
                                      ? formatCapacityPercent(
                                          part.allocation_percent,
                                        )
                                      : number(part.allocation_percent),
                                })}
                              </Badge>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    {extras.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {extras.map((extra) => (
                          <span
                            key={extra}
                            className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                          >
                            {t("capacity.plans.matchedExtra", { name: extra })}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {canEdit && (
                    <span className="text-xs text-muted-foreground group-hover:text-primary">
                      {t("capacity.plans.clickToAdjust")}
                    </span>
                  )}
                </>
              )
              if (canEdit) {
                return (
                  <button
                    key={empId}
                    type="button"
                    aria-label={t("capacity.plans.adjustPersonAria", {
                      name: personName,
                    })}
                    onClick={() => openEditor(false)}
                    className="group flex cursor-pointer flex-col justify-between gap-2 rounded-lg border border-surface-border bg-background p-3 text-left transition-colors hover:border-primary/60 hover:bg-muted/30"
                  >
                    {content}
                  </button>
                )
              }
              return (
                <div
                  key={empId}
                  className="flex flex-col justify-between gap-2 rounded-lg border border-surface-border bg-background p-3"
                >
                  {content}
                </div>
              )
            })}
            {canEdit && (
              <button
                type="button"
                onClick={() => openEditor(true)}
                className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-surface-border bg-muted/10 p-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/60 hover:bg-muted/30 hover:text-foreground"
              >
                <span>{t("capacity.plans.addPersonBtn")}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {forecastSummaries.length > 0 && (
        <section
          aria-label={t("capacity.plans.forecastAria")}
          className="space-y-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-sm"
        >
          <h5 className="font-medium text-sky-900 dark:text-sky-200">
            {t("capacity.plans.forecastTitle")}
          </h5>
          <ul className="list-inside list-disc space-y-1 text-xs text-sky-950/90 dark:text-sky-100/90 sm:text-sm">
            {forecastSummaries.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {riskSummaries.length > 0 && (
        <section
          aria-label={t("capacity.plans.risksAria")}
          className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h5 className="font-medium">
              {t("capacity.plans.risksTitle", { count: riskSummaries.length })}
            </h5>
            {riskSummaries.length > 2 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => setRisksExpanded((prev) => !prev)}
              >
                {risksExpanded
                  ? t("capacity.plans.collapse")
                  : t("capacity.plans.expandMore", {
                      count: riskSummaries.length - 2,
                    })}
              </Button>
            )}
          </div>
          <ul className="list-inside list-disc space-y-1 text-xs sm:text-sm">
            {visibleRisks.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {unconfirmedFindings.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("capacity.plans.unconfirmedHint", {
                selfHint: unconfirmedIncludesSelf
                  ? t("capacity.plans.unconfirmedSelfHint")
                  : "",
              })}{" "}
              <Link
                to="/capacity"
                search={{ tab: "team" }}
                className="font-medium text-foreground underline"
              >
                {t("capacity.demandDetail.confirmTeamLoadLink")}
              </Link>
            </p>
          )}
          {!snapshotAllowElastic && overRegularCapFindings.length > 0 && (
            <p className="text-xs text-amber-800 dark:text-amber-300">
              {t("capacity.plans.elasticTip")}
            </p>
          )}
        </section>
      )}

      {affectedWorks.length > 0 && (
        <div className="space-y-1">
          <h5 className="font-medium">
            {t("capacity.plans.affectedWorksTitle")}
          </h5>
          <ul className="list-inside list-disc text-xs text-muted-foreground sm:text-sm">
            {affectedWorks.map(({ id, work }) => (
              <li key={id}>
                {t("capacity.plans.affectedWorkLine", {
                  person:
                    people.get(label(work.employee_id)) ??
                    t("capacity.plans.personFallback"),
                  start:
                    work.start_date === null
                      ? t("capacity.assignments.startUnconfirmed")
                      : label(work.start_date),
                  countedFrom: label(work.counted_from),
                  due: label(work.due_date),
                  percent:
                    typeof work.allocation_percent === "number"
                      ? formatCapacityPercent(work.allocation_percent)
                      : number(work.allocation_percent),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {conditions.length > 0 && (
        <div className="space-y-1">
          <h5 className="font-medium">{t("capacity.plans.conditionsTitle")}</h5>
          <ul className="list-inside list-disc text-xs text-muted-foreground sm:text-sm">
            {conditions.map((condition) => (
              <li key={condition}>{condition}</li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("capacity.plans.editSegmentsTitle")}</DialogTitle>
            <DialogDescription>
              {t("capacity.plans.editSegmentsDesc")}
            </DialogDescription>
          </DialogHeader>
          <SegmentEditor
            key={editorKey}
            plan={plan}
            orgId={orgId}
            initial={editorInitial}
            onCancel={() => setEditorOpen(false)}
            onSaved={async (createdOptionId) => {
              setEditorOpen(false)
              await onRevised(createdOptionId)
            }}
          />
        </DialogContent>
      </Dialog>
    </article>
  )
}

type PlanningCaseApi = {
  getCase: (caseId: string) => Promise<CasePublic>
  createCase: (elastic: boolean) => Promise<CasePublic>
}

export async function loadPlanningCase({
  demandId,
  hash,
  change,
  storageKey,
  storage = localStorage,
  readOnly = false,
  queryClient,
  queryKey,
  api,
}: {
  demandId: string
  hash: string
  change: boolean
  storageKey: string
  storage?: Pick<Storage, "getItem" | "setItem">
  readOnly?: boolean
  queryClient?: QueryClient
  queryKey?: QueryKey
  api: PlanningCaseApi
}): Promise<CasePublic> {
  if (hash) {
    const caseId = new URLSearchParams(hash).get("case")
    if (!caseId) throw new Error(i18n.t("capacity.plans.invalidPlanLink"))
    const data = await api.getCase(caseId)
    if (data.demand_id !== demandId)
      throw new Error(i18n.t("capacity.plans.planDemandMismatch"))
    storage.setItem(storageKey, data.id)
    return data
  }
  const localeReadOnly =
    readOnly ||
    (queryClient !== undefined &&
      queryKey !== undefined &&
      isLocaleReadOnlyPlanningQuery(queryClient, queryKey))
  const caseId = storage.getItem(storageKey)
  if (caseId) {
    try {
      const data = await api.getCase(caseId)
      return !localeReadOnly && change && data.stale
        ? await api.createCase(false)
        : data
    } catch (error) {
      if (
        localeReadOnly ||
        !(error instanceof AxiosError) ||
        error.response?.status !== 404
      )
        throw error
    }
  }
  if (localeReadOnly) {
    throw new Error(i18n.t("capacity.plans.invalidPlanLink"))
  }
  return api.createCase(false)
}

export function Plans({
  orgId,
  demandId,
  change = false,
  onReply,
}: {
  orgId: string
  demandId: string
  change?: boolean
  onReply?: (reply: SelectedPlanReply) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const navigate = useNavigate()
  const hash = useLocation({ select: (location) => location.hash })
  const key = ["capacity", orgId, "planning", demandId, hash]
  const storageKey = `planning-case:${orgId}:${demandId}`
  const [allowElastic, setAllowElastic] = useState(false)
  const [activeOptionId, setActiveOptionId] = useState<string | null>(null)
  const create = async (elastic = false) => {
    const { data } = await PlanningService.createCase({
      path: { org_id: orgId, demand_id: demandId },
      body: { allow_elastic: elastic },
    })
    localStorage.setItem(storageKey, data.id)
    return data
  }
  const current = useQuery({
    queryKey: key,
    queryFn: ({ client: queryClient, queryKey }) =>
      loadPlanningCase({
        demandId,
        hash,
        change,
        storageKey,
        queryClient,
        queryKey,
        api: {
          getCase: async (caseId) =>
            (
              await PlanningService.getCase({
                path: { org_id: orgId, case_id: caseId },
              })
            ).data,
          createCase: create,
        },
      }),
  })
  const simulation = useMutation({
    mutationFn: (elastic: boolean) => create(elastic),
    onSuccess: async (data) => {
      const nextHash = hash ? `case=${data.id}` : ""
      client.setQueryData(
        ["capacity", orgId, "planning", demandId, nextHash],
        data,
      )
      if (hash !== nextHash) {
        await navigate({ search: true, hash: nextHash, replace: true })
      } else {
        await current.refetch()
      }
    },
  })
  const plan = current.data
  const visibleOptions = (plan?.options ?? []).filter(
    (option) => option.kind !== "borrow",
  )
  const rules = records([plan?.data.rules])[0]
  const snapshotId = plan?.snapshot_id
  const snapshotAllowElastic = rules?.allow_elastic === true
  const regularCapPercent =
    typeof rules?.default_allocation_cap_percent === "number"
      ? rules.default_allocation_cap_percent
      : 100
  useEffect(() => {
    if (snapshotId) setAllowElastic(snapshotAllowElastic)
  }, [snapshotId, snapshotAllowElastic])
  const selectedOptionId = hash ? new URLSearchParams(hash).get("option") : null
  const hasMatchedOption =
    !!selectedOptionId &&
    visibleOptions.some((item) => item.id === selectedOptionId)
  useEffect(() => {
    if (hasMatchedOption && selectedOptionId) {
      setActiveOptionId(selectedOptionId)
    }
  }, [hasMatchedOption, selectedOptionId])
  const activeOption =
    visibleOptions.find((option) => option.id === activeOptionId) ??
    visibleOptions[0]
  useEffect(() => {
    if (!hasMatchedOption || !selectedOptionId) return
    document
      .getElementById(`plan-option-${selectedOptionId}`)
      ?.scrollIntoView({ block: "center" })
  }, [hasMatchedOption, selectedOptionId])
  const error = simulation.error ?? current.error
  if (isCapacityAccessDenied(error))
    return <p role="alert">{t("capacity.plans.noPermission")}</p>
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">{t("capacity.plans.title")}</h3>
      {current.isPending && <ProfileLoading />}
      {error && <p role="alert">{errorText(error)}</p>}
      {error && (!plan || current.error) && (
        <Button
          variant="outline"
          onClick={() => simulation.mutate(allowElastic)}
          disabled={simulation.isPending || current.isFetching}
        >
          {t("capacity.plans.resimulate")}
        </Button>
      )}
      {plan && !current.error && (
        <>
          {plan.stale && <p role="alert">{t("capacity.plans.staleAlert")}</p>}
          {selectedOptionId && !hasMatchedOption && (
            <p role="status">{t("capacity.plans.missingHashOption")}</p>
          )}
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-surface-border bg-muted/20 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              {snapshotAllowElastic
                ? t("capacity.plans.modeElastic", {
                    cap: formatCapacityPercent(regularCapPercent),
                  })
                : t("capacity.plans.modeRegular", {
                    cap: formatCapacityPercent(regularCapPercent),
                  })}
            </span>
            <label className="inline-flex cursor-pointer items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={allowElastic}
                onChange={(event) => setAllowElastic(event.target.checked)}
                disabled={simulation.isPending || current.isFetching}
              />
              <span>{t("capacity.plans.allowElastic")}</span>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => simulation.mutate(allowElastic)}
              disabled={simulation.isPending || current.isFetching}
            >
              {t("capacity.plans.resimulate")}
            </Button>
          </div>
          {!visibleOptions.length ? (
            <p className="rounded-md border border-dashed border-surface-border p-4 text-sm text-muted-foreground">
              {t("capacity.plans.empty")}
            </p>
          ) : (
            <>
              {visibleOptions.length > 1 && (
                <div
                  role="tablist"
                  aria-label={t("capacity.plans.optionsTabAria")}
                  className="flex flex-wrap gap-2"
                >
                  {visibleOptions.map((option) => {
                    const isActive = option.id === activeOption?.id
                    const optionElastic =
                      typeof option.summary.elastic_used_percent === "number"
                        ? option.summary.elastic_used_percent
                        : 0
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => setActiveOptionId(option.id)}
                        className={`inline-flex cursor-pointer flex-wrap items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors sm:text-sm ${
                          isActive
                            ? "border-primary bg-primary/10 font-medium text-foreground ring-1 ring-primary/30"
                            : "border-surface-border bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                        }`}
                      >
                        <span>{option.kind_label}</span>
                        <Badge
                          variant={verdictBadgeVariant(option.verdict)}
                          className="px-1.5 py-0 text-[11px]"
                        >
                          {option.verdict_label}
                        </Badge>
                        <span>
                          {t("capacity.plans.finishPrefix", {
                            date: label(option.summary.finish_date),
                          })}
                        </span>
                        {option.summary.uses_elastic === true && (
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                            {t("capacity.plans.elasticUsedBadge", {
                              percent: formatCapacityPercent(optionElastic),
                            })}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
              {activeOption && (
                <OptionCard
                  key={activeOption.id}
                  option={activeOption}
                  plan={plan}
                  orgId={orgId}
                  selected={activeOption.id === selectedOptionId}
                  onRevised={async (createdOptionId) => {
                    if (createdOptionId) setActiveOptionId(createdOptionId)
                    await current.refetch()
                  }}
                  onReply={onReply}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
