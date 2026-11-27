import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useId } from "react"
import { useTranslation } from "react-i18next"
import { type OrganizationPublic, OrgsService } from "@/client"
import { localeRecord } from "@/components/Admin/labels"
import { SetupError } from "@/components/Setup/SetupError"
import { Checkbox } from "@/components/ui/checkbox"
import { i18n } from "@/i18n"

export const employeeFieldLabels = localeRecord(
  {
    job_family: "",
    work_location: "",
    hire_date: "",
  },
  "setup.employeeFields.labels",
)

export function EmployeeFields({ org }: { org: OrganizationPublic }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const id = useId()
  const fields = org.employee_fields ?? []
  const save = useMutation({
    mutationFn: (fields: NonNullable<OrganizationPublic["employee_fields"]>) =>
      OrgsService.updateEmployeeFields({
        path: { org_id: org.id },
        body: { fields },
      }),
    onSuccess: () => client.invalidateQueries(),
  })
  return (
    <section
      aria-label={t("setup.employeeFields.sectionAriaLabel")}
      className="space-y-4 rounded-xl border p-5"
    >
      <div>
        <h2 className="text-lg font-semibold">
          {t("setup.employeeFields.heading")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("setup.employeeFields.description")}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {Object.entries(employeeFieldLabels).map(([key, label]) => {
          const field = key as keyof typeof employeeFieldLabels
          return (
            <label
              key={field}
              htmlFor={`${id}-${field}`}
              className="flex items-center gap-3 rounded-lg bg-muted/30 p-3 text-sm"
            >
              <Checkbox
                id={`${id}-${field}`}
                role="switch"
                checked={fields.includes(field)}
                disabled={save.isPending}
                onCheckedChange={(checked) =>
                  save.mutate(
                    checked
                      ? [...fields, field]
                      : fields.filter((f) => f !== field),
                  )
                }
              />
              {label}
            </label>
          )
        })}
      </div>
      <SetupError error={save.error} />
    </section>
  )
}

export function tenureLabel(hireDate: string): string {
  const [year, month, day] = hireDate.split("-").map(Number)
  const today = new Date()
  const anniversaryPending =
    today.getMonth() + 1 < month ||
    (today.getMonth() + 1 === month && today.getDate() < day)
  const years = today.getFullYear() - year - Number(anniversaryPending)
  return years < 1
    ? i18n.t("setup.employeeFields.tenureLessThanYear")
    : i18n.t("setup.employeeFields.tenureYears", { years })
}
