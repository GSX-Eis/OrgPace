import { useMutation, useQueryClient } from "@tanstack/react-query"
import { AxiosError } from "axios"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapacityService,
  type CommitmentArrangement,
  type DemandPublic,
  type ProposalLinePublic,
} from "@/client"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import i18n from "@/i18n"
import { type RejectionReason, RejectionReasonSelect } from "./BorrowRequests"
import {
  approvalPartyKeys,
  failureKeys,
  ProposalError,
  proposalStatusKeys,
} from "./DemandDetailShared"
import { holdDeadline, SchedulePhases } from "./DemandSchedule"
import { invalidateDemandMutation } from "./queries"
import { formatCapacityPercent, formatIsoDateRange } from "./shared"

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

export function ProposalPanel({
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
    void invalidateDemandMutation(cache, orgId, demand.id)
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
