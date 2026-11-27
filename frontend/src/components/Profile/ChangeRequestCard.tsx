import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { TFunction } from "i18next"
import { ChevronDown } from "lucide-react"
import { type ReactNode, useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type ChangeItemPublic,
  type ChangeRequestPublic,
  EmployeeRequestsService,
  type ProfileItem,
  type RequestStatus,
} from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AppealItem } from "./AppealItem"
import type { EditorSelection } from "./ChangeRequestEditor"
import { EvidenceRows } from "./EvidenceList"
import { levelLabel, record } from "./fields"
import { RequestReviewers } from "./RequestReviewers"
import {
  decisionLabels,
  RequestSourceBadge,
  RequestTimeline,
} from "./RequestTimeline"
import { StatusBadge } from "./StatusBadge"
import { activeEvidence, cloneWithdrawnItems } from "./withdrawnRequest"

function requestSummary(request: ChangeRequestPublic, t: TFunction) {
  const statusLabels: Record<RequestStatus, string> = {
    draft: t("profile.request.statusLabels.draft"),
    pending_owner: t("profile.request.statusLabels.pending_owner"),
    pending_review: t("profile.request.statusLabels.pending_review"),
    approved: t("profile.request.statusLabels.approved"),
    changes_requested: t("profile.request.statusLabels.changes_requested"),
    rejected: t("profile.request.statusLabels.rejected"),
    withdrawn: t("profile.request.statusLabels.withdrawn"),
  }
  const items = request.items ?? []
  const itemLabels: Record<string, string> = {
    approved: t("profile.request.summaryLabels.approved"),
    changes_requested: t("profile.request.summaryLabels.rejected"),
    rejected: t("profile.request.summaryLabels.rejected"),
    pending: t("profile.request.summaryLabels.pending"),
  }
  const countsMap = new Map<string, number>()
  for (const item of items) {
    const label = itemLabels[item.decision ?? "pending"]
    if (label) {
      countsMap.set(label, (countsMap.get(label) ?? 0) + 1)
    }
  }
  const counts = Array.from(countsMap.entries()).map(([label, count]) => ({
    label,
    count,
  }))
  return counts.length > 1 && request.status !== "withdrawn"
    ? counts
        .map(({ label, count }) =>
          t("profile.request.summaryItemCount", { count, label }),
        )
        .join(t("profile.request.summaryListSeparator"))
    : t("profile.request.summarySingle", {
        status: statusLabels[request.status],
        count: items.length,
      })
}

function isRejectedItem(decision?: string | null) {
  return decision === "rejected" || decision === "changes_requested"
}

function findActiveChild(
  requestId: string,
  requests: ChangeRequestPublic[],
): ChangeRequestPublic | undefined {
  return requests.find(
    (candidate) =>
      candidate.parent_request_id === requestId &&
      candidate.status !== "withdrawn",
  )
}

function findLatestDescendant(
  requestId: string,
  requests: ChangeRequestPublic[],
): ChangeRequestPublic | undefined {
  const visited = new Set([requestId])
  let current = findActiveChild(requestId, requests)
  if (!current) return undefined
  while (!visited.has(current.id)) {
    visited.add(current.id)
    const next = findActiveChild(current.id, requests)
    if (!next) break
    current = next
  }
  return current
}

export type FocusedRequest = { id: string; seq: number }

