import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Search } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AccountsService,
  AppealsService,
  type EmployeeAccount,
  type EmploymentStatus,
  OrgsService,
  type ProgressReviewStatus,
} from "@/client"
import { AccountTable } from "@/components/Admin/AccountTable"
import { departmentOptions } from "@/components/Admin/departments"
import { IssueAccountsDialog } from "@/components/Admin/IssueAccountsDialog"
import {
  type AccountStatus,
  accountLabels,
  employmentLabels,
} from "@/components/Admin/labels"
import { PersonnelDialog } from "@/components/Admin/PersonnelDialog"
import { ResetPasswordDialog } from "@/components/Admin/ResetPasswordDialog"
import { UnlinkedAccounts } from "@/components/Admin/UnlinkedAccounts"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { WorkspacePage } from "@/components/Common/WorkbenchPrimitives"
import { UnmatchedIdentities } from "@/components/Identities/UnmatchedIdentities"
import { EmployeeQuickPeekDrawer } from "@/components/Profile/EmployeeQuickPeekDrawer"
import { ExportProfilesButtons } from "@/components/Profile/ExportProfilesButtons"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileCoverage } from "@/components/Progress/ProfileCoverage"
import { EmployeeFields } from "@/components/Roster/EmployeeFields"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useOrg } from "@/hooks/useOrg"
import { handleError } from "@/utils"

export function EmployeesAdminList({ filter }: { filter?: string }) {
  const { org } = useOrg()
  return org ? (
    <AccountsList key={`${org.id}:${filter}`} orgId={org.id} filter={filter} />
  ) : (
    <OrgState />
  )
}

