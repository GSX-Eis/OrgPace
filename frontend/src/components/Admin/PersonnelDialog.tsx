import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type EmployeeAccount,
  type EmployeeReference,
  EmployeesService,
  type RosterImportPreview,
  RosterService,
} from "@/client"
import { employeeFieldLabels } from "@/components/Roster/EmployeeFields"
import { RosterPreview } from "@/components/Roster/RosterPreview"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useOrg } from "@/hooks/useOrg"

export function PersonnelDialog({
  orgId,
  employee,
  department = "",
  offboard = false,
  initialManager,
}: {
  orgId: string
  employee?: EmployeeAccount
  department?: string
  offboard?: boolean
  initialManager?: EmployeeReference
}) {
  const { t } = useTranslation()
  const { org } = useOrg()
  const fields = org?.employee_fields ?? []
  const client = useQueryClient()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<RosterImportPreview | null>(null)
  const [managerSearch, setManagerSearch] = useState("")
  const [manager, setManager] = useState(initialManager?.id ?? "keep")
  const title = offboard
    ? t("admin.personnel.titleOffboard")
    : employee
      ? t("admin.personnel.titleTransfer")
      : t("admin.personnel.titleOnboard")
  const managers = useQuery({
    queryKey: ["employees", orgId, "manager-search", managerSearch],
    enabled: open && !offboard,
    queryFn: async () =>
      (
        await EmployeesService.readEmployees({
          path: { org_id: orgId },
          query: { q: managerSearch || undefined },
        })
      ).data,
  })
  const create = useMutation({
    mutationFn: async (form: FormData) => {
      const shared = {
        ...Object.fromEntries(
          fields.map((field) => [field, String(form.get(field)) || null]),
        ),
        department: String(form.get("department")),
        title: String(form.get("title")) || null,
        ...(manager === "keep"
          ? {}
          : { manager_id: manager === "none" ? null : manager }),
      }
      return (
        await RosterService.previewSingleChange({
          path: { org_id: orgId },
          body:
            offboard && employee
              ? { kind: "offboard", employee_ids: [employee.id] }
              : employee
                ? { kind: "transfer", employee_id: employee.id, ...shared }
                : {
                    kind: "onboard",
                    employee_code: String(form.get("employee_code")),
                    display_name: String(form.get("display_name")),
                    email: String(form.get("email")),
                    ...shared,
                  },
        })
      ).data
    },
    onSuccess: setPreview,
  })
  const apply = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error(t("admin.personnel.errorPreviewFirst"))
      return RosterService.applyImport({
        path: { org_id: orgId, id: preview.id },
        body: {
          base_revision: preview.base_revision,
          confirm_mass_deactivation: true,
        },
      })
    },
    onSuccess: () => {
      setOpen(false)
      client.invalidateQueries()
    },
  })
  const busy = create.isPending || apply.isPending
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        setOpen(next)
        setPreview(null)
        setManagerSearch("")
        setManager(initialManager?.id ?? "keep")
        create.reset()
        apply.reset()
      }}
    >
      <DialogTrigger asChild>
        <Button variant={offboard ? "destructive" : "outline"}>
          {initialManager
            ? t("admin.personnel.restoreManager", {
                name: initialManager.display_name,
              })
            : title}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {employee
              ? t("admin.personnel.dialogTitleWithName", {
                  title,
                  name: employee.display_name,
                })
              : title}
          </DialogTitle>
          <DialogDescription>
            {offboard
              ? t("admin.personnel.descOffboard")
              : t("admin.personnel.descDefault")}
          </DialogDescription>
        </DialogHeader>
        {!preview ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              create.mutate(new FormData(event.currentTarget))
            }}
          >
            {!offboard && (
              <>
                {!employee &&
                  (
                    [
                      [
                        "employee_code",
                        t("admin.personnel.fields.employee_code"),
                      ],
                      [
                        "display_name",
                        t("admin.personnel.fields.display_name"),
                      ],
                      ["email", t("admin.personnel.fields.email")],
                    ] as const
                  ).map(([name, label]) => (
                    <label
                      className="block space-y-2 text-sm"
                      key={name}
                      htmlFor={`${id}-${name}`}
                    >
                      {label}
                      <Input
                        id={`${id}-${name}`}
                        name={name}
                        type={name === "email" ? "email" : "text"}
                        required
                        disabled={busy}
                      />
                    </label>
                  ))}
                <label
                  className="block space-y-2 text-sm"
                  htmlFor={`${id}-department`}
                >
                  {t("admin.personnel.fields.department")}
                  <Input
                    id={`${id}-department`}
                    name="department"
                    defaultValue={department}
                    required
                    disabled={busy}
                  />
                </label>
                <label
                  className="block space-y-2 text-sm"
                  htmlFor={`${id}-title`}
                >
                  {t("admin.personnel.fields.title")}
                  <Input
                    id={`${id}-title`}
                    name="title"
                    defaultValue={employee?.title ?? ""}
                    disabled={busy}
                  />
                </label>
                {fields.map((field) => (
                  <label
                    className="block space-y-2 text-sm"
                    key={field}
                    htmlFor={`${id}-${field}`}
                  >
                    {employeeFieldLabels[field]}
                    <Input
                      id={`${id}-${field}`}
                      name={field}
                      type={field === "hire_date" ? "date" : "text"}
                      maxLength={field === "hire_date" ? undefined : 50}
                      defaultValue={employee?.[field] ?? ""}
                      disabled={busy}
                    />
                  </label>
                ))}
                <label
                  className="block space-y-2 text-sm"
                  htmlFor={`${id}-search`}
                >
                  {t("admin.personnel.searchManager")}
                  <Input
                    id={`${id}-search`}
                    value={managerSearch}
                    onChange={(e) => {
                      setManagerSearch(e.target.value)
                      setManager("keep")
                    }}
                    placeholder={t("admin.personnel.searchManagerPlaceholder")}
                    disabled={busy}
                  />
                </label>
                <label
                  className="block space-y-2 text-sm"
                  htmlFor={`${id}-manager`}
                >
                  {t("admin.personnel.manager")}
                  <select
                    className="h-10 w-full rounded-md border bg-background px-3"
                    id={`${id}-manager`}
                    value={manager}
                    disabled={busy || managers.isError}
                    onChange={(e) => setManager(e.target.value)}
                  >
                    <option value="keep">
                      {employee
                        ? t("admin.personnel.keepManager")
                        : t("admin.personnel.noManager")}
                    </option>
                    <option value="none">
                      {t("admin.personnel.clearManager")}
                    </option>
                    {initialManager &&
                      !managers.data?.data.some(
                        (e) => e.id === initialManager.id,
                      ) && (
                        <option value={initialManager.id}>
                          {initialManager.display_name}
                        </option>
                      )}
                    {managers.data?.data
                      .filter(
                        (e) =>
                          e.id !== employee?.id &&
                          e.employment_status === "active",
                      )
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.display_name}
                          {e.department ? ` · ${e.department.name}` : ""}
                        </option>
                      ))}
                  </select>
                </label>
                <SetupError error={managers.error} />
              </>
            )}
            <Button type="submit" disabled={busy}>
              {create.isPending
                ? t("admin.personnel.previewing")
                : t("admin.personnel.previewChanges")}
            </Button>
          </form>
        ) : (
          <>
            <RosterPreview preview={preview} />
            <div className="flex gap-2">
              <Button
                disabled={busy || !preview.can_apply || apply.isError}
                onClick={() => apply.mutate()}
              >
                {t("admin.personnel.confirmAction", { title })}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setPreview(null)
                  apply.reset()
                }}
              >
                {t("admin.personnel.refill")}
              </Button>
            </div>
          </>
        )}
        <SetupError error={create.error ?? apply.error} />
      </DialogContent>
    </Dialog>
  )
}
