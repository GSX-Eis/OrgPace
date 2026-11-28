import { ChevronDown, ChevronRight, Search } from "lucide-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { OrgChartDepartment } from "@/client"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export function DepartmentNav({
  childrenByParent,
  matches,
  byDepartment,
  departmentId,
  colors,
  term,
  navExpanded,
  search,
  onSearch,
  onToggle,
  selectDepartment,
  departmentCount,
}: {
  childrenByParent: Map<string | null, string[]>
  matches: Set<string>
  byDepartment: Map<string, OrgChartDepartment>
  departmentId?: string
  colors: Map<string, string>
  term: string
  navExpanded: Set<string>
  search: string
  onSearch: (value: string) => void
  onToggle: (id: string) => void
  selectDepartment: (id: string) => void
  departmentCount: number
}) {
  const { t } = useTranslation()
  function renderNav(parent: string | null): ReactNode {
    const items = (childrenByParent.get(parent) ?? []).filter((id) =>
      matches.has(id),
    )
    if (!items.length) return null
    return (
      <ul className={parent ? "org-nav-children" : ""}>
        {items.map((id) => {
          const item = byDepartment.get(id)!
          const hasChildren = (childrenByParent.get(id) ?? []).some((child) =>
            matches.has(child),
          )
          const expanded = !!term || navExpanded.has(id)
          return (
            <li key={id}>
              <div
                className={cn(
                  "org-nav-row",
                  departmentId === id && "bg-primary/10 text-primary",
                )}
              >
                {hasChildren && !term ? (
                  <button
                    type="button"
                    className="grid size-6 shrink-0 place-items-center rounded hover:bg-muted"
                    aria-label={
                      expanded
                        ? t("people.orgChart.collapseBranchAria", {
                            name: item.name,
                          })
                        : t("people.orgChart.expandBranchAria", {
                            name: item.name,
                          })
                    }
                    aria-expanded={expanded}
                    onClick={() => onToggle(id)}
                  >
                    {expanded ? (
                      <ChevronDown className="size-3" />
                    ) : (
                      <ChevronRight className="size-3" />
                    )}
                  </button>
                ) : (
                  <span className="w-6 shrink-0" />
                )}
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded py-1.5 pr-2 text-left"
                  aria-pressed={departmentId === id}
                  title={item.name}
                  onClick={() => selectDepartment(id)}
                >
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: colors.get(id) }}
                  />
                  <span className="flex-1 truncate">{item.name}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {item.total_count}
                  </span>
                </button>
              </div>
              {expanded && renderNav(id)}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <nav
      aria-label={t("people.orgChart.deptNavAria")}
      className="org-nav bg-surface"
    >
      <div className="relative border-surface-border border-b p-3">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-5 left-5 size-3.5 text-muted-foreground"
        />
        <Input
          className="h-8 pl-7 text-xs"
          aria-label={t("people.orgChart.searchAria")}
          placeholder={t("people.orgChart.searchPlaceholder")}
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
      <div className="org-nav-scroll p-2">
        {renderNav(null) ?? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {term
              ? t("people.orgChart.noMatchingDepts")
              : t("people.orgChart.noVisibleDepts")}
          </p>
        )}
      </div>
      <p className="border-surface-border border-t px-3 py-2 text-xs text-muted-foreground">
        {t("people.orgChart.navFooter", { count: departmentCount })}
      </p>
    </nav>
  )
}
