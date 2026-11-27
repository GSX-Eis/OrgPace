import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarOff, SlidersHorizontal } from "lucide-react"
import { type ReactNode, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapacityService,
  type MyWorkload as MyWorkloadData,
  type WorkloadUnavailabilitySegment,
} from "@/client"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import {
  SectionCard,
  SideDrawer,
} from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useOrg } from "@/hooks/useOrg"
import { cn } from "@/lib/utils"
import { MyAssignments } from "./MyAssignments"
import {
  addWeeks,
  formatCapacityPercent,
  formatDateOptional,
  formatIsoDateRange,
  loadBandLabel,
  loadColors,
  occupiedPercent,
  UtilizationBadge,
  unavailableStripes,
  WorkloadHelp,
  weekBand,
  weekLabel,
  weekLoadLabel,
} from "./shared"
import {
  type DateRange,
  overlaps,
  WorkloadDetails,
  WorkloadLegend,
  weekRange,
} from "./TeamWorkloadGantt"

export function MyWorkload({
  orgId,
  actions,
}: {
  orgId: string
  actions: ReactNode
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const { roles } = useOrg()
  const isAdmin = roles.includes("org_admin")
  const [adjusting, setAdjusting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [leaveNotice, setLeaveNotice] = useState<string[] | null>(null)
  const [percent, setPercent] = useState("")
  const [reason, setReason] = useState("")
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const query = useQuery({
    queryKey: ["capacity", orgId, "me"],
    queryFn: async () =>
      (await CapacityService.getMyWorkload({ path: { org_id: orgId } })).data,
  })
  const submit = useMutation({
    mutationFn: () => {
      const startWeek = start || query.data!.weeks[0].week_start
      const endWeek = end || startWeek
      return CapacityService.requestWorkloadChange({
        path: { org_id: orgId },
        body: {
          requested_percent: Number(percent),
          reason: reason.trim(),
          start_week: startWeek,
          end_week: endWeek,
        },
      })
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["capacity", orgId] })
      setPercent("")
      setReason("")
      setStart("")
      setEnd("")
      setAdjusting(false)
    },
  })
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  const pending = query.data.requests.some(
    (request) => request.status === "pending",
  )
  const sep = t("capacity.common.listSeparator")
  const reviewerNames = query.data.reviewer_names.join(sep)
  const submittedNames = submit.data?.data.reviewer_names?.join(sep)
  return (
    <div className="space-y-3">
      <p aria-hidden="true" className="text-lg font-semibold sm:hidden">
        {t("capacity.workload.myTitle")}
      </p>
      <TopbarActions>
        {actions}
        <WorkloadHelp />
        {!isAdmin && (
          <SideDrawer
            title={t("capacity.workload.leaveDrawerTitle")}
            open={leaving}
            onOpenChange={setLeaving}
            trigger={
              <Button
                size="sm"
                variant="outline"
                className="max-sm:size-8 max-sm:p-0"
              >
                <CalendarOff aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">
                  {t("capacity.workload.leaveBtn")}
                </span>
              </Button>
            }
          >
            <Unavailability
              orgId={orgId}
              employeeId={query.data.employee_id}
              startWeek={query.data.weeks[0].week_start}
              canWrite
              showNote
              idPrefix="leave"
              submitLabel={t("capacity.workload.leaveSubmit")}
              onRegistered={(overWeeks) => {
                setLeaveNotice(overWeeks)
                setLeaving(false)
              }}
            />
          </SideDrawer>
        )}
        <SideDrawer
          title={t("capacity.workload.adjustTitle")}
          open={adjusting}
          onOpenChange={setAdjusting}
          trigger={
            <Button
              size="sm"
              className="max-sm:size-8 max-sm:p-0"
              disabled={submit.isPending}
            >
              <SlidersHorizontal aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">
                {t("capacity.workload.adjustBtn")}
              </span>
            </Button>
          }
        >
          <form
            aria-label={t("capacity.workload.adjustBtn")}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              submit.mutate()
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
            <fieldset
              disabled={pending || submit.isPending}
              className="space-y-4"
            >
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
                    value={start || query.data.weeks[0].week_start}
                    onChange={(event) => {
                      const next = event.target.value
                      setStart(next)
                      const currentEnd = end || query.data.weeks[0].week_start
                      if (currentEnd < next) setEnd(next)
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
                    min={start || query.data.weeks[0].week_start}
                    max={addWeeks(start || query.data.weeks[0].week_start, 25)}
                    step={7}
                    required
                    value={end || start || query.data.weeks[0].week_start}
                    onChange={(event) => setEnd(event.target.value)}
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
                  onChange={(event) => setPercent(event.target.value)}
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
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <Button type="submit" disabled={!reason.trim()}>
                {submit.isPending
                  ? t("capacity.workload.submitting")
                  : t("capacity.workload.submitAdjust")}
              </Button>
            </fieldset>
            {pending && (
              <p role="status">{t("capacity.workload.pendingNotice")}</p>
            )}
            <SetupError error={submit.error} />
          </form>
        </SideDrawer>
      </TopbarActions>
      {leaveNotice !== null && (
        <p
          role="status"
          className="rounded-md border bg-surface px-3 py-2 text-sm"
        >
          {t("capacity.workload.leaveRegisteredNotice")}
          {leaveNotice.length > 0 &&
            t("capacity.workload.leaveOverWeeksNotice", {
              weeks: leaveNotice.join(sep),
            })}
        </p>
      )}
      <WorkloadOverview
        orgId={orgId}
        workload={query.data}
        isAdmin={isAdmin}
        onLeaveRegistered={(overWeeks) => setLeaveNotice(overWeeks)}
      />
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,68fr)_minmax(0,32fr)]">
        <MyAssignments orgId={orgId} />
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
            {submit.isSuccess && (
              <p className="text-sm" aria-live="polite">
                {submittedNames
                  ? t("capacity.workload.submittedTo", {
                      names: submittedNames,
                    })
                  : t("capacity.workload.noReviewer")}
              </p>
            )}
            {!query.data.requests.length && (
              <p className="text-sm text-muted-foreground">
                {t("capacity.workload.noRequests")}
              </p>
            )}
            <div className="divide-y">
              {query.data.requests.map((request) => (
                <article key={request.id} className="space-y-1 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <p className="font-medium">
                      {formatCapacityPercent(request.requested_percent)} ·{" "}
                      {
                        {
                          pending: reviewerNames
                            ? t(
                                "capacity.workload.requestPendingWithReviewers",
                                {
                                  names: reviewerNames,
                                },
                              )
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
      </div>
    </div>
  )
}

function WorkloadOverview({
  orgId,
  workload,
  isAdmin,
  onLeaveRegistered,
}: {
  orgId: string
  workload: MyWorkloadData
  isAdmin: boolean
  onLeaveRegistered: (overWeeks: string[]) => void
}) {
  const { t } = useTranslation()
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const overload = workload.weeks.find(
    (week) => weekBand(week) === "overloaded",
  )
  const activeWeek = workload.weeks.find(
    (week) => week.week_start === selectedWeek,
  )
  const activeRange = activeWeek ? weekRange(activeWeek.week_start) : null
  const activeTitle = activeWeek ? weekLabel(activeWeek.week_start) : ""
  return (
    <SectionCard
      aria-label={t("capacity.workload.overviewAria")}
      className={cn("space-y-3", activeWeek && "md:pr-[min(380px,38vw)]")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">
          {t("capacity.workload.overviewTitle")}
        </h2>
        {overload && (
          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-700 dark:text-red-300">
            {t("capacity.workload.overloadBadge", {
              week: weekLabel(overload.week_start),
            })}
          </span>
        )}
        <div className="sm:ml-auto">
          <WorkloadLegend />
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("capacity.workload.overviewHint")}
      </p>
      <div className="grid grid-cols-2 gap-2 min-[540px]:grid-cols-4 xl:grid-cols-8">
        {workload.weeks.map((week, index) => {
          const band = weekBand(week)
          const total = occupiedPercent(week)
          const range = weekRange(week.week_start)
          const unavailable =
            week.capacity_percent < 100 ||
            (workload.unavailabilities ?? []).some((dates) =>
              overlaps(range, dates),
            )
          const colors = loadColors[band]
          const selected = selectedWeek === week.week_start
          return (
            <button
              key={week.week_start}
              type="button"
              aria-haspopup="dialog"
              aria-pressed={selected}
              aria-label={t("capacity.workload.weekAriaLabel", {
                week: weekLabel(week.week_start),
                load: weekLoadLabel(week),
                band: loadBandLabel(band),
                leave: unavailable ? t("capacity.workload.weekAriaLeave") : "",
              })}
              className={cn(
                "min-w-0 cursor-pointer space-y-1.5 rounded-md border p-2.5 text-left text-xs outline-offset-2 hover:border-primary focus-visible:outline-2 focus-visible:outline-primary",
                colors.surface,
                unavailable && unavailableStripes,
                selected && "ring-2 ring-primary ring-inset",
              )}
              onClick={(event) => {
                opener.current = event.currentTarget
                setSelectedWeek(week.week_start)
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-1">
                <time className="font-semibold" dateTime={week.week_start}>
                  {index === 0
                    ? t("capacity.workload.thisWeek")
                    : index === 1
                      ? t("capacity.workload.nextWeek")
                      : weekLabel(week.week_start)}
                </time>
                {week.status === "stale" ? (
                  <Badge variant="outline">
                    {t("capacity.workload.statusStale")}
                  </Badge>
                ) : (
                  <UtilizationBadge
                    band={band}
                    percent={total}
                    capacity={week.capacity_percent}
                  />
                )}
              </div>
              {index < 2 && (
                <p className="text-muted-foreground">
                  {weekLabel(week.week_start)}
                </p>
              )}
              <div
                aria-hidden="true"
                className="relative h-1.5 rounded-full bg-foreground/10"
              >
                <span
                  className={cn("block h-full rounded-full", colors.bar)}
                  style={{ width: `${Math.min(total, 100)}%` }}
                />
                <span
                  className="absolute -inset-y-0.5 w-px bg-red-500"
                  style={{ left: `calc(${week.capacity_percent}% - 1px)` }}
                />
              </div>
              {unavailable && (
                <span className="inline-block rounded border border-current/25 bg-background/70 px-1 text-[11px] font-medium">
                  {t("capacity.workload.leaveBtn")}
                </span>
              )}
              {week.capacity_percent < 100 && (
                <p>
                  {t("capacity.workload.availableCap", {
                    percent: week.capacity_percent,
                  })}
                </p>
              )}
              {workload.correction_pending[week.week_start] && (
                <p className="text-amber-700 dark:text-amber-300">
                  {t("capacity.workload.adjustPending")}
                </p>
              )}
              {week.legacy_start && <p>{t("capacity.workload.legacyStart")}</p>}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
        <span>
          {t("capacity.workload.jiraLabel")}
          <span>
            {workload.jira_task_count === null
              ? t("capacity.workload.jiraUnlinked")
              : t("capacity.workload.jiraIncomplete", {
                  count: workload.jira_task_count,
                })}
          </span>
        </span>
      </div>
      <SideDrawer
        open={!!activeWeek}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedWeek(null)
            opener.current?.focus({ preventScroll: true })
          }
        }}
        modal={false}
        showOverlay={false}
        className="max-md:inset-x-0 max-md:top-auto max-md:bottom-0 max-md:h-[55dvh] max-md:w-full max-md:max-w-none md:w-[min(380px,38vw)] md:max-w-none"
        title={
          activeWeek
            ? t("capacity.workload.detailsTitleWithWeek", { week: activeTitle })
            : t("capacity.workload.detailsTitle")
        }
      >
        {activeWeek && activeRange && (
          <div key={activeWeek.week_start} className="space-y-3">
            <WorkloadDetails
              selection={{
                row: workload,
                range: activeRange,
                title: activeTitle,
                week: activeWeek.week_start,
              }}
            />
            <section
              aria-label={t("capacity.workload.weekLeaveAria")}
              className="space-y-2 border-t pt-3"
            >
              <h3 className="text-sm font-medium">
                {t("capacity.workload.weekLeaveTitle")}
              </h3>
              <Unavailability
                orgId={orgId}
                employeeId={workload.employee_id}
                startWeek={activeWeek.week_start}
                weekRange={activeRange}
                knownItems={workload.unavailabilities}
                canWrite={!isAdmin}
                showNote
                idPrefix="week-leave"
                submitLabel={t("capacity.workload.leaveSubmit")}
                onRegistered={onLeaveRegistered}
              />
            </section>
          </div>
        )}
      </SideDrawer>
    </SectionCard>
  )
}

export function Unavailability({
  orgId,
  employeeId,
  startWeek,
  weekRange: scopedRange,
  knownItems = [],
  canWrite,
  showNote = false,
  idPrefix = "unavailable",
  submitLabel,
  onRegistered,
}: {
  orgId: string
  employeeId: string
  startWeek: string
  weekRange?: DateRange
  knownItems?: WorkloadUnavailabilitySegment[]
  canWrite: boolean
  showNote?: boolean
  idPrefix?: string
  submitLabel?: string
  onRegistered?: (overWeeks: string[]) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [start, setStart] = useState(startWeek)
  const [end, setEnd] = useState(startWeek)
  const [over, setOver] = useState<string[]>([])
  const fromDate = scopedRange?.start_date ?? "1970-01-01"
  const toDate = scopedRange?.end_date ?? "9999-12-31"
  const resolvedSubmitLabel =
    submitLabel ?? t("capacity.unavailability.register")
  const query = useQuery({
    queryKey: [
      "capacity",
      orgId,
      "unavailability",
      employeeId,
      fromDate,
      toDate,
    ],
    queryFn: async () =>
      (
        await CapacityService.listUnavailability({
          path: { org_id: orgId },
          query: {
            employee_id: employeeId,
            from: fromDate,
            to: toDate,
          },
        })
      ).data,
  })
  const save = useMutation({
    mutationFn: (id?: string) =>
      id
        ? CapacityService.deleteUnavailability({
            path: { org_id: orgId, unavailability_id: id },
          })
        : CapacityService.registerUnavailability({
            path: { org_id: orgId },
            body: {
              employee_id: employeeId,
              start_date: start,
              end_date: end,
            },
          }),
    onSuccess: (response, id) => {
      setOver(response.data.over_weeks)
      client.invalidateQueries({ queryKey: ["capacity", orgId] })
      if (!id) {
        onRegistered?.(response.data.over_weeks)
      }
    },
  })
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  const seenIds = new Set(query.data.data.map((row) => row.id))
  const fallbackRows = knownItems
    .filter(
      (item) =>
        !seenIds.has(item.id) && (!scopedRange || overlaps(scopedRange, item)),
    )
    .map((item) => ({
      id: item.id,
      start_date: item.start_date,
      end_date: item.end_date,
      can_delete: false,
    }))
  const rows = [...query.data.data, ...fallbackRows]
  return (
    <div className="@container space-y-3">
      {!rows.length && (
        <p className="text-sm text-muted-foreground">
          {t("capacity.unavailability.empty")}
        </p>
      )}
      {rows.map((row) => (
        <div
          key={row.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
        >
          <span>{formatIsoDateRange(row.start_date, row.end_date)}</span>
          {row.can_delete && (
            <Button
              variant="outline"
              disabled={save.isPending}
              onClick={() => save.mutate(row.id)}
            >
              {t("capacity.unavailability.delete")}
            </Button>
          )}
        </div>
      ))}
      {canWrite && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate(undefined)
          }}
        >
          <fieldset disabled={save.isPending} className="space-y-3">
            <div className="grid min-w-0 gap-3 @sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${idPrefix}-start-${employeeId}`}>
                  {t("capacity.unavailability.startDate")}
                </Label>
                <Input
                  id={`${idPrefix}-start-${employeeId}`}
                  type="date"
                  required
                  value={start}
                  onChange={(event) => {
                    const next = event.target.value
                    setStart(next)
                    if (end < next) setEnd(next)
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${idPrefix}-end-${employeeId}`}>
                  {t("capacity.unavailability.endDate")}
                </Label>
                <Input
                  id={`${idPrefix}-end-${employeeId}`}
                  type="date"
                  required
                  min={start}
                  value={end}
                  onChange={(event) => setEnd(event.target.value)}
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {showNote
                ? t("capacity.unavailability.noteWithNotify")
                : t("capacity.unavailability.noteWithoutNotify")}
            </p>
            <Button type="submit">
              {save.isPending
                ? t("capacity.common.saving")
                : resolvedSubmitLabel}
            </Button>
          </fieldset>
        </form>
      )}
      {!!over.length && (
        <p role="status">
          {t("capacity.workload.leaveOverWeeksNotice", {
            weeks: over.join(t("capacity.common.listSeparator")),
          })}
        </p>
      )}
      <SetupError error={save.error} />
    </div>
  )
}
