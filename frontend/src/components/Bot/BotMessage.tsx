import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import type {
  CapabilitiesPublic,
  CapacityAction,
  Claim,
  PlanCard,
  ProfileEditAction,
  ProjectDraftAction,
  QuestionAction,
  RequestAction,
  ReviewAction,
  TurnResponse,
} from "@/client"
import { levelLabel } from "@/components/Profile/fields"
import { RequestReviewers } from "@/components/Profile/RequestReviewers"
import { StatusBadge } from "@/components/Profile/StatusBadge"
import { Button } from "@/components/ui/button"
import { safeNext } from "@/utils"
import { FeasibilityCard } from "./FeasibilityCard"
import { ProjectDraftMessage } from "./ProjectDraftMessage"
import { previewHistoryLabel, type RequestCard } from "./requestCards"

export type BotAction =
  | RequestAction
  | QuestionAction
  | ReviewAction
  | ProfileEditAction
  | CapacityAction
  | ProjectDraftAction

function assistantText(text: string) {
  const detailLinks =
    /(?:\[([^\]\n]+)\]\()?((?<![\w:/=&.-])\/(employees\/|capacity\?tab=projects&project=)([\da-fA-F]{8}(?:-[\da-fA-F]{4}){3}-[\da-fA-F]{12}))(?![\w/-])\)?/g
  let cursor = 0
  const parts = Array.from(text.matchAll(detailLinks)).flatMap((match) => {
    const [whole, label, path, prefix, id] = match
    const before = text.slice(cursor, match.index)
    cursor = match.index + (label ? whole.length : path.length)
    const link =
      prefix === "employees/" ? (
        <Link
          key={match.index}
          to="/employees/$employeeId"
          params={{ employeeId: id }}
          className="underline"
        >
          {label ?? path}
        </Link>
      ) : (
        <Link
          key={match.index}
          to="/capacity"
          search={{ tab: "projects", project: id }}
          className="underline"
        >
          {label ?? path}
        </Link>
      )
    return [before, link]
  })
  return parts.concat(text.slice(cursor))
}

