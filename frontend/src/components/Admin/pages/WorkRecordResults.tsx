import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { type Dispatch, type SetStateAction, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { WorkRecordPublic, WorkRecordsPublic } from "@/client"
import { localeRecord } from "@/components/Admin/labels"
import {
  DataTable,
  type DataTableFeatures,
} from "@/components/Common/DataTable"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/i18n/format"

const roleNames: Record<string, string> = localeRecord(
  {
    assignee: "",
    reporter: "",
  },
  "sources.workRecords.roles",
)

function formatRole(role: string) {
  return roleNames[role] ?? role
}

export function formatTime(value: string | null | undefined) {
  if (!value) return "—"
  return formatDate(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function PeopleCell({ record }: { record: WorkRecordPublic }) {
  const { t } = useTranslation()
  if (!record.people.length)
    return <span className="text-muted-foreground">—</span>
  return (
    <ul className="space-y-1 text-xs">
      {record.people.map((person, index) => {
        const name =
          person.employee_name ?? person.display_name ?? person.external_id
        return (
          <li
            key={`${person.external_id}:${person.role}:${index}`}
            className="flex flex-wrap items-center gap-1"
          >
            {person.employee_id ? (
              <Link
                to="/employees/$employeeId"
                params={{ employeeId: person.employee_id }}
                className="font-medium text-primary hover:underline"
              >
                {name}
              </Link>
            ) : (
              <span>{name}</span>
            )}
            {person.role && (
              <span className="text-muted-foreground">
                {t("sources.workRecords.personRole", {
                  role: formatRole(person.role),
                })}
              </span>
            )}
            {person.department && (
              <span className="text-muted-foreground">
                · {person.department.name}
              </span>
            )}
            {!person.employee_id && (
              <Badge variant="outline" className="py-0 text-[11px]">
                {t("sources.workRecords.unlinkedBadge")}
              </Badge>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function WorkRecordResults({
  records,
  pagination,
  setPagination,
}: {
  records: WorkRecordsPublic
  pagination: { pageIndex: number; pageSize: number }
  setPagination: Dispatch<
    SetStateAction<{ pageIndex: number; pageSize: number }>
  >
}) {
  const { t } = useTranslation()
  const sourceDisplay = useCallback(
    (record: WorkRecordPublic) =>
      record.source_kind === "jira"
        ? "Jira"
        : t("sources.workRecords.sourceCsv", { label: record.source_label }),
    [t],
  )

  const columns = useMemo<ColumnDef<DataTableFeatures, WorkRecordPublic>[]>(
    () => [
      {
        id: "title",
        header: t("sources.workRecords.columns.title"),
        cell: ({ row: { original: record } }) => (
          <div className="max-w-md space-y-0.5 py-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {!record.redacted && (
                <span className="font-mono text-xs text-muted-foreground">
                  {record.external_key}
                </span>
              )}
              <span className="font-medium wrap-anywhere">{record.title}</span>
            </div>
            {(record.project || record.task_type) && !record.redacted && (
              <p className="text-xs text-muted-foreground">
                {[record.project, record.task_type].filter(Boolean).join(" · ")}
              </p>
            )}
            {record.detail && !record.redacted && (
              <p className="line-clamp-2 text-xs text-muted-foreground wrap-anywhere">
                {record.detail}
              </p>
            )}
          </div>
        ),
      },
      {
        id: "status",
        header: t("sources.workRecords.columns.status"),
        cell: ({ row: { original: record } }) =>
          record.status ? (
            <Badge variant="secondary">{record.status}</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "occurred_at",
        header: t("sources.workRecords.columns.occurredAt"),
        cell: ({ row: { original: record } }) => (
          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {formatTime(record.occurred_at)}
          </span>
        ),
      },
      {
        id: "people",
        header: t("sources.workRecords.columns.people"),
        cell: ({ row }) => <PeopleCell record={row.original} />,
      },
      {
        id: "source",
        header: t("sources.workRecords.columns.source"),
        cell: ({ row: { original: record } }) => (
          <Badge variant="outline" className="whitespace-nowrap">
            {sourceDisplay(record)}
          </Badge>
        ),
      },
    ],
    [t, sourceDisplay],
  )

  return (
    <>
      <section
        aria-label={t("sources.workRecords.cardsAriaLabel")}
        className="space-y-2 sm:hidden"
      >
        {records.data.length === 0 && (
          <p className="rounded-lg border border-surface-border bg-surface p-4 text-center text-sm text-muted-foreground">
            {t("sources.workRecords.empty")}
          </p>
        )}
        {records.data.map((record) => (
          <article
            key={record.id}
            className="space-y-2 rounded-lg border border-surface-border bg-surface p-3 wrap-anywhere"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant="outline">{sourceDisplay(record)}</Badge>
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatTime(record.occurred_at)}
              </span>
            </div>
            <p className="font-medium">
              {!record.redacted && (
                <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                  {record.external_key}
                </span>
              )}
              {record.title}
            </p>
            {record.status && (
              <Badge variant="secondary">{record.status}</Badge>
            )}
            <PeopleCell record={record} />
          </article>
        ))}
      </section>
      <div className="hidden min-w-0 sm:block">
        <DataTable
          columns={columns}
          data={records.data}
          rowCount={records.count}
          pagination={pagination}
          onPaginationChange={setPagination}
          getRowId={(record) => record.id}
        />
      </div>
    </>
  )
}
