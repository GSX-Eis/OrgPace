import { useTranslation } from "react-i18next"
import type { MyWorkload as MyWorkloadData } from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { addWeeks } from "./dateUtils"
import {
  formatCapacityPercent,
  formatDateOptional,
  formatIsoDateRange,
} from "./shared"

export function MyWorkloadAdjustForm({
  firstWeekStart,
  reviewerNames,
  pending,
  isPending,
  error,
  start,
  end,
  percent,
  reason,
  onStartChange,
  onEndChange,
  onPercentChange,
  onReasonChange,
  onSubmit,
}: {
  firstWeekStart: string
  reviewerNames: string
  pending: boolean
  isPending: boolean
  error: Error | null
  start: string
  end: string
  percent: string
  reason: string
  onStartChange: (value: string) => void
  onEndChange: (value: string) => void
  onPercentChange: (value: string) => void
  onReasonChange: (value: string) => void
  onSubmit: () => void
}) {
  const { t } = useTranslation()
  const resolvedStart = start || firstWeekStart
  const resolvedEnd = end || resolvedStart

  return (
    <form
      aria-label={t("capacity.workload.adjustBtn")}
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t("capacity.workload.adjustHint")}
      </p>
      <p className="text-sm text-muted-foreground">
        {reviewerNames
          ? t("capacity.workload.willSubmitTo", { names: reviewerNames })
          : t("capacity.workload.noReviewer")}
      </p>
      <fieldset disabled={pending || isPending} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="request-start-week">
              {t("capacity.workload.startWeek")}
            </Label>
            <Input
              id="request-start-week"
              type="date"
              min="1970-01-05"
              step={7}
              required
              value={resolvedStart}
              onChange={(event) => {
                const next = event.target.value
                onStartChange(next)
                const currentEnd = end || firstWeekStart
                if (currentEnd < next) onEndChange(next)
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="request-end-week">
              {t("capacity.workload.endWeek")}
            </Label>
            <Input
              id="request-end-week"
              type="date"
              min={resolvedStart}
              max={addWeeks(resolvedStart, 25)}
              step={7}
              required
              value={resolvedEnd}
              onChange={(event) => onEndChange(event.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="requested-percent">
            {t("capacity.workload.requestedPercent")}
          </Label>
          <Input
            id="requested-percent"
            type="number"
            min={0}
            max={200}
            step={1}
            required
            value={percent}
            onChange={(event) => onPercentChange(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="workload-reason">
            {t("capacity.workload.reason")}
          </Label>
          <textarea
            className="w-full rounded-md border bg-transparent p-3 text-sm"
            id="workload-reason"
            required
            maxLength={500}
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={!reason.trim()}>
          {isPending
            ? t("capacity.workload.submitting")
            : t("capacity.workload.submitAdjust")}
        </Button>
      </fieldset>
      {pending && <p role="status">{t("capacity.workload.pendingNotice")}</p>}
      <SetupError error={error} />
    </form>
  )
}

export function MyWorkloadRequestHistory({
  requests,
  reviewerNames,
  pending,
  submitSuccess,
  submittedNames,
}: {
  requests: MyWorkloadData["requests"]
  reviewerNames: string
  pending: boolean
  submitSuccess: boolean
  submittedNames?: string
}) {
  const { t } = useTranslation()

  return (
    <aside className="min-w-0 space-y-3">
      <SectionCard
        aria-label={t("capacity.workload.requestsAria")}
        className="space-y-3"
      >
        <h2 className="text-sm font-semibold">
          {t("capacity.workload.requestsTitle")}
        </h2>
        {pending && (
          <p className="text-sm" role="status">
            {t("capacity.workload.pendingNotice")}
          </p>
        )}
        {submitSuccess && (
          <p className="text-sm" aria-live="polite">
            {submittedNames
              ? t("capacity.workload.submittedTo", {
                  names: submittedNames,
                })
              : t("capacity.workload.noReviewer")}
          </p>
        )}
        {!requests.length && (
          <p className="text-sm text-muted-foreground">
            {t("capacity.workload.noRequests")}
          </p>
        )}
        <div className="divide-y">
          {requests.map((request) => (
            <article key={request.id} className="space-y-1 py-2.5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <p className="font-medium">
                  {formatCapacityPercent(request.requested_percent)} ·{" "}
                  {
                    {
                      pending: reviewerNames
                        ? t("capacity.workload.requestPendingWithReviewers", {
                            names: reviewerNames,
                          })
                        : t("capacity.workload.requestPending"),
                      approved: t("capacity.workload.requestApproved"),
                      returned: t("capacity.workload.requestReturned"),
                    }[request.status]
                  }
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDateOptional(request.created_at)}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                {request.start_week && request.end_week
                  ? formatIsoDateRange(request.start_week, request.end_week)
                  : t("capacity.workload.approvedWeek")}
              </p>
              <p className="whitespace-pre-wrap break-words">
                {request.reason}
              </p>
              {request.decision_note && (
                <p className="whitespace-pre-wrap break-words">
                  {t("capacity.workload.decisionNote", {
                    note: request.decision_note,
                  })}
                </p>
              )}
            </article>
          ))}
        </div>
      </SectionCard>
    </aside>
  )
}
