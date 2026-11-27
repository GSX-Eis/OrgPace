import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AccountsService } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

export function EmployeePicker({
  orgId,
  account,
  pending,
  error,
  onSelect,
  onClose,
}: {
  orgId: string
  account: string
  pending: boolean
  error: Error | null
  onSelect: (employeeId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState("")
  const [skip, setSkip] = useState(0)
  const employees = useQuery({
    queryKey: ["accounts", orgId, "identity-picker", q, skip],
    queryFn: async () =>
      (
        await AccountsService.readAccounts({
          path: { org_id: orgId },
          query: { q, skip, limit: 20 },
        })
      ).data,
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogTitle>{t("sources.identities.picker.title")}</DialogTitle>
        <DialogDescription>
          {t("sources.identities.picker.description", { account })}
        </DialogDescription>
        <Input
          aria-label={t("sources.identities.picker.searchAriaLabel")}
          placeholder={t("sources.identities.picker.searchPlaceholder")}
          value={q}
          disabled={pending}
          onChange={(e) => {
            setQ(e.target.value)
            setSkip(0)
          }}
        />
        <SetupError error={error ?? employees.error} />
        {employees.isError && (
          <Button onClick={() => employees.refetch()}>
            {t("sources.identities.picker.retry")}
          </Button>
        )}
        {employees.isPending && (
          <p role="status">{t("sources.identities.picker.loading")}</p>
        )}
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {employees.data?.data.map((employee) => (
            <Button
              key={employee.id}
              variant="outline"
              className="h-auto w-full justify-start whitespace-normal text-left"
              disabled={pending}
              onClick={() => onSelect(employee.id)}
            >
              {t("sources.identities.picker.optionLabel", {
                name: employee.display_name,
                code:
                  employee.employee_code ??
                  t("sources.identities.picker.noEmployeeCode"),
                dept:
                  employee.department?.name ??
                  t("sources.identities.picker.noDepartment"),
                status:
                  employee.employment_status === "active"
                    ? t("sources.identities.picker.active")
                    : t("sources.identities.picker.inactive"),
              })}
            </Button>
          ))}
          {employees.data?.count === 0 && (
            <p>{t("sources.identities.picker.empty")}</p>
          )}
        </div>
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            disabled={pending || skip === 0}
            onClick={() => setSkip(skip - 20)}
          >
            {t("sources.identities.picker.prevPage")}
          </Button>
          <span className="text-sm">
            {t("sources.identities.picker.totalEmployees", {
              count: employees.data?.count ?? 0,
            })}
          </span>
          <Button
            variant="outline"
            disabled={pending || skip + 20 >= (employees.data?.count ?? 0)}
            onClick={() => setSkip(skip + 20)}
          >
            {t("sources.identities.picker.nextPage")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
