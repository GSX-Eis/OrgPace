import { useQuery } from "@tanstack/react-query"
import type { CellContext } from "@tanstack/react-table"
import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { AccountsService, type UnlinkedAccount } from "@/client"
import { AccountMenu } from "@/components/Admin/AccountTable"
import { accountLabels, roleLabels } from "@/components/Admin/labels"
import { ResetPasswordDialog } from "@/components/Admin/ResetPasswordDialog"
import {
  DataTable,
  type DataTableFeatures,
} from "@/components/Common/DataTable"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { formatDate } from "@/i18n/format"

export function UnlinkedAccounts({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 })
  const [target, setTarget] = useState<UnlinkedAccount | null>(null)
  const actions = useCallback(
    ({ row }: CellContext<DataTableFeatures, UnlinkedAccount>) => (
      <AccountMenu
        employee={row.original}
        onResetPassword={() => setTarget(row.original)}
      />
    ),
    [],
  )
  const query = useQuery({
    queryKey: ["accounts", orgId, "unlinked", pagination],
    queryFn: async () =>
      (
        await AccountsService.readUnlinkedAccounts({
          path: { org_id: orgId },
          query: {
            skip: pagination.pageIndex * pagination.pageSize,
            limit: pagination.pageSize,
          },
        })
      ).data,
  })
  return (
    <div className="space-y-4">
      <p>{t("admin.unlinkedAccounts.intro")}</p>
      {query.isPending ? (
        <p role="status">{t("admin.unlinkedAccounts.loading")}</p>
      ) : query.isError ? (
        <>
          <SetupError error={query.error} />
          <Button onClick={() => query.refetch()}>
            {t("admin.common.retry")}
          </Button>
        </>
      ) : (
        <DataTable
          data={query.data.data}
          getRowId={(row) => row.account.user_id}
          pagination={pagination}
          onPaginationChange={setPagination}
          rowCount={query.data.count}
          columns={[
            {
              accessorKey: "display_name",
              header: t("admin.unlinkedAccounts.colName"),
              cell: ({ row }) => row.original.display_name ?? "—",
            },
            {
              id: "username",
              header: t("admin.unlinkedAccounts.colUsername"),
              cell: ({ row }) => row.original.account.username,
            },
            {
              id: "status",
              header: t("admin.unlinkedAccounts.colStatus"),
              cell: ({ row }) => accountLabels[row.original.account.status],
            },
            {
              id: "roles",
              header: t("admin.unlinkedAccounts.colRoles"),
              cell: ({ row }) =>
                row.original.roles
                  .map(
                    (role) =>
                      `${roleLabels[role.role]}${role.department ? t("admin.accountTable.roleDepartmentSuffix", { name: role.department.name }) : ""}`,
                  )
                  .join(t("admin.unlinkedAccounts.roleJoin")) || "—",
            },
            {
              id: "login",
              header: t("admin.unlinkedAccounts.colLastLogin"),
              cell: ({ row }) =>
                row.original.account.last_login_at
                  ? formatDate(row.original.account.last_login_at, {
                      dateStyle: "short",
                      timeStyle: "medium",
                    })
                  : "—",
            },
            {
              id: "actions",
              header: t("admin.unlinkedAccounts.colActions"),
              cell: actions,
            },
          ]}
        />
      )}
      {target && (
        <ResetPasswordDialog
          orgId={orgId}
          userId={target.account.user_id}
          name={target.display_name ?? target.account.username}
          open
          onClose={() => {
            setTarget(null)
            query.refetch()
          }}
        />
      )}
    </div>
  )
}
