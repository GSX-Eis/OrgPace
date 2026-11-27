import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AccountsService,
  type EmployeeSummary,
  OrgsService,
  RolesService,
  RosterService,
} from "@/client"
import { AccountActions } from "@/components/Admin/AccountTable"
import { ChangeHistory } from "@/components/Admin/ChangeHistory"
import { ConfirmActionDialog } from "@/components/Admin/ConfirmActionDialog"
import { Disputes, useDisputes } from "@/components/Admin/Disputes"
import { departmentOptions } from "@/components/Admin/departments"
import { IssueAccountsDialog } from "@/components/Admin/IssueAccountsDialog"
import {
  accountLabels,
  employmentLabels,
  roleLabels,
} from "@/components/Admin/labels"
import { PersonnelDialog } from "@/components/Admin/PersonnelDialog"
import { ResetPasswordDialog } from "@/components/Admin/ResetPasswordDialog"
import { RoleGrantDialog } from "@/components/Admin/RoleGrantDialog"
import { IdentityTable } from "@/components/Identities/IdentityTable"
import { EmployeeSummaryContent } from "@/components/Profile/EmployeeSummary"
import { ProfileVisibility } from "@/components/Profile/ProfileVisibility"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import {
  employeeFieldLabels,
  tenureLabel,
} from "@/components/Roster/EmployeeFields"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useOrg } from "@/hooks/useOrg"

