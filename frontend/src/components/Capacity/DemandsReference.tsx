import { useMutation } from "@tanstack/react-query"
import { type ReactNode, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type CapacityReference,
  type CrossDeptFeasibilityDepartment,
  type CrossDeptFeasibilityInput,
  type DepartmentPublic,
  PlanningService,
} from "@/client"
import { Button } from "@/components/ui/button"
import i18n from "@/i18n"
import { CapacityError } from "./AssignmentFields"
import {
  formatCapacityPercent,
  formatIsoDate,
  formatIsoDateRange,
} from "./shared"

export function DemandsReference({
  reference,
}: {
  reference: CapacityReference
}) {
  const { t } = useTranslation()
  if ("conclusion" in reference) {
    const conclusionText =
      reference.conclusion === "can_do"
        ? t("capacity.demands.reference.canDo")
        : reference.conclusion === "later"
          ? t("capacity.demands.reference.later")
          : t("capacity.demands.reference.cannotDo")
    return (
      <p>
        {t("capacity.demands.reference.deptCapabilityLine", {
          dept: reference.department_name,
          capability: reference.capability_name,
          conclusion: conclusionText,
        })}
      </p>
    )
  }
  return (
    <p>
      {t("capacity.demands.reference.summaryLine", {
        dept: reference.department_name,
        count: reference.count,
        available: reference.available,
        full: reference.full,
        overloaded: reference.overloaded,
        unconfirmed: reference.unconfirmed,
      })}
    </p>
  )
}

export function readDemandExtras(data: FormData, prefix: string) {
  const levels = data.getAll(`${prefix}extra-level`)
  const required = data.getAll(`${prefix}required`)
  return data.getAll(`${prefix}extra`).map((key, index) => ({
    key: String(key),
    minimum_level: String(levels[index] ?? "") || null,
    required: required.includes(String(index)),
  }))
}

const loadLabelKeys = {
  low: "capacity.demands.reference.load.low",
  medium: "capacity.demands.reference.load.medium",
  high: "capacity.demands.reference.load.high",
  very_high: "capacity.demands.reference.load.very_high",
  unknown: "capacity.demands.reference.load.unknown",
  withheld: "capacity.demands.reference.load.withheld",
} as const

function conclusion(result: CrossDeptFeasibilityDepartment) {
  if (result.conclusion === "can_do")
    return i18n.t("capacity.demands.reference.conclusionCanDo", {
      range: formatIsoDateRange(
        result.suggested_start_date ?? "",
        result.suggested_end_date ?? "",
      ),
    })
  if (result.conclusion === "later")
    return i18n.t("capacity.demands.reference.conclusionLater", {
      earliest: result.earliest_start_date
        ? formatIsoDate(result.earliest_start_date)
        : "",
      range: formatIsoDateRange(
        result.suggested_start_date ?? "",
        result.suggested_end_date ?? "",
      ),
    })
  if (result.conclusion === "needs_confirmation")
    return i18n.t("capacity.demands.reference.conclusionNeedsConfirm")
  return result.load_level === "unknown" || result.load_level == null
    ? i18n.t("capacity.demands.reference.conclusionUnknown")
    : i18n.t("capacity.demands.reference.conclusionCannotDo")
}

function assessmentSummary(result: CrossDeptFeasibilityDepartment) {
  const percent = result.department_load_percent
  const level = result.load_level ?? "unknown"
  const load =
    level === "withheld"
      ? i18n.t("capacity.demands.reference.withheldLoad", {
          label: i18n.t(loadLabelKeys.withheld),
        })
      : percent != null
        ? i18n.t("capacity.demands.reference.overallLoad", {
            percent: formatCapacityPercent(percent),
            level: i18n.t(loadLabelKeys[level]),
          })
        : ""
  return `${load}${conclusion(result)}${result.is_estimated ? i18n.t("capacity.demands.reference.estimatedTag") : ""}`
}

