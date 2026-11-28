import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapabilitiesService,
  CapacityService,
  type DemandPublic,
} from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DemandAssignments } from "./DemandAssignments"
import { DemandsAction } from "./DemandDetailAction"
import { DemandsBasis } from "./DemandDetailBasis"
import { DecisionHistory } from "./DemandDetailHistory"
import { ProposalPanel } from "./DemandDetailProposal"
import {
  eventKeys,
  hasPublicEventText,
  outcomeKeys,
} from "./DemandDetailShared"
import { capabilityLevels } from "./DemandFields"
import { demandStatusLabel, latestDemandReply } from "./DemandSchedule"
import { DemandsReference } from "./DemandsReference"
import {
  detailAside,
  detailColumns,
  shortRequestNumber,
} from "./PlanningWorkbench"
import { Plans, type SelectedPlanReply } from "./Plans"
import { capacityKeys, useCapacityDepartments } from "./queries"
import {
  formatDateOptional,
  formatIsoDate,
  formatIsoDateRange,
  isCapacityAccessDenied,
} from "./shared"

export function DemandsDetail({
  orgId,
  demandId,
  side,
  back,
  plansOpen = false,
  riskMessage,
}: {
  orgId: string
  demandId: string
  side: "outgoing" | "incoming"
  back: () => void
  plansOpen?: boolean
  riskMessage?: string | null
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [now, setNow] = useState(Date.now)
  const [selected, setSelected] = useState<SelectedPlanReply | null>(null)
  const query = useQuery({
    queryKey: capacityKeys.demand(orgId, demandId),
    retry: (count, error) => !isCapacityAccessDenied(error) && count < 3,
    queryFn: async () =>
      (
        await CapacityService.getDemand({
          path: { org_id: orgId, demand_id: demandId },
        })
      ).data,
  })
  const catalog = useQuery({
    queryKey: ["capabilities", orgId],
    enabled: !!query.data?.minimum_level && !query.isError,
    queryFn: async () =>
      (await CapabilitiesService.readCapabilities({ path: { org_id: orgId } }))
        .data,
  })
  const capability = catalog.data?.data.find(
    (item) => item.key === query.data?.capability_key,
  )
  const level = capabilityLevels(capability?.level_rubric).find(
    (level) => level.key === query.data?.minimum_level,
  )?.label
  const minimumLevel =
    typeof level === "string"
      ? level
      : query.data?.minimum_level
        ? catalog.isPending
          ? t("capacity.demandDetail.loadingLevel")
          : t("capacity.demandDetail.levelUnavailable")
        : undefined
  const prerequisites = query.data?.project?.prerequisites ?? []
  const internal = side === "incoming" && !!query.data?.basis_url
  const latestReply = query.data && latestDemandReply(query.data)
  const legacy =
    query.data?.status === "replied" &&
    !query.data?.proposal_schedule &&
    !!latestReply &&
    latestReply.outcome !== "not_now"
  const status =
    query.data &&
    demandStatusLabel(
      query.data.status,
      latestReply?.outcome,
      query.data.proposal_schedule,
      now,
    )
  const openPlans = async (open: boolean) => {
    await navigate({
      to: "/capacity",
      resetScroll: false,
      search: {
        tab: "incoming",
        demand: demandId,
        plans: open ? 1 : undefined,
      },
    })
    if (open) document.getElementById("capacity-plans")?.scrollIntoView()
  }
  const change =
    side === "incoming" &&
    query.data?.status === "accepted" &&
    query.data.proposal?.status !== "pending" &&
    (query.data.proposal?.kind === "change" ||
      query.data.proposal?.status === "committed")
  return (
    <div className="space-y-5">
      <Button variant="outline" onClick={back}>
        {side === "incoming"
          ? t("capacity.demandDetail.backToApprovals")
          : t("capacity.demandDetail.backToDemands")}
      </Button>
      {query.isPending ? (
        <ProfileLoading />
      ) : query.isError ? (
        isCapacityAccessDenied(query.error) ? (
          <p role="status" className="rounded-xl border bg-muted/30 p-5">
            {t("capacity.demandDetail.accessDenied")}
          </p>
        ) : (
          <ProfileError retry={() => query.refetch()} />
        )
      ) : (
        <section
          aria-label={t("capacity.demandDetail.detailAria")}
          className={detailColumns}
        >
          <div className="min-w-0 space-y-3">
            <SectionCard className="space-y-2">
              <p
                className="font-mono text-xs text-muted-foreground"
                title={demandId}
              >
                {shortRequestNumber(demandId)}
              </p>
              <h2 className="break-words text-lg font-semibold">
                {query.data.capability_name}
              </h2>
              <p className="whitespace-pre-wrap break-words text-sm">
                {query.data.description}
              </p>
              <Button
                size="sm"
                variant="link"
                className="px-0 xl:hidden"
                onClick={() =>
                  document.getElementById("demand-properties")?.scrollIntoView()
                }
              >
                {t("capacity.demandDetail.jumpToProperties")}
              </Button>
            </SectionCard>
            {riskMessage && (
              <p
                role="status"
                className="wrap-anywhere rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
              >
                {riskMessage}
              </p>
            )}
            {side === "incoming" && !query.data.basis_url && (
              <DemandPlanAccess orgId={orgId} demand={query.data} />
            )}
            {legacy && side === "outgoing" && (
              <p
                role="status"
                className="rounded-md border bg-muted/30 p-3 text-sm"
              >
                {t("capacity.demandDetail.legacyOutgoingNotice")}
              </p>
            )}
            {side === "incoming" &&
              query.data.basis_url &&
              (query.data.can_reply || change || plansOpen) && (
                <SectionCard className="space-y-3">
                  {legacy && query.data.can_reply && (
                    <p>{t("capacity.demandDetail.legacyIncomingNotice")}</p>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => void openPlans(!plansOpen)}
                  >
                    {plansOpen
                      ? t("capacity.demandDetail.closePlans")
                      : change
                        ? t("capacity.demandDetail.proposeChange")
                        : t("capacity.demandDetail.managePlans")}
                  </Button>
                </SectionCard>
              )}
            {side === "incoming" && query.data.basis_url && (
              <DemandsBasis orgId={orgId} demand={query.data} />
            )}
            {side === "incoming" && query.data.basis_url && plansOpen && (
              <SectionCard
                id="capacity-plans"
                aria-label={t("capacity.demandDetail.plansAria")}
                className="scroll-mt-20 space-y-3"
              >
                <Plans
                  change={change}
                  orgId={orgId}
                  demandId={demandId}
                  onReply={
                    query.data.can_reply || change
                      ? (reply) => {
                          setSelected(reply)
                          requestAnimationFrame(() =>
                            document
                              .getElementById("demand-reply")
                              ?.scrollIntoView({ behavior: "smooth" }),
                          )
                        }
                      : undefined
                  }
                />
              </SectionCard>
            )}
            {side === "incoming" &&
              query.data.basis_url &&
              query.data.status === "accepted" && (
                <DemandAssignments
                  orgId={orgId}
                  demand={query.data}
                  canProposeChange={change}
                />
              )}
            <SectionCard
              aria-label={t("capacity.demandDetail.timelineAria")}
              className="space-y-3 text-sm"
            >
              <h3 className="font-semibold">
                {t("capacity.demandDetail.timelineTitle")}
              </h3>
              {(query.data.events ?? []).map((event, index) => (
                <article
                  key={index}
                  className="space-y-1 border-surface-border border-l-2 pl-3"
                >
                  <p className="font-medium">
                    {event.kind === "commitment_changed" && event.start_date
                      ? t("capacity.demandDetail.arrangementChanged")
                      : t(eventKeys[event.kind])}{" "}
                    · {formatDateOptional(event.created_at)}
                    {event.kind === "replied" &&
                      t("capacity.demandDetail.repliedBy", {
                        name: internal
                          ? (event.responder_name ??
                            t("capacity.demandDetail.defaultResponder"))
                          : t("capacity.demandDetail.defaultResponder"),
                      })}
                  </p>
                  {event.outcome && (
                    <p>
                      {t("capacity.demandDetail.outcomeLine", {
                        outcome: t(outcomeKeys[event.outcome]),
                      })}
                    </p>
                  )}
                  {event.kind === "commitment_changed" &&
                  event.previous_end_date !== event.end_date ? (
                    <p>
                      {t("capacity.demandDetail.commitmentChangedLine", {
                        prev: event.previous_end_date
                          ? formatIsoDate(event.previous_end_date)
                          : "",
                        next: event.end_date
                          ? formatIsoDate(event.end_date)
                          : "",
                      })}
                    </p>
                  ) : (
                    (event.start_date || event.end_date) && (
                      <p>
                        {t("capacity.demandDetail.earliestAndCommitted", {
                          earliest: event.start_date
                            ? formatIsoDate(event.start_date)
                            : t("capacity.common.tbd"),
                          committed: event.end_date
                            ? formatIsoDate(event.end_date)
                            : t("capacity.common.tbd"),
                        })}
                      </p>
                    )
                  )}
                  {event.text &&
                    (internal || hasPublicEventText(event.kind)) && (
                      <p className="whitespace-pre-wrap break-words">
                        {event.text}
                      </p>
                    )}
                  {internal && event.basis && (
                    <div className="rounded-lg bg-muted/30 p-3">
                      <p className="text-sm font-medium">
                        {t("capacity.demandDetail.basisHeading")}
                      </p>
                      <DemandsReference reference={event.basis} />
                    </div>
                  )}
                </article>
              ))}
            </SectionCard>
            <DecisionHistory orgId={orgId} demandId={demandId} side={side} />
          </div>
          <aside
            aria-label={t("capacity.demandDetail.propertiesAria")}
            id="demand-properties"
            className={`${detailAside} scroll-mt-16`}
          >
            <SectionCard className="space-y-3 break-words text-sm">
              <h3 className="font-semibold">
                {t("capacity.demandDetail.propertiesTitle")}
              </h3>
              <dl className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">
                    {t("capacity.demandDetail.currentStatus")}
                  </dt>
                  <dd>
                    <Badge variant="secondary">{status}</Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t("capacity.demandDetail.period")}
                  </dt>
                  <dd>
                    {formatIsoDateRange(
                      query.data.window_start,
                      query.data.window_end,
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t("capacity.demandDetail.capabilities")}
                  </dt>
                  <dd>
                    <ul className="space-y-1">
                      <li>
                        {query.data.capability_name} ·{" "}
                        {t("capacity.demandDetail.required")}
                        {minimumLevel && ` · ${minimumLevel}`}
                      </li>
                      {(query.data.extra_capabilities ?? []).map((extra) => {
                        const minimum =
                          extra.minimum_level_label ?? extra.minimum_level
                        return (
                          <li key={extra.key}>
                            {extra.capability_name} ·{" "}
                            {extra.required
                              ? t("capacity.demandDetail.required")
                              : t("capacity.demandDetail.optional")}
                            {minimum && ` · ${minimum}`}
                          </li>
                        )
                      })}
                    </ul>
                  </dd>
                </div>
              </dl>
              {query.data.project && (
                <div className="space-y-2 border-surface-border border-y py-2">
                  <p>
                    {t("capacity.demandDetail.project")}
                    <Link
                      className="font-medium underline underline-offset-4"
                      to="/capacity"
                      search={{
                        tab: "projects",
                        project: query.data.project.id,
                      }}
                    >
                      {query.data.project.title}
                    </Link>
                  </p>
                  <p>
                    {t("capacity.demandDetail.role", {
                      name: query.data.project.role_name,
                    })}
                  </p>
                  {prerequisites.length > 0 && (
                    <ul
                      aria-label={t("capacity.demandDetail.prerequisitesAria")}
                      className="space-y-1"
                    >
                      {prerequisites.map((role) => (
                        <li key={role.id}>
                          {t("capacity.demandDetail.prerequisiteItem", {
                            role: role.role_name,
                            dept: role.target_department_name,
                            status:
                              role.status === "replied" &&
                              !role.proposal_schedule
                                ? t("capacity.demandDetail.repliedStatus")
                                : demandStatusLabel(
                                    role.status,
                                    undefined,
                                    role.proposal_schedule,
                                  ),
                            range: formatIsoDateRange(
                              role.committed_start_date ?? role.window_start,
                              role.committed_end_date ?? role.window_end,
                            ),
                          })}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {query.data.status === "accepted" &&
                query.data.committed_end_date && (
                  <p>
                    {t("capacity.demandDetail.effectiveSchedule", {
                      range: query.data.committed_start_date
                        ? formatIsoDateRange(
                            query.data.committed_start_date,
                            query.data.committed_end_date,
                          )
                        : `${t("capacity.demandDetail.effectiveScheduleTbd")} – ${formatIsoDate(query.data.committed_end_date)}`,
                    })}
                  </p>
                )}
              {side === "incoming" &&
                query.data.basis_url &&
                query.data.status === "accepted" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      document
                        .getElementById("demand-assignments")
                        ?.scrollIntoView()
                    }
                  >
                    {t("capacity.demandDetail.viewAssignmentsBtn")}
                  </Button>
                )}
            </SectionCard>
            {query.data.proposal && (side === "outgoing" || internal) && (
              <ProposalPanel
                orgId={orgId}
                demand={query.data}
                side={side}
                now={now}
                setNow={setNow}
                replan={() => {
                  setSelected(null)
                  void openPlans(true)
                }}
              />
            )}
            {(side === "outgoing" || query.data.basis_url) && (
              <DemandsAction
                key={`${query.data.revision}:${selected?.option_id ?? ""}`}
                orgId={orgId}
                demand={query.data}
                side={side}
                selected={selected}
                change={change}
                clearSelection={() => setSelected(null)}
                onConfirmed={async (result) => {
                  setSelected(null)
                  if (result.status !== "accepted") return
                  await openPlans(false)
                  requestAnimationFrame(() =>
                    document
                      .getElementById("demand-assignments")
                      ?.scrollIntoView(),
                  )
                }}
              />
            )}
          </aside>
        </section>
      )}
    </div>
  )
}

function DemandPlanAccess({
  orgId,
  demand,
}: {
  orgId: string
  demand: DemandPublic
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const departments = useCapacityDepartments(orgId)
  const name =
    departments.data?.find((row) => row.id === demand.target_department_id)
      ?.name ?? t("capacity.demandDetail.targetDeptFallback")
  return (
    <section
      aria-label={t("capacity.demandDetail.planAccessAria")}
      className="space-y-3 rounded-xl border bg-muted/30 p-5"
    >
      <p>{t("capacity.demandDetail.planAccessNotice", { dept: name })}</p>
      <Button
        variant="outline"
        onClick={() =>
          navigate({
            to: "/capacity",
            search: { tab: "outgoing", demand: demand.id },
          })
        }
      >
        {t("capacity.demandDetail.goToOutgoingBtn")}
      </Button>
    </section>
  )
}
