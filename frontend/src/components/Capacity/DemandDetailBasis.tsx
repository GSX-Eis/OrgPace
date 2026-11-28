import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { CapacityService, type DemandPublic } from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { StatusBadge } from "@/components/Profile/StatusBadge"
import { addWeeks } from "./dateUtils"
import { capacityKeys } from "./queries"
import {
  formatCapacityPercent,
  isCapacityAccessDenied,
  WorkloadBand,
  weekLoadLabel,
} from "./shared"

export function DemandsBasis({
  orgId,
  demand,
}: {
  orgId: string
  demand: DemandPublic
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: capacityKeys.demandBasis(orgId, demand.id),
    queryFn: async () =>
      (
        await CapacityService.getDemandBasis({
          path: { org_id: orgId, demand_id: demand.id },
        })
      ).data,
  })
  return (
    <SectionCard
      aria-label={t("capacity.demandDetail.basisAria")}
      className="space-y-3"
    >
      <h3 className="font-semibold">{t("capacity.demandDetail.basisTitle")}</h3>
      {query.isPending ? (
        <ProfileLoading />
      ) : query.isError ? (
        isCapacityAccessDenied(query.error) ? (
          <p role="status">{t("capacity.demandDetail.noPermission")}</p>
        ) : (
          <ProfileError retry={() => query.refetch()} />
        )
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t("capacity.demandDetail.matchedCount", {
              count: query.data.count,
            })}
            {demand.allocation_percent != null
              ? t("capacity.demandDetail.demandAllocation", {
                  percent: formatCapacityPercent(demand.allocation_percent),
                })
              : ""}
          </p>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/30">
                <tr>
                  {[
                    t("capacity.demandDetail.cols.candidate"),
                    t("capacity.demandDetail.cols.capabilityCheck"),
                    t("capacity.demandDetail.cols.jiraRef"),
                    t("capacity.demandDetail.cols.confirmedLoad"),
                    t("capacity.demandDetail.cols.weeklyLoad"),
                  ].map((label) => (
                    <th key={label} className="whitespace-nowrap px-3 py-2">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((person) => {
                  const weeks = person.workload.weeks.filter(
                    ({ week_start }) =>
                      week_start <= demand.window_end &&
                      addWeeks(week_start, 1) > demand.window_start,
                  )
                  return (
                    <tr key={person.employee_id} className="border-t">
                      <th scope="row" className="whitespace-nowrap px-3 py-2">
                        {person.display_name}
                      </th>
                      <td className="px-3 py-2">
                        {t("capacity.demandDetail.evidenceCount", {
                          level:
                            person.level_name ??
                            t("capacity.demandDetail.unleveled"),
                          count: person.evidence_count,
                        })}
                        <StatusBadge
                          kind="assessment_status"
                          value={person.status}
                        />
                      </td>
                      <td className="px-3 py-2">
                        {person.workload.jira_task_count === null
                          ? t("capacity.demandDetail.jiraNone")
                          : t("capacity.demandDetail.jiraIncomplete", {
                              count: person.workload.jira_task_count,
                            })}
                      </td>
                      <td className="px-3 py-2">
                        {person.workload.confirmed_percent === null
                          ? t("capacity.demandDetail.unconfirmed")
                          : formatCapacityPercent(
                              person.workload.confirmed_percent,
                            )}
                        <WorkloadBand band={person.workload.band} />
                      </td>
                      <td className="px-3 py-2">
                        {weeks.length ? (
                          <details>
                            <summary className="cursor-pointer whitespace-nowrap">
                              {t("capacity.demandDetail.weeksRatio", {
                                count: weeks.length,
                              })}
                            </summary>
                            {weeks.map((week) => (
                              <p
                                key={week.week_start}
                                className="whitespace-nowrap"
                              >
                                {week.week_start} · {weekLoadLabel(week)}
                              </p>
                            ))}
                          </details>
                        ) : (
                          <span className="whitespace-nowrap text-muted-foreground">
                            {t("capacity.demandDetail.noPeriodData")}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  )
}
