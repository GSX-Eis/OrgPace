import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type {
  CellContext,
  ColumnDef,
  OnChangeFn,
  PaginationState,
} from "@tanstack/react-table"
import { type SyntheticEvent, useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AccountsService,
  type EmployeeAccount,
  EmployeesService,
} from "@/client"
import {
  DataTable,
  type DataTableFeatures,
} from "@/components/Common/DataTable"
import { preventRowEnterDefault } from "@/components/Profile/EmployeeQuickPeekDrawer"
import { publishedLabel } from "@/components/Profile/EmployeeSummary"
import { initialStatusLabel } from "@/components/Profile/initialStatus"
import { StatusBadge } from "@/components/Profile/StatusBadge"
import {
  employeeFieldLabels,
  tenureLabel,
} from "@/components/Roster/EmployeeFields"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import useAuth from "@/hooks/useAuth"
import { useOrg } from "@/hooks/useOrg"
import { ConfirmActionDialog } from "./ConfirmActionDialog"
import { IssueAccountsDialog } from "./IssueAccountsDialog"
import { accountLabels, employmentLabels, roleLabels } from "./labels"

function stopPortalEvent(event: SyntheticEvent<HTMLElement>) {
  // React bubbles events from account dialogs through the row that opened them.
  if (
    event.target instanceof Node &&
    !event.currentTarget.contains(event.target)
  )
    event.stopPropagation()
}

function RowAccountActions({
  employee,
  onResetPassword,
}: {
  employee: EmployeeAccount
  onResetPassword: (employee: EmployeeAccount) => void
}) {
  const { t } = useTranslation()
  return (
    <fieldset
      className="contents"
      aria-label={t("admin.accountTable.actionsAriaLabel")}
      onClick={stopPortalEvent}
      onKeyDown={stopPortalEvent}
    >
      <AccountMenu
        employee={employee}
        onResetPassword={() => onResetPassword(employee)}
        issuable={employee}
      />
    </fieldset>
  )
}

