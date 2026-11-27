import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import type { TFunction } from "i18next"
import { ArrowLeft, CheckCheck, ChevronDown, ListFilter } from "lucide-react"
import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  EmployeeRequestsService,
  type InboxChangeItemDetail,
  type InboxExtensionRequestDetail,
  type InboxKind,
  type InboxList,
  type InboxProfileRequestDetail,
  type InboxPublic,
  type InboxReadAllInput,
  type InboxWorkloadRequestDetail,
  type RequestStatus,
} from "@/client"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import {
  SectionCard,
  WorkspacePage,
} from "@/components/Common/WorkbenchPrimitives"
import { dateLabel, levelLabel, record } from "@/components/Profile/fields"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { StatusBadge } from "@/components/Profile/StatusBadge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useInbox } from "@/hooks/useInbox"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"
import { formatDate, formatDateRange, formatPercent } from "@/i18n/format"
import { cn } from "@/lib/utils"
import { handleError } from "@/utils"

export const Route = createFileRoute("/_layout/inbox")({
  component: InboxPage,
  head: () => ({ meta: [{ title: i18n.t("inbox.pageTitle") }] }),
})

const inboxKinds: InboxKind[] = [
  "capacity",
  "profile_edited",
  "initial_review",
  "question",
  "submitted",
  "status_changed",
  "admin_todos",
  "dictionary_changed",
  "review_requested",
  "decided",
]

function kindLabel(kind: InboxKind, t: TFunction) {
  switch (kind) {
    case "capacity":
      return t("inbox.kinds.capacity")
    case "profile_edited":
      return t("inbox.kinds.profile_edited")
    case "initial_review":
      return t("inbox.kinds.initial_review")
    case "question":
      return t("inbox.kinds.question")
    case "submitted":
      return t("inbox.kinds.submitted")
    case "status_changed":
      return t("inbox.kinds.status_changed")
    case "admin_todos":
      return t("inbox.kinds.admin_todos")
    case "dictionary_changed":
      return t("inbox.kinds.dictionary_changed")
    case "review_requested":
      return t("inbox.kinds.review_requested")
    case "decided":
      return t("inbox.kinds.decided")
  }
}

const demandLink =
  /\n\/capacity\?tab=(incoming|outgoing)&demand=([0-9a-f-]{36})(&plans=1)?$/
const borrowLink = /\n\/capacity\?tab=borrows$/

function capacityDestination(message: string, t: TFunction) {
  const demand = message.match(demandLink)
  if (demand) {
    const plans = demand[1] === "incoming" && demand[3] ? 1 : undefined
    return {
      to: "/capacity",
      search: { tab: demand[1], demand: demand[2], plans },
      label: plans
        ? t("inbox.capacityLinks.openPlans")
        : t("inbox.capacityLinks.viewDetails"),
    } as const
  }
  if (borrowLink.test(message))
    return {
      to: "/capacity",
      search: { tab: "borrows" },
      label: t("inbox.capacityLinks.openBorrows"),
    } as const
  const [title] = message.split("（", 1)
  if (
    title === "借调请求" || // i18n-ignore: 兼容中文与历史借调通知标题路由匹配
    title === "借调请求待你确认" || // i18n-ignore: 兼容中文与历史借调确认通知标题路由匹配
    message.startsWith("Borrow request (") ||
    message.startsWith("Borrow request awaiting your confirmation (")
  )
    return {
      to: "/reviews",
      search: { type: "borrow" },
      label: t("inbox.capacityLinks.viewReviews"),
    } as const
  if (
    title === "有负荷调整申请等你审批" || // i18n-ignore: 兼容中文与历史负荷审批通知标题路由匹配
    title === "有延期申请等你审批" || // i18n-ignore: 兼容中文与历史延期审批通知标题路由匹配
    message.startsWith(
      "You have a workload adjustment request awaiting approval",
    ) ||
    message.startsWith("You have an extension request awaiting approval")
  )
    return {
      to: "/reviews",
      search: { type: "workload" },
      label: t("inbox.capacityLinks.viewReviews"),
    } as const
  if (
    message.startsWith("收到新的协作需求") || // i18n-ignore: 兼容中文与历史协作需求通知路由匹配
    message.startsWith("协作需求收到追问") || // i18n-ignore: 兼容中文与历史协作追问通知路由匹配
    message.startsWith("New collaboration demand received") ||
    message.startsWith("Collaboration demand received a follow-up")
  )
    return {
      to: "/reviews",
      search: { type: "demand" },
      label: t("inbox.capacityLinks.viewDetails"),
    } as const
  if (
    message.startsWith("协作需求已收到答复") || // i18n-ignore: 兼容中文与历史协作答复通知路由匹配
    message.startsWith("Collaboration demand received a reply")
  )
    return {
      to: "/capacity",
      search: { tab: "outgoing" },
      label: t("inbox.capacityLinks.viewDetails"),
    } as const
  return {
    to: "/capacity",
    search: {},
    label: t("inbox.capacityLinks.viewDetails"),
  } as const
}

