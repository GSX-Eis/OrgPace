import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { AxiosError } from "axios"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapabilitiesService,
  CapacityService,
  type CommitmentArrangement,
  type DemandEventKind,
  type DemandOutcome,
  type DemandPublic,
  type PlanReplyInput,
  type ProposalLinePublic,
  type RespondInput,
} from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { StatusBadge } from "@/components/Profile/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import i18n from "@/i18n"
import { CapacityError } from "./AssignmentFields"
import {
  type RejectionReason,
  RejectionReasonSelect,
  rejectionReasonLabel,
} from "./BorrowRequests"
import { DemandAssignments } from "./DemandAssignments"
import { capabilityLevels } from "./DemandFields"
import {
  demandStatusLabel,
  holdDeadline,
  latestDemandReply,
  SchedulePhases,
} from "./DemandSchedule"
import { DemandsReference } from "./DemandsReference"
import {
  detailAside,
  detailColumns,
  shortRequestNumber,
} from "./PlanningWorkbench"
import { isInDemandWindow, Plans, type SelectedPlanReply } from "./Plans"
import {
  addWeeks,
  formatCapacityPercent,
  formatDateOptional,
  formatIsoDate,
  formatIsoDateRange,
  isCapacityAccessDenied,
  WorkloadBand,
  weekLoadLabel,
} from "./shared"

const outcomeKeys: Record<DemandOutcome, string> = {
  can_do: "capacity.demandDetail.outcomes.can_do",
  partial: "capacity.demandDetail.outcomes.partial",
  not_now: "capacity.demandDetail.outcomes.not_now",
}

const eventKeys: Record<DemandEventKind, string> = {
  submitted: "capacity.demandDetail.events.submitted",
  replied: "capacity.demandDetail.events.replied",
  accepted: "capacity.demandDetail.events.accepted",
  withdrawn: "capacity.demandDetail.events.withdrawn",
  follow_up: "capacity.demandDetail.events.follow_up",
  commitment_changed: "capacity.demandDetail.events.commitment_changed",
  committed: "capacity.demandDetail.events.committed",
  proposal_failed: "capacity.demandDetail.events.proposal_failed",
}

function hasPublicEventText(kind: DemandEventKind) {
  return (
    kind === "submitted" ||
    kind === "follow_up" ||
    kind === "commitment_changed"
  )
}

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
    queryKey: ["capacity", orgId, "demand", demandId],
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

const approvalPartyKeys: Record<string, string> = {
  resource_manager: "capacity.demandDetail.approvalParties.resource_manager",
  requester: "capacity.demandDetail.approvalParties.requester",
  lender_manager: "capacity.demandDetail.approvalParties.lender_manager",
  employee: "capacity.demandDetail.approvalParties.employee",
}

const failureKeys: Record<string, string> = {
  rejected: "capacity.demandDetail.failureLabels.rejected",
  expired: "capacity.demandDetail.failureLabels.expired",
  recheck_failed: "capacity.demandDetail.failureLabels.recheck_failed",
  borrow_unsuccessful:
    "capacity.demandDetail.failureLabels.borrow_unsuccessful",
}

const proposalStatusKeys: Record<string, string> = {
  pending: "capacity.demandDetail.proposalStatuses.pending",
  committed: "capacity.demandDetail.proposalStatuses.committed",
  failed: "capacity.demandDetail.proposalStatuses.failed",
  withdrawn: "capacity.demandDetail.proposalStatuses.withdrawn",
}