function AccountsList({ orgId, filter }: { orgId: string; filter?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const client = useQueryClient()
  const { org, roles } = useOrg()
  const [reviewStatus, setReviewStatus] = useState<ProgressReviewStatus | null>(
    null,
  )
  const [preview, setPreview] = useState<EmployeeAccount | null>(null)
  const [department, setDepartment] = useState("all")
  const [status, setStatus] = useState<AccountStatus | "all">("all")
  const [employment, setEmployment] = useState<EmploymentStatus | "all">("all")
  const [search, setSearch] = useState("")
  const [q, setQ] = useState("")
  const [passwordTarget, setPasswordTarget] = useState<EmployeeAccount | null>(
    null,
  )
  const [selected, setSelected] = useState<string[]>([])
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 })
  function reset() {
    setSelected([])
    setPagination((old) => ({ ...old, pageIndex: 0 }))
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      setSelected([])
      setQ(search.trim())
      setPagination((old) => ({ ...old, pageIndex: 0 }))
    }, 300)
    return () => clearTimeout(timer)
  }, [search])
  const departments = useQuery({
    queryKey: ["departments", orgId],
    queryFn: async () =>
      (await OrgsService.readDepartments({ path: { org_id: orgId } })).data,
  })
  const hasRoles = filter === "roles"
  const accounts = useQuery({
    queryKey: [
      "accounts",
      orgId,
      department,
      status,
      employment,
      q,
      reviewStatus,
      hasRoles,
      pagination,
    ],
    queryFn: async () =>
      (
        await AccountsService.readAccounts({
          path: { org_id: orgId },
          query: {
            department_id: department === "all" ? undefined : department,
            status: status === "all" ? undefined : status,
            employment_status: employment === "all" ? undefined : employment,
            q: q || undefined,
            review_status: reviewStatus ?? undefined,
            has_roles: hasRoles ? true : undefined,
            skip: pagination.pageIndex * pagination.pageSize,
            limit: pagination.pageSize,
          },
        })
      ).data,
    enabled: filter !== "account-only",
    retry: false,
  })
  const appeals = useQuery({
    queryKey: ["disputes", orgId],
    queryFn: async () =>
      (await AppealsService.listDisputes({ path: { org_id: orgId } })).data,
    enabled: filter === "appeals",
  })
  const disputed = new Set(appeals.data?.map((appeal) => appeal.employee_id))
  const options = departmentOptions(departments.data?.data ?? [])
  let error = ""
  if (accounts.error)
    handleError.call((message) => {
      error = message
    }, accounts.error)
  function changeDepartment(value: string) {
    setDepartment(value)
    reset()
  }
  const scopeFilter = (
    <AccountFilter
      title={t("admin.employeesList.scopeTitle")}
      value={
        filter === "appeals" || filter === "roles" || filter === "account-only"
          ? filter
          : "all"
      }
      labels={{
        appeals: t("admin.employeesList.scopes.appeals"),
        roles: t("admin.employeesList.scopes.roles"),
        "account-only": t("admin.employeesList.scopes.accountOnly"),
      }}
      onChange={(value) => {
        reset()
        navigate({
          to: "/employees",
          search: { filter: value === "all" ? undefined : value },
        })
      }}
    />
  )
  return (
    <WorkspacePage className="space-y-3">
      <h1 className="sr-only">{t("admin.employeesList.heading")}</h1>
      <ExportProfilesButtons orgId={orgId} />
      <TopbarActions>
        <div className="[&>button]:h-8 [&>button]:px-2 [&>button]:text-xs">
          {roles.includes("org_admin") && filter !== "account-only" && (
            <IssueAccountsDialog
              orgId={orgId}
              employees={accounts.data?.data
                .filter((e) => selected.includes(e.id))
                .map((e) => ({
                  id: e.id,
                  employee_code: e.employee_code,
                  display_name: e.display_name,
                  status: e.account?.status ?? "none",
                }))}
              onIssued={() => {
                setSelected([])
                client.invalidateQueries({ queryKey: ["accounts", orgId] })
              }}
            />
          )}
        </div>
      </TopbarActions>
      <ProfileCoverage
        orgId={orgId}
        department={department}
        onDepartmentChange={
          filter === "account-only" ? undefined : changeDepartment
        }
        reviewStatus={reviewStatus}
        onStatusChange={
          filter === "account-only"
            ? undefined
            : (value) => {
                setReviewStatus(value)
                reset()
              }
        }
      />
      <div className="flex flex-wrap items-center gap-2 [&>button]:h-8 [&>button]:text-xs">
        {roles.includes("org_admin") && (
          <>
            <PersonnelDialog orgId={orgId} />
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">
                  {t("admin.employeesList.fieldsButton")}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {t("admin.employeesList.fieldsDialogTitle")}
                  </DialogTitle>
                </DialogHeader>
                {org && <EmployeeFields org={org} />}
              </DialogContent>
            </Dialog>
          </>
        )}
        <UnmatchedIdentities
          orgId={orgId}
          initiallyOpen={filter === "identities"}
        />
      </div>
      {passwordTarget?.account && (
        <ResetPasswordDialog
          orgId={orgId}
          userId={passwordTarget.account.user_id}
          name={passwordTarget.display_name}
          open={true}
          onClose={() => {
            setPasswordTarget(null)
            client.invalidateQueries({ queryKey: ["accounts", orgId] })
          }}
        />
      )}
      {filter === "account-only" ? (
        <>
          {scopeFilter}
          <UnlinkedAccounts orgId={orgId} />
        </>
      ) : (
        <div>
          <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-t-lg border border-surface-border bg-surface px-3 py-1.5">
            <div className="relative min-w-36 flex-1 sm:max-w-56">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
              />
              <Input
                className="h-8 pl-8"
                aria-label={t("admin.employeesList.searchAriaLabel")}
                placeholder={t("admin.employeesList.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <AccountFilter
              title={t("admin.employeesList.filterDepartment")}
              value={department}
              labels={Object.fromEntries(options.map((d) => [d.id, d.name]))}
              onChange={changeDepartment}
            />
            <AccountFilter
              title={t("admin.employeesList.filterAccountStatus")}
              value={status}
              labels={accountLabels}
              onChange={(value) => {
                setStatus(value)
                reset()
              }}
            />
            <AccountFilter
              title={t("admin.employeesList.filterEmploymentStatus")}
              value={employment}
              labels={employmentLabels}
              onChange={(value) => {
                setEmployment(value)
                reset()
              }}
            />
            {scopeFilter}
            <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
              {t("admin.employeesList.totalAndSelected", {
                total: accounts.data?.count ?? "—",
                selected: selected.length,
              })}
            </span>
          </div>
          {departments.isError && (
            <div role="alert">
              {t("admin.employeesList.departmentsError")}
              <Button variant="outline" onClick={() => departments.refetch()}>
                {t("admin.common.retry")}
              </Button>
            </div>
          )}
          {filter === "appeals" &&
            (appeals.isPending ? (
              <p role="status">{t("admin.employeesList.loadingAppeals")}</p>
            ) : appeals.isError ? (
              <div role="alert">
                {t("admin.employeesList.appealsError")}
                <Button onClick={() => appeals.refetch()}>
                  {t("admin.common.retry")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("admin.employeesList.appealsHint")}
              </p>
            ))}
          {accounts.isPending ? (
            <p role="status">{t("admin.employeesList.loadingAccounts")}</p>
          ) : accounts.isError ? (
            <div role="alert">
              {error}
              <Button variant="outline" onClick={() => accounts.refetch()}>
                {t("admin.common.retry")}
              </Button>
            </div>
          ) : (
            <AccountTable
              data={
                filter === "appeals"
                  ? accounts.data.data.filter((employee) =>
                      disputed.has(employee.id),
                    )
                  : accounts.data.data
              }
              onPreview={setPreview}
              onResetPassword={setPasswordTarget}
              count={accounts.data.count}
              departments={new Map(options.map((d) => [d.id, d.name]))}
              selected={selected}
              onSelect={(id, checked) =>
                setSelected((old) =>
                  checked ? [...old, id] : old.filter((value) => value !== id),
                )
              }
              pagination={pagination}
              onPaginationChange={(updater) => {
                setSelected([])
                setPagination(updater)
              }}
            />
          )}
        </div>
      )}
      <EmployeeQuickPeekDrawer
        orgId={orgId}
        employee={preview}
        onClose={() => setPreview(null)}
      />
    </WorkspacePage>
  )
}

function AccountFilter<T extends string>({
  title,
  value,
  labels,
  onChange,
}: {
  title: string
  value: T | "all"
  labels: Record<T, string>
  onChange: (value: T | "all") => void
}) {
  const { t } = useTranslation()
  const keys = Object.keys(labels) as T[]
  return (
    <Select
      value={value}
      onValueChange={(value) => {
        const key = keys.find((key) => key === value)
        if (value === "all" || key) onChange(key ?? "all")
      }}
    >
      <SelectTrigger
        aria-label={t("admin.employeesList.filterAriaLabel", { title })}
        size="sm"
        className="max-w-44"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">
          {t("admin.employeesList.filterAllOption", { title })}
        </SelectItem>
        {keys.map((key) => (
          <SelectItem key={key} value={key}>
            {labels[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
