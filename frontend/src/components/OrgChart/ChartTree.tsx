import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { OrgChartPerson } from "@/client"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function PersonCard({
  person,
  selected,
  cycle,
  onSelect,
}: {
  person: OrgChartPerson
  selected: boolean
  cycle: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      data-org-item={person.id}
      className={cn(
        "w-52 overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm",
        selected && "border-primary ring-2 ring-primary/30",
      )}
    >
      <button
        type="button"
        aria-label={t("people.orgChart.viewReportingAria", {
          name: person.display_name,
        })}
        aria-pressed={selected}
        onClick={onSelect}
        className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Avatar className="size-10">
          <AvatarFallback className="bg-primary/10 text-primary">
            {person.display_name.slice(0, 1)}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0">
          <span className="block font-semibold">{person.display_name}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {person.title || t("people.orgChart.jobTitleEmpty")}
          </span>
        </span>
      </button>
      {cycle && (
        <p className="px-3 pb-3 text-xs text-destructive">
          {t("people.orgChart.reportingCycle")}
        </p>
      )}
      {selected && (
        <Button
          asChild
          variant="ghost"
          className="w-full rounded-none border-t text-primary"
        >
          <Link to="/employees/$employeeId" params={{ employeeId: person.id }}>
            {t("people.orgChart.viewDetails")}
          </Link>
        </Button>
      )}
    </div>
  )
}

export function ChartTree({
  roots,
  childrenByParent,
  renderCard,
  expanded,
  showConnectorTestId = true,
}: {
  roots?: string[]
  childrenByParent: Map<string | null, string[]>
  renderCard: (id: string) => ReactNode
  expanded?: Set<string>
  showConnectorTestId?: boolean
}) {
  function branch(id: string): ReactNode {
    const children = childrenByParent.get(id) ?? []
    const isExpanded = !expanded || expanded.has(id)
    return (
      <li key={id}>
        {renderCard(id)}
        {children.length > 0 && isExpanded && (
          <>
            <span
              className="org-stem"
              data-testid={showConnectorTestId ? "org-connector" : undefined}
              aria-hidden="true"
            />
            <ul>{children.map(branch)}</ul>
          </>
        )}
      </li>
    )
  }
  return (
    <ul className="org-tree">
      {(roots ?? childrenByParent.get(null) ?? []).map(branch)}
    </ul>
  )
}
