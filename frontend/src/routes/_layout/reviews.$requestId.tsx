import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { isAxiosError } from "axios"
import type { TFunction } from "i18next"
import { ArrowLeft, ArrowRight, FileText } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type DecisionInput,
  type PendingReviews,
  type ReviewDetail,
  ReviewsService,
} from "@/client"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import {
  SectionCard,
  WorkspacePage,
} from "@/components/Common/WorkbenchPrimitives"
import { EvidenceSheet } from "@/components/Profile/EvidenceSheet"
import { LevelBadge } from "@/components/Profile/LevelBadge"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { RequestSourceBadge } from "@/components/Profile/RequestTimeline"
import { StatusBadge } from "@/components/Profile/StatusBadge"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useOrg } from "@/hooks/useOrg"
import { useReviews } from "@/hooks/useReviews"
import i18n from "@/i18n"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_layout/reviews/$requestId")({
  component: ReviewPage,
  head: () => ({ meta: [{ title: i18n.t("reviews.detail.pageTitle") }] }),
})
function approvalStatusHint(
  { after, jira_only }: ReviewDetail["items"][number],
  t: TFunction,
) {
  if (jira_only) return t("reviews.detail.hintJiraOnly")
  if (after.after?.assessment_status === "tentative") {
    return t("reviews.detail.hintTentative")
  }
}

function ReviewPage() {
  const { org } = useOrg()
  const { requestId } = Route.useParams()
  return org ? (
    <ReviewForm
      key={`${org.id}:${requestId}`}
      orgId={org.id}
      requestId={requestId}
    />
  ) : null
}

const decisionStyles: Record<DecisionInput["decision"], string> = {
  approved:
    "aria-pressed:bg-emerald-600 aria-pressed:text-white aria-pressed:hover:bg-emerald-600",
  rejected:
    "aria-pressed:bg-destructive aria-pressed:text-white aria-pressed:hover:bg-destructive",
}

