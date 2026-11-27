import { useTranslation } from "react-i18next"
import type { EmployeeSummary } from "@/client"
import {
  employeeFieldLabels,
  tenureLabel,
} from "@/components/Roster/EmployeeFields"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"
import { formatDate } from "@/i18n/format"
import { initialStatusLabel } from "./initialStatus"
import { StatusBadge } from "./StatusBadge"

export function publishedLabel(value: EmployeeSummary["latest_published"]) {
  return value
    ? `r${value.revision} · ${formatDate(value.published_at)}`
    : i18n.t("profile.summary.unpublished")
}

export function EmployeeSummaryContent({
  employee,
  showHeading = true,
}: {
  employee: EmployeeSummary
  showHeading?: boolean
}) {
  const { t } = useTranslation()
  const { org } = useOrg()
  const statusTitles = [
    t("profile.summary.fillStatus"),
    t("profile.summary.initialProfile"),
    t("profile.summary.reviewStatus"),
  ]
  return (
    <div className="flex flex-col gap-6">
      {showHeading && (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">
            {t("profile.summary.heading")}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            {employee.display_name}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {employee.title ?? t("profile.summary.jobTitleEmpty")} ·{" "}
            {employee.department?.name ?? t("profile.summary.deptEmpty")}
          </p>
        </div>
      )}
      <dl className="grid gap-6 rounded-xl border bg-muted/10 p-6 sm:grid-cols-2 lg:grid-cols-4">
        {(["fill_status", "inference_status", "review_status"] as const).map(
          (kind, i) => (
            <div key={kind}>
              <dt className="mb-2 text-sm text-muted-foreground">
                {statusTitles[i]}
              </dt>
              <dd>
                {kind === "inference_status" ? (
                  initialStatusLabel(employee.progress?.initial_profile_status)
                ) : (
                  <StatusBadge kind={kind} value={employee.progress?.[kind]} />
                )}
              </dd>
            </div>
          ),
        )}
        {(org?.employee_fields ?? []).map((field) => (
          <div key={field}>
            <dt className="mb-2 text-sm text-muted-foreground">
              {field === "hire_date"
                ? t("profile.summary.tenure")
                : employeeFieldLabels[field]}
            </dt>
            <dd>
              {field === "hire_date" && employee.hire_date
                ? tenureLabel(employee.hire_date)
                : (employee[field] ?? "—")}
            </dd>
          </div>
        ))}
        <div>
          <dt className="mb-2 text-sm text-muted-foreground">
            {t("profile.summary.latestPublished")}
          </dt>
          <dd>{publishedLabel(employee.latest_published)}</dd>
        </div>
        <div>
          <dt className="mb-2 text-sm text-muted-foreground">
            {t("profile.summary.employmentStatus")}
          </dt>
          <dd>
            {employee.employment_status === "active"
              ? t("profile.summary.active")
              : t("profile.summary.inactive")}
          </dd>
        </div>
      </dl>
    </div>
  )
}
