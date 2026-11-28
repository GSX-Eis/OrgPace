import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import {
  CapabilitiesService,
  type CapabilityPublic,
  type DepartmentPublic,
  EmployeesService,
} from "@/client"
import { record } from "@/components/Profile/fields"
import { Input } from "@/components/ui/input"
import { useOrg } from "@/hooks/useOrg"
import { capacityKeys, useCapacityDepartments } from "./queries"

export type DemandOptionsData = {
  departments: DepartmentPublic[]
  capabilities: CapabilityPublic[]
  ownDepartment: string | undefined
  requesting: DepartmentPublic[]
}

type DemandOptionsResult =
  | {
      isPending: true
      isError: false
      data: undefined
      refetch: () => Promise<unknown>
    }
  | {
      isPending: false
      isError: true
      data: undefined
      refetch: () => Promise<unknown>
    }
  | {
      isPending: false
      isError: false
      data: DemandOptionsData
      refetch: () => Promise<unknown>
    }

export function useDemandOptions(orgId: string): DemandOptionsResult {
  const { roles, employeeId, managedDepartmentIds } = useOrg()
  const departments = useCapacityDepartments(orgId)
  const meta = useQuery({
    queryKey: capacityKeys.demandOptions(orgId),
    queryFn: async () => {
      const [capabilities, self] = await Promise.all([
        CapabilitiesService.readCapabilities({ path: { org_id: orgId } }),
        employeeId
          ? EmployeesService.readEmployee({
              path: { org_id: orgId, employee_id: employeeId },
            })
          : null,
      ])
      return {
        capabilities: capabilities.data.data,
        ownDepartment: self?.data.department?.id,
      }
    },
  })
  const refetch = () => Promise.all([departments.refetch(), meta.refetch()])
  if (departments.isError || meta.isError) {
    return { isPending: false, isError: true, data: undefined, refetch }
  }
  if (
    departments.isPending ||
    meta.isPending ||
    !departments.data ||
    !meta.data
  ) {
    return { isPending: true, isError: false, data: undefined, refetch }
  }
  return {
    isPending: false,
    isError: false,
    refetch,
    data: {
      departments: departments.data,
      capabilities: meta.data.capabilities,
      ownDepartment: meta.data.ownDepartment,
      requesting: departments.data.filter(
        (d) =>
          roles.includes("org_admin") ||
          (managedDepartmentIds.length
            ? managedDepartmentIds.includes(d.id)
            : d.id === meta.data.ownDepartment),
      ),
    },
  }
}

export function capabilityLevels(rubric: unknown) {
  return record(rubric) && Array.isArray(rubric.levels)
    ? rubric.levels.filter(record)
    : []
}

export function demandWork(data: FormData, prefix = "") {
  return {
    window_start: String(data.get(`${prefix}start`)),
    window_end: String(data.get(`${prefix}end`)),
    description: String(data.get(`${prefix}description`)).trim(),
  }
}

export function DemandWorkFields({ prefix = "" }: { prefix?: string }) {
  const { t } = useTranslation()
  const idPrefix = prefix || "demand-"
  return (
    <>
      {[
        {
          name: "start",
          label: t("capacity.demands.fields.startDate"),
          type: "date",
        },
        {
          name: "end",
          label: t("capacity.demands.fields.endDate"),
          type: "date",
        },
      ].map(({ name, label, ...input }) => (
        <label
          key={name}
          htmlFor={`${idPrefix}${name}`}
          className="space-y-2 text-sm font-medium"
        >
          <span>{label}</span>
          <Input
            id={`${idPrefix}${name}`}
            name={`${prefix}${name}`}
            {...input}
            required
          />
        </label>
      ))}
      <label className="space-y-2 text-sm font-medium sm:col-span-2">
        <span>{t("capacity.demands.fields.description")}</span>
        <textarea
          name={`${prefix}description`}
          required
          maxLength={2000}
          className="min-h-28 w-full rounded-md border bg-background p-3"
        />
      </label>
    </>
  )
}
