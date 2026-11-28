import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { type OrgChartPerson, type OrgChartPublic, OrgsService } from "@/client"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { WorkspacePage } from "@/components/Common/WorkbenchPrimitives"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useOrg } from "@/hooks/useOrg"
import { ChartTree, PersonCard } from "./ChartTree"
import { DepartmentDetail } from "./DepartmentDetail"
import { DepartmentNav } from "./DepartmentNav"
import { DepartmentTree } from "./DepartmentTree"
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
  const firstDepartment = useMemo(
    () =>
      departments.find((item) => !item.parent_department_id) ?? departments[0],
    [departments],
  )
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
  const byDepartment = useMemo(
    () => new Map(departments.map((item) => [item.id, item])),
    [departments],
  )
  const department =
    (selectedDepartment ? byDepartment.get(selectedDepartment) : undefined) ??
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

  const byPerson = useMemo(
    () => new Map(people.map((item) => [item.id, item])),
    [people],
  )
  const person = selectedPerson ? byPerson.get(selectedPerson) : undefined
  const children = useMemo(
    () => groupByParent(departments, (item) => item.parent_department_id),
    [departments],
  )
  const colors = useMemo(() => {
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

    return colors
  }, [children])
  const managerNames = useMemo(
    () =>
      new Map(
        departments.map((item) => [
          item.id,
          item.managers
            ?.map((manager) => manager.display_name)
            .join(t("people.orgChart.nameSeparator")),
        ]),
      ),
    [departments, t],
  )
  const ancestors = useCallback(
    (id: string) => {
      const ids: string[] = []
      let parent = byDepartment.get(id)?.parent_department_id
      while (parent) {
        ids.push(parent)
        parent = byDepartment.get(parent)?.parent_department_id
      }
      return ids
    },
    [byDepartment],
  )
  const term = search.trim().toLocaleLowerCase()
  const matches = useMemo(() => {
    const matches = new Set<string>()
    for (const item of departments) {
      if (
        `${item.name} ${managerNames.get(item.id) ?? ""}`
          .toLocaleLowerCase()
          .includes(term)
      ) {
        matches.add(item.id)
        if (term) for (const id of ancestors(item.id)) matches.add(id)
      }
    }
    return matches
  }, [departments, managerNames, term, ancestors])
  const members = useMemo(
    () =>
      people.filter(
        (item) =>
          item.department_id &&
          department &&
          (item.department_id === department.id ||
            (includeChildren &&
              ancestors(item.department_id).includes(department.id))),
      ),
    [people, department, includeChildren, ancestors],
  )
  const cycles = useMemo(() => reportingCycles(people), [people])
  const departmentReports = useMemo(() => {
    const memberIds = new Set(members.map((item) => item.id))
    const departmentReports = groupByParent(members, (item) =>
      !cycles.has(item.id) && item.manager_id && memberIds.has(item.manager_id)
        ? item.manager_id
        : null,
    )
    return departmentReports
  }, [members, cycles])
  const reports = useMemo(() => {
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
              (item) =>
                item.manager_id === person.id && !chain.includes(item.id),
            )
            .map((item) => item.id),
        )
      } else {
        reports = departmentReports
      }
    }

    return reports
  }, [view, person, reporting, byPerson, people, departmentReports])

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
        <DepartmentNav
          childrenByParent={children}
          matches={matches}
          byDepartment={byDepartment}
          departmentId={department?.id}
          colors={colors}
          term={term}
          navExpanded={navExpanded}
          search={search}
          onSearch={setSearch}
          onToggle={(id) => toggleBranch(id, setNavExpanded)}
          selectDepartment={selectDepartment}
          departmentCount={departments.length}
        />

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
                <DepartmentTree
                  department={department}
                  childrenByParent={children}
                  chartExpanded={chartExpanded}
                  byDepartment={byDepartment}
                  colors={colors}
                  managerNames={managerNames}
                  selectDepartment={selectDepartment}
                  onToggle={(id) => toggleBranch(id, setChartExpanded)}
                />
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

        <DepartmentDetail
          department={department}
          colors={colors}
          childrenByParent={children}
          byDepartment={byDepartment}
          managerNames={managerNames}
          selectDepartment={selectDepartment}
          canEdit={canEdit}
          actionsRef={actionsRef}
          orgId={orgId}
          departments={departments}
          onMovedParent={(parentId) =>
            setNavExpanded(
              (previous) =>
                new Set([...previous, ...ancestors(parentId), parentId]),
            )
          }
        />
      </div>
    </WorkspacePage>
  )
}
