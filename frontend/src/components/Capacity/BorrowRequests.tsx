import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type ActiveBorrowAssignment,
  type BorrowDecisionInput,
  type BorrowRequest,
  CapacityService,
  CapacityTrackingService,
} from "@/client"
import { SideDrawer } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useBorrowRequests } from "@/hooks/usePendingApprovals"
import i18n from "@/i18n"
import { cn } from "@/lib/utils"
import {
  AssignmentFeedback,
  useFeedbackAssignments,
} from "./AssignmentFeedback"
import { CapacityError, useCapacityRefresh } from "./AssignmentFields"
import { AssignmentTracking } from "./AssignmentTracking"
import {
  PlanningBoard,
  type PlanningView,
  shortRequestNumber,
} from "./PlanningWorkbench"
import {
  formatCapacityPercent,
  formatIsoDate,
  formatIsoDateRange,
} from "./shared"

const statusKeys: Record<string, string> = {
  pending_selection: "capacity.borrows.statuses.pending_selection",
  selected: "capacity.borrows.statuses.selected",
  pending_consent: "capacity.borrows.statuses.pending_consent",
  waiting_commitment: "capacity.borrows.statuses.waiting_commitment",
  failed: "capacity.borrows.statuses.failed",
}

export type RejectionReason = NonNullable<BorrowDecisionInput["reason_code"]>

const rejectionReasonKeys: Record<RejectionReason, string> = {
  capacity: "capacity.borrows.rejectionReasons.capacity",
  skill: "capacity.borrows.rejectionReasons.skill",
  timing: "capacity.borrows.rejectionReasons.timing",
  priority: "capacity.borrows.rejectionReasons.priority",
  scope: "capacity.borrows.rejectionReasons.scope",
  other: "capacity.borrows.rejectionReasons.other",
}

export function rejectionReasonLabel(code: string | null | undefined) {
  const key = Object.entries(rejectionReasonKeys).find(
    ([entry]) => entry === code,
  )?.[1]
  return key ? i18n.t(key) : i18n.t("capacity.borrows.unknownReason")
}

export function RejectionReasonSelect({
  value,
  onChange,
}: {
  value: RejectionReason | ""
  onChange: (value: RejectionReason | "") => void
}) {
  const { t } = useTranslation()
  return (
    <label className="block space-y-2 text-sm font-medium">
      <span>{t("capacity.borrows.rejectionLabel")}</span>
      <select
        className="h-10 w-full rounded-md border bg-background px-3"
        value={value}
        onChange={(event) =>
          onChange(event.target.value as RejectionReason | "")
        }
      >
        <option value="">{t("capacity.borrows.rejectionPlaceholder")}</option>
        {Object.entries(rejectionReasonKeys).map(([code, key]) => (
          <option key={code} value={code}>
            {t(key)}
          </option>
        ))}
      </select>
    </label>
  )
}

export function BorrowRequests({
  orgId,
  mine = false,
  view = "board",
}: {
  orgId: string
  mine?: boolean
  view?: PlanningView
}) {
  const { t } = useTranslation()
  const query = useBorrowRequests(orgId, mine)
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  if (mine && query.data.length === 0) return null
  if (!mine)
    return <BorrowWorkbench orgId={orgId} requests={query.data} view={view} />
  return (
    <section
      aria-label={t("capacity.borrows.sectionAria")}
      className="space-y-3"
    >
      <h2 className="text-lg font-semibold">{t("capacity.borrows.title")}</h2>
      {query.data.map((request) => (
        <BorrowRequestCard
          key={request.id}
          orgId={orgId}
          request={request}
          mine
        />
      ))}
    </section>
  )
}

