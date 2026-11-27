import { useMutation } from "@tanstack/react-query"
import { ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  CapacityService,
  type ExtensionPublic,
  type MyAssignment,
} from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  CapacityError,
  DateField,
  NoteField,
  useCapacityRefresh,
  useExtensions,
  useMyAssignments,
} from "./AssignmentFields"
import { AssignmentTracking } from "./AssignmentTracking"
import { BorrowRequests } from "./BorrowRequests"
import { assignmentStatusLabel } from "./DemandAssignments"
import {
  formatCapacityPercent,
  formatIsoDate,
  formatIsoDateRange,
} from "./shared"

const extensionStatusKeys = {
  pending: "capacity.assignments.my.extensionStatuses.pending",
  approved: "capacity.assignments.my.extensionStatuses.approved",
  returned: "capacity.assignments.my.extensionStatuses.returned",
} as const

type GroupKey = "active" | "upcoming" | "past"

export function MyAssignments({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const assignments = useMyAssignments(orgId)
  const requests = useExtensions(orgId)
  if (assignments.isPending || requests.isPending) return <ProfileLoading />
  if (assignments.isError || requests.isError)
    return (
      <ProfileError
        retry={() => {
          assignments.refetch()
          requests.refetch()
        }}
      />
    )
  const groups = new Map<GroupKey, MyAssignment[]>([
    ["active", []],
    ["upcoming", []],
    ["past", []],
  ])
  const today = new Date().toLocaleDateString("sv-SE")
  for (const row of assignments.data.data) {
    const group: GroupKey =
      row.status !== "active"
        ? "past"
        : row.start_date && row.start_date > today
          ? "upcoming"
          : "active"
    groups.get(group)?.push(row)
  }
  return (
    <SectionCard
      aria-label={t("capacity.assignments.my.aria")}
      className="space-y-3 p-0"
    >
      <h2 className="px-4 pt-4 text-sm font-semibold">
        {t("capacity.assignments.my.title")}
      </h2>
      <div className="px-4 empty:hidden">
        <BorrowRequests orgId={orgId} mine />
      </div>
      {!assignments.data.count && (
        <p className="px-4 pb-4 text-sm text-muted-foreground">
          {t("capacity.assignments.empty")}
        </p>
      )}
      {Array.from(groups, ([key, rows]) => {
        const label = t(`capacity.assignments.my.groups.${key}`)
        return rows.length ? (
          <section key={key} aria-label={label}>
            <h3 className="border-y bg-surface-muted px-4 py-1.5 text-xs font-medium text-muted-foreground">
              {t("capacity.assignments.my.groupHeading", {
                label,
                count: rows.length,
              })}
            </h3>
            <div className="divide-y">
              {rows.map((row) => (
                <MyAssignmentRow
                  key={row.id}
                  orgId={orgId}
                  row={row}
                  requests={requests.data.data.filter(
                    (request) => request.assignment_id === row.id,
                  )}
                />
              ))}
            </div>
          </section>
        ) : null
      })}
    </SectionCard>
  )
}

function MyAssignmentRow({
  orgId,
  row,
  requests,
}: {
  orgId: string
  row: MyAssignment
  requests: ExtensionPublic[]
}) {
  const { t } = useTranslation()
  const refresh = useCapacityRefresh(orgId)
  const submit = useMutation({
    mutationFn: (data: FormData) =>
      CapacityService.requestExtension({
        path: { org_id: orgId, assignment_id: row.id },
        body: {
          requested_due_date: String(data.get("requested_due_date")),
          reason: String(data.get("reason")).trim(),
        },
      }),
    onSuccess: refresh,
  })
  const pending = requests.some((request) => request.status === "pending")
  const sep = t("capacity.common.listSeparator")
  const waitingNames = (
    submit.data?.data.reviewer_names ?? row.reviewer_names
  ).join(sep)
  const nextDueDate = new Date(Date.parse(row.due_date) + 86_400_000)
    .toISOString()
    .slice(0, 10)
  return (
    <article className="space-y-2 px-4 py-2.5 text-sm">
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="min-w-0 flex-1 break-words font-semibold">
          {row.capability_name}
        </h4>
        <Badge variant="secondary" className="max-w-full whitespace-normal">
          {row.requesting_department_name}
        </Badge>
        <span className="font-semibold tabular-nums">
          {formatCapacityPercent(row.allocation_percent)}
        </span>
        <span className="text-xs text-muted-foreground">
          {row.start_date
            ? formatIsoDateRange(row.start_date, row.due_date)
            : `${t("capacity.assignments.startUnconfirmed")} – ${formatIsoDate(row.due_date)}`}
        </span>
        <Badge variant="outline">{assignmentStatusLabel(row.status)}</Badge>
      </div>
      <details className="group">
        <summary className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-primary">
          <ChevronRight
            className="size-3 group-open:rotate-90"
            aria-hidden="true"
          />
          {t("capacity.assignments.my.taskDetails")}
        </summary>
        <p className="my-2 whitespace-pre-wrap break-words">
          {row.description}
        </p>
        {row.status === "active" && (
          <AssignmentTracking orgId={orgId} assignmentId={row.id} />
        )}
      </details>
      {pending && (
        <p role="status">
          {waitingNames
            ? t("capacity.assignments.my.pendingWithReviewers", {
                names: waitingNames,
              })
            : t("capacity.assignments.my.pendingNoReviewer")}
        </p>
      )}
      {!pending && row.status === "active" && (
        <details className="group">
          <summary className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-primary">
            <ChevronRight
              className="size-3 group-open:rotate-90"
              aria-hidden="true"
            />
            {t("capacity.assignments.my.requestExtension")}
          </summary>
          <form
            className="mt-2 space-y-2 rounded-md border bg-surface-muted p-3"
            aria-label={t("capacity.assignments.my.requestExtension")}
            onSubmit={(event) => {
              event.preventDefault()
              submit.mutate(new FormData(event.currentTarget))
            }}
          >
            <p className="text-sm text-muted-foreground">
              {row.reviewer_names.length
                ? t("capacity.assignments.my.willSubmitTo", {
                    names: row.reviewer_names.join(sep),
                  })
                : t("capacity.assignments.my.pendingNoReviewer")}
            </p>
            <fieldset disabled={submit.isPending} className="space-y-3">
              <DateField
                label={t("capacity.assignments.my.requestedDueDate")}
                name="requested_due_date"
                min={nextDueDate}
              />
              <NoteField
                label={t("capacity.assignments.my.extensionReason")}
                name="reason"
              />
              <Button type="submit">
                {t("capacity.assignments.my.submitExtensionBtn")}
              </Button>
            </fieldset>
          </form>
        </details>
      )}
      <CapacityError error={submit.error} />
      {!!requests.length && (
        <section
          aria-label={t("capacity.assignments.my.extensionHistory")}
          className="space-y-2"
        >
          <h4 className="text-xs font-medium text-muted-foreground">
            {t("capacity.assignments.my.extensionHistory")}
          </h4>
          {requests.map((request) => (
            <div key={request.id} className="space-y-1 border-l-2 pl-3 text-sm">
              <p>
                {formatIsoDate(request.requested_due_date)} ·{" "}
                {t(extensionStatusKeys[request.status])}
              </p>
              <p className="whitespace-pre-wrap break-words">
                {request.reason}
              </p>
              {request.decision_note && (
                <p className="whitespace-pre-wrap break-words">
                  {t("capacity.assignments.my.decisionNote", {
                    note: request.decision_note,
                  })}
                </p>
              )}
            </div>
          ))}
        </section>
      )}
    </article>
  )
}
