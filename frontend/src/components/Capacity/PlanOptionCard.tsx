import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { AssigneeInput, CasePublic } from "@/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useOrg } from "@/hooks/useOrg"
import { countWeeks } from "./dateUtils"
import { SegmentEditor } from "./PlanSegmentEditor"
import {
  createBlankSegment,
  isInDemandWindow,
  label,
  number,
  personWeeks,
  records,
  type SelectedPlanReply,
  strings,
  summarizeFindings,
  verdictBadgeVariant,
} from "./PlansShared"
import { formatCapacityPercent, formatIsoDateRange } from "./shared"

export function OptionCard({
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