export function AccountTable({
  data,
  selected,
  onSelect,
  count,
  departments,
  pagination,
  onPaginationChange,
  onResetPassword,
  onPreview,
}: {
  selected: string[]
  onSelect: (id: string, checked: boolean) => void
  data: EmployeeAccount[]
  count: number
  departments: Map<string, string>
  pagination: PaginationState
  onPaginationChange: OnChangeFn<PaginationState>
  onResetPassword: (employee: EmployeeAccount) => void
  onPreview: (employee: EmployeeAccount) => void
}) {
  const { t } = useTranslation()
  const { org } = useOrg()
  const actions = useCallback(
    ({ row }: CellContext<DataTableFeatures, EmployeeAccount>) => (
      <RowAccountActions
        employee={row.original}
        onResetPassword={onResetPassword}
      />
    ),
    [onResetPassword],
  )
  function selection(employee: EmployeeAccount) {
    return (
      <Checkbox
        aria-label={t("admin.accountTable.selectAriaLabel", {
          target: employee.employee_code ?? employee.display_name,
        })}
        checked={selected.includes(employee.id)}
        disabled={
          employee.employment_status !== "active" ||
          (!!employee.account &&
            employee.account.status !== "pending_first_login")
        }
        onCheckedChange={(checked) => onSelect(employee.id, checked === true)}
      />
    )
  }
  function employeeLink(employee: EmployeeAccount) {
    return (
      <Link
        className="font-medium text-primary hover:underline"
        to="/employees/$employeeId"
        params={{ employeeId: employee.id }}
      >
        {employee.display_name}
      </Link>
    )
  }
  const progressHeaders = {
    fill_status: t("admin.accountTable.columns.fillStatus"),
    inference_status: t("admin.accountTable.columns.inferenceStatus"),
    review_status: t("admin.accountTable.columns.reviewStatus"),
    published: t("admin.accountTable.columns.published"),
  } as const
  const columns: ColumnDef<DataTableFeatures, EmployeeAccount>[] = [
    {
      id: "select",
      header: t("admin.accountTable.columns.select"),
      cell: ({ row }) => selection(row.original),
    },
    {
      accessorKey: "display_name",
      header: t("admin.accountTable.columns.name"),
      cell: ({ row }) => employeeLink(row.original),
    },
    {
      accessorKey: "title",
      header: t("admin.accountTable.columns.title"),
      cell: ({ row }) => row.original.title ?? "—",
    },
    {
      id: "department",
      header: t("admin.accountTable.columns.department"),
      cell: ({ row }) =>
        departments.get(row.original.department?.id ?? "") ?? "—",
    },
    {
      id: "employment",
      header: t("admin.accountTable.columns.employment"),
      cell: ({ row }) => employmentLabels[row.original.employment_status],
    },
    {
      id: "status",
      header: t("admin.accountTable.columns.accountStatus"),
      cell: ({ row }) => (
        <Badge variant="secondary">
          {accountLabels[row.original.account?.status ?? "none"]}
        </Badge>
      ),
    },
    {
      id: "roles",
      header: t("admin.accountTable.columns.roles"),
      cell: ({ row }) =>
        row.original.roles.length ? (
          <div className="flex gap-1">
            {row.original.roles.map((role) => (
              <Badge key={role.id} variant="outline">
                {roleLabels[role.role]}
                {role.department
                  ? t("admin.accountTable.roleDepartmentSuffix", {
                      name:
                        departments.get(role.department.id) ??
                        role.department.name,
                    })
                  : ""}
              </Badge>
            ))}
          </div>
        ) : (
          "—"
        ),
    },
    ...(
      ["fill_status", "inference_status", "review_status", "published"] as const
    ).map((kind) => ({
      id: kind,
      header: progressHeaders[kind],
      cell: ({ row }: { row: { original: EmployeeAccount } }) =>
        org ? (
          <EmployeeProgress
            orgId={org.id}
            employeeId={row.original.id}
            kind={kind}
          />
        ) : (
          "—"
        ),
    })),
    ...(org?.employee_fields ?? []).map((field) => ({
      id: field,
      header:
        field === "hire_date"
          ? t("admin.accountTable.columns.tenure")
          : employeeFieldLabels[field],
      cell: ({ row }: { row: { original: EmployeeAccount } }) =>
        field === "hire_date" && row.original.hire_date
          ? tenureLabel(row.original.hire_date)
          : (row.original[field] ?? "—"),
    })),
    {
      id: "actions",
      header: t("admin.accountTable.columns.actions"),
      cell: actions,
    },
  ]
  return (
    <div className="min-w-0">
      <section
        aria-label={t("admin.accountTable.cardsAriaLabel")}
        className="space-y-2 py-2 sm:hidden"
      >
        {data.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">
            {t("admin.accountTable.empty")}
          </p>
        )}
        {data.map((employee) => (
          <article
            key={employee.id}
            className="space-y-2 rounded-lg border border-surface-border bg-surface p-3 wrap-anywhere"
          >
            <div className="flex items-start gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center">
                {selection(employee)}
              </div>
              <div className="min-w-0 flex-1">
                {employeeLink(employee)}
                <p className="text-xs text-muted-foreground">
                  {[
                    employee.employee_code,
                    employee.title,
                    departments.get(employee.department?.id ?? ""),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <RowAccountActions
                employee={employee}
                onResetPassword={onResetPassword}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="secondary">
                {accountLabels[employee.account?.status ?? "none"]}
              </Badge>
              <span>{employmentLabels[employee.employment_status]}</span>
              {org && (
                <EmployeeProgress
                  orgId={org.id}
                  employeeId={employee.id}
                  kind="review_status"
                />
              )}
              <Button
                size="sm"
                variant="outline"
                className="ml-auto min-h-9"
                onClick={() => onPreview(employee)}
              >
                {t("admin.accountTable.quickView")}
              </Button>
            </div>
          </article>
        ))}
      </section>
      <div
        onKeyDownCapture={preventRowEnterDefault}
        className="[&>div]:rounded-t-none [&>div]:border-t-0 [&_th]:h-11 max-sm:[&_[data-slot=table-container]]:hidden"
      >
        <DataTable
          columns={columns}
          data={data}
          onRowClick={onPreview}
          getRowId={(employee) => employee.id}
          rowCount={count}
          pagination={pagination}
          onPaginationChange={onPaginationChange}
        />
      </div>
    </div>
  )
}

export function AccountActions({
  employee: e,
  onResetPassword,
}: {
  employee: { display_name: string | null; account: EmployeeAccount["account"] }
  onResetPassword: () => void
}) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { org, roles } = useOrg()
  const client = useQueryClient()
  const refresh = () => {
    client.invalidateQueries({ queryKey: ["accounts", org?.id] })
  }
  if (!org || !roles.includes("org_admin") || !e.account) return "—"
  if (e.account.user_id === user?.id)
    return t("admin.accountTable.selfPasswordHint")
  const path = { org_id: org.id, user_id: e.account.user_id }
  const disabled = e.account.status === "disabled"
  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => onResetPassword()}>
        {t("admin.accountTable.resetPassword")}
      </Button>
      <ConfirmActionDialog
        title={
          disabled
            ? t("admin.accountTable.enableTitle")
            : t("admin.accountTable.disableTitle")
        }
        description={
          disabled
            ? t("admin.accountTable.enableDesc", { name: e.display_name })
            : t("admin.accountTable.disableDesc", { name: e.display_name })
        }
        action={() =>
          disabled
            ? AccountsService.enableAccount({ path })
            : AccountsService.disableAccount({ path })
        }
        onSuccess={refresh}
      />
    </div>
  )
}