export function ChangeRequestCard({
  requests,
  employeeId,
  isOwner,
  onEvidence,
  orgId,
  onEdit,
  compact = false,
  profileItems = [],
  focusedRequest,
}: {
  compact?: boolean
  profileItems?: ProfileItem[]
  requests: ChangeRequestPublic[]
  focusedRequest?: FocusedRequest | null
  employeeId: string
  isOwner: boolean
  onEvidence: (id: string) => void
  orgId: string
  onEdit: (selection: EditorSelection) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [localFocus, setLocalFocus] = useState<FocusedRequest | null>(null)
  const activeFocus = localFocus ?? focusedRequest
  useEffect(() => {
    if (focusedRequest) setLocalFocus(null)
  }, [focusedRequest])
  useEffect(() => {
    if (!activeFocus?.id || !requests.some(({ id }) => id === activeFocus.id))
      return
    const request = document.getElementById(`request-${activeFocus.id}`)
    const disclosure = request?.closest("details")
    if (disclosure) disclosure.open = true
    request?.scrollIntoView({ block: "center" })
  }, [activeFocus, requests])
  const withdraw = useMutation({
    mutationFn: (id: string) =>
      EmployeeRequestsService.withdrawRequest({
        path: { org_id: orgId, request_id: id },
      }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["change-requests", orgId] }),
        client.invalidateQueries({ queryKey: ["profile", orgId] }),
        client.invalidateQueries({ queryKey: ["profile-versions", orgId] }),
        client.invalidateQueries({ queryKey: ["inbox", orgId] }),
        client.invalidateQueries({ queryKey: ["reviews", orgId] }),
        client.invalidateQueries({ queryKey: ["employees", orgId] }),
        client.invalidateQueries({ queryKey: ["employee", orgId] }),
        client.invalidateQueries({ queryKey: ["coverage", orgId] }),
      ]),
  })
  const pending = requests.filter(
    (request) =>
      ["initial_sync", "import"].includes(request.origin) &&
      request.status === "pending_owner",
  )
  const others = requests.filter((request) => !pending.includes(request))
  const open = others.filter((request) =>
    ["draft", "pending_owner", "pending_review"].includes(request.status),
  )
  const actionable = others.filter((request) => open.includes(request))
  const groups = [
    {
      title: t("profile.request.otherPendingTitle"),
      requests: actionable,
      pending: true,
    },
    {
      title: t("profile.request.processedTitle"),
      requests: others.filter((request) => !actionable.includes(request)),
      pending: false,
    },
  ]
  return (
    <div className="empty:hidden space-y-2">
      <SetupError error={withdraw.error} />
      {pending.map((initial) => {
        const confirmPrefix = isOwner
          ? t("profile.request.pendingYourConfirm")
          : t("profile.request.pendingOwnerConfirm")
        const draftName =
          initial.origin === "import"
            ? t("profile.request.importedProfileName")
            : t("profile.request.initialDraftName")
        return (
          <RequestDisclosure
            key={initial.id}
            id={`request-${initial.id}`}
            label={
              initial.origin === "import"
                ? t("profile.request.importDraftLabel")
                : t("profile.request.initialDraftLabel")
            }
            summary={t("profile.request.pendingSummary", {
              prefix: confirmPrefix,
              name: draftName,
              count: initial.items?.length ?? 0,
            })}
            pending
          >
            <div className="space-y-2">
              <h2 className="sr-only">
                {confirmPrefix}
                {draftName}
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {initial.origin === "import"
                  ? isOwner
                    ? t("profile.request.importIntroOwner")
                    : t("profile.request.importIntroOther")
                  : isOwner
                    ? t("profile.request.initialIntroOwner")
                    : t("profile.request.initialIntroOther")}
              </p>
            </div>
            {!initial.items?.length && (
              <div className="space-y-3">
                <p>{t("profile.request.noInitialItems")}</p>
                {isOwner && (
                  <Button
                    variant="outline"
                    onClick={() => onEdit({ request: initial })}
                  >
                    {t("profile.request.supplementInitial")}
                  </Button>
                )}
              </div>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              {(initial.items ?? []).map((item) => (
                <section
                  key={item.id}
                  aria-label={t("profile.request.draftItemAria", {
                    name: item.capability.name,
                  })}
                  className="space-y-2 rounded-lg border border-surface-border bg-surface p-3"
                >
                  {compact ? (
                    <CompactChange item={item} profileItems={profileItems} />
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="font-semibold">
                          {item.capability.name}
                        </h3>
                        {item.after && (
                          <StatusBadge
                            kind="assessment_status"
                            value={item.after.assessment_status}
                          />
                        )}
                      </div>
                      <p>{item.after?.statement}</p>
                      <p className="text-sm">
                        {t("profile.request.levelColon")}
                        {item.after?.level
                          ? levelLabel(
                              item.capability.level_rubric,
                              item.after.level,
                            )
                          : t("profile.request.ungraded")}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t("profile.request.ownerNoteColon")}
                        {item.owner_statement ??
                          item.explanation ??
                          t("profile.request.noNote")}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t("profile.request.uncertaintyColon")}
                        {item.uncertainty ?? t("profile.request.noNote")}
                      </p>
                      <EvidenceRows
                        items={(item.evidence ?? []).map((evidence) => ({
                          ...evidence,
                          id: evidence.evidence_id,
                        }))}
                        onSelect={onEvidence}
                      />
                    </>
                  )}
                  {isOwner && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() =>
                          onEdit({
                            request: initial,
                            capabilityKey: item.capability.key,
                          })
                        }
                      >
                        {t("profile.request.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          onEdit({
                            request: initial,
                            capabilityKey: item.capability.key,
                            objection: true,
                          })
                        }
                      >
                        {t("profile.request.objection")}
                      </Button>
                    </div>
                  )}
                </section>
              ))}
            </div>
            {!compact && (
              <RequestTimeline
                orgId={orgId}
                employeeId={employeeId}
                requestId={initial.id}
              />
            )}
            {isOwner && (
              <Button
                disabled={!initial.items?.length}
                onClick={() => onEdit({ request: initial, preview: true })}
              >
                {t("profile.request.submitDirectly")}
              </Button>
            )}
          </RequestDisclosure>
        )
      })}
      {groups.map(
        ({ title, requests: group, pending: isPendingGroup }) =>
          group.length > 0 && (
            <RequestDisclosure
              key={title}
              label={title}
              summary={t("profile.request.groupSummary", {
                title,
                count: group.length,
              })}
              pending={isPendingGroup}
            >
              <div className="grid gap-3 md:grid-cols-2 text-sm text-muted-foreground">
                {group.map((request) => {
                  const isRejected =
                    request.status === "rejected" ||
                    request.status === "changes_requested"
                  const hasRejectedItems = (request.items ?? []).some((item) =>
                    isRejectedItem(item.decision),
                  )
                  const activeChild =
                    !open.includes(request) && hasRejectedItems
                      ? findActiveChild(request.id, requests)
                      : undefined
                  const isDraftChild =
                    activeChild?.status === "draft" ||
                    activeChild?.status === "pending_owner"
                  const linkedDraft =
                    isOwner && isDraftChild ? activeChild : undefined
                  const isResubmitted = Boolean(activeChild && !isDraftChild)
                  const latestRequest = isResubmitted
                    ? findLatestDescendant(request.id, requests)
                    : undefined
                  const canCloneRejected =
                    isOwner &&
                    !open.includes(request) &&
                    hasRejectedItems &&
                    !activeChild &&
                    cloneWithdrawnItems(request, profileItems).length > 0
                  const canWithdrawClone =
                    isOwner &&
                    request.status === "withdrawn" &&
                    cloneWithdrawnItems(request, profileItems).length > 0
                  const canEditDraft =
                    isOwner &&
                    (request.status === "draft" ||
                      (request.origin === "assignment_feedback" &&
                        request.status === "pending_owner"))
                  const canWithdraw =
                    isOwner && request.status === "pending_review"
                  const hasActions =
                    Boolean(linkedDraft) ||
                    Boolean(latestRequest) ||
                    canCloneRejected ||
                    canWithdrawClone ||
                    canEditDraft ||
                    canWithdraw
                  return (
                    <div
                      key={request.id}
                      id={`request-${request.id}`}
                      className={`flex flex-col gap-2.5 rounded-lg border p-3 wrap-anywhere ${
                        isRejected
                          ? "border-destructive/40 bg-destructive/5 text-foreground"
                          : "border-surface-border bg-surface"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {request.origin === "assignment_feedback" && (
                            <Badge variant="outline">
                              {t("profile.request.assignmentFeedback")}
                            </Badge>
                          )}
                          <Badge
                            variant="outline"
                            className={
                              isRejected
                                ? "border-destructive/40 bg-destructive/10 font-medium text-destructive"
                                : request.status === "pending_review" ||
                                    (request.status === "approved" &&
                                      hasRejectedItems)
                                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                  : request.status === "approved"
                                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                    : undefined
                            }
                          >
                            {requestSummary(request, t)}
                          </Badge>
                          {isResubmitted && (
                            <Badge variant="outline">
                              {t("profile.request.resubmitted")}
                            </Badge>
                          )}
                        </div>
                        <RequestSourceBadge
                          via={request.submitted_via}
                          clientName={request.client_name}
                        />
                      </div>
                      {isOwner && request.status === "pending_review" && (
                        <RequestReviewers reviewers={request.reviewers} />
                      )}
                      {!compact &&
                        request.submitted_via === "admin_handover" && (
                          <span>
                            {t("profile.request.adminHandoverOwnerUnreviewed")}
                          </span>
                        )}
                      {open.includes(request) &&
                        request.items?.map((item) => (
                          <CompactChange
                            key={item.id}
                            item={item}
                            profileItems={profileItems}
                          />
                        ))}
                      {request.status === "withdrawn" &&
                        request.items?.map((item) => {
                          const evidence = activeEvidence(item.evidence)
                          return (
                            <section
                              key={item.id}
                              className="space-y-2 rounded-lg border p-3 wrap-anywhere"
                            >
                              <CompactChange
                                item={item}
                                profileItems={profileItems}
                              />
                              {evidence.length > 0 && (
                                <EvidenceRows
                                  items={evidence.map((entry) => ({
                                    ...entry,
                                    id: entry.evidence_id,
                                  }))}
                                  onSelect={onEvidence}
                                />
                              )}
                            </section>
                          )
                        })}
                      {request.origin === "assignment_feedback" &&
                        open.includes(request) && (
                          <EvidenceRows
                            items={Array.from(
                              new Map(
                                request.items?.flatMap((item) =>
                                  (item.evidence ?? []).map(
                                    (ref) =>
                                      [
                                        ref.evidence_id,
                                        { ...ref, id: ref.evidence_id },
                                      ] as const,
                                  ),
                                ),
                              ).values(),
                            )}
                            onSelect={onEvidence}
                          />
                        )}
                      {request.items?.some((item) => item.decision) && (
                        <ul className="space-y-2">
                          {request.items.map((item) => {
                            const itemRejected = isRejectedItem(item.decision)
                            return (
                              <li
                                key={item.id}
                                className={
                                  itemRejected
                                    ? "space-y-1 rounded-md border border-destructive/35 bg-destructive/10 p-2 text-foreground"
                                    : "space-y-1"
                                }
                              >
                                <p
                                  className={
                                    itemRejected
                                      ? "font-medium text-destructive"
                                      : undefined
                                  }
                                >
                                  {t("profile.request.itemDecisionLine", {
                                    name: item.capability.name,
                                    decision: item.decision
                                      ? decisionLabels[item.decision]
                                      : t("profile.request.pendingDecision"),
                                  })}
                                </p>
                                {item.decision_reason && (
                                  <p className="whitespace-pre-wrap break-words">
                                    {t("profile.request.decisionReason", {
                                      reason: item.decision_reason,
                                    })}
                                  </p>
                                )}
                                {isOwner && item.appeal_id && (
                                  <AppealItem orgId={orgId} item={item} />
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                      {!compact && (
                        <RequestTimeline
                          orgId={orgId}
                          employeeId={employeeId}
                          requestId={request.id}
                        />
                      )}
                      {hasActions && (
                        <div className="mt-auto flex flex-wrap gap-2 pt-1">
                          {canWithdrawClone && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onEdit({ cloneFrom: request })}
                            >
                              {t("profile.request.cloneAndResubmit")}
                            </Button>
                          )}
                          {(linkedDraft || canCloneRejected) && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                onEdit(
                                  linkedDraft
                                    ? { request: linkedDraft }
                                    : { cloneFrom: request },
                                )
                              }
                            >
                              {t("profile.request.editAndResubmit")}
                            </Button>
                          )}
                          {latestRequest && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setLocalFocus((prev) => ({
                                  id: latestRequest.id,
                                  seq: (prev?.seq ?? 0) + 1,
                                }))
                              }
                            >
                              {t("profile.request.viewLatestRequest")}
                            </Button>
                          )}
                          {canEditDraft && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onEdit({ request })}
                            >
                              {request.status === "pending_owner"
                                ? t("profile.request.confirmAndSubmit")
                                : t("profile.request.continueEditing")}
                            </Button>
                          )}
                          {canWithdraw && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={withdraw.isPending}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    t("profile.request.withdrawConfirm"),
                                  )
                                )
                                  withdraw.mutate(request.id)
                              }}
                            >
                              {t("profile.request.withdraw")}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </RequestDisclosure>
          ),
      )}
    </div>
  )
}

function RequestDisclosure({
  id,
  label,
  summary,
  pending,
  children,
}: {
  id?: string
  label: string
  summary: string
  pending?: boolean
  children: ReactNode
}) {
  return (
    <details
      className={`group/requests rounded-lg border bg-surface ${pending ? "border-amber-500/40" : "border-surface-border"}`}
    >
      <summary
        className={`flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium group-open/requests:rounded-b-none [&::-webkit-details-marker]:hidden ${pending ? "bg-amber-500/10" : "bg-muted/40"}`}
      >
        {summary}
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-open/requests:rotate-180"
        />
      </summary>
      <section
        id={id}
        aria-label={label}
        className="space-y-3 border-t border-surface-border p-3"
      >
        {children}
      </section>
    </details>
  )
}

function CompactChange({
  item,
  profileItems,
}: {
  item: ChangeItemPublic
  profileItems: ProfileItem[]
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const statementId = useId()
  const before = profileItems.find(
    (entry) => entry.claim?.id === item.target_claim_id,
  )?.claim
  const displayLevel = (level: string | null | undefined) => {
    if (!level) return t("profile.request.ungraded")
    const rubric = item.capability.level_rubric
    if (
      !record(rubric) ||
      !Array.isArray(rubric.levels) ||
      !rubric.levels.some(
        (entry: unknown) => record(entry) && entry.key === level,
      )
    )
      return t("profile.request.levelAdjusted")
    return levelLabel(rubric, level)
  }
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">{item.capability.name}</h3>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          {t("profile.request.compactBefore")}
          {before?.level
            ? displayLevel(before.level)
            : before
              ? t("profile.request.ungraded")
              : item.target_claim_id
                ? t("profile.request.compactOriginal")
                : t("profile.request.compactNoRecord")}
        </span>
        {(before || !item.target_claim_id) && (
          <StatusBadge
            kind="assessment_status"
            value={before?.assessment_status ?? "unknown"}
          />
        )}
        {item.op === "attach_evidence" ? (
          <span>{t("profile.request.compactAttach")}</span>
        ) : item.after ? (
          <>
            <span>
              {t("profile.request.compactAfter", {
                level: displayLevel(item.after.level),
              })}
            </span>
            <StatusBadge
              kind="assessment_status"
              value={item.after.assessment_status}
            />
          </>
        ) : (
          <span>{t("profile.request.compactRetract")}</span>
        )}
      </div>
      <p
        id={statementId}
        className={`whitespace-pre-wrap break-words ${expanded ? "" : "line-clamp-2"}`}
      >
        {item.after?.statement ??
          before?.statement ??
          (item.op === "retract"
            ? t("profile.request.compactRetractBody")
            : t("profile.request.compactAttachBody"))}
      </p>
      {(item.after?.statement || before?.statement) && (
        <Button
          variant="link"
          size="sm"
          aria-controls={statementId}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? t("profile.request.collapse")
            : t("profile.request.expandFull")}
        </Button>
      )}
    </div>
  )
}