function ReviewForm({
  orgId,
  requestId,
}: {
  orgId: string
  requestId: string
}) {
  const { t } = useTranslation()
  const decisionOptions: [DecisionInput["decision"], string][] = [
    ["approved", t("reviews.detail.decisions.approved")],
    ["rejected", t("reviews.detail.decisions.rejected")],
  ]
  const path = { org_id: orgId, request_id: requestId }
  const cache = useQueryClient()
  const reviews = useReviews()
  const subject = reviews.data?.data.find((request) => request.id === requestId)
  const [decisions, setDecisions] = useState<Record<string, DecisionInput>>({})
  const [comment, setComment] = useState("")
  const [confirm, setConfirm] = useState(false)
  const [revision, setRevision] = useState(0)
  const [stale, setStale] = useState(false)
  const [evidenceId, setEvidenceId] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ["review", orgId, requestId],
    // Review access can expire; discard restricted content when its view closes.
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => (await ReviewsService.getReview({ path })).data,
    retry: false,
  })
  const mutation = useMutation({
    mutationFn: () =>
      ReviewsService.decide({
        path,
        body: {
          revision,
          decisions: Object.values(decisions),
          comment: comment.trim() || null,
        },
      }),
    onSuccess: async () => {
      const queryKey = ["reviews", orgId]
      await cache.cancelQueries({ queryKey })
      cache.setQueryData<PendingReviews>(queryKey, (previous) => {
        if (!previous) return previous
        const data = previous.data.filter((request) => request.id !== requestId)
        return { ...previous, data, count: data.length }
      })
      setConfirm(false)
      cache.invalidateQueries()
    },
    onError: (error) => {
      setConfirm(false)
      if (isAxiosError(error) && error.response?.status === 409) {
        setStale(true)
        setDecisions({})
        query.refetch()
      }
    },
  })
  if (mutation.isSuccess)
    return (
      <div role="status" className="space-y-4">
        <h1 className="text-2xl font-semibold">
          {t("reviews.detail.submittedTitle")}
        </h1>
        <p>{t("reviews.detail.submittedDesc")}</p>
        <Link className="text-primary underline" to="/reviews">
          {t("reviews.detail.backToReviews")}
        </Link>
      </div>
    )
  if (query.isPending) return <ProfileLoading />
  if (query.isError) {
    if (
      isAxiosError(query.error) &&
      [403, 404].includes(query.error.response?.status ?? 0)
    )
      return (
        <div role="alert" className="space-y-4">
          <p>
            {stale
              ? t("reviews.detail.staleError")
              : t("reviews.detail.unavailableError")}
          </p>
          <Link className="text-primary underline" to="/reviews">
            {t("reviews.detail.backToReviews")}
          </Link>
        </div>
      )
    return <ProfileError retry={() => query.refetch()} />
  }
  const items = query.data.items
    .filter((item) => !item.after.decision)
    .map((item) => ({ ...item, approvalHint: approvalStatusHint(item, t) }))
  const valid =
    items.length > 0 &&
    items.every((item) => {
      const value = decisions[item.after.id]
      return (
        value &&
        (value.decision === "approved"
          ? item.approvable
          : !!value.reason?.trim())
      )
    })
  return (
    <WorkspacePage>
      <h1 className="sr-only">{t("reviews.detail.heading")}</h1>
      <TopbarActions>
        <Button asChild size="sm" variant="outline">
          <Link to="/reviews">
            <ArrowLeft aria-hidden="true" />
            {t("reviews.detail.backToReviews")}
          </Link>
        </Button>
      </TopbarActions>
      {stale && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {t("reviews.detail.staleError")}
        </p>
      )}
      {!stale && <SetupError error={mutation.error} />}
      <form
        className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,31%)]"
        onSubmit={(event) => {
          event.preventDefault()
          if (!valid || mutation.isPending || query.isFetching) return
          setRevision(query.data.revision)
          setConfirm(true)
        }}
      >
        <section
          aria-label={t("reviews.detail.itemsAria")}
          className="min-w-0 space-y-3"
        >
          <h2 className="text-sm font-semibold">
            {t("reviews.detail.itemsHeading")}{" "}
            <span className="text-muted-foreground">
              {t("reviews.detail.itemsCount", { count: items.length })}
            </span>
          </h2>
          <RequestSourceBadge
            via={query.data.submitted_via}
            clientName={query.data.client_name}
          />
          {items.map(({ before, after, evidence, approvalHint }) => (
            <SectionCard key={after.id} className="space-y-3">
              <h3 className="wrap-anywhere text-sm font-semibold">
                {after.capability.name}
              </h3>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                {[
                  {
                    title: t("reviews.detail.beforeTitle"),
                    claim: before,
                    fallback: t("reviews.detail.beforeFallback"),
                  },
                  {
                    title: t("reviews.detail.afterTitle"),
                    claim: after.after,
                    fallback:
                      after.op === "retract"
                        ? t("reviews.detail.afterRetractFallback")
                        : t("reviews.detail.afterAttachFallback"),
                  },
                ].map(({ title, claim, fallback }, index) => (
                  <div
                    key={title}
                    className={cn(
                      "min-w-0 rounded-md bg-muted/60 p-2.5 text-sm",
                      index === 1 && "sm:col-start-3 sm:row-start-1",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-xs text-muted-foreground">{title}</h4>
                      {claim && (
                        <>
                          <LevelBadge
                            rubric={after.capability.level_rubric}
                            level={claim.level}
                          />
                          <StatusBadge
                            kind="assessment_status"
                            value={claim.assessment_status}
                          />
                        </>
                      )}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap wrap-anywhere">
                      {claim?.statement ?? fallback}
                    </p>
                  </div>
                ))}
                <ArrowRight
                  aria-hidden="true"
                  className="hidden size-4 self-center text-primary sm:col-start-2 sm:row-start-1 sm:block"
                />
              </div>
              {approvalHint && (
                <p className="rounded bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-300">
                  {approvalHint}
                </p>
              )}
              {[
                {
                  label: t("reviews.detail.labelExplanation"),
                  text: after.explanation,
                  style: "border-surface-border bg-muted/60",
                },
                {
                  label: t("reviews.detail.labelUncertainty"),
                  text: after.uncertainty,
                  style: "border-amber-500 bg-amber-500/10",
                },
                {
                  label: t("reviews.detail.labelOwnerStatement"),
                  text: after.owner_statement,
                  style: "border-primary/50 bg-primary/5",
                },
                {
                  label: t("reviews.detail.labelObjection"),
                  text: after.objection,
                  style: "border-destructive bg-destructive/5",
                },
              ].map(
                ({ label, text, style }) =>
                  text?.trim() && (
                    <p
                      key={label}
                      className={cn(
                        "whitespace-pre-wrap wrap-anywhere border-l-2 px-2.5 py-1.5 text-sm",
                        style,
                      )}
                    >
                      <span className="font-medium">
                        {t("reviews.detail.fieldColon", { label })}
                      </span>
                      {text}
                    </p>
                  ),
              )}
              {evidence.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {evidence.map(({ id, title }) => (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto max-w-full rounded-full py-1 whitespace-normal wrap-anywhere text-left text-xs shadow-none"
                      key={id}
                      onClick={() => setEvidenceId(id)}
                    >
                      <FileText aria-hidden="true" />
                      {title}
                    </Button>
                  ))}
                </div>
              )}
            </SectionCard>
          ))}
        </section>
        <SectionCard
          aria-label={t("reviews.detail.panelAria")}
          className="flex min-w-0 flex-col p-0 lg:sticky lg:top-16 lg:max-h-[calc(100dvh-5rem)]"
        >
          <header className="flex flex-wrap items-center justify-between gap-1 border-surface-border border-b px-4 py-3">
            <h2 className="text-sm font-semibold">
              {t("reviews.detail.panelTitle")}
            </h2>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {t("reviews.detail.selectedCount", {
                selected: Object.keys(decisions).length,
                total: items.length,
              })}
            </span>
          </header>
          <div className="min-h-0 divide-y divide-surface-border px-4 lg:overflow-y-auto">
            {(subject ||
              query.data.acting_for_name ||
              query.data.assignment_reason ||
              !query.data.owner_reviewed) && (
              <div className="space-y-1 py-3 text-sm wrap-anywhere">
                {subject && (
                  <p className="font-medium">
                    {subject.employee_name} ·{" "}
                    {subject.department_name ?? t("reviews.detail.deptEmpty")}
                  </p>
                )}
                {query.data.acting_for_name && (
                  <p className="font-medium text-primary">
                    {t("reviews.detail.actingFor", {
                      name: query.data.acting_for_name,
                    })}
                  </p>
                )}
                {query.data.assignment_reason && (
                  <p className="text-muted-foreground">
                    {t("reviews.detail.assignmentReason", {
                      reason: query.data.assignment_reason,
                    })}
                  </p>
                )}
                {!query.data.owner_reviewed && (
                  <p className="text-amber-700 dark:text-amber-300">
                    {t("reviews.detail.ownerUnreviewed")}
                  </p>
                )}
              </div>
            )}
            {items.map(({ after, approvable, approval_blocked_reason }) => {
              const value = decisions[after.id]
              return (
                <fieldset key={after.id} className="min-w-0 space-y-2 py-3">
                  <legend className="sr-only">
                    {t("reviews.detail.itemLegend", {
                      name: after.capability.name,
                    })}
                  </legend>
                  <h3 className="wrap-anywhere text-sm font-semibold">
                    {after.capability.name}
                  </h3>
                  <div className="grid grid-cols-2 gap-0.5 rounded-md bg-muted p-0.5">
                    {decisionOptions.map(([decision, label]) => (
                      <Button
                        key={decision}
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={cn("px-1", decisionStyles[decision])}
                        aria-pressed={value?.decision === decision}
                        disabled={decision === "approved" && !approvable}
                        onClick={() =>
                          setDecisions((previous) => ({
                            ...previous,
                            [after.id]: {
                              item_id: after.id,
                              decision,
                              reason:
                                decision === "approved"
                                  ? ""
                                  : (previous[after.id]?.reason ?? ""),
                            },
                          }))
                        }
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  {!approvable && (
                    <p role="status" className="text-xs text-destructive">
                      {t("reviews.detail.cannotApprove", {
                        reason: approval_blocked_reason,
                      })}
                    </p>
                  )}
                  {value && value.decision !== "approved" && (
                    <label className="block space-y-1 text-xs text-muted-foreground">
                      <span>{t("reviews.detail.reasonRequired")}</span>
                      <textarea
                        aria-label={t("reviews.detail.reasonAria", {
                          name: after.capability.name,
                        })}
                        className="min-h-16 w-full rounded-md border bg-background p-2 text-sm text-foreground"
                        required
                        value={value.reason ?? ""}
                        onChange={(event) =>
                          setDecisions({
                            ...decisions,
                            [after.id]: {
                              ...value,
                              reason: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  )}
                </fieldset>
              )
            })}
            <label className="block space-y-1 py-3 text-xs text-muted-foreground">
              <span>{t("reviews.detail.overallComment")}</span>
              <textarea
                className="min-h-16 w-full rounded-md border bg-background p-2 text-sm text-foreground"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </label>
          </div>
          <footer className="sticky bottom-0 space-y-2 rounded-b-lg border-surface-border border-t bg-surface px-4 py-3">
            <Button
              className="w-full"
              disabled={!valid || mutation.isPending || query.isFetching}
              type="submit"
            >
              {t("reviews.detail.submitButton")}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {t("reviews.detail.visibilityNote")}
            </p>
          </footer>
        </SectionCard>
      </form>
      <Dialog
        open={confirm}
        onOpenChange={(open) => {
          if (!mutation.isPending) setConfirm(open)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("reviews.detail.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("reviews.detail.confirmDesc")}
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.after.id} className="break-words">
                {t("reviews.detail.confirmItemLine", {
                  name: item.after.capability.name,
                  decision: decisions[item.after.id]
                    ? decisions[item.after.id].decision === "approved"
                      ? t("reviews.detail.decisions.approved")
                      : t("reviews.detail.decisions.rejected")
                    : "",
                })}
                {decisions[item.after.id]?.decision === "approved" &&
                  item.approvalHint && (
                    <p className="text-sm text-muted-foreground">
                      {item.approvalHint}
                    </p>
                  )}
                {decisions[item.after.id]?.reason?.trim() && (
                  <p>{decisions[item.after.id].reason}</p>
                )}
              </li>
            ))}
          </ul>
          {comment.trim() && (
            <p className="whitespace-pre-wrap break-words">
              {t("reviews.detail.confirmOverallComment", { comment })}
            </p>
          )}
          <Button
            disabled={mutation.isPending || !valid || query.isFetching}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending
              ? t("reviews.detail.submitting")
              : t("reviews.detail.confirmSubmit")}
          </Button>
        </DialogContent>
      </Dialog>
      <EvidenceSheet
        orgId={orgId}
        evidenceId={evidenceId}
        requestId={requestId}
        onClose={() => setEvidenceId(null)}
      />
    </WorkspacePage>
  )
}
