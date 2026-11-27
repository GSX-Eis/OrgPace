import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, Navigate } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import type { TFunction } from "i18next"
import { Search } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type EmployeeSummary,
  EmployeesService,
  OrgsService,
  type ProgressReviewStatus,
} from "@/client"
import { EmployeesAdminList } from "@/components/Admin/EmployeesAdminList"
import {
  DataTable,
  type DataTableFeatures,
} from "@/components/Common/DataTable"
import { WorkspacePage } from "@/components/Common/WorkbenchPrimitives"
import {
  EmployeeQuickPeekDrawer,
  preventRowEnterDefault,
} from "@/components/Profile/EmployeeQuickPeekDrawer"
import { publishedLabel } from "@/components/Profile/EmployeeSummary"
import { ExportProfilesButtons } from "@/components/Profile/ExportProfilesButtons"
import { initialStatusLabel } from "@/components/Profile/initialStatus"
import { OrgState } from "@/components/Profile/OrgState"
import { StatusBadge } from "@/components/Profile/StatusBadge"
import { ProfileCoverage } from "@/components/Progress/ProfileCoverage"
import {
  employeeFieldLabels,
  tenureLabel,
} from "@/components/Roster/EmployeeFields"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"

export const Route = createFileRoute("/_layout/employees/")({
  component: EmployeesPage,
  validateSearch: (search: Record<string, unknown>): { filter?: string } => ({
    filter: ["appeals", "identities", "roles", "account-only"].includes(
      String(search.filter),
    )
      ? String(search.filter)
      : undefined,
  }),
  head: () => ({ meta: [{ title: i18n.t("people.list.pageTitle") }] }),
})

function columns(
  t: TFunction,
): ColumnDef<DataTableFeatures, EmployeeSummary>[] {
  const statusHeaders = [
    t("people.list.columns.fillStatus"),
    t("people.list.columns.initialProfile"),
    t("people.list.columns.reviewStatus"),
  ]
  return [
    {
      accessorKey: "display_name",
      header: t("people.list.columns.name"),
      cell: ({ row }) => (
        <Link
          className="font-medium hover:underline"
          to="/employees/$employeeId"
          params={{ employeeId: row.original.id }}
        >
          {row.original.display_name}
        </Link>
      ),
    },
    {
      accessorKey: "employee_code",
      header: t("people.list.columns.employeeCode"),
      cell: ({ row }) =>
        row.original.employee_code ?? t("people.list.unfilled"),
    },
    {
      accessorKey: "title",
      header: t("people.list.columns.title"),
      cell: ({ row }) => row.original.title ?? "—",
    },
    {
      id: "department",
      header: t("people.list.columns.department"),
      cell: ({ row }) => row.original.department?.name ?? "—",
    },
    ...(["fill_status", "inference_status", "review_status"] as const).map(
      (kind, i) => ({
        id: kind,
        header: statusHeaders[i],
        cell: ({ row }: { row: { original: EmployeeSummary } }) =>
          kind === "inference_status" ? (
            initialStatusLabel(row.original.progress?.initial_profile_status)
          ) : (
            <StatusBadge kind={kind} value={row.original.progress?.[kind]} />
          ),
      }),
    ),
    {
      id: "published",
      header: t("people.list.columns.latestPublished"),
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {publishedLabel(row.original.latest_published)}
        </span>
      ),
    },
  ]
}

function EmployeesPage() {
  const { org, roles } = useOrg()
  const { filter } = Route.useSearch()
  if (!org) return <OrgState />
  if (!roles.includes("org_admin") && !roles.includes("dept_manager"))
    return <Navigate to="/" replace />
  return roles.includes("org_admin") ? (
    <EmployeesAdminList key={org.id} filter={filter} />
  ) : (
    <EmployeesList key={org.id} orgId={org.id} />
  )
}

