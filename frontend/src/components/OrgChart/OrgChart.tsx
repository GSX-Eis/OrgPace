import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronDown, ChevronRight, Search } from "lucide-react"
import {
  Fragment,
  type ReactNode,
  type Ref,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { useTranslation } from "react-i18next"
import {
  type OrgChartDepartment,
  type OrgChartPerson,
  type OrgChartPublic,
  OrgsService,
} from "@/client"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { WorkspacePage } from "@/components/Common/WorkbenchPrimitives"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"
import { cn } from "@/lib/utils"
import { DepartmentCapabilities } from "./DepartmentCapabilities"
import "./org-chart.css"

export function OrgChart() {
  const { t } = useTranslation()
  const { org, roles } = useOrg()
  if (!org) return <OrgState />
  if (!roles.some((role) => role === "org_admin" || role === "dept_manager"))
    return <p role="alert">{t("people.orgChart.noPermission")}</p>
  return (
    <Chart key={org.id} orgId={org.id} canEdit={roles.includes("org_admin")} />
  )
}

// Only members of a cycle become roots; their other reports remain attached.
function reportingCycles(people: OrgChartPerson[]) {
  const managers = new Map(
    people.map((person) => [person.id, person.manager_id]),
  )
  const checked = new Set<string>()
  const cycles = new Set<string>()
  for (const person of people) {
    const path = new Map<string, number>()
    let id: string | null | undefined = person.id
    while (id && managers.has(id) && !checked.has(id)) {
      const start = path.get(id)
      if (start !== undefined) {
        for (const [member, index] of path)
          if (index >= start) cycles.add(member)
        break
      }
      path.set(id, path.size)
      id = managers.get(id)
    }
    for (const member of path.keys()) checked.add(member)
  }
  return cycles
}

const branchColors = ["#2563eb", "#0d9488", "#7c3aed", "#d97706", "#e11d48"]

function groupByParent<T extends { id: string }>(
  items: T[],
  parentOf: (item: T) => string | null,
) {
  const groups = new Map<string | null, string[]>()
  for (const item of items) {
    const parent = parentOf(item)
    const siblings = groups.get(parent) ?? []
    siblings.push(item.id)
    groups.set(parent, siblings)
  }
  return groups
}

function managerNames(department: OrgChartDepartment) {
  return department.managers
    ?.map((manager) => manager.display_name)
    .join(i18n.t("people.orgChart.nameSeparator"))
}

function Chart({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const chart = useQuery({
    queryKey: ["org-chart", orgId],
    queryFn: async () =>
      (await OrgsService.readOrgChart({ path: { org_id: orgId } })).data,
  })
  if (chart.isPending) return <ProfileLoading />
  if (chart.isError) return <ProfileError retry={() => chart.refetch()} />
  return <ChartWorkspace data={chart.data} orgId={orgId} canEdit={canEdit} />
}

function ChartWorkspace({
  data: { departments, people },
  orgId,
  canEdit,
}: {
  data: OrgChartPublic
  orgId: string
  canEdit: boolean
}) {
  const { t } = useTranslation()
  const firstDepartment =
    departments.find((item) => !item.parent_department_id) ?? departments[0]
  const [selectedDepartment, setDepartment] = useState(firstDepartment?.id)
  const [selectedPerson, setPerson] = useState<string | null>(null)
  const [view, setView] = useState<"tree" | "members">("tree")
  const [reporting, setReporting] = useState(false)
  const [includeChildren, setIncludeChildren] = useState(false)
  const [search, setSearch] = useState("")
  const [navExpanded, setNavExpanded] = useState<Set<string>>(() => new Set())
  const [chartExpanded, setChartExpanded] = useState<Set<string>>(
    () => new Set(firstDepartment ? [firstDepartment.id] : []),
  )
  const canvasRef = useRef<HTMLElement>(null)
  const actionsRef = useRef<HTMLFieldSetElement>(null)
  const department =
    departments.find((item) => item.id === selectedDepartment) ??
    firstDepartment

  const activeItemId = view === "tree" ? department?.id : selectedPerson

  useLayoutEffect(() => {
    if (!activeItemId) return
    const canvas = canvasRef.current
    const active = canvas?.querySelector(
      `[data-org-item="${CSS.escape(activeItemId)}"]`,
    )
    if (!canvas || !active) return
    const bounds = canvas.getBoundingClientRect()
    const node = active.getBoundingClientRect()
    canvas.scrollBy({
      left:
        Math.max(0, node.right - bounds.right) +
        Math.min(0, node.left - bounds.left),
      top:
        Math.max(0, node.bottom - bounds.bottom) +
        Math.min(0, node.top - bounds.top),
    })
  }, [activeItemId])

  const byDepartment = new Map(departments.map((item) => [item.id, item]))
  const byPerson = new Map(people.map((item) => [item.id, item]))
  const person = selectedPerson ? byPerson.get(selectedPerson) : undefined
  const children = groupByParent(
    departments,
    (item) => item.parent_department_id,
  )
  const colors = new Map<string, string>()
  function colorBranch(id: string, color: string) {
    colors.set(id, color)
    for (const child of children.get(id) ?? []) colorBranch(child, color)
  }
  const roots = children.get(null) ?? []
  const soleRoot = roots.length === 1 ? roots[0] : undefined
  const primaryBranches = soleRoot ? (children.get(soleRoot) ?? []) : roots
  if (soleRoot) colors.set(soleRoot, "var(--foreground)")
  primaryBranches.forEach((id, index) => {
    colorBranch(id, branchColors[index % branchColors.length])
  })

  const matches = new Set<string>()
  const term = search.trim().toLocaleLowerCase()
  function ancestors(id: string) {
    const ids: string[] = []
    let parent = byDepartment.get(id)?.parent_department_id
    while (parent) {
      ids.push(parent)
      parent = byDepartment.get(parent)?.parent_department_id
    }
    return ids
  }
  for (const item of departments) {
    if (
      `${item.name} ${managerNames(item) ?? ""}`
        .toLocaleLowerCase()
        .includes(term)
    ) {
      matches.add(item.id)
      if (term) for (const id of ancestors(item.id)) matches.add(id)
    }
  }
  const members = people.filter(
    (item) =>
      item.department_id &&
      department &&
      (item.department_id === department.id ||
        (includeChildren &&
          ancestors(item.department_id).includes(department.id))),
  )
  const cycles = reportingCycles(people)
  const memberIds = new Set(members.map((item) => item.id))
  const departmentReports = groupByParent(members, (item) =>
    !cycles.has(item.id) && item.manager_id && memberIds.has(item.manager_id)
      ? item.manager_id
      : null,
  )
  let reports = new Map<string | null, string[]>()
  if (view === "members" && (person || reporting)) {
    if (person) {
      const chain = [person.id]
      let manager = person.manager_id
      while (manager && byPerson.has(manager) && !chain.includes(manager)) {
        chain.unshift(manager)
        manager = byPerson.get(manager)?.manager_id ?? null
      }
      chain.forEach((id, index) => {
        reports.set(index ? chain[index - 1] : null, [id])
      })
      reports.set(
        person.id,
        people
          .filter(
            (item) => item.manager_id === person.id && !chain.includes(item.id),
          )
          .map((item) => item.id),
      )
    } else {
      reports = departmentReports
    }
  }

  function selectDepartment(id: string) {
    setDepartment(id)
    setPerson(null)
    const parentIds = ancestors(id)
    if (parentIds.length) {
      setNavExpanded((previous) => new Set([...previous, ...parentIds]))
    }
    setChartExpanded(new Set([id]))
  }

  function toggleBranch(
    id: string,
    set: (update: (previous: Set<string>) => Set<string>) => void,
  ) {
    set((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function renderNav(parent: string | null): ReactNode {
    const items = (children.get(parent) ?? []).filter((id) => matches.has(id))
    if (!items.length) return null
    return (
      <ul className={parent ? "org-nav-children" : ""}>
        {items.map((id) => {
          const item = byDepartment.get(id)!
          const hasChildren = (children.get(id) ?? []).some((child) =>
            matches.has(child),
          )
          const expanded = !!term || navExpanded.has(id)
          return (
            <li key={id}>
              <div
                className={cn(
                  "org-nav-row",
                  department?.id === id && "bg-primary/10 text-primary",
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
                    onClick={() => toggleBranch(id, setNavExpanded)}
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
                  aria-pressed={department?.id === id}
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

  const label =
    view === "tree"
      ? t("people.orgChart.viewDepartmentHierarchy")
      : person
        ? t("people.orgChart.viewPersonReporting")
        : reporting
          ? t("people.orgChart.viewDepartmentReporting")
          : t("people.orgChart.viewDepartmentMembers")
  return (
    <WorkspacePage variant="split" className="org-workspace">
      <h1 className="sr-only">{t("people.orgChart.heading")}</h1>
      <TopbarActions>
        <fieldset
          aria-label={t("people.orgChart.viewSwitchAria")}
          className="flex shrink-0 gap-0.5 rounded-md border bg-surface-muted p-0.5"
        >
          {(["tree", "members"] as const).map((mode) => (
            <Button
              key={mode}
              variant="ghost"
              size="sm"
              aria-pressed={view === mode}
              className="h-6 px-2 text-xs aria-pressed:bg-surface aria-pressed:shadow-xs"
              onClick={() => {
                setView(mode)
                setPerson(null)
                setReporting(false)
              }}
            >
              {mode === "tree"
                ? t("people.orgChart.viewTree")
                : t("people.orgChart.viewMembers")}
            </Button>
          ))}
        </fieldset>
        {canEdit && department && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => actionsRef.current?.querySelector("button")?.focus()}
          >
            {t("people.orgChart.manageDepartment")}
          </Button>
        )}
      </TopbarActions>
      <div className="org-layout">
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
              onChange={(event) => setSearch(event.target.value)}
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
            {t("people.orgChart.navFooter", { count: departments.length })}
          </p>
        </nav>

        <section aria-label={label} className="org-canvas">
          {view === "tree" ? (
            <>
              <header className="flex flex-wrap items-center justify-between gap-2 border-surface-border border-b bg-surface px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h2 className="min-w-0 font-semibold wrap-anywhere">
                    {department?.name ??
                      t("people.orgChart.viewDepartmentHierarchy")}
                  </h2>
                  {department?.parent_department_id &&
                    byDepartment.has(department.parent_department_id) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() =>
                          selectDepartment(department.parent_department_id!)
                        }
                      >
                        {t("people.orgChart.backToParent", {
                          name: byDepartment.get(
                            department.parent_department_id,
                          )!.name,
                        })}
                      </Button>
                    )}
                </div>
                {department && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      {t("people.orgChart.deptStats", {
                        children: children.get(department.id)?.length ?? 0,
                        members: members.length,
                      })}
                    </span>
                    {!!children.get(department.id)?.length && (
                      <label className="flex items-center gap-1.5 text-foreground">
                        <input
                          type="checkbox"
                          checked={includeChildren}
                          onChange={(event) =>
                            setIncludeChildren(event.target.checked)
                          }
                        />
                        {t("people.orgChart.includeChildren")}
                      </label>
                    )}
                  </div>
                )}
              </header>
              <section
                ref={canvasRef}
                aria-label={t("people.orgChart.scrollableChartAria")}
                className="org-diagram px-3 py-5"
              >
                {department ? (
                  <ChartTree
                    roots={[department.id]}
                    childrenByParent={children}
                    expanded={chartExpanded}
                    renderCard={(id) => {
                      const item = byDepartment.get(id)!
                      const childCount = children.get(id)?.length ?? 0
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
                              title={managerNames(item)}
                            >
                              {t("people.orgChart.managerLabel", {
                                names:
                                  managerNames(item) ||
                                  t("people.orgChart.unset"),
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
                              onClick={() => toggleBranch(id, setChartExpanded)}
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
              </section>
              {department && (
                <section
                  aria-label={t("people.orgChart.selectedDeptAria")}
                  className="space-y-4 border-surface-border border-t bg-surface p-4"
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">
                        {t("people.orgChart.deptReportingTitle")}
                      </h3>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setView("members")
                          setReporting(true)
                          setPerson(null)
                        }}
                      >
                        {t("people.orgChart.deptReportingButton")}
                      </Button>
                    </div>
                    {departmentReports.get(null)?.length ? (
                      <div className="overflow-x-auto rounded-lg border border-surface-border bg-surface-muted/40 p-3">
                        <ChartTree
                          childrenByParent={departmentReports}
                          showConnectorTestId={false}
                          renderCard={(id) => (
                            <PersonCard
                              person={byPerson.get(id)!}
                              selected={false}
                              cycle={cycles.has(id)}
                              onSelect={() => {
                                setView("members")
                                setReporting(true)
                                setPerson(id)
                              }}
                            />
                          )}
                        />
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t("people.orgChart.noActiveMembers")}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">
                        {t("people.orgChart.deptMembersTitle", {
                          count: members.length,
                        })}
                      </h3>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setView("members")
                          setReporting(false)
                          setPerson(null)
                        }}
                      >
                        {t("people.orgChart.viewFullMembers")}
                      </Button>
                    </div>
                    {members.length ? (
                      <div className="overflow-x-auto rounded-lg border border-surface-border">
                        <Table className="[&_td]:h-10 [&_td]:px-3 [&_td]:py-1 [&_th]:px-3">
                          <TableHeader>
                            <TableRow>
                              <TableHead>
                                {t("people.orgChart.colMember")}
                              </TableHead>
                              <TableHead>
                                {t("people.orgChart.colDepartment")}
                              </TableHead>
                              <TableHead>
                                {t("people.orgChart.colManager")}
                              </TableHead>
                              <TableHead>
                                <span className="sr-only">
                                  {t("people.orgChart.colActions")}
                                </span>
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {members.slice(0, 20).map((item) => (
                              <TableRow key={item.id}>
                                <TableCell>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setView("members")
                                      setReporting(false)
                                      setPerson(item.id)
                                    }}
                                    className="block text-left font-medium hover:text-primary hover:underline"
                                  >
                                    {item.display_name}
                                    {item.title && (
                                      <span className="block text-xs font-normal text-muted-foreground">
                                        {item.title}
                                      </span>
                                    )}
                                  </button>
                                </TableCell>
                                <TableCell>
                                  {byDepartment.get(item.department_id ?? "")
                                    ?.name ?? "—"}
                                </TableCell>
                                <TableCell>
                                  {item.manager_id
                                    ? (byPerson.get(item.manager_id)
                                        ?.display_name ?? "—")
                                    : "—"}
                                </TableCell>
                                <TableCell>
                                  <Link
                                    className="text-xs text-primary hover:underline"
                                    to="/employees/$employeeId"
                                    params={{ employeeId: item.id }}
                                  >
                                    {t("people.orgChart.profileLink")}
                                  </Link>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t("people.orgChart.noActiveMembers")}
                      </p>
                    )}
                  </div>
                </section>
              )}
            </>
          ) : (
            <>
              <header className="flex flex-wrap items-center justify-between gap-2 border-surface-border border-b bg-surface px-3 py-2">
                <h2 className="min-w-0 font-semibold wrap-anywhere">
                  {person
                    ? t("people.orgChart.personHeader", {
                        name: person.display_name,
                      })
                    : (department?.name ??
                      t("people.orgChart.viewDepartmentMembers"))}
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {department && !person && (
                    <>
                      <span className="text-muted-foreground">
                        {t("people.orgChart.totalMembersCount", {
                          count: members.length,
                        })}
                      </span>
                      <label className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={includeChildren}
                          onChange={(event) =>
                            setIncludeChildren(event.target.checked)
                          }
                        />
                        {t("people.orgChart.includeChildren")}
                      </label>
                    </>
                  )}
                  {department && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (person) setPerson(null)
                        else setReporting(!reporting)
                      }}
                    >
                      {person
                        ? reporting
                          ? t("people.orgChart.backToReportingChart")
                          : t("people.orgChart.backToMembersTable")
                        : reporting
                          ? t("people.orgChart.backToMembersTable")
                          : t("people.orgChart.deptReportingButton")}
                    </Button>
                  )}
                </div>
              </header>
              {person || reporting ? (
                <section
                  ref={canvasRef}
                  aria-label={t("people.orgChart.scrollableReportingAria")}
                  className="org-diagram px-3 py-5"
                >
                  {reports.get(null)?.length ? (
                    <ChartTree
                      childrenByParent={reports}
                      renderCard={(id) => (
                        <PersonCard
                          person={byPerson.get(id)!}
                          selected={person?.id === id}
                          cycle={cycles.has(id)}
                          onSelect={() => setPerson(id)}
                        />
                      )}
                    />
                  ) : (
                    <p className="p-6 text-center text-sm text-muted-foreground">
                      {t("people.orgChart.noActiveMembers")}
                    </p>
                  )}
                </section>
              ) : members.length ? (
                <div className="bg-surface">
                  <Table className="[&_td]:h-11 [&_td]:px-3 [&_td]:py-1 [&_th]:px-3">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("people.orgChart.colMember")}</TableHead>
                        <TableHead>
                          {t("people.orgChart.colDepartment")}
                        </TableHead>
                        <TableHead>{t("people.orgChart.colManager")}</TableHead>
                        <TableHead>
                          <span className="sr-only">
                            {t("people.orgChart.colActions")}
                          </span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {members.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>
                            <button
                              type="button"
                              aria-label={t(
                                "people.orgChart.viewReportingAria",
                                { name: item.display_name },
                              )}
                              onClick={() => setPerson(item.id)}
                              className="block text-left font-medium hover:text-primary hover:underline"
                            >
                              {item.display_name}
                              {item.title && (
                                <span className="block text-xs font-normal text-muted-foreground">
                                  {item.title}
                                </span>
                              )}
                            </button>
                          </TableCell>
                          <TableCell>
                            {byDepartment.get(item.department_id ?? "")?.name ??
                              "—"}
                          </TableCell>
                          <TableCell>
                            {item.manager_id
                              ? (byPerson.get(item.manager_id)?.display_name ??
                                "—")
                              : "—"}
                            {cycles.has(item.id) && (
                              <span className="block text-xs text-destructive">
                                {t("people.orgChart.reportingCycle")}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Link
                              className="text-xs text-primary hover:underline"
                              aria-label={t("people.orgChart.viewProfileAria", {
                                name: item.display_name,
                              })}
                              to="/employees/$employeeId"
                              params={{ employeeId: item.id }}
                            >
                              {t("people.orgChart.profileLink")}
                            </Link>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {department
                    ? t("people.orgChart.noActiveMembers")
                    : t("people.orgChart.noVisibleDepts")}
                </p>
              )}
            </>
          )}
        </section>

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
                  [
                    t("people.orgChart.totalWithChildren"),
                    department.total_count,
                  ],
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
                  {managerNames(department) || t("people.orgChart.unset")}
                </p>
              </div>
              {!!children.get(department.id)?.length && (
                <div className="space-y-1.5 border-surface-border border-t pt-3">
                  <h3 className="text-xs text-muted-foreground">
                    {t("people.orgChart.subdeptsHeading")}
                  </h3>
                  <ul className="flex flex-wrap gap-1.5">
                    {children.get(department.id)?.map((id) => {
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
                    onMovedParent={(parentId) =>
                      setNavExpanded(
                        (previous) =>
                          new Set([
                            ...previous,
                            ...ancestors(parentId),
                            parentId,
                          ]),
                      )
                    }
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
      </div>
    </WorkspacePage>
  )
}

function DepartmentActions({
  actionsRef,
  orgId,
  department,
  departments,
  onMovedParent,
}: {
  actionsRef: Ref<HTMLFieldSetElement>
  orgId: string
  department: OrgChartDepartment
  departments: OrgChartDepartment[]
  onMovedParent?: (parentId: string) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [action, setAction] = useState<"rename" | "move" | "delete" | null>(
    null,
  )
  const actionLabels = {
    rename: t("people.orgChart.actions.rename"),
    move: t("people.orgChart.actions.move"),
    delete: t("people.orgChart.actions.delete"),
  } as const
  const [name, setName] = useState(department.name)
  const [parent, setParent] = useState(department.parent_department_id ?? "")
  const blocked = new Set([department.id])
  let changed = true
  while (changed) {
    changed = false
    for (const item of departments)
      if (
        item.parent_department_id &&
        blocked.has(item.parent_department_id) &&
        !blocked.has(item.id)
      ) {
        blocked.add(item.id)
        changed = true
      }
  }
  const pathLabel = (item: OrgChartDepartment): string => {
    const names = [item.name]
    const seen = new Set([item.id])
    let ancestor = departments.find((d) => d.id === item.parent_department_id)
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id)
      names.unshift(ancestor.name)
      ancestor = departments.find(
        (d) => d.id === ancestor?.parent_department_id,
      )
    }
    return names.join(" / ")
  }
  const save = useMutation({
    mutationFn: async () => {
      const path = { org_id: orgId, id: department.id }
      if (action === "delete") return OrgsService.deleteDepartment({ path })
      return OrgsService.updateDepartment({
        path,
        body:
          action === "rename"
            ? { name }
            : { parent_department_id: parent || null },
      })
    },
    onSuccess: () => {
      if (action === "move" && parent) onMovedParent?.(parent)
      client.invalidateQueries({ queryKey: ["org-chart", orgId] })
      client.invalidateQueries({ queryKey: ["departments", orgId] })
      client.invalidateQueries({ queryKey: ["department-capabilities", orgId] })
      client.invalidateQueries({ queryKey: ["profile", orgId] })
      setAction(null)
    },
  })
  return (
    <>
      <fieldset
        ref={actionsRef}
        className="flex flex-wrap gap-1 border-surface-border border-t pt-2"
        aria-label={t("people.orgChart.deptActionsAria", {
          name: department.name,
        })}
      >
        {(["rename", "move", "delete"] as const).map((key) => {
          const label = actionLabels[key]
          return (
            <Button
              key={key}
              variant="ghost"
              size="sm"
              aria-label={t("people.orgChart.actionButtonAria", {
                action: label,
                name: department.name,
              })}
              onClick={() => {
                save.reset()
                setName(department.name)
                setParent(department.parent_department_id ?? "")
                setAction(key)
              }}
            >
              {label}
            </Button>
          )
        })}
      </fieldset>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !save.isPending) setAction(null)
        }}
      >
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              save.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {action &&
                  t("people.orgChart.actionDialogTitle", {
                    action: actionLabels[action],
                    name: department.name,
                  })}
              </DialogTitle>
              <DialogDescription>
                {action === "delete"
                  ? t("people.orgChart.deleteDesc")
                  : action === "move"
                    ? t("people.orgChart.moveDesc")
                    : t("people.orgChart.renameDesc")}
              </DialogDescription>
            </DialogHeader>
            {action === "rename" && (
              <label
                className="block space-y-2"
                htmlFor={`department-name-${department.id}`}
              >
                <span>{t("people.orgChart.deptNameLabel")}</span>
                <Input
                  id={`department-name-${department.id}`}
                  value={name}
                  maxLength={100}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            {action === "move" && (
              <label className="block space-y-2">
                <span>{t("people.orgChart.parentDeptLabel")}</span>
                <select
                  className="w-full rounded-md border bg-background p-2"
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                >
                  <option value="">{t("people.orgChart.topLevelDept")}</option>
                  {departments
                    .filter((item) => !blocked.has(item.id))
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {pathLabel(item)}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <SetupError error={save.error} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={save.isPending}
                onClick={() => setAction(null)}
              >
                {t("people.orgChart.cancel")}
              </Button>
              <Button
                type="submit"
                variant={action === "delete" ? "destructive" : "default"}
                disabled={
                  save.isPending || (action === "rename" && !name.trim())
                }
              >
                {save.isPending
                  ? t("people.orgChart.saving")
                  : action === "delete"
                    ? t("people.orgChart.confirmDelete")
                    : t("people.orgChart.confirmSave")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

function PersonCard({
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

function ChartTree({
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
