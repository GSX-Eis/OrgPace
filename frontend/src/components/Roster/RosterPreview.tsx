import { useTranslation } from "react-i18next"
import type { RosterImportPreview } from "@/client"
import { localeRecord } from "@/components/Admin/labels"
import { DataTable } from "@/components/Common/DataTable"
import { DepartmentTree } from "./DepartmentTree"

export const changeLabels = localeRecord(
  {
    added: "",
    updated: "",
    transferred: "",
    manager_changed: "",
    deactivated: "",
    reactivated: "",
  },
  "setup.rosterPreview.changes",
)
const fieldLabels: Record<string, string> = localeRecord(
  {
    job_family: "",
    work_location: "",
    hire_date: "",
    display_name: "",
    title: "",
    email: "",
    department: "",
    manager: "",
  },
  "setup.rosterPreview.fields",
)

export function RosterPreview({ preview }: { preview: RosterImportPreview }) {
  const { t } = useTranslation()
  const errors = preview.issues.filter((issue) => issue.severity === "error")
  const warnings = preview.issues.filter(
    (issue) => issue.severity === "warning",
  )
  const sep = t("setup.rosterPreview.fieldSeparator")
  const emptyVal = t("setup.rosterPreview.emptyValue")
  return (
    <section
      aria-label={t("setup.rosterPreview.sectionAriaLabel")}
      className="space-y-5"
    >
      <h3 className="text-lg font-semibold">
        {t("setup.rosterPreview.heading")}
      </h3>
      <details>
        <summary className="cursor-pointer">
          {t("setup.rosterPreview.columnsSummary")}
        </summary>
        <ul className="mt-2 text-sm">
          {Object.entries(preview.column_mapping).map(([from, to]) => (
            <li key={from}>
              {from} → {to}
            </li>
          ))}
        </ul>
      </details>
      {errors.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-destructive p-4 text-destructive"
        >
          <h4 className="font-semibold">
            {t("setup.rosterPreview.errorsHeading")}
          </h4>
          <DataTable
            data={errors}
            columns={[
              {
                accessorKey: "row_number",
                header: t("setup.rosterPreview.colRow"),
                cell: ({ row }) =>
                  row.original.row_number ?? t("setup.rosterPreview.rowFile"),
              },
              {
                accessorKey: "column",
                header: t("setup.rosterPreview.colColumn"),
              },
              {
                accessorKey: "message",
                header: t("setup.rosterPreview.colIssue"),
              },
            ]}
          />
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-lg border bg-muted/40 p-4 text-sm">
          <h4 className="font-semibold">
            {t("setup.rosterPreview.warningsHeading")}
          </h4>
          <ul className="list-disc pl-5">
            {warnings.map((issue, index) => (
              <li key={`${index}:${issue.message}`}>
                {issue.row_number
                  ? t("setup.rosterPreview.warningRowPrefix", {
                      row: issue.row_number,
                    })
                  : ""}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Object.entries(changeLabels).map(([kind, label]) => (
          <details
            key={kind}
            className={`min-w-0 rounded-lg border p-3 ${kind === "deactivated" && preview.summary[kind] ? "border-destructive bg-destructive/5" : "bg-muted/20"}`}
          >
            <summary className="cursor-pointer font-medium">
              {t("setup.rosterPreview.summaryItem", {
                label,
                count: preview.summary[kind] ?? 0,
              })}
            </summary>
            <DataTable
              data={preview.changes.filter((item) => item.kind === kind)}
              columns={[
                {
                  accessorKey: "employee_code",
                  header: t("setup.rosterPreview.colEmployeeCode"),
                },
                {
                  accessorKey: "display_name",
                  header: t("setup.rosterPreview.colDisplayName"),
                },
                {
                  id: "before",
                  header: t("setup.rosterPreview.colBefore"),
                  cell: ({ row }) =>
                    (row.original.fields ?? [])
                      .map((f) =>
                        t("setup.rosterPreview.fieldValue", {
                          field: fieldLabels[f.field] ?? f.field,
                          value: f.before ?? emptyVal,
                        }),
                      )
                      .join(sep) ||
                    (kind === "deactivated"
                      ? t("setup.rosterPreview.statusActive")
                      : kind === "reactivated"
                        ? t("setup.rosterPreview.statusInactive")
                        : emptyVal),
                },
                {
                  id: "after",
                  header: t("setup.rosterPreview.colAfter"),
                  cell: ({ row }) =>
                    (row.original.fields ?? [])
                      .map((f) =>
                        t("setup.rosterPreview.fieldValue", {
                          field: fieldLabels[f.field] ?? f.field,
                          value: f.after ?? emptyVal,
                        }),
                      )
                      .join(sep) || label,
                },
              ]}
            />
          </details>
        ))}
        <details className="rounded-lg border bg-muted/20 p-3">
          <summary className="cursor-pointer font-medium">
            {t("setup.rosterPreview.createdDepartments", {
              count: preview.created_departments.length,
            })}
          </summary>
          <ul className="mt-2 text-sm">
            {preview.created_departments.map((path) => (
              <li key={path.join("/")}>{path.join(" / ")}</li>
            ))}
          </ul>
        </details>
      </div>
      <div className="rounded-lg border p-4">
        <h4 className="mb-3 font-semibold">
          {t("setup.rosterPreview.departmentTreeHeading")}
        </h4>
        <DepartmentTree nodes={preview.departments} />
      </div>
    </section>
  )
}
