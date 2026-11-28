import { useIsMutating } from "@tanstack/react-query"
import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { FolderOpen, FolderPlus, Plus } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useTranslation } from "react-i18next"
import { tabSearch } from "@/components/Admin/AdminTabs"
import {
  DemandList,
  IncomingDemands,
  OutgoingDemands,
} from "@/components/Capacity/Demands"
import { DemandsCreate } from "@/components/Capacity/DemandsCreate"
import { MyWorkload } from "@/components/Capacity/MyWorkload"
import {
  type PlanningView,
  PlanningViewToggle,
} from "@/components/Capacity/PlanningWorkbench"
import { ProjectCreate } from "@/components/Capacity/ProjectCreate"
import { ProjectList, Projects } from "@/components/Capacity/ProjectDetail"
import { capacityKeys } from "@/components/Capacity/queries"
import {
  useCapacityDisabled,
  useCapacitySettings,
} from "@/components/Capacity/shared"
import { TeamWorkload } from "@/components/Capacity/TeamWorkload"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { SideDrawer } from "@/components/Common/WorkbenchPrimitives"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"

export const Route = createFileRoute("/_layout/capacity")({
  component: CapacityPage,
  validateSearch: (search: Record<string, unknown>) => ({
    ...tabSearch(search),
    ...(typeof search.demand === "string" ? { demand: search.demand } : {}),
    ...(typeof search.project === "string" ? { project: search.project } : {}),
    ...(search.plans === "1" || search.plans === 1
      ? { plans: 1 as const }
      : {}),
  }),
  beforeLoad: ({ search }) => {
    const { tab, demand } = search
    if (tab === "assignments")
      throw redirect({
        to: "/capacity",
        search: { tab: "mine" },
        replace: true,
      })
    if (tab === "approvals" || (tab === "incoming" && !demand))
      throw redirect({
        to: "/reviews",
        search: { type: tab === "approvals" ? "workload" : "demand" },
        replace: true,
      })
  },
  head: () => ({ meta: [{ title: i18n.t("capacity.pageTitle") }] }),
})

function CapacityPage() {
  const { t } = useTranslation()
  const { org, roles, employeeId } = useOrg()
  const settings = useCapacitySettings(org?.id)
  const disabled = useCapacityDisabled(org?.id)
  if (!org) return <OrgState />
  if (disabled || settings.data?.enabled === false)
    return <p role="status">{t("capacity.disabled")}</p>
  if (settings.isPending) return <ProfileLoading />
  if (settings.isError) return <ProfileError retry={() => settings.refetch()} />
  const manages = roles.includes("org_admin") || roles.includes("dept_manager")
  const canRequest =
    manages || (!!employeeId && settings.data.requester_policy === "everyone")
  return (
    <CapacityWorkspace
      key={org.id}
      orgId={org.id}
      manages={manages}
      hasEmployee={!!employeeId}
      canRequest={canRequest}
    />
  )
}

