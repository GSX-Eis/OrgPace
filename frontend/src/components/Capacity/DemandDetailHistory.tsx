import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { CapacityService } from "@/client"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { rejectionReasonLabel } from "./BorrowRequests"
import {
  approvalPartyKeys,
  eventKeys,
  failureKeys,
  hasPublicEventText,
  outcomeKeys,
  proposalStatusKeys,
} from "./DemandDetailShared"
import { capacityKeys } from "./queries"
import { formatDateOptional, isCapacityAccessDenied } from "./shared"

export function DecisionHistory({
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
    queryKey: capacityKeys.demandHistory(orgId, demandId),
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