function CapacityNoticeLink({
  message,
  onClick,
}: {
  message: string
  onClick: () => void
}) {
  const { t } = useTranslation()
  const { label, ...link } = capacityDestination(message, t)
  return (
    <Button variant="outline" asChild>
      <Link {...link} onClick={onClick}>
        {label}
      </Link>
    </Button>
  )
}

function messageText(item: InboxPublic) {
  if (item.kind === "capacity")
    return item.message.replace(demandLink, "").replace(borrowLink, "")
  if (item.kind === "admin_todos")
    return item.message.replace(
      /^(你有 \d+ 条管理员待办，)请在网页首页处理。$/,
      "$1请前往网页「协同 → AI 助手（企业管理）」处理。", // i18n-ignore: 改写历史中文管理员待办通知文案
    )
  return item.message
}

function KindBadge({ kind }: { kind: InboxKind }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs leading-none",
        kind === "question" || kind === "initial_review"
          ? "border-primary/20 bg-primary/10 text-primary"
          : "border-surface-border bg-muted text-muted-foreground",
      )}
    >
      {kindLabel(kind, t)}
    </span>
  )
}

function QuestionAnswer({
  orgId,
  questionId,
  onAnswerStart,
  onAnswered,
}: {
  orgId: string
  questionId: string
  onAnswerStart: () => void
  onAnswered: () => void
}) {
  const { t } = useTranslation()
  const quickReplies = [
    t("inbox.question.quickReplies.solo"),
    t("inbox.question.quickReplies.support"),
    t("inbox.question.quickReplies.later"),
  ]
  const cache = useQueryClient()
  const [answer, setAnswer] = useState("")
  const input = useRef<HTMLTextAreaElement>(null)
  const [error, setError] = useState("")
  const query = useQuery({
    queryKey: ["question", orgId, questionId],
    queryFn: async () =>
      (
        await EmployeeRequestsService.readQuestion({
          path: { org_id: orgId, question_id: questionId },
        })
      ).data,
    retry: false,
  })
  const mutation = useMutation({
    mutationFn: async () =>
      (
        await EmployeeRequestsService.answerQuestion({
          path: { org_id: orgId, question_id: questionId },
          body: { answer: answer.trim() },
        })
      ).data,
    onSuccess: (data) => {
      cache.setQueryData(["question", orgId, questionId], data)
      onAnswered()
      cache.invalidateQueries({ queryKey: ["inbox", orgId] })
      cache.invalidateQueries({ queryKey: ["evidence", orgId] })
      setAnswer("")
      setError("")
    },
    onError: (err) => handleError.call(setError, err),
  })
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  if (query.data.status !== "open")
    return (
      <p role="status">
        {query.data.status === "answered"
          ? t("inbox.question.answered")
          : t("inbox.question.closed")}
      </p>
    )
  const inputId = `answer-${questionId}`
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!answer.trim() || mutation.isPending) return
        setError("")
        onAnswerStart()
        mutation.mutate()
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t("inbox.question.reason", { reason: query.data.reason })}
      </p>
      <fieldset className="flex min-w-0 flex-wrap gap-1.5">
        <legend className="sr-only">
          {t("inbox.question.quickRepliesAria")}
        </legend>
        {quickReplies.map((reply) => (
          <Button
            key={reply}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto max-w-full rounded-full py-1 whitespace-normal text-left text-xs shadow-none aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:bg-primary/10"
            aria-pressed={answer === reply}
            disabled={mutation.isPending}
            onClick={() => {
              setAnswer(reply)
              input.current?.focus()
            }}
          >
            {reply}
          </Button>
        ))}
      </fieldset>
      <label htmlFor={inputId} className="block text-sm font-medium">
        {t("inbox.question.answerLabel")}
      </label>
      <textarea
        id={inputId}
        ref={input}
        className="min-h-20 w-full rounded-md border bg-background p-2.5 text-sm"
        required
        maxLength={10000}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        disabled={mutation.isPending}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("inbox.question.restrictedHint")}
        </p>
        <Button
          size="sm"
          type="submit"
          disabled={!answer.trim() || mutation.isPending}
        >
          {mutation.isPending
            ? t("inbox.question.submitting")
            : t("inbox.question.submit")}
        </Button>
      </div>
    </form>
  )
}