export function EmployeeDetailTabs({
  employee: summary,
  tab,
  onTabChange,
  children,
  evidence,
}: {
  employee: EmployeeSummary
  tab?: string
  onTabChange: (tab: string) => void
  children: ReactNode
  evidence: ReactNode
}) {
  const { t } = useTranslation()
  const { org, roles } = useOrg()
  const orgId = org!.id
  const employeeId = summary.id
  const isAdmin = roles.includes("org_admin")
  const client = useQueryClient()
  const [resetPassword, setResetPassword] = useState(false)
  const person = useQuery({
    queryKey: ["accounts", orgId, "person", employeeId],
    enabled: isAdmin,
    queryFn: async () =>
      (
        await AccountsService.readAccounts({
          path: { org_id: orgId },
          query: { employee_id: employeeId },
        })
      ).data,
  })
  const departments = useQuery({
    queryKey: ["departments", orgId],
    enabled: isAdmin,
    queryFn: async () =>
      (await OrgsService.readDepartments({ path: { org_id: orgId } })).data,
  })
  const previousManager = useQuery({
    queryKey: ["previous-manager", orgId, employeeId],
    enabled:
      isAdmin && summary.employment_status === "active" && !summary.manager,
    queryFn: async () =>
      (
        await RosterService.readPreviousManager({
          path: { org_id: orgId, employee_id: employeeId },
        })
      ).data,
  })
  const refresh = () => {
    for (const queryKey of [
      ["accounts", orgId],
      ["role-grants", orgId],
      ["memberships"],
      ["change-history", orgId],
    ])
      client.invalidateQueries({ queryKey })
  }
  const employee = person.data?.data[0]
  const options = departmentOptions(departments.data?.data ?? [])
  const disputes = useDisputes(isAdmin ? orgId : undefined, employeeId)
  const pendingDisputes = disputes.data?.length ?? 0
  const showAppeals = tab === "appeals"
  const selected =
    tab === "account" || tab === "fields" || tab === "identities"
      ? "account"
      : isAdmin && (tab === "evidence" || tab === "versions")
        ? "evidence"
        : "capabilities"
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-surface-border bg-surface px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar className="size-9 shrink-0">
            <AvatarFallback className="bg-primary/10 font-semibold text-primary">
              {summary.display_name.slice(0, 1)}
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="font-semibold [overflow-wrap:anywhere]">
              {summary.display_name}
            </h1>
            <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {t("people.detail.tabs.employeeCodePrefix", {
                code: summary.employee_code ?? t("people.detail.tabs.unfilled"),
              })}
            </p>
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {summary.title ?? t("people.detail.tabs.jobTitleEmpty")} ·{" "}
              {summary.department?.name ?? t("people.detail.tabs.deptEmpty")}
            </p>
            {isAdmin && (
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {t("people.detail.tabs.managerPrefix", {
                  name:
                    summary.manager?.display_name ??
                    t("people.detail.tabs.noManager"),
                })}
              </p>
            )}
            <Badge
              variant="secondary"
              className={
                summary.employment_status === "active"
                  ? "rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
                  : "rounded-full"
              }
            >
              {summary.employment_status === "inactive"
                ? t("people.detail.tabs.inactiveBadge")
                : employmentLabels[summary.employment_status]}
            </Badge>
            <ProfileVisibility tooltip />
          </div>
        </div>
        {isAdmin &&
          employee?.employment_status === "active" &&
          departments.isSuccess && (
            <section
              aria-label={t("people.detail.tabs.personnelActionsAria")}
              className="ml-auto flex flex-wrap gap-2 [&_[data-slot=dialog-trigger]]:h-8"
            >
              <PersonnelDialog
                orgId={orgId}
                employee={employee}
                department={
                  options.find((d) => d.id === summary.department?.id)?.name
                }
              />
              <PersonnelDialog orgId={orgId} employee={employee} offboard />
            </section>
          )}
      </header>
      {summary.employment_status === "active" &&
        !summary.manager &&
        previousManager.data?.id && (
          <section
            aria-label={t("people.detail.tabs.resetManagerAria")}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm"
          >
            <p>{t("people.detail.tabs.managerNotSet")}</p>
            {previousManager.data.is_active === false ? (
              <p>
                {t("people.detail.tabs.previousManagerLeft", {
                  name: previousManager.data.display_name,
                })}
              </p>
            ) : previousManager.data.can_restore &&
              employee &&
              departments.isSuccess ? (
              <PersonnelDialog
                orgId={orgId}
                employee={employee}
                department={
                  options.find((d) => d.id === summary.department?.id)?.name
                }
                initialManager={previousManager.data}
              />
            ) : (
              <p>{t("people.detail.tabs.pleaseResetManager")}</p>
            )}
          </section>
        )}
      {isAdmin &&
        (person.isError || departments.isError || previousManager.isError) && (
          <ProfileError
            retry={() => {
              person.refetch()
              departments.refetch()
              previousManager.refetch()
            }}
          />
        )}
      {isAdmin && (pendingDisputes > 0 || showAppeals) && (
        <details
          key={String(showAppeals)}
          open={showAppeals}
          className="rounded-xl border border-amber-500/40 bg-amber-500/10"
        >
          <summary className="cursor-pointer px-4 py-3 font-medium">
            {t("people.detail.tabs.disputesTitle")}
            {disputes.isSuccess &&
              t("people.detail.tabs.disputesPending", {
                count: pendingDisputes,
              })}
          </summary>
          <div className="border-t border-amber-500/40 bg-background p-4">
            <Disputes orgId={orgId} employeeId={employeeId} />
          </div>
        </details>
      )}
      <Tabs
        value={selected}
        onValueChange={onTabChange}
        className="min-w-0 gap-3"
      >
        <TabsList
          aria-label={t("people.detail.tabs.tabsAria")}
          className="h-auto max-w-full flex-wrap justify-start"
        >
          <TabsTrigger value="capabilities">
            {t("people.detail.tabs.tabCapabilities")}
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="evidence">
              {t("people.detail.tabs.tabEvidence")}
            </TabsTrigger>
          )}
          <TabsTrigger value="account">
            {isAdmin
              ? t("people.detail.tabs.tabAccountAdmin")
              : t("people.detail.tabs.tabAccount")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="capabilities" className="space-y-3">
          {children}
          {isAdmin && (
            <div className="[&_dl]:gap-3 [&_dl]:rounded-lg [&_dl]:border-surface-border [&_dl]:bg-surface [&_dl]:p-3 [&_dt]:mb-1 [&_dt]:text-xs [&_dd]:text-sm">
              <EmployeeSummaryContent employee={summary} showHeading={false} />
            </div>
          )}
        </TabsContent>
        {isAdmin && (
          <TabsContent value="evidence" className="space-y-6">
            {evidence}
          </TabsContent>
        )}
        <TabsContent value="account" className="space-y-6">
          <EmployeeFields
            summary={summary}
            workEmail={employee?.work_email}
            departmentName={
              options.find((d) => d.id === summary.department?.id)?.name
            }
          />
          {isAdmin && (
            <>
              {person.isPending ? (
                <ProfileLoading />
              ) : (
                employee && (
                  <section
                    aria-label={t("people.detail.tabs.accountRolesTitle")}
                    className="space-y-4 rounded-xl border p-5"
                  >
                    <h2 className="text-lg font-semibold">
                      {t("people.detail.tabs.accountRolesTitle")}
                    </h2>
                    <p>
                      {t("people.detail.tabs.emailLabel")}
                      {employee.account?.username ??
                        employee.work_email ??
                        t("people.detail.tabs.unfilled")}{" "}
                      · {accountLabels[employee.account?.status ?? "none"]}
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      {employee.employment_status === "active" &&
                        (!employee.account ||
                          employee.account.status ===
                            "pending_first_login") && (
                          <IssueAccountsDialog
                            orgId={orgId}
                            employees={[
                              {
                                id: employee.id,
                                employee_code: employee.employee_code,
                                display_name: employee.display_name,
                                status: employee.account?.status ?? "none",
                              },
                            ]}
                            onIssued={refresh}
                          />
                        )}
                      <AccountActions
                        employee={employee}
                        onResetPassword={() => setResetPassword(true)}
                      />
                      {employee.account &&
                        employee.account.status !== "disabled" &&
                        departments.isSuccess &&
                        employee.employment_status === "active" && (
                          <RoleGrantDialog
                            orgId={orgId}
                            employeeId={employeeId}
                            grants={employee.roles}
                            departments={options}
                            onSuccess={refresh}
                          />
                        )}
                    </div>
                    {employee.roles.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        {t("people.detail.tabs.noRoles")}
                      </p>
                    )}
                    {employee.roles.map((grant) => (
                      <div
                        key={grant.id}
                        className="flex flex-wrap items-center gap-3 text-sm"
                      >
                        <span>
                          {roleLabels[grant.role]}
                          {grant.department
                            ? ` · ${options.find((d) => d.id === grant.department_id)?.name ?? grant.department.name}`
                            : ""}
                        </span>
                        <ConfirmActionDialog
                          title={t("people.detail.tabs.revokeRoleTitle")}
                          description={t("people.detail.tabs.revokeRoleDesc", {
                            name: employee.display_name,
                            role: roleLabels[grant.role],
                          })}
                          action={() =>
                            RolesService.revokeRole({
                              path: { org_id: orgId, grant_id: grant.id },
                            })
                          }
                          onSuccess={refresh}
                        />
                      </div>
                    ))}
                  </section>
                )
              )}
              {resetPassword && employee?.account && (
                <ResetPasswordDialog
                  orgId={orgId}
                  userId={employee.account.user_id}
                  name={employee.display_name}
                  open
                  onClose={() => {
                    setResetPassword(false)
                    refresh()
                  }}
                />
              )}
              <section
                className="rounded-xl border p-5"
                aria-label={t("people.detail.tabs.jiraTitle")}
              >
                <h2 className="mb-4 text-lg font-semibold">
                  {t("people.detail.tabs.jiraTitle")}
                </h2>
                <p className="mb-4 text-sm text-muted-foreground">
                  {t("people.detail.tabs.jiraDesc")}
                </p>
                <IdentityTable orgId={orgId} employeeId={employeeId} />
              </section>
              <ChangeHistory employeeId={employeeId} />
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function EmployeeFields({
  summary,
  workEmail,
  departmentName,
}: {
  summary: EmployeeSummary
  workEmail?: string | null
  departmentName?: string
}) {
  const { t } = useTranslation()
  const { org } = useOrg()
  const fields = [
    ...(org?.employee_fields ?? []).map((field) => [
      field === "hire_date"
        ? t("people.detail.tabs.tenure")
        : employeeFieldLabels[field],
      field === "hire_date" && summary.hire_date
        ? tenureLabel(summary.hire_date)
        : summary[field],
    ]),
    [t("people.detail.tabs.employeeCode"), summary.employee_code],
    ...(workEmail !== undefined
      ? [[t("people.detail.tabs.email"), workEmail]]
      : []),
    [
      t("people.detail.tabs.department"),
      departmentName ?? summary.department?.name,
    ],
    [t("people.detail.tabs.title"), summary.title],
    [
      t("people.detail.tabs.employmentStatus"),
      employmentLabels[summary.employment_status],
    ],
    [t("people.detail.tabs.manager"), summary.manager?.display_name],
  ]

  return (
    <section
      aria-label={t("people.detail.tabs.fieldsAria")}
      className="rounded-xl border p-5"
    >
      <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map(([name, value]) => (
          <div key={name}>
            <dt className="text-xs text-muted-foreground">{name}</dt>
            <dd className="mt-1 break-words text-sm font-medium">
              {value || t("people.detail.tabs.unfilled")}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