function EmployeesList({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const { org, roles, managedDepartmentIds } = useOrg()
  const [reviewStatus, setReviewStatus] = useState<ProgressReviewStatus | null>(
    null,
  )
  const [preview, setPreview] = useState<EmployeeSummary | null>(null)
  const [department, setDepartment] = useState("all")
  const [search, setSearch] = useState("")
  const [q, setQ] = useState("")
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 })
  useEffect(() => {
    const timeout = setTimeout(() => {
      setQ(search.trim())
      setPagination((value) => ({ ...value, pageIndex: 0 }))
    }, 300)
    return () => clearTimeout(timeout)
  }, [search])
  const departments = useQuery({
    queryKey: ["departments", orgId],
    queryFn: async () =>
      (await OrgsService.readDepartments({ path: { org_id: orgId } })).data,
  })
  const employees = useQuery({
    queryKey: ["employees", orgId, department, q, reviewStatus, pagination],
    queryFn: async () =>
      (
        await EmployeesService.readEmployees({
          path: { org_id: orgId },
          query: {
            department_id: department === "all" ? undefined : department,
            q: q || undefined,
            review_status: reviewStatus ?? undefined,
            skip: pagination.pageIndex * pagination.pageSize,
            limit: pagination.pageSize,
          },
        })
      ).data,
  })
  const options =
    departments.data?.data.filter(
      (item) =>
        roles.includes("org_admin") || managedDepartmentIds.includes(item.id),
    ) ?? []
  function changeDepartment(value: string) {
    setDepartment(value)
    setPagination((old) => ({ ...old, pageIndex: 0 }))
  }
  return (
    <WorkspacePage className="space-y-3">
      <h1 className="sr-only">{t("people.list.heading")}</h1>
      <ExportProfilesButtons orgId={orgId} />
      <ProfileCoverage
        orgId={orgId}
        department={department}
        onDepartmentChange={changeDepartment}
        reviewStatus={reviewStatus}
        onStatusChange={(status) => {
          setReviewStatus(status)
          setPagination((old) => ({ ...old, pageIndex: 0 }))
        }}
      />
      <div className="space-y-0">
        <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-t-lg border border-surface-border bg-surface px-3 py-1.5">
          <div className="relative min-w-36 flex-1 sm:max-w-56">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
            />
            <Input
              aria-label={t("people.list.searchAria")}
              placeholder={t("people.list.searchPlaceholder")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 pl-8"
            />
          </div>
          <Select value={department} onValueChange={changeDepartment}>
            <SelectTrigger
              aria-label={t("people.list.deptFilterAria")}
              size="sm"
              className="w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("people.list.allDepartments")}
              </SelectItem>
              {options.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
            {t("people.list.totalEmployees", {
              count: employees.data?.count ?? "—",
            })}
          </span>
        </div>
        {departments.isError && (
          <div role="alert">
            {t("people.list.loadDeptError")}
            <Button variant="outline" onClick={() => departments.refetch()}>
              {t("people.list.retry")}
            </Button>
          </div>
        )}
        {employees.isPending ? (
          <p role="status">{t("people.list.loadingEmployees")}</p>
        ) : employees.isError ? (
          <div role="alert">
            {t("people.list.loadEmployeesError")}
            <Button variant="outline" onClick={() => employees.refetch()}>
              {t("people.list.retry")}
            </Button>
          </div>
        ) : (
          <>
            <section
              className="space-y-2 pt-2 sm:hidden"
              aria-label={t("people.list.mobileCardsAria")}
            >
              {employees.data.data.length === 0 && (
                <p>{t("people.list.noEmployees")}</p>
              )}
              {employees.data.data.map((employee) => (
                <article
                  key={employee.id}
                  aria-label={employee.display_name}
                  className="space-y-2 rounded-lg border border-surface-border bg-surface p-3 wrap-anywhere"
                >
                  <Link
                    className="font-semibold text-primary hover:underline"
                    to="/employees/$employeeId"
                    params={{ employeeId: employee.id }}
                  >
                    {employee.display_name}
                  </Link>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">
                      {t("people.list.columns.employeeCode")}
                    </dt>
                    <dd>
                      {employee.employee_code ?? t("people.list.unfilled")}
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("people.list.columns.department")}
                    </dt>
                    <dd>
                      {employee.department?.name ?? t("people.list.deptEmpty")}
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("people.list.columns.initialProfile")}
                    </dt>
                    <dd>
                      {initialStatusLabel(
                        employee.progress?.initial_profile_status,
                      )}
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("people.list.columns.reviewStatus")}
                    </dt>
                    <dd>
                      <StatusBadge
                        kind="review_status"
                        value={employee.progress?.review_status}
                      />
                    </dd>
                  </dl>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-9"
                    onClick={() => setPreview(employee)}
                  >
                    {t("people.list.quickView")}
                  </Button>
                </article>
              ))}
              {employees.data.count > pagination.pageSize && (
                <div className="flex items-center justify-between gap-2">
                  <Button
                    variant="outline"
                    disabled={pagination.pageIndex === 0}
                    onClick={() =>
                      setPagination((old) => ({
                        ...old,
                        pageIndex: old.pageIndex - 1,
                      }))
                    }
                  >
                    {t("people.list.prevPage")}
                  </Button>
                  <span className="text-sm">
                    {t("people.list.pageNumber", {
                      page: pagination.pageIndex + 1,
                    })}
                  </span>
                  <Button
                    variant="outline"
                    disabled={
                      (pagination.pageIndex + 1) * pagination.pageSize >=
                      employees.data.count
                    }
                    onClick={() =>
                      setPagination((old) => ({
                        ...old,
                        pageIndex: old.pageIndex + 1,
                      }))
                    }
                  >
                    {t("people.list.nextPage")}
                  </Button>
                </div>
              )}
            </section>
            <div
              onKeyDownCapture={preventRowEnterDefault}
              className="hidden min-w-0 sm:block [&>div]:rounded-t-none [&>div]:border-t-0 [&_th]:h-11"
            >
              <DataTable
                columns={[
                  ...columns(t),
                  ...(org?.employee_fields ?? []).map((field) => ({
                    id: field,
                    header:
                      field === "hire_date"
                        ? t("people.list.columns.tenure")
                        : employeeFieldLabels[field],
                    cell: ({ row }: { row: { original: EmployeeSummary } }) =>
                      field === "hire_date" && row.original.hire_date
                        ? tenureLabel(row.original.hire_date)
                        : (row.original[field] ?? "—"),
                  })),
                ]}
                data={employees.data.data}
                pagination={pagination}
                onPaginationChange={setPagination}
                rowCount={employees.data.count}
                onRowClick={setPreview}
              />
            </div>
          </>
        )}
      </div>
      <EmployeeQuickPeekDrawer
        orgId={orgId}
        employee={preview}
        onClose={() => setPreview(null)}
      />
    </WorkspacePage>
  )
}