function dateTimeLabel(value: string | null | undefined) {
  return value
    ? formatDate(value, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—"
}

function displayLevel(rubric: unknown, level: string | null | undefined) {
  if (!level) return i18n.t("inbox.profileDetail.ungraded")
  if (
    record(rubric) &&
    Array.isArray(rubric.levels) &&
    !rubric.levels.some(
      (entry: unknown) => record(entry) && entry.key === level,
    )
  )
    return level
  return levelLabel(rubric, level)
}

function ProfileChangeItemCard({ item }: { item: InboxChangeItemDetail }) {
  const { t } = useTranslation()
  const itemDecisionMeta = {
    approved: {
      label: t("inbox.itemDecision.approved"),
      className:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    },
    changes_requested: {
      label: t("inbox.itemDecision.rejected"),
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    },
    rejected: {
      label: t("inbox.itemDecision.rejected"),
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    },
  } as const
  const decision = item.decision ? itemDecisionMeta[item.decision] : null
  const beforeLevel = item.before
    ? displayLevel(item.capability_level_rubric, item.before.level)
    : t("inbox.profileDetail.noRecord")
  const afterLevel = item.after
    ? displayLevel(item.capability_level_rubric, item.after.level)
    : null
  return (
    <details
      open
      className="group rounded-lg border border-surface-border bg-muted/20"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span>{item.capability_name}</span>
        <span className="inline-flex items-center gap-2">
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs leading-none",
              decision
                ? decision.className
                : "border-surface-border bg-muted text-muted-foreground",
            )}
          >
            {decision ? decision.label : t("inbox.itemDecision.pending")}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </span>
      </summary>
      <div className="space-y-2 border-surface-border border-t px-3 py-2.5 text-sm">
        {item.op === "add" && item.after && (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">
                {t("inbox.profileDetail.addedLevel")}
              </span>
              <span className="font-medium">{afterLevel}</span>
              {item.after.assessment_status && (
                <StatusBadge
                  kind="assessment_status"
                  value={item.after.assessment_status}
                />
              )}
            </div>
            <p className="whitespace-pre-wrap break-words">
              <span className="text-muted-foreground">
                {t("inbox.profileDetail.addedStatement")}
              </span>
              {item.after.statement}
            </p>
          </div>
        )}
        {item.op === "modify" && (
          <div className="space-y-2">
            <div className="rounded-md border border-surface-border bg-surface p-2.5">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{t("inbox.profileDetail.beforeLabel")}</span>
                <span className="font-medium text-foreground">
                  {beforeLevel}
                </span>
                {item.before?.assessment_status && (
                  <StatusBadge
                    kind="assessment_status"
                    value={item.before.assessment_status}
                  />
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {item.before?.statement ??
                  t("inbox.profileDetail.originalRecord")}
              </p>
            </div>
            {item.after && (
              <div className="rounded-md border border-surface-border bg-surface p-2.5">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{t("inbox.profileDetail.afterLabel")}</span>
                  <span className="font-medium text-foreground">
                    {afterLevel}
                  </span>
                  {item.after.assessment_status && (
                    <StatusBadge
                      kind="assessment_status"
                      value={item.after.assessment_status}
                    />
                  )}
                </div>
                <p className="whitespace-pre-wrap break-words">
                  {item.after.statement}
                </p>
              </div>
            )}
          </div>
        )}
        {item.op === "retract" && (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">
                {t("inbox.profileDetail.retractPrefix")}
              </span>
              <span>{beforeLevel}</span>
              <span className="text-muted-foreground">
                {t("inbox.profileDetail.retractArrow")}
              </span>
            </div>
            {item.before?.statement && (
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {item.before.statement}
              </p>
            )}
          </div>
        )}
        {item.op === "attach_evidence" && (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">
                {t("inbox.profileDetail.attachPrefix")}
              </span>
              <span>{beforeLevel}</span>
              <span className="text-muted-foreground">
                {t("inbox.profileDetail.attachArrow")}
              </span>
            </div>
            {item.before?.statement && (
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {item.before.statement}
              </p>
            )}
          </div>
        )}
        {item.decision_reason && (
          <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2.5 py-1.5 text-sm">
            <span className="font-medium">
              {t("inbox.profileDetail.managerReason")}
            </span>
            {item.decision_reason}
          </p>
        )}
      </div>
    </details>
  )
}

function ProfileRequestResultDetail({
  detail,
  fallbackCreatedAt,
}: {
  detail: InboxProfileRequestDetail
  fallbackCreatedAt: string
}) {
  const { t } = useTranslation()
  const requestStatusLabels: Record<RequestStatus, string> = {
    draft: t("inbox.requestStatus.draft"),
    pending_owner: t("inbox.requestStatus.pending_owner"),
    pending_review: t("inbox.requestStatus.pending_review"),
    approved: t("inbox.requestStatus.approved"),
    changes_requested: t("inbox.requestStatus.changes_requested"),
    rejected: t("inbox.requestStatus.rejected"),
    withdrawn: t("inbox.requestStatus.withdrawn"),
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="rounded-full border border-surface-border bg-muted px-2 py-0.5 font-medium text-foreground">
          {requestStatusLabels[detail.status]}
        </span>
        {detail.reviewer_name && (
          <span>
            {t("inbox.profileDetail.reviewer", { name: detail.reviewer_name })}
          </span>
        )}
        <span>
          {t("inbox.profileDetail.time", {
            time: dateTimeLabel(detail.decided_at ?? fallbackCreatedAt),
          })}
        </span>
      </div>
      {detail.decision_comment && (
        <p className="whitespace-pre-wrap break-words rounded-md border border-surface-border bg-muted/30 px-3 py-2 text-sm">
          <span className="font-medium">
            {t("inbox.profileDetail.decisionComment")}
          </span>
          {detail.decision_comment}
        </p>
      )}
      {detail.items && detail.items.length > 0 && (
        <div className="space-y-2">
          {detail.items.map((entry) => (
            <ProfileChangeItemCard key={entry.id} item={entry} />
          ))}
        </div>
      )}
    </div>
  )
}

function WorkloadRequestResultDetail({
  detail,
  fallbackCreatedAt,
}: {
  detail: InboxWorkloadRequestDetail
  fallbackCreatedAt: string
}) {
  const { t } = useTranslation()
  const capacityStatusMeta = {
    approved: {
      label: t("inbox.capacityStatus.approved"),
      className:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    },
    returned: {
      label: t("inbox.capacityStatus.returned"),
      className:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    },
    pending: {
      label: t("inbox.capacityStatus.pending"),
      className: "border-surface-border bg-muted text-muted-foreground",
    },
  } as const
  const status = capacityStatusMeta[detail.status]
  const requestedPct = formatPercent(detail.requested_percent / 100)
  return (
    <div className="space-y-2.5 rounded-lg border border-surface-border bg-muted/20 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 font-medium leading-none",
            status.className,
          )}
        >
          {status.label}
        </span>
        {detail.reviewer_name && (
          <span>
            {t("inbox.workloadDetail.reviewer", { name: detail.reviewer_name })}
          </span>
        )}
        <span>
          {t("inbox.workloadDetail.time", {
            time: dateTimeLabel(detail.decided_at ?? fallbackCreatedAt),
          })}
        </span>
      </div>
      <p>
        <span className="text-muted-foreground">
          {t("inbox.workloadDetail.changeLabel")}
        </span>
        {detail.before_percent != null
          ? detail.status === "approved"
            ? t("inbox.workloadDetail.changeApproved", {
                before: formatPercent(detail.before_percent / 100),
                after: requestedPct,
              })
            : t("inbox.workloadDetail.changeRequested", {
                before: formatPercent(detail.before_percent / 100),
                after: requestedPct,
              })
          : t("inbox.workloadDetail.changeNew", { after: requestedPct })}
      </p>
      <p>
        <span className="text-muted-foreground">
          {t("inbox.workloadDetail.weeksLabel")}
        </span>
        {detail.start_week
          ? detail.end_week
            ? formatDateRange(detail.start_week, detail.end_week)
            : formatDate(detail.start_week)
          : t("inbox.workloadDetail.approvedWeek")}
      </p>
      <p className="whitespace-pre-wrap break-words">
        <span className="text-muted-foreground">
          {t("inbox.workloadDetail.reasonLabel")}
        </span>
        {detail.reason}
      </p>
      {detail.decision_note && (
        <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2.5 py-1.5">
          <span className="font-medium">
            {t("inbox.workloadDetail.managerReason")}
          </span>
          {detail.decision_note}
        </p>
      )}
    </div>
  )
}