function EmployeeProgress({
  orgId,
  employeeId,
  kind,
}: {
  orgId: string
  employeeId: string
  kind: "fill_status" | "inference_status" | "review_status" | "published"
}) {
  const { t } = useTranslation()
  const summary = useQuery({
    queryKey: ["employee", orgId, employeeId],
    queryFn: async () =>
      (
        await EmployeesService.readEmployee({
          path: { org_id: orgId, employee_id: employeeId },
        })
      ).data,
  })
  if (summary.isPending) return t("admin.accountTable.progressLoading")
  if (summary.isError)
    return (
      <Button variant="ghost" size="sm" onClick={() => summary.refetch()}>
        {t("admin.accountTable.retryProgress")}
      </Button>
    )
  return kind === "published" ? (
    publishedLabel(summary.data.latest_published)
  ) : kind === "inference_status" ? (
    initialStatusLabel(summary.data.progress?.initial_profile_status)
  ) : (
    <StatusBadge kind={kind} value={summary.data.progress?.[kind]} />
  )
}

export function AccountMenu({
  employee: e,
  onResetPassword,
  issuable,
}: {
  employee: { display_name: string | null; account: EmployeeAccount["account"] }
  onResetPassword: () => void
  issuable?: EmployeeAccount
}) {
  const { t } = useTranslation()
  const { org } = useOrg()
  const { user } = useAuth()
  const client = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const [issue, setIssue] = useState(false)
  if (!org) return null
  const disabled = e.account?.status === "disabled"
  const name =
    e.display_name ??
    e.account?.username ??
    t("admin.accountTable.employeeFallback")
  const refresh = () =>
    client.invalidateQueries({ queryKey: ["accounts", org.id] })
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            {t("admin.accountTable.more")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent onClick={(event) => event.stopPropagation()}>
          {issuable?.employment_status === "active" &&
            (!e.account || e.account.status === "pending_first_login") && (
              <DropdownMenuItem onSelect={() => setIssue(true)}>
                {t("admin.accountTable.issueAccount")}
              </DropdownMenuItem>
            )}
          {e.account &&
            (e.account.user_id === user?.id ? (
              <DropdownMenuItem disabled>
                {t("admin.accountTable.selfPasswordHint")}
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onSelect={onResetPassword}>
                  {t("admin.accountTable.resetPassword")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setConfirm(true)}>
                  {disabled
                    ? t("admin.accountTable.enableTitle")
                    : t("admin.accountTable.disableTitle")}
                </DropdownMenuItem>
              </>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {e.account && (
        <ConfirmActionDialog
          title={
            disabled
              ? t("admin.accountTable.enableTitle")
              : t("admin.accountTable.disableTitle")
          }
          description={
            disabled
              ? t("admin.accountTable.enableDesc", { name })
              : t("admin.accountTable.disableDesc", { name })
          }
          open={confirm}
          onOpenChange={setConfirm}
          action={() =>
            disabled
              ? AccountsService.enableAccount({
                  path: { org_id: org.id, user_id: e.account!.user_id },
                })
              : AccountsService.disableAccount({
                  path: { org_id: org.id, user_id: e.account!.user_id },
                })
          }
          onSuccess={refresh}
        />
      )}
      {issuable && (
        <IssueAccountsDialog
          orgId={org.id}
          open={issue}
          onOpenChange={setIssue}
          employees={[
            {
              id: issuable.id,
              employee_code: issuable.employee_code,
              display_name: issuable.display_name,
              status: e.account?.status ?? "none",
            },
          ]}
          onIssued={refresh}
        />
      )}
    </>
  )
}
