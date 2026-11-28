import { Fragment, type Ref } from "react"
import { useTranslation } from "react-i18next"
import type { OrgChartDepartment } from "@/client"
import { DepartmentActions } from "./DepartmentActions"
import { DepartmentCapabilities } from "./DepartmentCapabilities"
export function DepartmentDetail({
  department,
  colors,
  childrenByParent,
  byDepartment,
  managerNames,
  selectDepartment,
  canEdit,
  actionsRef,
  orgId,
  departments,
  onMovedParent,
}: {
  department?: OrgChartDepartment
  colors: Map<string, string>
  childrenByParent: Map<string | null, string[]>
  byDepartment: Map<string, OrgChartDepartment>
  managerNames: Map<string, string | undefined>
  selectDepartment: (id: string) => void
  canEdit: boolean
  actionsRef: Ref<HTMLFieldSetElement>
  orgId: string
  departments: OrgChartDepartment[]
  onMovedParent: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <aside
      aria-label={t("people.orgChart.deptDetailAria")}
      className="org-detail space-y-4 bg-surface p-4"
    >
      {department ? (
        <>
          <h2 className="flex items-center gap-2 font-semibold wrap-anywhere">
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: colors.get(department.id) }}
            />
            <span className="min-w-0">{department.name}</span>
          </h2>
          <dl className="grid grid-cols-2 gap-2">
            {[
              [t("people.orgChart.totalWithChildren"), department.total_count],
              [t("people.orgChart.directMembers"), department.direct_count],
            ].map(([name, count]) => (
              <div
                key={name}
                className="rounded-md border border-surface-border bg-surface-muted p-2.5"
              >
                <dt className="text-xs text-muted-foreground">{name}</dt>
                <dd className="font-semibold tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
          <div className="space-y-1 text-sm">
            <h3 className="text-xs text-muted-foreground">
              {t("people.orgChart.deptManagerHeading")}
            </h3>
            <p className="wrap-anywhere">
              {managerNames.get(department.id) || t("people.orgChart.unset")}
            </p>
          </div>
          {!!childrenByParent.get(department.id)?.length && (
            <div className="space-y-1.5 border-surface-border border-t pt-3">
              <h3 className="text-xs text-muted-foreground">
                {t("people.orgChart.subdeptsHeading")}
              </h3>
              <ul className="flex flex-wrap gap-1.5">
                {childrenByParent.get(department.id)?.map((id) => {
                  const item = byDepartment.get(id)!
                  return (
                    <li key={id} className="min-w-0">
                      <button
                        type="button"
                        onClick={() => selectDepartment(id)}
                        className="rounded-full border border-surface-border px-2 py-0.5 text-left text-xs wrap-anywhere hover:bg-muted"
                      >
                        {item.name} ({item.total_count})
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          <Fragment key={department.id}>
            {canEdit && (
              <DepartmentActions
                actionsRef={actionsRef}
                orgId={orgId}
                department={department}
                departments={departments}
                onMovedParent={onMovedParent}
              />
            )}
            <DepartmentCapabilities
              orgId={orgId}
              departmentId={department.id}
              canEdit={canEdit}
            />
          </Fragment>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("people.orgChart.noDeptDetail")}
        </p>
      )}
    </aside>
  )
}