function ExtensionRequestResultDetail({
  detail,
  fallbackCreatedAt,
}: {
  detail: InboxExtensionRequestDetail
  fallbackCreatedAt: string
}) {
  const { t } = useTranslation()
  const capacityStatusMeta = {
    approved: {
      label: t("inbox.capacityStatus.approved"),
      className:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    },
    returned: {
      label: t("inbox.capacityStatus.returned"),
      className:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    },
    pending: {
      label: t("inbox.capacityStatus.pending"),
      className: "border-surface-border bg-muted text-muted-foreground",
    },
  } as const
  const status = capacityStatusMeta[detail.status]
  const targetDate = detail.new_due_date ?? detail.requested_due_date
  return (
    <div className="space-y-2.5 rounded-lg border border-surface-border bg-muted/20 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 font-medium leading-none",
            status.className,
          )}
        >
          {status.label}
        </span>
        {detail.reviewer_name && (
          <span>
            {t("inbox.extensionDetail.reviewer", {
              name: detail.reviewer_name,
            })}
          </span>
        )}
        <span>
          {t("inbox.extensionDetail.time", {
            time: dateTimeLabel(detail.decided_at ?? fallbackCreatedAt),
          })}
        </span>
      </div>
      <p>
        <span className="text-muted-foreground">
          {t("inbox.extensionDetail.capabilityLabel")}
        </span>
        <span className="font-medium">{detail.capability_name}</span>
      </p>
      <p>
        <span className="text-muted-foreground">
          {t("inbox.extensionDetail.changeLabel")}
        </span>
        {detail.status === "approved"
          ? t("inbox.extensionDetail.changeApproved", {
              before: detail.before_due_date ?? "—",
              after: targetDate,
            })
          : t("inbox.extensionDetail.changeRequested", {
              before: detail.before_due_date ?? "—",
              after: targetDate,
            })}
      </p>
      <p className="whitespace-pre-wrap break-words">
        <span className="text-muted-foreground">
          {t("inbox.extensionDetail.reasonLabel")}
        </span>
        {detail.reason}
      </p>
      {detail.decision_note && (
        <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2.5 py-1.5">
          <span className="font-medium">
            {t("inbox.extensionDetail.managerReason")}
          </span>
          {detail.decision_note}
        </p>
      )}
    </div>
  )
}

