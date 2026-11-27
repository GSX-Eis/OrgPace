import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { CapacityService, type ProjectImpactReason } from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DemandScheduleSummary, demandStatusLabel } from "./DemandSchedule"
import { detailAside, detailColumns } from "./PlanningWorkbench"
import {
  formatDateOptional,
  formatIsoDate,
  formatIsoDateRange,
  isCapacityAccessDenied,
} from "./shared"

const impactKeys: Record<ProjectImpactReason, string> = {
  partial: "capacity.projects.impacts.partial",
  not_now: "capacity.projects.impacts.not_now",
  late_commitment: "capacity.projects.impacts.late_commitment",
  dependency: "capacity.projects.impacts.dependency",
}

export function ProjectList({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ["capacity", orgId, "projects"],
    queryFn: async () =>
      (await CapacityService.listProjects({ path: { org_id: orgId } })).data,
  })
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  return (
    <SectionCard aria-label={t("capacity.projects.listAria")} className="p-0">
      {query.data.length ? (
        <ul className="divide-y divide-surface-border">
          {query.data.map((project) => (
            <li
              key={project.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm"
            >
              <Link
                to="/capacity"
                search={{ tab: "projects", project: project.id }}
                className="min-w-0 flex-1 break-words font-semibold hover:underline"
              >
                {project.title}
              </Link>
              <span className="text-muted-foreground">
                {project.requesting_department_name} ·{" "}
                {formatDateOptional(project.created_at)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {t("capacity.projects.empty")}
        </p>
      )}
    </SectionCard>
  )
}

export function Projects({
  orgId,
  projectId,
}: {
  orgId: string
  projectId: string
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ["capacity", orgId, "project", projectId],
    retry: (count, error) => !isCapacityAccessDenied(error) && count < 3,
    queryFn: async () =>
      (
        await CapacityService.getProject({
          path: { org_id: orgId, project_id: projectId },
        })
      ).data,
  })
  const project = query.data
  const statuses = new Map<string, number>()
  for (const role of project?.roles ?? []) {
    const status = demandStatusLabel(
      role.status,
      role.outcome,
      role.proposal_schedule,
    )
    statuses.set(status, (statuses.get(status) ?? 0) + 1)
  }
  return (
    <div className="space-y-5">
      <Button variant="outline" asChild>
        <Link to="/capacity" search={{ tab: "projects" }}>
          {t("capacity.projects.backBtn")}
        </Link>
      </Button>
      {query.isPending ? (
        <ProfileLoading />
      ) : query.isError ? (
        isCapacityAccessDenied(query.error) ? (
          <p role="status">{t("capacity.projects.notFound")}</p>
        ) : (
          <ProfileError retry={() => query.refetch()} />
        )
      ) : (
        project && (
          <section
            aria-label={t("capacity.projects.detailAria")}
            className={detailColumns}
          >
            <div className="min-w-0 space-y-3">
              <SectionCard className="space-y-2">
                <h2 className="break-words text-lg font-semibold">
                  {project.title}
                </h2>
                {project.description && (
                  <p className="whitespace-pre-wrap break-words">
                    {project.description}
                  </p>
                )}
                <ul
                  id="project-roles"
                  aria-label={t("capacity.projects.rolesAria")}
                  className="scroll-mt-16 divide-y border-t"
                >
                  {project.roles.map((role) => {
                    const schedule = role.proposal_schedule
                    const status = demandStatusLabel(
                      role.status,
                      role.outcome,
                      schedule,
                    )
                    return (
                      <li
                        key={role.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-3"
                      >
                        <div className="space-y-1">
                          <p className="font-medium">
                            {role.role_name} · {role.target_department_name}
                          </p>
                          <div className="text-sm text-muted-foreground">
                            <DemandScheduleSummary
                              demand={role}
                              status={status}
                            />
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{status}</Badge>
                          {role.demand && (
                            <Button asChild variant="outline" size="sm">
                              <Link
                                to="/capacity"
                                search={{ tab: "outgoing", demand: role.id }}
                              >
                                {t("capacity.projects.viewRoleDemand")}
                              </Link>
                            </Button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </SectionCard>
              <SectionCard
                aria-label={t("capacity.projects.stagesAria")}
                className="space-y-3"
              >
                <h3 className="font-semibold">
                  {t("capacity.projects.stagesTitle")}
                </h3>
                {project.schedule.stages.map((stage, index) => (
                  <div
                    key={stage[0].role.id}
                    className="overflow-x-auto rounded-lg border"
                  >
                    <table className="min-w-max w-full text-left text-sm">
                      <caption className="bg-muted/40 px-3 py-2 text-left font-medium">
                        {t("capacity.projects.stageCaption", {
                          index: index + 1,
                        })}
                      </caption>
                      <thead>
                        <tr className="border-b">
                          {[
                            t("capacity.projects.cols.roleAndDept"),
                            t("capacity.projects.cols.plannedPeriod"),
                            t("capacity.projects.cols.earliestStart"),
                            t("capacity.projects.cols.expectedPeriod"),
                          ].map((heading) => (
                            <th scope="col" className="px-3 py-2" key={heading}>
                              {heading}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {stage.map(
                          ({
                            role,
                            planned_start,
                            planned_end,
                            earliest_start,
                            forecast_start,
                            forecast_end,
                            forecast_unconfirmed,
                          }) => (
                            <tr key={role.id}>
                              <th scope="row" className="px-3 py-2 font-medium">
                                {role.role_name} · {role.target_department_name}
                              </th>
                              <td className="px-3 py-2">
                                {formatIsoDateRange(planned_start, planned_end)}
                              </td>
                              <td className="px-3 py-2">
                                {earliest_start
                                  ? formatIsoDate(earliest_start)
                                  : "—"}
                              </td>
                              <td className="px-3 py-2">
                                {forecast_unconfirmed
                                  ? t("capacity.projects.unconfirmed")
                                  : forecast_start && forecast_end
                                    ? formatIsoDateRange(
                                        forecast_start,
                                        forecast_end,
                                      )
                                    : t("capacity.projects.outOfRange")}
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                ))}
              </SectionCard>
              {project.schedule.impacts.length > 0 && (
                <SectionCard
                  aria-label={t("capacity.projects.impactsAria")}
                  className="space-y-3 border-amber-500/30 text-sm"
                >
                  <h3 className="font-semibold">
                    {t("capacity.projects.impactsTitle")}
                  </h3>
                  <p>
                    {project.schedule.forecast_unconfirmed
                      ? t("capacity.projects.impactUnconfirmed")
                      : t("capacity.projects.impactDelay", {
                          days: project.schedule.delay_days,
                        })}
                  </p>
                  <ul className="space-y-3">
                    {project.schedule.impacts.map(
                      ({ role, reasons, downstream }) => (
                        <li
                          className="border-l-2 border-current/20 pl-3"
                          key={role.id}
                        >
                          <p className="font-medium">
                            {role.role_name} · {role.target_department_name}
                          </p>
                          <p>
                            {reasons
                              .map((reason) => t(impactKeys[reason]))
                              .join(t("capacity.common.semicolonSeparator"))}
                          </p>
                          {downstream.length > 0 && (
                            <p className="text-sm text-muted-foreground">
                              {t("capacity.projects.downstreamAffected", {
                                roles: downstream
                                  .map((item) =>
                                    t("capacity.projects.downstreamRoleItem", {
                                      role: item.role_name,
                                      dept: item.target_department_name,
                                    }),
                                  )
                                  .join(t("capacity.common.listSeparator")),
                              })}
                            </p>
                          )}
                        </li>
                      ),
                    )}
                  </ul>
                </SectionCard>
              )}
            </div>
            <aside
              aria-label={t("capacity.projects.propertiesAria")}
              className={detailAside}
            >
              <SectionCard className="space-y-3 text-sm">
                <h3 className="font-semibold">
                  {t("capacity.projects.propertiesTitle")}
                </h3>
                <p>
                  {t("capacity.projects.requester", {
                    dept: project.requesting_department_name,
                  })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("capacity.projects.expectedWindowLine", {
                    finish: project.schedule.forecast_unconfirmed
                      ? t("capacity.projects.unconfirmed")
                      : project.schedule.forecast_end
                        ? formatIsoDate(project.schedule.forecast_end)
                        : t("capacity.projects.outOfRange"),
                    windowEnd: formatIsoDate(project.schedule.window_end),
                  })}
                </p>
                <div className="flex flex-wrap gap-1">
                  {Array.from(statuses, ([status, count]) => (
                    <Badge key={status} variant="secondary">
                      {status} {count}
                    </Badge>
                  ))}
                </div>
                <Button size="sm" variant="outline" asChild>
                  <a href="#project-roles">
                    {t("capacity.projects.viewRolesBtn")}
                  </a>
                </Button>
              </SectionCard>
            </aside>
          </section>
        )
      )}
    </div>
  )
}
