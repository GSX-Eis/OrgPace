import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapacityService,
  type DemandPublic,
  type PlanReplyInput,
  type RespondInput,
} from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { Button } from "@/components/ui/button"
import { type RejectionReason, RejectionReasonSelect } from "./BorrowRequests"
import { ProposalError } from "./DemandDetailShared"
import { isInDemandWindow, type SelectedPlanReply } from "./Plans"
import { invalidateDemandMutation } from "./queries"
import { formatIsoDateRange } from "./shared"

export function DemandsAction({
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
  const refresh = () => invalidateDemandMutation(cache, orgId, demand.id)
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