function InboxApprovalDetail({
  orgId,
  item,
  employeeId,
  onActionClick,
}: {
  orgId: string
  item: InboxPublic
  employeeId: string | null | undefined
  onActionClick: () => void
}) {
  const { t, i18n } = useTranslation()
  const query = useQuery({
    queryKey: ["inbox-detail", orgId, item.id, i18n.language],
    queryFn: async () =>
      (
        await EmployeeRequestsService.readInboxItemDetail({
          path: { org_id: orgId, inbox_id: item.id },
        })
      ).data,
    retry: false,
  })
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  const detail = query.data
  if (
    !detail.profile_request &&
    !detail.workload_request &&
    !detail.extension_request
  ) {
    if (item.kind === "capacity" || item.question_id) return null
    return (
      <p className="text-sm text-muted-foreground">
        {t("inbox.approvalDetail.summaryOnly")}
      </p>
    )
  }
  return (
    <div className="space-y-3">
      {detail.profile_request && (
        <ProfileRequestResultDetail
          detail={detail.profile_request}
          fallbackCreatedAt={item.created_at}
        />
      )}
      {detail.workload_request && (
        <WorkloadRequestResultDetail
          detail={detail.workload_request}
          fallbackCreatedAt={item.created_at}
        />
      )}
      {detail.extension_request && (
        <ExtensionRequestResultDetail
          detail={detail.extension_request}
          fallbackCreatedAt={item.created_at}
        />
      )}
      {detail.profile_request &&
        item.request_id &&
        item.kind === "review_requested" &&
        !item.done_at && (
          <Button variant="outline" size="sm" asChild>
            <Link
              to="/reviews/$requestId"
              params={{ requestId: item.request_id }}
              onClick={onActionClick}
            >
              {t("inbox.approvalDetail.reviewAction")}
            </Link>
          </Button>
        )}
      {detail.profile_request &&
        item.request_id &&
        employeeId &&
        item.kind !== "review_requested" && (
          <Button variant="outline" size="sm" asChild>
            <Link
              to="/employees/$employeeId"
              params={{ employeeId }}
              onClick={onActionClick}
            >
              {t("inbox.approvalDetail.viewDetails")}
            </Link>
          </Button>
        )}
    </div>
  )
}