function BorrowWorkbench({
  orgId,
  requests,
  view,
}: {
  orgId: string
  requests: BorrowRequest[]
  view: PlanningView
}) {
  const { t } = useTranslation()
  const assignments = useQuery({
    queryKey: ["capacity", orgId, "active-borrow-assignments"],
    queryFn: async () =>
      (
        await CapacityTrackingService.trackingListActiveBorrowAssignments({
          path: { org_id: orgId },
        })
      ).data,
  })
  const completed = useFeedbackAssignments(orgId)
  const activeCards = (assignments.data ?? []).map((assignment) => (
    <ActiveBorrowAssignmentCard
      key={assignment.id}
      orgId={orgId}
      assignment={assignment}
    />
  ))
  const completedCards = (completed.data ?? []).map((assignment) => (
    <article key={assignment.id} className={compactCard}>
      <h3 className="break-words font-semibold">{assignment.demand_title}</h3>
      <p className="text-muted-foreground">
        {assignment.employee_name} · {formatIsoDate(assignment.due_date)}
      </p>
      <AssignmentFeedback orgId={orgId} assignment={assignment} />
    </article>
  ))
  const render = (request: BorrowRequest) => (
    <BorrowRequestCard
      key={request.id}
      orgId={orgId}
      request={request}
      mine={false}
      compact={view}
    />
  )
  const failed = requests.filter(({ status }) => status === "failed")
  const assignmentsByState = [
    {
      label: t("capacity.borrows.groupActive"),
      color: "border-t-emerald-500",
      cards: activeCards,
    },
    {
      label: t("capacity.borrows.groupCompleted"),
      color: "border-t-slate-500",
      cards: completedCards,
    },
  ]
  return (
    <section
      aria-label={t("capacity.borrows.sectionAria")}
      className="space-y-3"
    >
      {(assignments.isPending || completed.isPending) && <ProfileLoading />}
      {assignments.isError && (
        <ProfileError retry={() => assignments.refetch()} />
      )}
      {completed.isError && <ProfileError retry={() => completed.refetch()} />}
      {view === "board" ? (
        <PlanningBoard
          groups={[
            {
              label: t("capacity.borrows.groupPendingSelection"),
              color: "border-t-blue-500",
              cards: requests
                .filter((request) => request.status === "pending_selection")
                .map(render),
            },
            {
              label: t("capacity.borrows.groupPendingConfirmation"),
              color: "border-t-amber-500",
              cards: requests
                .filter(
                  (request) =>
                    !["pending_selection", "failed"].includes(request.status),
                )
                .map(render),
            },
            ...assignmentsByState,
            ...(failed.length
              ? [
                  {
                    label: t("capacity.borrows.groupFailed"),
                    color: "border-t-red-500",
                    cards: failed.map(render),
                  },
                ]
              : []),
          ]}
        />
      ) : (
        <>
          <div className="space-y-1">{requests.map(render)}</div>
          {assignmentsByState.map(
            ({ label, cards }) =>
              cards.length > 0 && (
                <section key={label} aria-label={label} className="space-y-1">
                  <h2 className="text-sm font-semibold">{label}</h2>
                  {cards}
                </section>
              ),
          )}
          {!requests.length &&
            !activeCards.length &&
            !completedCards.length && (
              <p className="text-sm text-muted-foreground">
                {t("capacity.borrows.empty")}
              </p>
            )}
        </>
      )}
    </section>
  )
}

const compactCard =
  "min-w-0 space-y-1 rounded-md border border-surface-border bg-surface px-3 py-2 text-sm"

function ActiveBorrowAssignmentCard({
  orgId,
  assignment,
}: {
  orgId: string
  assignment: ActiveBorrowAssignment
}) {
  const { t } = useTranslation()
  const refresh = useCapacityRefresh(orgId)
  const complete = useMutation({
    mutationFn: () =>
      CapacityService.updateAssignment({
        path: { org_id: orgId, assignment_id: assignment.id },
        body: { status: "done" },
      }),
    onSuccess: refresh,
  })
  return (
    <article className={compactCard}>
      <h3 className="font-medium">{assignment.employee_name}</h3>
      <p>
        {assignment.demand_title} ·{" "}
        {assignment.start_date
          ? formatIsoDateRange(assignment.start_date, assignment.due_date)
          : formatIsoDate(assignment.due_date)}
      </p>
      <AssignmentTracking orgId={orgId} assignmentId={assignment.id} />
      <Button
        variant="outline"
        disabled={complete.isPending || complete.isSuccess}
        onClick={() => complete.mutate()}
      >
        {t("capacity.borrows.markDone")}
      </Button>
      <CapacityError error={complete.error} />
    </article>
  )
}

