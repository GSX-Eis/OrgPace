import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AccountsService,
  type Role,
  type RolePublic,
  RolesService,
} from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { roleLabels } from "./labels"

export function RoleGrantDialog({
  orgId,
  employeeId,
  departments,
  grants,
  onSuccess,
}: {
  orgId: string
  employeeId?: string
  departments: { id: string; name: string }[]
  grants: RolePublic[]
  onSuccess: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [userId, setUserId] = useState("")
  const [role, setRole] = useState<Role>("dept_manager")
  const [departmentId, setDepartmentId] = useState("")
  const [message, setMessage] = useState("")
  const accounts = useQuery({
    queryKey: ["accounts", orgId, "role-picker", search.trim(), employeeId],
    queryFn: async () =>
      (
        await AccountsService.readAccounts({
          path: { org_id: orgId },
          query: {
            q: search.trim(),
            employment_status: "active",
            limit: 100,
            employee_id: employeeId,
          },
        })
      ).data,
    enabled: open,
  })
  const mutation = useMutation({
    mutationFn: async () =>
      (
        await RolesService.grantRole({
          path: { org_id: orgId },
          body: {
            user_id: userId,
            role,
            department_id: role === "dept_manager" ? departmentId : null,
          },
        })
      ).data,
    onSuccess: (grant) => {
      setMessage(
        grants.some((item) => item.id === grant.id)
          ? t("admin.roleGrant.alreadyGranted")
          : t("admin.roleGrant.granted"),
      )
      onSuccess()
    },
  })
  function changeOpen(value: boolean) {
    if (mutation.isPending) return
    setOpen(value)
    setSearch("")
    setUserId("")
    setRole("dept_manager")
    setDepartmentId("")
    setMessage("")
    mutation.reset()
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <Button onClick={() => changeOpen(true)}>
        {t("admin.roleGrant.button")}
      </Button>
      <DialogContent showCloseButton={!mutation.isPending}>
        <DialogHeader>
          <DialogTitle>{t("admin.roleGrant.title")}</DialogTitle>
          <DialogDescription>
            {t("admin.roleGrant.description")}
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label={t("admin.roleGrant.searchAriaLabel")}
          placeholder={t("admin.roleGrant.searchPlaceholder")}
          value={search}
          disabled={mutation.isPending}
          onChange={(event) => {
            setSearch(event.target.value)
            setUserId("")
          }}
        />
        <SetupError error={accounts.error} />
        <RoleSelect
          label={t("admin.roleGrant.accountLabel")}
          value={userId}
          onChange={setUserId}
          disabled={mutation.isPending || accounts.isFetching}
          options={
            accounts.data?.data.flatMap((employee) =>
              employee.account && employee.account.status !== "disabled"
                ? [
                    {
                      id: employee.account.user_id,
                      name: t("admin.roleGrant.accountWithUsername", {
                        name: employee.display_name,
                        username: employee.account.username,
                      }),
                    },
                  ]
                : [],
            ) ?? []
          }
        />
        {accounts.data && accounts.data.count > 100 && (
          <p>{t("admin.roleGrant.limitNotice")}</p>
        )}
        <RoleSelect
          label={t("admin.roleGrant.roleLabel")}
          value={role}
          disabled={mutation.isPending}
          onChange={(value) => {
            if (value === "org_admin" || value === "dept_manager")
              setRole(value)
          }}
          options={Object.entries(roleLabels).map(([id, name]) => ({
            id,
            name,
          }))}
        />
        {role === "dept_manager" && (
          <RoleSelect
            label={t("admin.roleGrant.departmentLabel")}
            value={departmentId}
            onChange={setDepartmentId}
            disabled={mutation.isPending}
            options={departments}
          />
        )}
        <SetupError error={mutation.error} />
        {message && <p role="status">{message}</p>}
        <Button
          disabled={
            !userId ||
            (role === "dept_manager" && !departmentId) ||
            accounts.isFetching ||
            accounts.isError ||
            mutation.isPending
          }
          onClick={() => {
            setMessage("")
            mutation.mutate()
          }}
        >
          {mutation.isPending
            ? t("admin.roleGrant.granting")
            : t("admin.roleGrant.confirmGrant")}
        </Button>
        <Button
          variant="outline"
          disabled={mutation.isPending}
          onClick={() => changeOpen(false)}
        >
          {t("admin.common.close")}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

function RoleSelect({
  label,
  value,
  onChange,
  disabled,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  options: { id: string; name: string }[]
}) {
  const { t } = useTranslation()
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label}>
        <SelectValue
          placeholder={t("admin.roleGrant.selectPlaceholder", { label })}
        />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