function InboxPage() {
  const { org, employeeId } = useOrg()
  if (!org) return <OrgState />
  return (
    <InboxContent
      key={`${org.id}:${employeeId}`}
      orgId={org.id}
      employeeId={employeeId}
    />
  )
}

function InboxContent({
  orgId,
  employeeId,
}: {
  orgId: string
  employeeId: string | null | undefined
}) {
  const { t } = useTranslation()
  const [skip, setSkip] = useState(0)
  const [selected, setSelected] = useState<{
    item: InboxPublic
    answered?: boolean
  } | null>(null)
  const [pendingOnly, setPendingOnly] = useState(false)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [kind, setKind] = useState<InboxKind>()
  const [error, setError] = useState("")
  const query = useInbox({ skip, pendingOnly, unreadOnly, kind })
  const cache = useQueryClient()
  const pendingReadIds = useRef(new Set<string>())
  const read = useMutation({
    mutationFn: (id: string) =>
      EmployeeRequestsService.readInboxItem({
        path: { org_id: orgId, inbox_id: id },
      }),
    onMutate: async (id) => {
      setError("")
      pendingReadIds.current.add(id)
      await cache.cancelQueries({ queryKey: ["inbox", orgId] })
      const previous = cache.getQueriesData<InboxList>({
        queryKey: ["inbox", orgId],
      })
      const now = new Date().toISOString()
      cache.setQueriesData<InboxList>(
        { queryKey: ["inbox", orgId] },
        (data) => {
          if (!data) return data
          const target = data.data.find((row) => row.id === id)
          if (target?.read_at) return data
          return {
            ...data,
            unread_count: Math.max(0, data.unread_count - 1),
            filtered_unread_count: target
              ? Math.max(0, data.filtered_unread_count - 1)
              : data.filtered_unread_count,
            data: data.data.map((row) =>
              row.id === id && !row.read_at ? { ...row, read_at: now } : row,
            ),
          }
        },
      )
      setSelected((current) =>
        current?.item.id === id && !current.item.read_at
          ? { ...current, item: { ...current.item, read_at: now } }
          : current,
      )
      return { previous }
    },
    onError: (err, id, context) => {
      for (const [key, snapshot] of context?.previous ?? []) {
        cache.setQueryData(key, snapshot)
      }
      setSelected((current) =>
        current?.item.id === id
          ? { ...current, item: { ...current.item, read_at: null } }
          : current,
      )
      handleError.call(setError, err)
    },
    onSettled: (_data, _err, id) => {
      pendingReadIds.current.delete(id)
      cache.invalidateQueries({ queryKey: ["inbox", orgId] })
    },
  })
  const readAll = useMutation({
    mutationFn: (filters: InboxReadAllInput) =>
      EmployeeRequestsService.readAllInbox({
        path: { org_id: orgId },
        body: filters,
      }),
    onMutate: () => setError(""),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["inbox", orgId] }),
    onError: (err) => handleError.call(setError, err),
  })
  const rows = query.data?.data ?? []
  if (skip > 0 && query.isSuccess && !query.isFetching && !rows.length) {
    setSkip(0)
    if (!selected?.answered) setSelected(null)
  }
  const currentRow = selected
    ? rows.find((row) => row.id === selected.item.id)
    : rows[0]
  const item = currentRow ?? selected?.item
  const filtered = pendingOnly || unreadOnly || kind !== undefined
  const reading = read.isPending || readAll.isPending
  const markItemRead = (id: string) => {
    if (!pendingReadIds.current.has(id)) read.mutate(id)
  }
  const openItem = (row: InboxPublic) => {
    setSelected({ item: row })
    if (!row.read_at) markItemRead(row.id)
  }
  const markRead = () => {
    if (currentRow && !currentRow.read_at) markItemRead(currentRow.id)
  }
  return (
    <WorkspacePage
      variant="split"
      className="grid items-start md:grid-cols-[minmax(0,min(360px,44%))_minmax(0,1fr)]"
    >
      <h1 className="sr-only">{t("inbox.heading")}</h1>
      <TopbarActions>
        <Button
          variant="outline"
          size="sm"
          title={
            filtered
              ? t("inbox.toolbar.markFilteredTitle")
              : t("inbox.toolbar.markAllTitle")
          }
          disabled={!query.data?.filtered_unread_count || reading}
          onClick={() =>
            readAll.mutate({
              pending_only: pendingOnly,
              unread_only: unreadOnly,
              kind,
            })
          }
        >
          <CheckCheck aria-hidden="true" />
          {filtered
            ? t("inbox.toolbar.markFiltered")
            : t("inbox.toolbar.markAll")}
        </Button>
      </TopbarActions>
      <p role="status" className="sr-only">
        {t("inbox.toolbar.statusSummary", {
          unread: query.data?.unread_count ?? 0,
          pending: query.data?.pending_count ?? 0,
        })}
      </p>
      {error && (
        <p
          role="alert"
          className="px-3 py-2 text-sm text-destructive md:col-span-2"
        >
          {error}
        </p>
      )}
      <aside
        aria-label={t("inbox.list.ariaLabel")}
        className={cn(
          "min-w-0 border-surface-border bg-surface md:h-[calc(100dvh-3rem)] md:overflow-y-auto md:border-r",
          item && selected && "hidden md:block",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-surface-border border-b px-3 py-2.5">
          <fieldset className="inline-flex min-w-0 gap-0.5 rounded-md bg-muted p-0.5">
            <legend className="sr-only">{t("inbox.list.viewLegend")}</legend>
            {[true, false].map((pending) => (
              <Button
                key={String(pending)}
                variant="ghost"
                size="sm"
                className="h-7 aria-pressed:bg-surface aria-pressed:shadow-xs"
                aria-pressed={pendingOnly === pending}
                onClick={() => {
                  setPendingOnly(pending)
                  setSelected(null)
                  setSkip(0)
                }}
              >
                {pending ? t("inbox.list.pendingTab") : t("inbox.list.allTab")}
                <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">
                  {(pending
                    ? query.data?.pending_count
                    : query.data?.total_count) ?? 0}
                </span>
              </Button>
            ))}
          </fieldset>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn("h-7", (unreadOnly || kind) && "text-primary")}
              >
                <ListFilter aria-hidden="true" /> {t("inbox.list.filterButton")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuCheckboxItem
                checked={unreadOnly}
                onCheckedChange={(checked) => {
                  setUnreadOnly(checked)
                  setSelected(null)
                  setSkip(0)
                }}
              >
                {t("inbox.list.unreadOnly")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("inbox.list.byKind")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={kind ?? "all"}
                onValueChange={(value) => {
                  setKind(inboxKinds.find((entry) => entry === value))
                  setSelected(null)
                  setSkip(0)
                }}
              >
                <DropdownMenuRadioItem value="all">
                  {t("inbox.list.allKinds")}
                </DropdownMenuRadioItem>
                {inboxKinds.map((value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {kindLabel(value, t)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {query.isPending ? (
          <ProfileLoading />
        ) : query.isError ? (
          <ProfileError retry={() => query.refetch()} />
        ) : (
          <>
            {!rows.length && (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {t("inbox.list.empty")}
              </p>
            )}
            <ul className="divide-y divide-surface-border border-surface-border border-b">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-current={item?.id === row.id ? "true" : undefined}
                    onClick={() => openItem(row)}
                    className="flex w-full min-w-0 items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/70 focus-visible:outline-primary aria-current:bg-primary/5"
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        !row.read_at && "bg-blue-600",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center justify-between gap-1">
                        <KindBadge kind={row.kind} />
                        <time
                          dateTime={row.created_at}
                          className="text-xs text-muted-foreground"
                        >
                          {dateLabel(row.created_at)}
                        </time>
                      </span>
                      {!row.read_at && (
                        <span className="sr-only">
                          {t("inbox.list.unreadSr")}
                        </span>
                      )}
                      <span
                        className={cn(
                          "block truncate text-sm",
                          !row.read_at && "font-semibold",
                        )}
                      >
                        {messageText(row)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {query.data.count > 20 && (
              <nav
                aria-label={t("inbox.list.paginationAria")}
                className="flex flex-wrap items-center justify-between gap-1 p-2 text-xs"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={skip === 0}
                  onClick={() => {
                    setSkip(skip - 20)
                    setSelected(null)
                  }}
                >
                  {t("inbox.list.prevPage")}
                </Button>
                {t("inbox.list.pageSummary", {
                  page: skip / 20 + 1,
                  count: query.data.count,
                })}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={skip + 20 >= query.data.count}
                  onClick={() => {
                    setSkip(skip + 20)
                    setSelected(null)
                  }}
                >
                  {t("inbox.list.nextPage")}
                </Button>
              </nav>
            )}
          </>
        )}
      </aside>
      <div
        className={cn(
          "min-w-0 p-3 md:max-h-[calc(100dvh-3rem)] md:overflow-y-auto md:p-4",
          (!item || !selected) && "hidden md:block",
        )}
      >
        {item && (
          <>
            <Button
              className="mb-2 md:hidden"
              variant="ghost"
              size="sm"
              onClick={() => setSelected(null)}
            >
              <ArrowLeft aria-hidden="true" />{" "}
              {t("inbox.detailPane.backToList")}
            </Button>
            <SectionCard
              aria-label={t("inbox.detailPane.ariaLabel")}
              className="p-0"
            >
              <header className="flex flex-wrap items-center gap-2 border-surface-border border-b px-3 py-2 sm:px-4">
                <KindBadge kind={item.kind} />
                <time
                  dateTime={item.created_at}
                  className="text-xs text-muted-foreground"
                >
                  {dateLabel(item.created_at)}
                </time>
                {currentRow && !currentRow.read_at && (
                  <Button
                    className="ml-auto"
                    variant="ghost"
                    size="sm"
                    disabled={reading}
                    onClick={markRead}
                  >
                    {t("inbox.detailPane.markRead")}
                  </Button>
                )}
              </header>
              <h2 className="whitespace-pre-wrap wrap-anywhere px-3 py-3 text-base font-semibold sm:px-4">
                {messageText(item)}
              </h2>
              {(item.question_id ||
                item.kind === "capacity" ||
                item.request_id ||
                item.workload_request_id ||
                item.extension_request_id) && (
                <div className="space-y-3 border-surface-border border-t p-3 sm:p-4">
                  {(item.request_id ||
                    item.workload_request_id ||
                    item.extension_request_id) && (
                    <InboxApprovalDetail
                      key={item.id}
                      orgId={orgId}
                      item={item}
                      employeeId={employeeId}
                      onActionClick={markRead}
                    />
                  )}
                  {item.question_id && (
                    <QuestionAnswer
                      key={item.question_id}
                      orgId={orgId}
                      questionId={item.question_id}
                      onAnswerStart={() => setSelected({ item })}
                      onAnswered={() =>
                        setSelected((selection) =>
                          selection?.item.id === item.id
                            ? { ...selection, answered: true }
                            : selection,
                        )
                      }
                    />
                  )}
                  {item.kind === "capacity" && (
                    <CapacityNoticeLink
                      message={item.message}
                      onClick={markRead}
                    />
                  )}
                </div>
              )}
            </SectionCard>
          </>
        )}
      </div>
    </WorkspacePage>
  )
}
