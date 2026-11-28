import { AxiosError } from "axios"
import { useTranslation } from "react-i18next"
import type { DemandEventKind, DemandOutcome } from "@/client"
import { CapacityError } from "./AssignmentFields"
import { formatCapacityPercent } from "./shared"

export const outcomeKeys: Record<DemandOutcome, string> = {
  can_do: "capacity.demandDetail.outcomes.can_do",
  partial: "capacity.demandDetail.outcomes.partial",
  not_now: "capacity.demandDetail.outcomes.not_now",
}

export const eventKeys: Record<DemandEventKind, string> = {
  submitted: "capacity.demandDetail.events.submitted",
  replied: "capacity.demandDetail.events.replied",
  accepted: "capacity.demandDetail.events.accepted",
  withdrawn: "capacity.demandDetail.events.withdrawn",
  follow_up: "capacity.demandDetail.events.follow_up",
  commitment_changed: "capacity.demandDetail.events.commitment_changed",
  committed: "capacity.demandDetail.events.committed",
  proposal_failed: "capacity.demandDetail.events.proposal_failed",
}

export const approvalPartyKeys: Record<string, string> = {
  resource_manager: "capacity.demandDetail.approvalParties.resource_manager",
  requester: "capacity.demandDetail.approvalParties.requester",
  lender_manager: "capacity.demandDetail.approvalParties.lender_manager",
  employee: "capacity.demandDetail.approvalParties.employee",
}

export const failureKeys: Record<string, string> = {
  rejected: "capacity.demandDetail.failureLabels.rejected",
  expired: "capacity.demandDetail.failureLabels.expired",
  recheck_failed: "capacity.demandDetail.failureLabels.recheck_failed",
  borrow_unsuccessful:
    "capacity.demandDetail.failureLabels.borrow_unsuccessful",
}

export const proposalStatusKeys: Record<string, string> = {
  pending: "capacity.demandDetail.proposalStatuses.pending",
  committed: "capacity.demandDetail.proposalStatuses.committed",
  failed: "capacity.demandDetail.proposalStatuses.failed",
  withdrawn: "capacity.demandDetail.proposalStatuses.withdrawn",
}

export function hasPublicEventText(kind: DemandEventKind) {
  return (
    kind === "submitted" ||
    kind === "follow_up" ||
    kind === "commitment_changed"
  )
}

export function ProposalError({ error }: { error: Error | null }) {
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