function CapacityWorkspace({
  orgId,
  manages,
  hasEmployee,
  canRequest,
}: {
  orgId: string
  manages: boolean
  hasEmployee: boolean
  canRequest: boolean
}) {
  const { t } = useTranslation()
  const { tab, demand, plans, project } = Route.useSearch()
  const [display, setDisplay] = useState<PlanningView>("board")
  const workbench = tab === "outgoing" || tab === "projects"
  const requestActions = (
    <>
      {!workbench && (
        <Button asChild size="icon-sm" variant="ghost">
          <Link
            to="/capacity"
            search={{ tab: "outgoing" }}
            aria-label={t("capacity.nav.demandsAndProjects")}
          >
            <FolderOpen aria-hidden="true" />
          </Link>
        </Button>
      )}
      {canRequest && tab !== "incoming" && (
        <>
          <CreateDrawer orgId={orgId} kind="outgoing" />
          <CreateDrawer orgId={orgId} kind="projects" />
        </>
      )}
    </>
  )
  let title = t("capacity.titles.plan")
  let isTeamView = false
  let view: ReactNode
  let actions: ReactNode = (
    <TopbarActions>
      {tab === "outgoing" && !demand && (
        <PlanningViewToggle view={display} onChange={setDisplay} />
      )}
      {requestActions}
    </TopbarActions>
  )
  if (manages && tab === "incoming" && demand) {
    title = t("capacity.titles.demand")
    view = (
      <IncomingDemands orgId={orgId} demand={demand} plansOpen={plans === 1} />
    )
  } else if (tab === "outgoing" && demand) {
    title = t("capacity.titles.demand")
    view = <OutgoingDemands orgId={orgId} demand={demand} />
  } else if (tab === "projects" && project) {
    title = t("capacity.titles.project")
    view = <Projects orgId={orgId} projectId={project} />
  } else if (tab === "outgoing" || tab === "projects") {
    title =
      tab === "projects"
        ? t("capacity.titles.project")
        : t("capacity.titles.demand")
    view =
      tab === "projects" ? (
        <ProjectList orgId={orgId} />
      ) : (
        <DemandList orgId={orgId} view={display} canRequest={canRequest} />
      )
  } else if (tab === "borrows") {
    title = t("capacity.titles.borrows")
    view = (
      <section
        aria-label={t("capacity.borrowsDisabled.aria")}
        className="space-y-3 rounded-xl border border-surface-border bg-surface p-6 text-sm"
      >
        <h2 className="text-base font-semibold">
          {t("capacity.borrowsDisabled.heading")}
        </h2>
        <p className="text-muted-foreground">
          {t("capacity.borrowsDisabled.description")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" asChild>
            <Link to="/capacity" search={{ tab: manages ? "team" : "mine" }}>
              {manages
                ? t("capacity.borrowsDisabled.backToTeam")
                : t("capacity.borrowsDisabled.backToMine")}
            </Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to="/capacity" search={{ tab: "outgoing" }}>
              {t("capacity.borrowsDisabled.viewOutgoing")}
            </Link>
          </Button>
        </div>
      </section>
    )
  } else if (manages && (tab === "team" || !hasEmployee)) {
    title = t("capacity.titles.team")
    isTeamView = true
    view = <TeamWorkload orgId={orgId} />
    actions = <TopbarActions>{requestActions}</TopbarActions>
  } else if (hasEmployee) {
    title = t("capacity.titles.mine")
    view = <MyWorkload orgId={orgId} actions={requestActions} />
    actions = null
  }
  return (
    <div data-workspace-page={isTeamView ? "" : undefined} className="min-w-0">
      <h1 className="sr-only">{title}</h1>
      {actions}
      {workbench && !demand && !project && (
        <nav
          aria-label={t("capacity.nav.workbenchAria")}
          className="mb-3 flex flex-wrap items-center gap-1"
        >
          {(
            [
              ["outgoing", t("capacity.nav.outgoing")],
              ["projects", t("capacity.nav.projects")],
            ] as const
          ).map(([target, label]) => (
            <Button
              key={target}
              size="sm"
              variant={tab === target ? "secondary" : "ghost"}
              asChild
            >
              <Link to="/capacity" search={{ tab: target }}>
                {label}
              </Link>
            </Button>
          ))}
          <Button size="sm" variant="link" asChild>
            <Link to="/assistant">{t("capacity.nav.toAssistant")}</Link>
          </Button>
        </nav>
      )}
      {view}
    </div>
  )
}

function CreateDrawer({
  orgId,
  kind,
}: {
  orgId: string
  kind: "outgoing" | "projects"
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const navigate = Route.useNavigate()
  const saving =
    useIsMutating({ mutationKey: capacityKeys.createMutation(orgId, kind) }) > 0
  const isProject = kind === "projects"
  const Form = isProject ? ProjectCreate : DemandsCreate
  const Icon = isProject ? FolderPlus : Plus
  return (
    <SideDrawer
      title={
        isProject
          ? t("capacity.createDrawer.projectTitle")
          : t("capacity.createDrawer.demandTitle")
      }
      open={open}
      onOpenChange={(open) => {
        if (!saving) setOpen(open)
      }}
      className="sm:max-w-lg"
      trigger={
        <Button size="sm" variant={isProject ? "outline" : "default"}>
          <Icon aria-hidden="true" />
          <span className="sr-only lg:not-sr-only">
            {isProject
              ? t("capacity.createDrawer.projectTrigger")
              : t("capacity.createDrawer.demandTrigger")}
          </span>
        </Button>
      }
    >
      <Form
        orgId={orgId}
        back={() => setOpen(false)}
        created={(id) => {
          setOpen(false)
          void navigate({
            search: isProject
              ? { tab: kind, project: id }
              : { tab: kind, demand: id },
          })
        }}
      />
    </SideDrawer>
  )
}
