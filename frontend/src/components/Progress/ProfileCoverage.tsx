import { useQuery } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type CoverageSummary,
  OrgsService,
  type ProgressReviewStatus,
} from "@/client"
import { HelpTip, SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { Button } from "@/components/ui/button"
import { formatDate, formatPercent } from "@/i18n/format"

const statusMeta = [
  ["published", "bg-emerald-500"],
  ["disputed", "bg-rose-500"],
  ["pending_employee", "bg-amber-500"],
  ["pending_manager", "bg-sky-500"],
  ["none", "bg-muted-foreground"],
] as const

export function ProfileCoverage({
  orgId,
  department,
  onDepartmentChange,
  reviewStatus,
  onStatusChange,
}: {
  orgId: string
  department: string
  onDepartmentChange?: (id: string) => void
  reviewStatus: ProgressReviewStatus | null
  onStatusChange?: (status: ProgressReviewStatus | null) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const coverage = useQuery({
    queryKey: ["coverage", orgId],
    queryFn: async () =>
      (await OrgsService.getCoverage({ path: { org_id: orgId } })).data,
  })
  function counts(summary: CoverageSummary) {
    return statusMeta.map(([status, color]) => ({
      status,
      title: t(`admin.coverage.statuses.${status}`),
      color,
      value: summary.statuses.find((item) => item.status === status),
    }))
  }
  const summary = coverage.data
  const metrics = summary ? counts(summary) : []
  return (
    <SectionCard
      aria-label={t("admin.coverage.sectionAriaLabel")}
      className="space-y-2 px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-1.5">
          <h2 className="whitespace-nowrap font-semibold text-sm">
            {t("admin.coverage.heading")}
          </h2>
          <HelpTip
            label={t("admin.coverage.tipLabel")}
            content={t("admin.coverage.tipContent")}
          />
        </div>
        {coverage.isPending ? (
          <p role="status" className="text-sm">
            {t("admin.coverage.loading")}
          </p>
        ) : coverage.isError ? (
          <div role="alert" className="flex items-center gap-2 text-sm">
            {t("admin.coverage.error")}
            <Button
              variant="outline"
              size="sm"
              onClick={() => coverage.refetch()}
            >
              {t("admin.common.retry")}
            </Button>
          </div>
        ) : (
          summary && (
            <>
              <p className="whitespace-nowrap text-muted-foreground text-xs">
                {t("admin.coverage.totalLabel")}{" "}
                <strong className="text-foreground text-sm tabular-nums">
                  {summary.total}
                </strong>
                {t("admin.coverage.totalUnit")
                  ? ` ${t("admin.coverage.totalUnit")}`
                  : ""}
              </p>
              {metrics.map(({ status, title, color, value }) => (
                <Button
                  key={status}
                  variant={reviewStatus === status ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-1.5 text-xs tabular-nums"
                  disabled={!onStatusChange}
                  aria-pressed={reviewStatus === status}
                  onClick={() =>
                    onStatusChange?.(reviewStatus === status ? null : status)
                  }
                >
                  <span className={`size-1.5 shrink-0 rounded-full ${color}`} />
                  <span>{title}</span>
                  <strong>{value?.count ?? 0}</strong>
                  <span className="text-muted-foreground">
                    {formatPercent((value?.percentage ?? 0) / 100, {
                      maximumFractionDigits: 1,
                    })}
                  </span>
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={expanded}
                className="ml-auto h-7 text-xs"
                onClick={() => setExpanded(!expanded)}
              >
                {t("admin.coverage.byDepartment")}
                <ChevronDown
                  aria-hidden="true"
                  className={expanded ? "rotate-180" : ""}
                />
              </Button>
            </>
          )
        )}
      </div>
      {summary && (
        <>
          <div
            aria-hidden="true"
            className="flex h-1.5 overflow-hidden rounded-full bg-muted"
          >
            {metrics.map(({ status, color, value }) => (
              <span
                key={status}
                className={color}
                style={{ width: `${value?.percentage ?? 0}%` }}
              />
            ))}
          </div>
          {(expanded ||
            summary.overdue_initial_requests > 0 ||
            summary.review_backlog_requests > 0 ||
            summary.jira_sync_failure) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
              <p>
                {t("admin.coverage.overdueInitial", {
                  count: summary.overdue_initial_requests,
                })}
              </p>
              <p>
                {t("admin.coverage.reviewBacklog", {
                  count: summary.review_backlog_requests,
                })}
              </p>
              {summary.jira_sync_failure && (
                <p className="text-destructive">
                  {t("admin.coverage.jiraFailure", {
                    name: summary.jira_sync_failure.connection_name,
                    time: formatDate(summary.jira_sync_failure.failed_at, {
                      dateStyle: "short",
                      timeStyle: "medium",
                    }),
                  })}
                </p>
              )}
            </div>
          )}
          {expanded && (
            <div className="divide-y border-surface-border border-t">
              <div className="flex flex-wrap items-center justify-between gap-2 py-2">
                <p className="text-muted-foreground text-xs">
                  {t("admin.coverage.unassignedNote")}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={department === "all"}
                  disabled={!onDepartmentChange}
                  onClick={() => onDepartmentChange?.("all")}
                >
                  {t("admin.coverage.allDepartments")}
                </Button>
              </div>
              {summary.departments.map((item) => (
                <div key={item.department_id} className="space-y-1.5 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <Button
                      variant={
                        department === item.department_id
                          ? "secondary"
                          : "ghost"
                      }
                      size="sm"
                      aria-pressed={department === item.department_id}
                      disabled={!onDepartmentChange}
                      onClick={() => onDepartmentChange?.(item.department_id)}
                    >
                      {t("admin.coverage.departmentTotal", {
                        name: item.department_name,
                        total: item.total,
                      })}
                    </Button>
                    <dl className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
                      {counts(item).map(({ status, title, value }) => (
                        <div key={status} className="flex gap-1">
                          <dt>{title}</dt>
                          <dd className="text-muted-foreground">
                            {value?.count ?? 0} ·{" "}
                            {formatPercent((value?.percentage ?? 0) / 100, {
                              maximumFractionDigits: 1,
                            })}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                  {item.with_descendants && (
                    <p className="px-3 text-muted-foreground text-xs">
                      {t("admin.coverage.withDescendants", {
                        total: item.with_descendants.total,
                        stats: counts(item.with_descendants)
                          .map(({ title, value }) =>
                            t("admin.coverage.descendantStat", {
                              title,
                              count: value?.count ?? 0,
                            }),
                          )
                          .join(""),
                      })}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </SectionCard>
  )
}
