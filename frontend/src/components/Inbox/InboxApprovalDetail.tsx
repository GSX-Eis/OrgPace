import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronDown } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  EmployeeRequestsService,
  type InboxChangeItemDetail,
  type InboxExtensionRequestDetail,
  type InboxProfileRequestDetail,
  type InboxPublic,
  type InboxWorkloadRequestDetail,
  type RequestStatus,
} from "@/client"
import { levelLabel, record } from "@/components/Profile/fields"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { StatusBadge } from "@/components/Profile/StatusBadge"
import { Button } from "@/components/ui/button"
import i18n from "@/i18n"
import { formatDate, formatDateRange, formatPercent } from "@/i18n/format"
import { cn } from "@/lib/utils"

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

function capacityStatusMeta(t: ReturnType<typeof useTranslation>["t"]) {
  return {
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
  const status = capacityStatusMeta(t)[detail.status]
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
  const status = capacityStatusMeta(t)[detail.status]
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

export function InboxApprovalDetail({
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
  const { t, i18n: i18next } = useTranslation()
  const query = useQuery({
    queryKey: ["inbox-detail", orgId, item.id, i18next.language],
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