export function BotMessage({
  message,
  dictionary,
  laterRequest,
  disabled,
  onAction,
}: {
  message: TurnResponse["messages"][number]
  dictionary?: CapabilitiesPublic
  laterRequest?: RequestCard
  disabled: boolean
  onAction: (action: BotAction) => void
}) {
  const { t } = useTranslation()
  const [answer, setAnswer] = useState("")
  const actionLabels = {
    confirm_submit: t("bot.actionLabels.confirm_submit"),
    continue_editing: t("bot.actionLabels.continue_editing"),
    withdraw: t("bot.actionLabels.withdraw"),
  }
  const statuses: Record<string, string> = {
    draft: t("bot.statuses.draft"),
    pending_owner: t("bot.statuses.pending_owner"),
    pending_review: t("bot.statuses.pending_review"),
    withdrawn: t("bot.statuses.withdrawn"),
    approved: t("bot.statuses.approved"),
    changes_requested: t("bot.statuses.changes_requested"),
    rejected: t("bot.statuses.rejected"),
  }
  if (message.type === "feasibility_card")
    return <FeasibilityCard card={message} />
  if (message.type === "project_draft_card")
    return (
      <ProjectDraftMessage
        card={message}
        disabled={disabled}
        onConfirm={onAction}
      />
    )
  const displayLevel = (claim: Claim | null | undefined, key: string) =>
    claim?.level_name ??
    (claim?.level
      ? dictionary
        ? levelLabel(
            dictionary.data.find((capability) => capability.key === key)
              ?.level_rubric,
            claim.level,
          )
        : t("bot.levelAdjusted")
      : t("bot.ungraded"))
  if (message.type === "capacity_card") {
    const link = message.detail_link
    return (
      <section
        className="space-y-4 rounded-xl border bg-background p-4"
        aria-label={message.title}
      >
        <h3 className="font-semibold">{message.title}</h3>
        {!!message.questions?.length && (
          <div className="rounded-md bg-amber-50 p-3 text-amber-950">
            <p className="font-medium">{t("bot.confirmOperation")}</p>
            {message.questions?.map((question) => (
              <p key={question}>{question}</p>
            ))}
          </div>
        )}
        {message.fields?.length ? (
          <>
            <dl className="space-y-2">
              {message.fields?.map((field) => (
                <div
                  key={field.label}
                  className={field.unclear ? "rounded-md bg-amber-50 p-2" : ""}
                >
                  <dt className="inline font-medium">
                    {t("bot.fieldColon", { label: field.label })}
                  </dt>
                  <dd className="inline break-words">{field.value}</dd>
                  {field.unclear && (
                    <span className="ml-2 font-medium text-amber-900">
                      {t("bot.unclearPending")}
                    </span>
                  )}
                </div>
              ))}
            </dl>
            <p>{message.content.split("\n").slice(-1)[0]}</p>
          </>
        ) : (
          <p className="whitespace-pre-wrap break-words leading-7">
            {message.content}
          </p>
        )}
        {link && safeNext(link.href) === link.href && (
          <Link
            to={link.href}
            href={link.href}
            className="inline-block underline"
          >
            {link.label}
          </Link>
        )}
        {message.result && <p role="status">{message.result}</p>}
        {message.plan && <PlanDetails plan={message.plan} />}
        {message.status === "pending" && (
          <div className="flex flex-wrap gap-2">
            {(message.actions ?? []).map((action) => (
              <Button
                key={action.action}
                disabled={disabled}
                variant={
                  action.action === "confirm_capacity" ? "default" : "outline"
                }
                onClick={() => onAction(action)}
              >
                {action.action === "confirm_capacity"
                  ? t("bot.confirm")
                  : t("bot.cancel")}
              </Button>
            ))}
          </div>
        )}
      </section>
    )
  }
  if (message.type === "plan_card")
    return (
      <section
        className="space-y-4 rounded-xl border bg-background p-4"
        aria-label={message.title}
      >
        <PlanDetails plan={message} />
      </section>
    )
  if (message.type === "text")
    return (
      <div className="space-y-2">
        <p className="whitespace-pre-wrap break-words leading-7">
          {assistantText(message.text)}
        </p>
        {message.review_link && (
          <Link to="/reviews" className="underline">
            {t("bot.goToReviews")}
          </Link>
        )}
        {message.capacity_links?.map((link) => (
          <a key={link.href} href={link.href} className="mr-4 underline">
            {t("bot.goToLink", { label: link.label })}
          </a>
        ))}
      </div>
    )
  if (message.type === "profile_edit_card")
    return (
      <section
        className="space-y-4 rounded-xl border bg-background p-4"
        aria-label={t("bot.profileEditAria")}
      >
        <h3 className="font-semibold">
          {t("bot.profileEditTitle", { name: message.employee_name })}
        </h3>
        {message.items.map((item) => {
          return (
            <div key={item.capability_key} className="space-y-2 border-t pt-3">
              <h4 className="font-medium">{item.capability_name}</h4>
              {[
                { label: t("bot.before"), claim: item.before },
                { label: t("bot.after"), claim: item.after },
              ].map(({ label, claim }) => (
                <p key={label}>
                  {t("bot.fieldColon", { label })}
                  {claim?.statement ?? t("bot.noRecord")}
                  {t("bot.levelInline", {
                    level: displayLevel(claim, item.capability_key),
                  })}
                  {claim && (
                    <StatusBadge
                      kind="assessment_status"
                      value={claim.assessment_status}
                    />
                  )}
                </p>
              ))}
            </div>
          )
        })}
        <p>{t("bot.profileEditNotice")}</p>
        {message.result && <p role="status">{message.result}</p>}
        {!!(message.actions ?? []).length && (
          <div className="flex flex-wrap gap-2">
            {(message.actions ?? []).map((action) => (
              <Button
                key={action.action}
                disabled={disabled}
                variant={
                  action.action === "confirm_profile_edit"
                    ? "default"
                    : "outline"
                }
                onClick={() => onAction(action)}
              >
                {action.action === "confirm_profile_edit"
                  ? t("bot.confirmProfileEdit")
                  : t("bot.continueEditing")}
              </Button>
            ))}
          </div>
        )}
      </section>
    )
  if (message.type === "review_card")
    return (
      <section
        className="space-y-4 rounded-xl border bg-background p-4"
        aria-label={t("bot.reviewCardAria")}
      >
        <h3 className="font-semibold">
          {t("bot.reviewCardTitle", { revision: message.revision })}
        </h3>
        {message.items.map((item) => {
          const decision = message.decisions.find(
            (d) => d.item_id === item.after.id,
          )
          return (
            <div key={item.after.id} className="space-y-2 border-t pt-3">
              <h4 className="font-medium">{item.after.capability.name}</h4>
              <p>
                {t("bot.fieldColon", { label: t("bot.before") })}
                {item.before?.statement ?? t("bot.noRecord")}
                {t("bot.levelInline", {
                  level: displayLevel(item.before, item.after.capability.key),
                })}
                {item.before && (
                  <StatusBadge
                    kind="assessment_status"
                    value={item.before.assessment_status}
                  />
                )}
              </p>
              <p>
                {t("bot.fieldColon", { label: t("bot.after") })}
                {item.after.after?.statement ?? t("bot.removeItem")}
                {t("bot.levelInline", {
                  level: displayLevel(
                    item.after.after,
                    item.after.capability.key,
                  ),
                })}
                {item.after.after && (
                  <StatusBadge
                    kind="assessment_status"
                    value={item.after.after.assessment_status}
                  />
                )}
              </p>
              <p>
                {t("bot.relatedEvidence", {
                  titles:
                    item.evidence
                      .map((e) => e.title)
                      .join(t("bot.listSeparator")) || t("bot.none"),
                })}
              </p>
              {item.jira_only && <p>{t("bot.jiraOnlyNotice")}</p>}
              <p>
                {t("bot.reviewDecision", {
                  decision: decision
                    ? (statuses[decision.decision] ?? decision.decision)
                    : t("bot.notFilled"),
                })}
              </p>
              <p>
                {t("bot.reviewReason", {
                  reason: decision?.reason || t("bot.notFilled"),
                })}
              </p>
            </div>
          )
        })}
        <Link
          to="/reviews/$requestId"
          params={{ requestId: message.id }}
          className="underline"
        >
          {t("bot.viewEvidenceOnReviews")}
        </Link>
        {message.result && (
          <p role="status">
            {message.result}
            {message.status === "confirmed" && (
              <>
                {" "}
                <Link to="/reviews" className="underline">
                  {t("bot.goToReviews")}
                </Link>
              </>
            )}
          </p>
        )}
        {!!(message.actions ?? []).length && (
          <div className="flex flex-wrap gap-2">
            {(message.actions ?? []).map((action) => (
              <Button
                key={action.action}
                disabled={disabled}
                variant={
                  action.action === "confirm_review" ? "default" : "outline"
                }
                onClick={() => onAction(action)}
              >
                {action.action === "confirm_review"
                  ? t("bot.confirmReview")
                  : t("bot.continueEditing")}
              </Button>
            ))}
          </div>
        )}
      </section>
    )
  const previewLabel =
    message.type === "preview_card"
      ? previewHistoryLabel(message, laterRequest)
      : undefined
  const liveStatus =
    message.type === "preview_card" && laterRequest?.type === "status_card"
      ? laterRequest
      : message.type === "status_card"
        ? laterRequest?.type === "status_card"
          ? laterRequest
          : message
        : undefined
  const currentStatus = liveStatus?.status
  const activeActions =
    message.type === "preview_card"
      ? laterRequest
        ? laterRequest.type === "status_card"
          ? laterRequest.actions
          : []
        : message.actions
      : (liveStatus?.actions ?? [])
  const mixed =
    !!liveStatus &&
    (currentStatus === "pending_review" || currentStatus === "withdrawn") &&
    liveStatus.items.some((item) => item.decision === "approved") &&
    liveStatus.items.some((item) => item.decision === null)
  return (
    <section
      className="space-y-4 rounded-xl border bg-background p-4"
      aria-label={
        message.type === "preview_card"
          ? t("bot.previewCardAria")
          : message.type === "status_card"
            ? t("bot.statusCardAria")
            : t("bot.questionCardAria")
      }
    >
      {message.type === "question_card" ? (
        <>
          <h3 className="font-semibold">{message.question}</h3>
          <p className="text-muted-foreground">{message.reason}</p>
          {message.actions.includes("answer_question") ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                onAction({
                  action: "answer_question",
                  question_id: message.id,
                  answer: answer.trim(),
                })
              }}
            >
              <label className="block space-y-2">
                {t("bot.yourAnswer")}
                <textarea
                  aria-label={t("bot.yourAnswer")}
                  className="min-h-24 w-full rounded-md border bg-background p-3"
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  maxLength={10000}
                  disabled={disabled}
                  required
                />
              </label>
              <p className="text-muted-foreground">
                {t("bot.answerSaveNotice")}
              </p>
              <Button disabled={disabled || !answer.trim()}>
                {t("bot.submitAnswer")}
              </Button>
            </form>
          ) : (
            <p>{t("bot.answered")}</p>
          )}
        </>
      ) : (
        <>
          <h3 className="font-semibold">
            {message.type === "preview_card"
              ? previewLabel
                ? t("bot.previewCardTitleWithLabel", { label: previewLabel })
                : t("bot.previewCardTitle")
              : laterRequest?.type === "preview_card"
                ? t("bot.historyExpired")
                : (statuses[currentStatus ?? ""] ??
                  t("bot.statusUpdatedFallback"))}
          </h3>
          {message.type === "preview_card" ? (
            liveStatus ? (
              currentStatus === "pending_review" ? (
                <>
                  <RequestReviewers reviewers={liveStatus.reviewers} />
                  <p>
                    {mixed
                      ? t("bot.partialAutoPublishWaitReview")
                      : liveStatus.actions.length
                        ? t("bot.submittedWithdrawable")
                        : t("bot.submitted")}
                  </p>
                  {mixed && liveStatus.actions.length > 0 && (
                    <p>{t("bot.partialWithdrawNotice")}</p>
                  )}
                </>
              ) : currentStatus ? (
                <p>
                  {t("bot.currentStatus", {
                    status:
                      statuses[currentStatus] ?? t("bot.statusUpdatedFallback"),
                  })}
                </p>
              ) : null
            ) : (
              !previewLabel && (
                <RequestReviewers
                  reviewers={message.reviewers}
                  requiresManager={message.requires_manager}
                  partialAutoPublish={message.partial_auto_publish}
                  preview
                />
              )
            )
          ) : laterRequest?.type === "preview_card" && currentStatus ? (
            <p>
              {t("bot.currentStatus", {
                status:
                  statuses[currentStatus] ?? t("bot.statusUpdatedFallback"),
              })}
            </p>
          ) : liveStatus?.status === "pending_review" ? (
            <RequestReviewers reviewers={liveStatus.reviewers} />
          ) : null}
          {message.type === "preview_card" ? (
            message.items.map((item, index) => {
              const statusItem = liveStatus?.items.find(
                (entry) => entry.capability.key === item.after.capability.key,
              )
              return (
                <div key={index} className="space-y-2 border-t pt-3">
                  <h4 className="font-medium">
                    {item.after.capability.name}
                    {mixed &&
                      statusItem &&
                      (statusItem.decision === "approved" ||
                        statusItem.decision === null) && (
                        <span className="ml-2 text-sm font-medium">
                          {statusItem.decision === "approved"
                            ? t("bot.publishedTentative")
                            : currentStatus === "withdrawn"
                              ? t("bot.statuses.withdrawn")
                              : t("bot.statuses.pending_review")}
                        </span>
                      )}
                  </h4>
                  {item.submission_notice && <p>{item.submission_notice}</p>}
                  <p>
                    {t("bot.fieldColon", { label: t("bot.before") })}
                    {item.before?.statement ?? t("bot.noRecord")}
                    {t("bot.levelInline", {
                      level: displayLevel(
                        item.before,
                        item.after.capability.key,
                      ),
                    })}
                  </p>
                  <p>
                    {t("bot.fieldColon", { label: t("bot.after") })}
                    {item.after.after?.statement ?? t("bot.removeItem")}
                    {t("bot.levelInline", {
                      level: displayLevel(
                        item.after.after,
                        item.after.capability.key,
                      ),
                    })}
                  </p>
                </div>
              )
            })
          ) : (
            <>
              {liveStatus?.status === "pending_review" && (
                <p>
                  {mixed
                    ? t("bot.partialAutoPublishWaitReview")
                    : liveStatus.actions.length
                      ? t("bot.submittedWithdrawable")
                      : t("bot.submitted")}
                </p>
              )}
              {mixed && liveStatus && liveStatus.actions.length > 0 && (
                <p>{t("bot.partialWithdrawNotice")}</p>
              )}
              {(liveStatus ?? message).items.map((item, index) => (
                <p key={index}>
                  {t("bot.itemWithStatement", {
                    name: item.capability.name,
                    statement: item.after?.statement ?? t("bot.removeItem"),
                  })}
                  {t("bot.levelInline", {
                    level: displayLevel(item.after, item.capability.key),
                  })}
                  {mixed &&
                    (item.decision === "approved" ||
                      item.decision === null) && (
                      <span className="ml-2 font-medium">
                        {item.decision === "approved"
                          ? t("bot.publishedTentative")
                          : currentStatus === "withdrawn"
                            ? t("bot.statuses.withdrawn")
                            : t("bot.statuses.pending_review")}
                      </span>
                    )}
                </p>
              ))}
            </>
          )}
          {!!activeActions.length && (
            <div className="flex flex-wrap gap-2">
              {activeActions.map((action) => (
                <Button
                  key={action.action}
                  variant={
                    action.action === "confirm_submit" ? "default" : "outline"
                  }
                  disabled={disabled}
                  onClick={() => onAction(action)}
                >
                  {actionLabels[action.action]}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function PlanDetails({ plan }: { plan: PlanCard }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">{plan.title}</h3>
      <dl className="space-y-2">
        {plan.fields.map((field) => (
          <div key={field.label}>
            <dt className="inline font-medium">
              {t("bot.fieldColon", { label: field.label })}
            </dt>
            <dd className="inline break-words">{field.value}</dd>
          </div>
        ))}
      </dl>
      {plan.changes && <p>{t("bot.planChanges", { changes: plan.changes })}</p>}
      <a href={plan.link} className="underline">
        {t("bot.editOnPlanPage")}
      </a>
      {plan.rule_fallback && (
        <div className="space-y-3 border-t pt-3">
          <h4 className="font-semibold">{t("bot.alternativePlan")}</h4>
          <dl className="space-y-2">
            {plan.rule_fallback.fields.map((field) => (
              <div key={field.label}>
                <dt className="inline font-medium">
                  {t("bot.fieldColon", { label: field.label })}
                </dt>
                <dd className="inline break-words">{field.value}</dd>
              </div>
            ))}
          </dl>
          <p className="font-medium">{t("bot.compareWithRecommended")}</p>
          {plan.rule_fallback.differences.map((field) => (
            <p key={field.label}>
              {t("bot.fieldColon", { label: field.label })}
              {field.value}
            </p>
          ))}
          <a href={plan.rule_fallback.link} className="underline">
            {t("bot.viewAlternativePlan")}
          </a>
        </div>
      )}
    </div>
  )
}
