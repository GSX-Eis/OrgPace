import { ChevronDown, ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { OrgChartDepartment } from "@/client"

import { ChartTree } from "./ChartTree"
export function DepartmentTree({
  department,
  childrenByParent,
  chartExpanded,
  byDepartment,
  colors,
  managerNames,
  selectDepartment,
  onToggle,
}: {
  department?: OrgChartDepartment
  childrenByParent: Map<string | null, string[]>
  chartExpanded: Set<string>
  byDepartment: Map<string, OrgChartDepartment>
  colors: Map<string, string>
  managerNames: Map<string, string | undefined>
  selectDepartment: (id: string) => void
  onToggle: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      {department ? (
        <ChartTree
          roots={[department.id]}
          childrenByParent={childrenByParent}
          expanded={chartExpanded}
          renderCard={(id) => {
            const item = byDepartment.get(id)!
            const childCount = childrenByParent.get(id)?.length ?? 0
            const expanded = chartExpanded.has(id)
            return (
              <div
                className="org-node"
                style={{ borderTopColor: colors.get(id) }}
                data-selected={id === department.id}
                data-org-item={id}
              >
                <button
                  type="button"
                  aria-pressed={id === department.id}
                  onClick={() => selectDepartment(id)}
                  className="block w-full rounded-sm px-2.5 py-2 text-left hover:bg-muted/50"
                >
                  <span className="flex items-start justify-between gap-1.5">
                    <span className="min-w-0 font-semibold wrap-anywhere">
                      {item.name}
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                      {t("people.orgChart.personCountBadge", {
                        count: item.total_count,
                      })}
                    </span>
                  </span>
                  <span
                    className="mt-0.5 block truncate text-xs text-muted-foreground"
                    title={managerNames.get(item.id)}
                  >
                    {t("people.orgChart.managerLabel", {
                      names:
                        managerNames.get(item.id) || t("people.orgChart.unset"),
                    })}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t("people.orgChart.directCount", {
                      count: item.direct_count,
                    })}
                  </span>
                </button>
                {childCount > 0 && (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={
                      expanded
                        ? t("people.orgChart.collapseSubdeptsAria", {
                            name: item.name,
                          })
                        : t("people.orgChart.expandSubdeptsAria", {
                            name: item.name,
                          })
                    }
                    onClick={() => onToggle(id)}
                    className="flex w-full items-center justify-center gap-1 border-surface-border border-t py-1 text-xs text-muted-foreground hover:bg-muted"
                  >
                    {expanded ? (
                      <ChevronDown className="size-3" />
                    ) : (
                      <ChevronRight className="size-3" />
                    )}
                    {t("people.orgChart.subdeptsCount", {
                      count: childCount,
                    })}
                  </button>
                )}
              </div>
            )
          }}
        />
      ) : (
        <p className="p-6 text-center text-sm text-muted-foreground">
          {t("people.orgChart.noVisibleDepts")}
        </p>
      )}
    </>
  )
}