export function DemandTarget({
  orgId,
  departments,
  prefix = "",
  structureKey = "",
  children,
}: {
  orgId: string
  departments: DepartmentPublic[]
  prefix?: string
  structureKey?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const targetId = useId()
  const [inputError, setInputError] = useState(false)
  const assessment = useMutation({
    mutationFn: ({
      body,
    }: {
      body: CrossDeptFeasibilityInput
      structureKey: string
    }) => PlanningService.assessFeasibility({ path: { org_id: orgId }, body }),
  })
  const result =
    assessment.variables?.structureKey === structureKey
      ? assessment.data?.data
      : undefined
  const results = new Map(
    result?.departments.map((item) => [item.department_id, item]),
  )
  const options = departments.map((department) => ({
    department,
    result: results.get(department.id),
  }))
  options.sort((a, b) => {
    const order = [
      "can_do",
      "later",
      "needs_confirmation",
      "cannot_do",
      undefined,
    ]
    return (
      order.indexOf(a.result?.conclusion) - order.indexOf(b.result?.conclusion)
    )
  })

  return (
    <div
      className="space-y-4"
      onChange={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.matches(
            "[name$=capability], [name$=minimum], [name$=level], [name$=start], [name$=end], [name$=extra], [name$=required]",
          )
        ) {
          assessment.reset()
          setInputError(false)
        }
      }}
    >
      {children}
      <section
        aria-label={t("capacity.demands.reference.assessAria")}
        className="space-y-3 rounded-lg border bg-muted/30 p-4"
      >
        <Button
          type="button"
          variant="outline"
          disabled={assessment.isPending}
          onClick={(event) => {
            const data = new FormData(event.currentTarget.form ?? undefined)
            const capability = String(data.get(`${prefix}capability`) ?? "")
            const start = String(data.get(`${prefix}start`) ?? "")
            const end = String(data.get(`${prefix}end`) ?? "")
            setInputError(!capability || !start || !end || end < start)
            if (!capability || !start || !end || end < start) return
            assessment.mutate({
              structureKey,
              body: {
                capability_key: capability,
                minimum_level:
                  String(
                    data.get(prefix ? `${prefix}level` : "minimum") ?? "",
                  ) || null,
                window_start: start,
                window_end: end,
                extra_capabilities: readDemandExtras(data, prefix).filter(
                  ({ key }) => key,
                ),
              },
            })
          }}
        >
          {assessment.isPending
            ? t("capacity.demands.reference.assessing")
            : t("capacity.demands.reference.assessBtn")}
        </Button>
        {inputError && (
          <p role="alert" className="text-sm text-destructive">
            {t("capacity.demands.reference.assessInputError")}
          </p>
        )}
        <CapacityError error={assessment.error} />
        <div className="space-y-2 text-sm font-medium">
          <label htmlFor={targetId}>
            {t("capacity.demands.reference.targetDept")}
          </label>
          <select
            id={targetId}
            name={prefix ? `${prefix}department` : "target"}
            className="h-10 w-full rounded-md border bg-background px-3"
            required
          >
            <option value="">
              {t("capacity.demands.create.selectPlaceholder")}
            </option>
            {options.map(({ department, result }) => (
              <option key={department.id} value={department.id}>
                {department.name}
                {result ? ` · ${assessmentSummary(result)}` : ""}
              </option>
            ))}
          </select>
        </div>
        {result && (
          <div
            className="space-y-1 text-sm text-muted-foreground"
            role="status"
          >
            {options
              .filter(
                ({ result }) =>
                  result?.department_load_percent != null ||
                  result?.load_level === "withheld" ||
                  result?.conclusion === "needs_confirmation",
              )
              .map(
                ({ department, result }) =>
                  result && (
                    <p key={department.id}>
                      {department.name} · {assessmentSummary(result)}
                    </p>
                  ),
              )}
            <p>{t("capacity.demands.reference.estimateNote")}</p>
          </div>
        )}
      </section>
    </div>
  )
}