function DecisionHistory({
  orgId,
  demandId,
  side,
}: {
  orgId: string
  demandId: string
  side: "incoming" | "outgoing"
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ["capacity", orgId, "history", demandId],
    retry: (count, error) => !isCapacityAccessDenied(error) && count < 3,
    queryFn: async () =>
      (
        await CapacityService.getDemandHistory({
          path: { org_id: orgId, demand_id: demandId },
        })
      ).data,
  })
  return (
    <section
      aria-label={t("capacity.demandDetail.historyAria")}
      className="space-y-3 rounded-xl border p-5"
    >
      <h3 className="font-semibold">
        {t("capacity.demandDetail.historyTitle")}
      </h3>
      {query.isPending ? (
        <ProfileLoading />
      ) : query.isError ? (
        <ProfileError retry={() => query.refetch()} />
      ) : (
        <>
          {query.data.proposals.map((proposal) => {
            const failKey = failureKeys[proposal.fail_reason ?? ""]
            const statusKey = proposalStatusKeys[proposal.status]
            return (
              <article key={proposal.id} className="space-y-1 border-l-2 pl-4">
                <h4 className="font-medium">
                  {proposal.kind === "change"
                    ? t("capacity.demandDetail.changeProposalTitle")
                    : t("capacity.demandDetail.planProposalTitle")}{" "}
                  ·{" "}
                  {failKey
                    ? t(failKey)
                    : statusKey
                      ? t(statusKey)
                      : proposal.status}{" "}
                  · {formatDateOptional(proposal.created_at)}
                </h4>
                {proposal.approvals.map((approval, index) => (
                  <p key={index} className="whitespace-pre-wrap break-words">
                    {approvalPartyKeys[approval.party]
                      ? t(approvalPartyKeys[approval.party])
                      : t("capacity.demandDetail.fallbackParty")}
                    {t("capacity.demandDetail.approvalLine", {
                      party: "",
                      decision:
                        approval.decision === "approved"
                          ? t("capacity.demandDetail.approvalApproved")
                          : t("capacity.demandDetail.approvalRejected", {
                              reason: rejectionReasonLabel(
                                approval.reason_code,
                              ),
                            }),
                      reason:
                        approval.reason &&
                        (side === "incoming" || approval.party === "requester")
                          ? ` · ${approval.reason}`
                          : "",
                    }).replace(/^[:：]/, "")}
                  </p>
                ))}
              </article>
            )
          })}
          {side === "incoming" && !!query.data.snapshots?.length && (
            <details>
              <summary className="cursor-pointer font-medium">
                {t("capacity.demandDetail.historicalSnapshots")}
              </summary>
              {query.data.snapshots.map((snapshot) => (
                <div key={snapshot.id} className="mt-2 border-l-2 pl-4">
                  <p>{formatDateOptional(snapshot.created_at)}</p>
                  {snapshot.options?.map((option, index) => (
                    <p key={index}>
                      {option.kind_label} · {option.verdict_label}
                    </p>
                  ))}
                </div>
              ))}
            </details>
          )}
          <details
            open={query.data.events.some(
              (event) => event.outcome === "not_now",
            )}
          >
            <summary className="cursor-pointer font-medium">
              {t("capacity.demandDetail.demandTimeline")}
            </summary>
            {query.data.events.map((event, index) => (
              <div key={index} className="mt-2 border-l-2 pl-4">
                <p>
                  {t(eventKeys[event.kind])} ·{" "}
                  {formatDateOptional(event.created_at)}
                  {event.outcome && ` · ${t(outcomeKeys[event.outcome])}`}
                  {event.outcome === "not_now" &&
                    ` · ${rejectionReasonLabel(event.reason_code)}`}
                </p>
                {event.text &&
                  (side === "incoming" || hasPublicEventText(event.kind)) && (
                    <p className="whitespace-pre-wrap break-words">
                      {event.text}
                    </p>
                  )}
              </div>
            ))}
          </details>
        </>
      )}
    </section>
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
  const departments = useQuery({
    queryKey: ["capacity", orgId, "departments"],
    queryFn: async () =>
      (
        await CapacityService.listCapacityDepartments({
          path: { org_id: orgId },
        })
      ).data,
  })
  const name =
    departments.data?.data.find((row) => row.id === demand.target_department_id)
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

function DemandsBasis({
  orgId,
  demand,
}: {
  orgId: string
  demand: DemandPublic
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ["capacity", orgId, "demand-basis", demand.id],
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

function DemandsAction({
  orgId,
  demand,
  side,
  selected,
  change,
  clearSelection,
  onConfirmed,
}: {
  orgId: string
  demand: DemandPublic
  side: "outgoing" | "incoming"
  selected: SelectedPlanReply | null
  change: boolean
  clearSelection: () => void
  onConfirmed: (demand: DemandPublic) => Promise<void>
}) {
  const { t } = useTranslation()
  const cache = useQueryClient()
  const outcome = selected?.outcome ?? "not_now"
  const direct =
    !selected?.lender_department_id &&
    isInDemandWindow(
      selected?.start_date,
      selected?.end_date,
      demand.window_start,
      demand.window_end,
    )
  const [text, setText] = useState("")
  const [privateLoad, setPrivateLoad] = useState(false)
  const [reasonCode, setReasonCode] = useState<RejectionReason | "">("")
  const path = { org_id: orgId, demand_id: demand.id }
  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["capacity", orgId] }),
      cache.invalidateQueries({ queryKey: ["inbox", orgId] }),
    ])
  }
  const respond = useMutation({
    mutationFn: (action: RespondInput["action"]) =>
      CapacityService.respondDemand({
        path,
        body: { action, revision: demand.revision, text: text.trim() || null },
      }),
    onSuccess: refresh,
  })
  const reply = useMutation({
    mutationFn: (
      dates: Pick<PlanReplyInput, "start_date" | "end_date" | "outside_basis">,
    ) =>
      CapacityService.replyDemand({
        path,
        body: {
          ...dates,
          option_id: selected?.option_id,
          lender_department_id: selected?.lender_department_id,
          borrow_headcount: selected?.borrow_headcount,
          outcome,
          reason_code: outcome === "not_now" ? reasonCode || null : undefined,
          text: text.trim(),
          revision: demand.revision,
        },
      }),
    onSuccess: async ({ data }) => {
      await refresh()
      await onConfirmed(data)
    },
  })
  const propose = useMutation({
    mutationFn: (body: { option_id: string; outside_basis: boolean }) =>
      CapacityService.proposeChange({
        path,
        body: {
          ...body,
          reason: text,
          revision: demand.revision,
          lender_department_id: selected?.lender_department_id,
          borrow_headcount: selected?.borrow_headcount,
        },
      }),
    onSuccess: () => {
      clearSelection()
      return refresh()
    },
  })
  if (change && selected?.option_id) {
    const optionId = selected.option_id
    return (
      <form
        id="demand-reply"
        aria-label={t("capacity.demandDetail.changeFormAria")}
        className="min-w-0 scroll-mt-16 space-y-3 rounded-lg border border-surface-border bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault()
          propose.mutate({
            option_id: optionId,
            outside_basis: new FormData(event.currentTarget).has(
              "outside_basis",
            ),
          })
        }}
      >
        <fieldset disabled={propose.isPending} className="space-y-4">
          <label className="block space-y-2 text-sm font-medium">
            <span>{t("capacity.demandDetail.changeReasonLabel")}</span>
            <textarea
              required
              maxLength={500}
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="min-h-28 w-full rounded-md border bg-background p-3"
            />
          </label>
          {selected.outside_basis && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="outside_basis" required />
              {t("capacity.demandDetail.outsideBasisConfirm")}
            </label>
          )}
          <Button type="submit" disabled={!text.trim()}>
            {t("capacity.demandDetail.sendChangeBtn")}
          </Button>
        </fieldset>
        <ProposalError error={propose.error} />
      </form>
    )
  }
  if (
    demand.status === "accepted" ||
    demand.status === "withdrawn" ||
    demand.proposal?.status === "pending"
  )
    return null
  if (side === "outgoing") {
    return (
      <SectionCard className="space-y-3">
        {demand.status === "replied" && (
          <label className="block space-y-2 text-sm font-medium">
            <span>{t("capacity.demandDetail.followUpLabel")}</span>
            <textarea
              maxLength={2000}
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="min-h-20 w-full rounded-md border bg-background p-3"
            />
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          {demand.status === "replied" && (
            <Button
              variant="outline"
              disabled={respond.isPending || !text.trim()}
              onClick={() => respond.mutate("follow_up")}
            >
              {t("capacity.demandDetail.sendFollowUpBtn")}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={respond.isPending}
            onClick={() => respond.mutate("withdraw")}
          >
            {t("capacity.demandDetail.withdrawDemandBtn")}
          </Button>
        </div>
        <ProposalError error={respond.error} />
      </SectionCard>
    )
  }
  if (!demand.can_reply || (!selected && demand.status !== "submitted"))
    return null
  return (
    <form
      id="demand-reply"
      aria-label={t("capacity.demandDetail.replyFormAria")}
      className="min-w-0 scroll-mt-16 space-y-3 rounded-lg border border-surface-border bg-surface p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (reply.isPending) return
        const invalid =
          /超负荷|满负荷|基本满|有余量|饱和|已满|满员|排满|人手紧|人手不足|忙不过来|空闲|有空|闲置|余量|负荷.{0,4}未确认/.test(
            text,
          ) ||
          /\b(overloaded|fully booked|at capacity|full capacity|spare capacity|headcount shortage|idle staff|workload unconfirmed)\b/i.test(
            text,
          )
        setPrivateLoad(invalid)
        if (invalid) return
        reply.mutate({
          start_date: selected?.start_date ?? null,
          end_date: selected?.end_date ?? null,
          outside_basis: new FormData(event.currentTarget).has("outside_basis"),
        })
      }}
    >
      <fieldset disabled={reply.isPending} className="space-y-4">
        <h3 className="font-semibold">
          {selected
            ? t("capacity.demandDetail.confirmPlanTitle")
            : t("capacity.demandDetail.rejectDemandTitle")}
        </h3>
        {selected ? (
          <>
            <p>
              {t("capacity.demandDetail.proposedSchedule", {
                range: formatIsoDateRange(
                  selected.start_date ?? "",
                  selected.end_date ?? "",
                ),
              })}
            </p>
            <p className="text-sm text-muted-foreground">
              {direct
                ? t("capacity.demandDetail.directConfirmHint")
                : selected.lender_department_id
                  ? t("capacity.demandDetail.borrowConfirmHint")
                  : t("capacity.demandDetail.holdConfirmHint")}
            </p>
          </>
        ) : (
          <RejectionReasonSelect value={reasonCode} onChange={setReasonCode} />
        )}
        {selected?.outside_basis && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="outside_basis" required />
            {t("capacity.demandDetail.outsideBasisConfirm")}
          </label>
        )}
        <label className="block space-y-2 text-sm font-medium">
          <span>{t("capacity.demandDetail.replyNoteLabel")}</span>
          <textarea
            required
            maxLength={2000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-h-24 w-full rounded-md border bg-background p-3"
          />
        </label>
        <p className="text-sm text-muted-foreground">
          {t("capacity.demandDetail.replyNoteHint")}
        </p>
        {privateLoad && (
          <p role="alert" className="text-sm text-destructive">
            {t("capacity.demandDetail.privateLoadError")}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={!text.trim() || (!selected && !reasonCode)}
          >
            {selected
              ? direct
                ? t("capacity.demandDetail.confirmPlanAndAssignBtn")
                : t("capacity.demandDetail.submitAltScheduleBtn")
              : t("capacity.demandDetail.confirmRejectBtn")}
          </Button>
          {selected && (
            <Button type="button" variant="outline" onClick={clearSelection}>
              {t("capacity.demandDetail.clearPlanBtn")}
            </Button>
          )}
        </div>
      </fieldset>
      <ProposalError error={reply.error} />
    </form>
  )
}

function proposalLabel(
  proposal: NonNullable<DemandPublic["proposal"]>,
  now: number,
  internal: boolean,
) {
  if (
    proposal.status === "pending" &&
    Date.parse(proposal.hold_expires_at) <= now
  )
    return i18n.t("capacity.demandDetail.expired")
  if (proposal.borrow_progress) {
    if (internal) return proposal.borrow_progress
    if (proposal.status === "committed")
      return i18n.t("capacity.demandDetail.borrowCommitted")
    if (proposal.status === "failed")
      return i18n.t("capacity.demandDetail.borrowFailed")
    if (
      proposal.status === "pending" &&
      proposal.approvals.some(({ party }) => party === "requester")
    )
      return i18n.t("capacity.demandDetail.borrowPending")
  }
  const failKey = failureKeys[proposal.fail_reason ?? ""]
  if (failKey) return i18n.t(failKey)
  const statusKey = proposalStatusKeys[proposal.status]
  return statusKey ? i18n.t(statusKey) : proposal.status
}

function ProposalError({ error }: { error: Error | null }) {
  const { t } = useTranslation()
  const detail =
    error instanceof AxiosError ? error.response?.data?.detail : null
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const statusKey = proposalStatusKeys[String(detail.status)]
    const status = statusKey ? t(statusKey) : undefined
    return (
      <div
        role="alert"
        className="space-y-2 rounded-lg border border-destructive/40 p-4 text-sm text-destructive"
      >
        <p>
          {typeof detail.message === "string"
            ? detail.message
            : t("capacity.demandDetail.refreshStatusFallback")}
          {status && t("capacity.demandDetail.currentStatusPrefix", { status })}
        </p>
        {Array.isArray(detail.over_weeks) && (
          <ul>
            {detail.over_weeks.map(
              (
                week: {
                  week_start: string
                  over_percent: number
                  sources?: string[]
                },
                i: number,
              ) => (
                <li key={i}>
                  {t("capacity.demandDetail.overWeekLine", {
                    week: week.week_start,
                    percent: formatCapacityPercent(week.over_percent),
                  })}
                  {Array.isArray(week.sources) &&
                    week.sources.length > 0 &&
                    t("capacity.demandDetail.overWeekSources", {
                      sources: week.sources.join(
                        t("capacity.common.listSeparator"),
                      ),
                    })}
                </li>
              ),
            )}
          </ul>
        )}
        {Array.isArray(detail.weeks) && detail.weeks.length > 0 && (
          <>
            <ul>
              {detail.weeks.map(
                (week: { week_start: string; status: string }, i: number) => (
                  <li key={i}>
                    {t("capacity.demandDetail.unconfirmedWeekLine", {
                      week: week.week_start,
                      status:
                        week.status === "stale"
                          ? t("capacity.workload.statusStale")
                          : t("capacity.workload.statusUnconfirmed"),
                    })}
                  </li>
                ),
              )}
            </ul>
            <a href="/capacity?tab=team" className="underline">
              {t("capacity.demandDetail.confirmTeamLoadLink")}
            </a>
          </>
        )}
      </div>
    )
  }
  return <CapacityError error={error} />
}

function ProposalPanel({
  orgId,
  demand,
  side,
  now,
  setNow,
  replan,
}: {
  orgId: string
  demand: DemandPublic
  side: "incoming" | "outgoing"
  now: number
  setNow: (now: number) => void
  replan: () => void
}) {
  const { t } = useTranslation()
  const proposal = demand.proposal!
  const cache = useQueryClient()
  const expiresAt = Date.parse(proposal.hold_expires_at)
  useEffect(() => {
    if (proposal.status !== "pending" || !Number.isFinite(expiresAt)) return
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, expiresAt - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [proposal.status, expiresAt, setNow])
  const [action, setAction] = useState<
    "accept" | "follow_up" | "withdraw" | null
  >(null)
  const [reason, setReason] = useState("")
  const [reasonCode, setReasonCode] = useState<RejectionReason | "">("")
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ["capacity", orgId] })
    void cache.invalidateQueries({ queryKey: ["inbox", orgId] })
  }
  const mutation = useMutation({
    mutationFn: async () => {
      if (action === "withdraw")
        return CapacityService.withdrawProposal({
          path: { org_id: orgId, proposal_id: proposal.id },
          body: { revision: proposal.revision },
        })
      return CapacityService.respondDemand({
        path: { org_id: orgId, demand_id: demand.id },
        body: {
          action: action === "accept" ? "accept" : "follow_up",
          revision: demand.revision,
          text: action === "follow_up" ? reason.trim() : null,
          reason_code: action === "follow_up" ? reasonCode || null : undefined,
        },
      })
    },
    onSuccess: () => {
      setAction(null)
      refresh()
    },
    onError: (error) => {
      setAction(null)
      if (error instanceof AxiosError && error.response?.status === 409)
        refresh()
    },
  })
  const expired =
    proposal.status === "pending" && Date.parse(proposal.hold_expires_at) <= now
  const label = proposalLabel(proposal, now, side === "incoming")
  const pending = proposal.status === "pending" && !expired
  useEffect(() => {
    if (!pending && !mutation.isPending) setAction(null)
  }, [pending, mutation.isPending])
  const requesterApproved = proposal.approvals.some(
    (approval) => approval.party === "requester",
  )
  const change = proposal.kind === "change"
  const acceptLabel = change
    ? t("capacity.demandDetail.acceptChangeBtn")
    : t("capacity.demandDetail.confirmScheduleBtn")
  const rejectLabel = change
    ? t("capacity.demandDetail.rejectChangeBtn")
    : t("capacity.demandDetail.abandonBtn")
  const sectionTitle = change
    ? t("capacity.demandDetail.changeProposalTitle")
    : t("capacity.demandDetail.planProposalTitle")
  const failReasonKey = expired
    ? "expired"
    : (proposal.fail_reason ?? proposal.status)
  const failNotice =
    (
      {
        rejected: t("capacity.demandDetail.failNoticeRejected"),
        expired: t("capacity.demandDetail.failNoticeExpired"),
        recheck_failed: t("capacity.demandDetail.failNoticeRecheck"),
        withdrawn: t("capacity.demandDetail.failNoticeWithdrawn"),
      } as Record<string, string>
    )[failReasonKey] ?? t("capacity.demandDetail.failNoticeDefault")
  return (
    <section
      aria-label={sectionTitle}
      className="space-y-3 rounded-lg border border-surface-border bg-surface p-3 text-sm"
    >
      <h3 className="text-lg font-semibold">
        {sectionTitle} · {label}
      </h3>
      <p>
        {side === "incoming" && proposal.headcount != null
          ? t("capacity.demandDetail.headcountPrefix", {
              count: proposal.headcount,
            })
          : ""}
        {formatIsoDateRange(proposal.start_date, proposal.end_date)}
      </p>
      {proposal.status === "pending" && (
        <p>
          {t("capacity.demandDetail.holdExpires", {
            deadline: holdDeadline(proposal.hold_expires_at),
          })}
        </p>
      )}
      {side === "incoming" && proposal.conditions && (
        <p className="whitespace-pre-wrap break-words">
          {change
            ? t("capacity.demandDetail.changeReasonPrefix", {
                text: proposal.conditions,
              })
            : t("capacity.demandDetail.conditionsPrefix", {
                text: proposal.conditions,
              })}
        </p>
      )}
      {proposal.previous && (
        <section
          aria-label={t("capacity.demandDetail.beforeChange")}
          className="space-y-2"
        >
          <h4 className="font-semibold">
            {t("capacity.demandDetail.beforeChange")}
          </h4>
          <ProposalPeople
            arrangement={proposal.previous}
            side={side}
            phase="previous"
          />
        </section>
      )}
      <section
        aria-label={
          change
            ? t("capacity.demandDetail.afterChange")
            : t("capacity.demandDetail.arrangementDetails")
        }
        className="space-y-2"
      >
        {change && (
          <h4 className="font-semibold">
            {t("capacity.demandDetail.afterChange")}
          </h4>
        )}
        <ProposalPeople
          arrangement={{
            participants: proposal.participants ?? [],
            lines: "lines" in proposal ? proposal.lines : null,
            schedule_phases: proposal.schedule_phases ?? [],
          }}
          side={side}
          phase={change ? "current" : undefined}
        />
      </section>
      {side === "incoming" &&
        proposal.approvals.map((approval, index) => (
          <p key={index} className="whitespace-pre-wrap break-words">
            {t("capacity.demandDetail.approvalLine", {
              party: approvalPartyKeys[approval.party]
                ? t(approvalPartyKeys[approval.party])
                : t("capacity.demandDetail.fallbackParty"),
              decision:
                approval.decision === "approved"
                  ? t("capacity.demandDetail.approvalAgreed")
                  : t("capacity.demandDetail.approvalDisagreed"),
              reason: approval.reason
                ? t("capacity.demandDetail.approvalReason", {
                    reason: approval.reason,
                  })
                : "",
            })}
          </p>
        ))}
      {!pending &&
        proposal.status !== "committed" &&
        !proposal.borrow_progress && <p>{failNotice}</p>}
      {pending && (
        <div className="flex flex-wrap gap-3">
          {side === "outgoing"
            ? !requesterApproved && (
                <>
                  <Button
                    disabled={mutation.isPending}
                    onClick={() => setAction("accept")}
                  >
                    {acceptLabel}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={mutation.isPending}
                    onClick={() => {
                      setReason("")
                      setReasonCode("")
                      setAction("follow_up")
                    }}
                  >
                    {rejectLabel}
                  </Button>
                </>
              )
            : demand.basis_url && (
                <Button
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() => setAction("withdraw")}
                >
                  {t("capacity.demandDetail.withdrawProposalBtn")}
                </Button>
              )}
        </div>
      )}
      {side === "incoming" &&
        demand.basis_url &&
        !pending &&
        proposal.status !== "committed" && (
          <Button variant="outline" onClick={replan}>
            {t("capacity.demandDetail.replanBtn")}
          </Button>
        )}
      <ProposalError error={mutation.error} />
      <Dialog
        open={action !== null && pending}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setAction(null)
        }}
      >
        <DialogContent>
          <DialogTitle>
            {action === "accept"
              ? acceptLabel
              : action === "follow_up"
                ? rejectLabel
                : t("capacity.demandDetail.withdrawProposalBtn")}
          </DialogTitle>
          <DialogDescription>
            {action === "accept"
              ? proposal.borrow_progress
                ? t("capacity.demandDetail.acceptDescBorrow")
                : change
                  ? t("capacity.demandDetail.acceptDescChange")
                  : t("capacity.demandDetail.acceptDescDefault")
              : action === "follow_up"
                ? t("capacity.demandDetail.rejectDesc")
                : t("capacity.demandDetail.withdrawDesc")}
          </DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const current = Date.now()
              if (
                !pending ||
                mutation.isPending ||
                proposal.status !== "pending" ||
                (Number.isFinite(expiresAt) && expiresAt <= current)
              ) {
                setNow(current)
                setAction(null)
                return
              }
              mutation.mutate()
            }}
            className="space-y-4"
          >
            {action === "follow_up" && (
              <>
                <RejectionReasonSelect
                  value={reasonCode}
                  onChange={setReasonCode}
                />
                <label className="block space-y-2 text-sm">
                  <span>{t("capacity.demandDetail.rejectionReasonLabel")}</span>
                  <textarea
                    required
                    maxLength={500}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    className="min-h-28 w-full rounded-md border bg-background p-3"
                  />
                </label>
              </>
            )}
            <div className="flex gap-3">
              <Button
                type="submit"
                disabled={
                  !pending ||
                  mutation.isPending ||
                  (action === "follow_up" && (!reasonCode || !reason.trim()))
                }
              >
                {action === "accept"
                  ? t("capacity.demandDetail.confirmAcceptBtn")
                  : action === "follow_up"
                    ? t("capacity.demandDetail.confirmRejectProposalBtn")
                    : t("capacity.demandDetail.confirmWithdrawBtn")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => setAction(null)}
              >
                {t("capacity.common.cancel")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function participantLabel(
  person: NonNullable<CommitmentArrangement["participants"]>[number],
  phase?: "previous" | "current",
) {
  const status = "status" in person ? person.status : undefined
  if (status === "replaced")
    return i18n.t(
      phase === "previous"
        ? "capacity.demandDetail.participantReplacedBefore"
        : "capacity.demandDetail.participantReplacedAfter",
      { num: person.number },
    )
  if (status === "added")
    return i18n.t("capacity.demandDetail.participantAdded", {
      num: person.number,
    })
  if (status === "removed")
    return i18n.t("capacity.demandDetail.participantRemoved", {
      num: person.number,
    })
  return i18n.t("capacity.demandDetail.participantDefault", {
    num: person.number,
  })
}

function ProposalPeople({
  arrangement,
  side,
  phase,
}: {
  arrangement: CommitmentArrangement
  side: "incoming" | "outgoing"
  phase?: "previous" | "current"
}) {
  const { t } = useTranslation()
  if (side === "outgoing")
    return <SchedulePhases phases={arrangement.schedule_phases} />
  const groups = new Map<string, ProposalLinePublic[]>()
  if (arrangement.lines)
    for (const line of arrangement.lines) {
      const parts = groups.get(line.employee_id) ?? []
      parts.push(line)
      groups.set(line.employee_id, parts)
    }
  const participants = arrangement.participants ?? []
  const people = groups.size
    ? Array.from(groups.values(), (parts) => ({
        name: parts[0].employee_name,
        segments: parts,
      }))
    : participants.map((person) => ({
        name: participantLabel(person, phase),
        segments: person.segments,
      }))
  if (!people.length)
    return <SchedulePhases phases={arrangement.schedule_phases} />
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {people.map((person, index) => (
        <div key={index} className="space-y-2 rounded-lg bg-muted/30 p-3">
          <h4 className="font-medium">{person.name}</h4>
          {person.segments.map((segment, i) => (
            <p key={i} className="text-sm">
              {t("capacity.demandDetail.segmentLine", {
                percent: formatCapacityPercent(segment.allocation_percent),
                range: formatIsoDateRange(segment.start_date, segment.end_date),
              })}
            </p>
          ))}
        </div>
      ))}
    </div>
  )
}