export function BorrowRequestCard({
  orgId,
  request,
  mine,
  compact,
}: {
  orgId: string
  request: BorrowRequest
  mine: boolean
  compact?: PlanningView
}) {
  const { t } = useTranslation()
  const [employee, setEmployee] = useState("")
  const [reason, setReason] = useState("")
  const [reasonCode, setReasonCode] = useState<RejectionReason | "">("")
  const refresh = useCapacityRefresh(orgId)
  const mutation = useMutation({
    mutationFn: (body: BorrowDecisionInput) =>
      CapacityService.decideBorrowRequest({
        path: { org_id: orgId, line_id: request.id },
        body,
      }),
    onSuccess: refresh,
    onError: refresh,
  })
  const selectable = request.status === "pending_selection"
  const consent = request.status === "pending_consent"
  const statusLabel = statusKeys[request.status]
    ? t(statusKeys[request.status])
    : request.status
  const range = formatIsoDateRange(request.start_date, request.end_date)
  const percent = formatCapacityPercent(request.allocation_percent)
  const decision = (selectable || consent) && (
    <fieldset className="space-y-3" disabled={mutation.isPending}>
      {selectable && (
        <label className="block space-y-2 text-sm">
          <span>{t("capacity.borrows.selectEmployee")}</span>
          <select
            className="h-10 w-full rounded-md border bg-background px-3"
            value={employee}
            onChange={(event) => setEmployee(event.target.value)}
          >
            <option value="">{t("capacity.borrows.selectPlaceholder")}</option>
            {request.candidates?.map((person) => (
              <option key={person.employee_id} value={person.employee_id}>
                {person.display_name}
              </option>
            ))}
          </select>
        </label>
      )}
      <RejectionReasonSelect value={reasonCode} onChange={setReasonCode} />
      <label className="block space-y-2 text-sm">
        <span>
          {t("capacity.borrows.reasonLabel")}
          {mine && reasonCode !== "other"
            ? t("capacity.borrows.reasonOptionalSelf")
            : t("capacity.borrows.reasonRequired")}
        </span>
        <textarea
          className="min-h-16 w-full rounded-md border bg-background p-3"
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={selectable && !employee}
          onClick={() =>
            mutation.mutate(
              selectable
                ? { action: "select", employee_id: employee }
                : { action: "accept" },
            )
          }
        >
          {selectable
            ? t("capacity.borrows.confirmCandidate")
            : t("capacity.borrows.accept")}
        </Button>
        <Button
          variant="outline"
          disabled={
            !reasonCode || ((!mine || reasonCode === "other") && !reason.trim())
          }
          onClick={() =>
            mutation.mutate({
              action: mine ? "decline" : "reject",
              reason_code: reasonCode || null,
              reason: reason.trim() || null,
            })
          }
        >
          {mine ? t("capacity.borrows.decline") : t("capacity.borrows.reject")}
        </Button>
      </div>
    </fieldset>
  )
  if (compact)
    return (
      <article
        className={cn(
          compactCard,
          compact === "list" &&
            "grid items-center gap-x-4 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto]",
        )}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span
              className="font-mono text-xs text-muted-foreground"
              title={request.id}
            >
              {shortRequestNumber(request.id)}
            </span>
            <Badge variant="secondary">{statusLabel}</Badge>
          </div>
          <h3 className="break-words font-semibold">
            {request.capability_name}
          </h3>
          <p className="line-clamp-2 break-words text-muted-foreground">
            {request.description}
          </p>
        </div>
        <p className="break-words text-xs text-muted-foreground">
          {t("capacity.borrows.cardMeta", {
            dept: request.borrower_department,
            percent,
            range,
          })}
        </p>
        {decision && (
          <SideDrawer
            title={request.capability_name}
            trigger={
              <Button size="sm" variant="outline">
                {selectable
                  ? t("capacity.borrows.selectAction")
                  : t("capacity.borrows.viewAndConfirm")}
              </Button>
            }
          >
            <p className="mb-3 whitespace-pre-wrap break-words text-sm">
              {request.description}
            </p>
            {decision}
            <CapacityError error={mutation.error} />
          </SideDrawer>
        )}
      </article>
    )
  return (
    <article className="space-y-3 rounded-xl border p-5">
      <h3 className="font-semibold">
        {t("capacity.borrows.cardTitleWithStatus", {
          capability: request.capability_name,
          status: statusLabel,
        })}
      </h3>
      <p className="text-sm">
        {t("capacity.borrows.cardDetailMeta", {
          dept: request.borrower_department,
          percent,
          range,
        })}
      </p>
      <p className="whitespace-pre-wrap break-words">{request.description}</p>
      {request.reason && (
        <p>
          {t("capacity.borrows.yourRejectionReason", {
            label: rejectionReasonLabel(request.reason_code),
            reason: request.reason,
          })}
        </p>
      )}
      {decision}
      <CapacityError error={mutation.error} />
    </article>
  )
}
