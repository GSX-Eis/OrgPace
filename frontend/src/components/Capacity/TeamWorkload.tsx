import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  SlidersHorizontal,
  Undo2,
} from "lucide-react"
import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapacityService,
  type CarryOverPlanItem,
  type CarryOverRevertPreview,
  type WorkloadPublic,
} from "@/client"
import { HelpTip, SideDrawer } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useOrg } from "@/hooks/useOrg"
import i18n, { getLocale } from "@/i18n"
import { formatDate } from "@/i18n/format"
import { cn } from "@/lib/utils"
import { ForecastPolicyPanel } from "./ForecastPolicyPanel"
import { Unavailability } from "./MyWorkload"
import {
  addWeeks,
  formatCapacityPercent,
  formatDateOptional,
  hasForecast,
  useCapacitySettings,
  weekLabel,
  workloadNotice,
} from "./shared"
import {
  overlaps,
  TeamWorkloadGantt,
  WorkloadDetails,
  WorkloadLegend,
  type WorkloadSelection,
  weekRange,
} from "./TeamWorkloadGantt"

type WorkloadDialog =
  | { mode: "details"; selection: WorkloadSelection }
  | {
      mode: "edit"
      row: WorkloadPublic
      week: string
      initialPercent?: number
    }
  | { mode: "forecast_edit"; row: WorkloadPublic; week: string }

export function TeamWorkload({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const { employeeId, managedDepartmentIds, roles } = useOrg()
  const isAdmin = roles.includes("org_admin")
  const settings = useCapacitySettings(orgId)
  const defaultAllocationCapPercent =
    settings.data?.default_allocation_cap_percent ?? 70
  const [department, setDepartment] = useState("all")
  const [offset, setOffset] = useState(0)
  const [dialog, setDialog] = useState<WorkloadDialog | null>(null)
  const [previewItems, setPreviewItems] = useState<CarryOverPlanItem[] | null>(
    null,
  )
  const [revertDialogOpen, setRevertDialogOpen] = useState(false)
  const [revertPreview, setRevertPreview] =
    useState<CarryOverRevertPreview | null>(null)
  const [carryMessage, setCarryMessage] = useState<string | null>(null)
  const [policyDrawerOpen, setPolicyDrawerOpen] = useState(false)
  const dialogOpener = useRef<HTMLElement | null>(null)
  const list = async (from_week?: string) =>
    (
      await CapacityService.listWorkloads({
        path: { org_id: orgId },
        query: { from_week, weeks: 8 },
      })
    ).data.data
  const current = useQuery({
    queryKey: ["capacity", orgId, "team"],
    queryFn: () => list(),
  })
  const canCarryOver = !isAdmin && !!managedDepartmentIds.length
  const canRefreshForecasts = isAdmin || !!managedDepartmentIds.length
  const carryOverPreview = useQuery({
    queryKey: ["capacity", orgId, "carry-over-preview", department],
    queryFn: async () =>
      (
        await CapacityService.previewCapacityCarryOver({
          path: { org_id: orgId },
          query: {
            department_id: department === "all" ? undefined : department,
          },
        })
      ).data,
    enabled: canCarryOver,
  })
  const currentWeek = current.data?.[0]?.weeks[0]?.week_start
  const fromWeek =
    currentWeek && offset ? addWeeks(currentWeek, offset) : undefined
  const shifted = useQuery({
    queryKey: ["capacity", orgId, "team", fromWeek],
    queryFn: () => list(fromWeek),
    enabled: !!fromWeek,
  })
  const visible = (row: WorkloadPublic) =>
    department === "all" || row.department_id === department
  const canEdit = (row: WorkloadPublic) =>
    !isAdmin &&
    row.employee_id !== employeeId &&
    !!row.department_id &&
    managedDepartmentIds.includes(row.department_id)
  const planItems = carryOverPreview.data?.items ?? []
  const skippedCount = carryOverPreview.data?.skipped_no_baseline ?? 0
  const reversibleCount = carryOverPreview.data?.reversible_count ?? 0
  const latestBatch = carryOverPreview.data?.latest_batch ?? null
  const sep = t("capacity.common.listSeparator")
  const semi = t("capacity.common.semicolonSeparator")
  const confirm = useMutation({
    mutationFn: (items: CarryOverPlanItem[]) =>
      CapacityService.commitCapacityCarryOver({
        path: { org_id: orgId },
        body: {
          items: items.map((item) => ({
            employee_id: item.employee_id,
            week_start: item.target_week_start,
            baseline_week_start: item.baseline_week_start,
            other_percent: item.other_percent,
          })),
        },
      }),
    onSuccess: (response) => {
      setPreviewItems(null)
      setCarryMessage(
        t("capacity.team.carrySuccess", { count: response.data.items.length }),
      )
      client.invalidateQueries({ queryKey: ["capacity", orgId] })
      client.invalidateQueries({ queryKey: ["inbox", orgId] })
    },
  })
  const previewRevert = useMutation({
    mutationFn: async () =>
      (
        await CapacityService.previewCapacityCarryOverRevert({
          path: { org_id: orgId },
        })
      ).data,
    onSuccess: (data) => {
      setRevertPreview(data)
    },
  })
  const revert = useMutation({
    mutationFn: (batchId: string) =>
      CapacityService.revertCapacityCarryOver({
        path: { org_id: orgId },
        body: { batch_id: batchId },
      }),
    onSuccess: (response) => {
      const weeks = Array.from(
        new Set(response.data.items.map((item) => weekLabel(item.week_start))),
      ).join(sep)
      setRevertDialogOpen(false)
      setRevertPreview(null)
      setCarryMessage(
        t("capacity.team.revertSuccess", {
          name: response.data.created_by_name,
          weeks,
          count: response.data.items.length,
        }),
      )
      client.invalidateQueries({ queryKey: ["capacity", orgId] })
      client.invalidateQueries({ queryKey: ["inbox", orgId] })
    },
    onError: () => {
      client.invalidateQueries({ queryKey: ["capacity", orgId] })
    },
  })
  const refreshForecast = useMutation({
    mutationFn: () =>
      CapacityService.refreshCapacityForecasts({
        path: { org_id: orgId },
        query: department === "all" ? undefined : { department_id: department },
      }),
    onSuccess: (response) => {
      setCarryMessage(
        t("capacity.team.refreshSuccess", {
          count: response.data.updated_rows,
        }),
      )
      client.invalidateQueries({ queryKey: ["capacity", orgId] })
    },
  })
  const resetForecast = useMutation({
    mutationFn: ({
      targetEmployeeId,
      week,
    }: {
      targetEmployeeId: string
      week: string
    }) =>
      CapacityService.resetCapacityForecasts({
        path: { org_id: orgId },
        query: {
          employee_id: targetEmployeeId,
          start_week: week,
          end_week: week,
        },
      }),
    onSuccess: () => {
      setCarryMessage(t("capacity.team.resetSuccess"))
      client.invalidateQueries({ queryKey: ["capacity", orgId] })
    },
  })
  if (current.isPending) return <ProfileLoading />
  if (current.isError) return <ProfileError retry={() => current.refetch()} />
  const chart = fromWeek ? shifted : current
  const departments = new Map(
    current.data.flatMap((row) =>
      row.department_id && row.department_name
        ? [[row.department_id, row.department_name] as const]
        : [],
    ),
  )
  const selected = dialog?.mode === "details" ? dialog.selection : dialog
  const selectedRow = chart.data?.find(
    (row) => row.employee_id === selected?.row.employee_id && visible(row),
  )
  const changeWindow = (weeks: number) => {
    setDialog(null)
    setOffset(weeks)
  }
  const openDialog = (next: WorkloadDialog, opener?: HTMLElement) => {
    if (opener) dialogOpener.current = opener
    setDialog(next)
  }
  const actions = (
    row: WorkloadPublic,
    week = row.weeks[0].week_start,
    inDetails = false,
  ) => (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {canEdit(row) && (
        <Button
          size="sm"
          variant="outline"
          className="px-2"
          onClick={(event) =>
            openDialog(
              { mode: "edit", row, week },
              inDetails ? undefined : event.currentTarget,
            )
          }
        >
          {inDetails
            ? t("capacity.team.setWeekBtn")
            : t("capacity.team.setBtn")}
        </Button>
      )}
    </div>
  )
  const carrySummary =
    planItems.length > 200
      ? t("capacity.team.carryOverLimit")
      : planItems.length
        ? t("capacity.team.carryOverSummary", {
            items: planItems
              .slice(0, 5)
              .map((item) =>
                t("capacity.team.carryOverItemInline", {
                  name: item.employee_name,
                  week: weekLabel(item.target_week_start),
                  percent: formatCapacityPercent(item.other_percent),
                }),
              )
              .join(semi),
            more:
              planItems.length > 5
                ? t("capacity.team.carryOverMore", { count: planItems.length })
                : "",
            skipped: skippedCount
              ? t("capacity.team.carryOverExtraSkipped", {
                  count: skippedCount,
                })
              : "",
          })
        : skippedCount
          ? t("capacity.team.carryOverNoneWithSkipped", { count: skippedCount })
          : t("capacity.team.carryOverNone")
  return (
    <div className="min-w-0">
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-surface-border border-b bg-surface px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor="capacity-department" className="sr-only">
            {t("capacity.team.deptFilterAria")}
          </Label>
          <Select
            value={department}
            onValueChange={(value) => {
              setDepartment(value)
              setDialog(null)
            }}
          >
            <SelectTrigger
              id="capacity-department"
              className="max-w-52 sm:max-w-60"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("capacity.team.allDepts")}</SelectItem>
              {Array.from(departments, ([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {currentWeek && (
          <fieldset
            className="flex min-w-0 flex-wrap items-center gap-1"
            aria-label={t("capacity.team.timeWindowAria")}
          >
            <Button
              size="sm"
              variant="outline"
              onClick={() => changeWindow(offset - 4)}
              aria-label={t("capacity.team.prevPeriod")}
            >
              <ChevronLeft aria-hidden="true" />
              <span className="hidden xl:inline">
                {t("capacity.team.prevPeriod")}
              </span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!offset}
              onClick={() => changeWindow(0)}
            >
              {t("capacity.team.backToThisWeek")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => changeWindow(offset + 4)}
              aria-label={t("capacity.team.nextPeriod")}
            >
              <span className="hidden xl:inline">
                {t("capacity.team.nextPeriod")}
              </span>
              <ChevronRight aria-hidden="true" />
            </Button>
            <span
              className="sr-only ml-1 text-xs text-muted-foreground xl:not-sr-only"
              aria-live="polite"
            >
              {t("capacity.team.fromWeek", {
                week: weekLabel(fromWeek ?? currentWeek),
              })}
            </span>
          </fieldset>
        )}
        <HelpTip
          label={t("capacity.team.helpLabel")}
          content={
            <div className="space-y-2">
              <p>{workloadNotice()}</p>
              <p>{t("capacity.team.helpRef")}</p>
              {isAdmin && <p>{t("capacity.team.helpManagerOnly")}</p>}
              <p>{t("capacity.team.helpCellNote")}</p>
              <WorkloadLegend />
            </div>
          }
        />
        {(canCarryOver || canRefreshForecasts) && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {canRefreshForecasts && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDialog(null)
                    setPolicyDrawerOpen(true)
                  }}
                >
                  <SlidersHorizontal aria-hidden="true" />
                  <span>{t("capacity.team.policyBtn")}</span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    refreshForecast.isPending ||
                    confirm.isPending ||
                    revert.isPending
                  }
                  onClick={() => refreshForecast.mutate()}
                >
                  <RefreshCw aria-hidden="true" />
                  <span>
                    {refreshForecast.isPending
                      ? t("capacity.team.refreshing")
                      : t("capacity.team.refreshBtn")}
                  </span>
                </Button>
              </>
            )}
            {canCarryOver && (
              <>
                <HelpTip
                  label={t("capacity.team.carryOverHelpLabel")}
                  content={carrySummary}
                />
                <Dialog
                  open={!!previewItems}
                  onOpenChange={(open) => {
                    if (confirm.isPending) return
                    if (!open) setPreviewItems(null)
                    else if (planItems.length && !carryOverPreview.isFetching) {
                      confirm.reset()
                      setDialog(null)
                      setPreviewItems(planItems)
                    }
                  }}
                >
                  <DialogTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={t("capacity.team.carryOverBtn")}
                      title={carrySummary}
                      disabled={
                        !planItems.length ||
                        planItems.length > 200 ||
                        carryOverPreview.isFetching ||
                        confirm.isPending ||
                        revert.isPending
                      }
                    >
                      {t("capacity.team.carryOverBtn")}
                    </Button>
                  </DialogTrigger>
                  {previewItems && (
                    <DialogContent
                      className="flex max-h-[90dvh] flex-col"
                      showCloseButton={false}
                    >
                      <DialogHeader>
                        <DialogTitle>
                          {t("capacity.team.carryOverTitle")}
                        </DialogTitle>
                        <DialogDescription>
                          {t("capacity.team.carryOverDesc", {
                            count: previewItems.length,
                          })}
                        </DialogDescription>
                      </DialogHeader>
                      <ul
                        aria-label={t("capacity.team.carryOverAffectedAria")}
                        className="min-h-0 divide-y overflow-y-auto rounded-md border px-3"
                      >
                        {previewItems.map((item) => (
                          <li
                            key={item.employee_id}
                            className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                          >
                            <div className="min-w-0">
                              <p className="font-medium break-words">
                                {item.employee_name}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {t("capacity.team.carryOverItemWeek", {
                                  baseline: weekLabel(item.baseline_week_start),
                                  targetWeek: weekLabel(item.target_week_start),
                                  targetDate: item.target_week_start,
                                })}
                              </p>
                            </div>
                            <span className="shrink-0 font-medium tabular-nums">
                              {formatCapacityPercent(item.other_percent)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <SetupError error={confirm.error} />
                      <DialogFooter>
                        <DialogClose asChild>
                          <Button
                            variant="outline"
                            disabled={confirm.isPending}
                          >
                            {t("capacity.common.cancel")}
                          </Button>
                        </DialogClose>
                        <Button
                          disabled={confirm.isPending}
                          onClick={() => confirm.mutate(previewItems)}
                        >
                          {confirm.isPending
                            ? t("capacity.team.confirming")
                            : t("capacity.team.confirmCarryOver")}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  )}
                </Dialog>
                <Dialog
                  open={revertDialogOpen}
                  onOpenChange={(open) => {
                    if (revert.isPending) return
                    setRevertDialogOpen(open)
                    if (!open) {
                      setRevertPreview(null)
                      revert.reset()
                      previewRevert.reset()
                    }
                  }}
                >
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t("capacity.team.revertAria")}
                    title={
                      latestBatch
                        ? t("capacity.team.revertTitleAvailable", {
                            count: reversibleCount,
                          })
                        : t("capacity.team.revertTitleEmpty")
                    }
                    disabled={
                      !reversibleCount ||
                      revert.isPending ||
                      confirm.isPending ||
                      carryOverPreview.isFetching
                    }
                    onClick={() => {
                      setDialog(null)
                      revert.reset()
                      setRevertPreview(null)
                      setRevertDialogOpen(true)
                      previewRevert.mutate()
                    }}
                  >
                    <Undo2 aria-hidden="true" />
                    <span>
                      {revert.isPending
                        ? t("capacity.team.reverting")
                        : t("capacity.team.revertBtn")}
                    </span>
                  </Button>
                  <DialogContent
                    className="flex max-h-[90dvh] flex-col"
                    showCloseButton={false}
                  >
                    <DialogHeader>
                      <DialogTitle>
                        {t("capacity.team.revertDialogTitle")}
                      </DialogTitle>
                      <DialogDescription>
                        {t("capacity.team.revertDialogDesc")}
                      </DialogDescription>
                    </DialogHeader>
                    {previewRevert.isPending && (
                      <p className="text-sm text-muted-foreground">
                        {t("capacity.team.revertLoading")}
                      </p>
                    )}
                    <SetupError error={previewRevert.error} />
                    {!previewRevert.isPending &&
                      !previewRevert.isError &&
                      revertPreview &&
                      !revertPreview.latest_batch && (
                        <p className="text-sm text-muted-foreground">
                          {t("capacity.team.revertEmpty")}
                        </p>
                      )}
                    {!previewRevert.isPending &&
                      revertPreview?.latest_batch && (
                        <div className="min-h-0 space-y-3 overflow-y-auto">
                          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border bg-muted/30 p-3 text-sm">
                            <dt className="text-muted-foreground">
                              {t("capacity.team.revertOperator")}
                            </dt>
                            <dd className="font-medium">
                              {t("capacity.team.revertOperatorValue", {
                                name: revertPreview.latest_batch
                                  .created_by_name,
                                date: formatDateOptional(
                                  revertPreview.latest_batch.created_at,
                                ),
                              })}
                            </dd>
                            <dt className="text-muted-foreground">
                              {t("capacity.team.revertDepts")}
                            </dt>
                            <dd>
                              {revertPreview.latest_batch.department_names
                                .length
                                ? revertPreview.latest_batch.department_names.join(
                                    sep,
                                  )
                                : t("capacity.gantt.unassignedDept")}
                            </dd>
                            <dt className="text-muted-foreground">
                              {t("capacity.team.revertEmployees")}
                            </dt>
                            <dd>
                              {t("capacity.team.revertEmployeesValue", {
                                names:
                                  revertPreview.latest_batch.employee_names.join(
                                    sep,
                                  ),
                                count:
                                  revertPreview.latest_batch.employee_names
                                    .length,
                              })}
                            </dd>
                            <dt className="text-muted-foreground">
                              {t("capacity.team.revertWeeks")}
                            </dt>
                            <dd>
                              {revertPreview.latest_batch.week_starts
                                .map((w) =>
                                  t("capacity.team.revertWeekItem", {
                                    week: weekLabel(w),
                                    date: w,
                                  }),
                                )
                                .join(sep)}
                            </dd>
                          </dl>
                          <ul
                            aria-label={t("capacity.team.revertItemsAria")}
                            className="divide-y rounded-md border px-3"
                          >
                            {revertPreview.latest_batch.items.map((item) => (
                              <li
                                key={`${item.employee_id}-${item.week_start}`}
                                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                              >
                                <div className="min-w-0">
                                  <p className="font-medium break-words">
                                    {item.employee_name}
                                    {item.department_name
                                      ? ` · ${item.department_name}`
                                      : ""}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {t("capacity.team.revertWeekItem", {
                                      week: weekLabel(item.week_start),
                                      date: item.week_start,
                                    })}
                                  </p>
                                </div>
                                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                  {formatCapacityPercent(item.other_percent)} →{" "}
                                  {item.before_percent == null
                                    ? t("capacity.gantt.unconfirmed")
                                    : formatCapacityPercent(
                                        item.before_percent,
                                      )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    <SetupError error={revert.error} />
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline" disabled={revert.isPending}>
                          {t("capacity.common.cancel")}
                        </Button>
                      </DialogClose>
                      {revert.isError && (
                        <Button
                          variant="outline"
                          disabled={previewRevert.isPending || revert.isPending}
                          onClick={() => {
                            revert.reset()
                            previewRevert.mutate()
                          }}
                        >
                          {t("capacity.team.refreshAndRetry")}
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        disabled={
                          previewRevert.isPending ||
                          revert.isPending ||
                          !revertPreview?.latest_batch
                        }
                        onClick={() => {
                          const batchId = revertPreview?.latest_batch?.id
                          if (batchId) revert.mutate(batchId)
                        }}
                      >
                        {revert.isPending
                          ? t("capacity.team.reverting")
                          : t("capacity.team.confirmRevert")}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </>
            )}
          </div>
        )}
      </div>
      {carryMessage && (
        <div className="border-surface-border border-b bg-muted/40 px-3 py-2 text-xs">
          <p role="status">{carryMessage}</p>
        </div>
      )}
      <div className={cn("min-w-0", selectedRow && "md:pr-[min(380px,38vw)]")}>
        {chart.isPending ? (
          <ProfileLoading />
        ) : chart.isError ? (
          <ProfileError retry={() => chart.refetch()} />
        ) : (
          <TeamWorkloadGantt
            rows={chart.data.filter(visible)}
            current={currentWeek ?? ""}
            actions={actions}
            activeEmployee={selectedRow?.employee_id}
            activeWeek={selected?.week}
            defaultAllocationCapPercent={defaultAllocationCapPercent}
            onSelect={(selection, opener) =>
              openDialog({ mode: "details", selection }, opener)
            }
          />
        )}
      </div>
      <SideDrawer
        open={!!selectedRow}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null)
            dialogOpener.current?.focus({ preventScroll: true })
          }
        }}
        modal={false}
        showOverlay={false}
        className="max-md:inset-x-0 max-md:top-auto max-md:bottom-0 max-md:h-[55dvh] max-md:w-full max-md:max-w-none md:w-[min(380px,38vw)] md:max-w-none"
        title={
          selectedRow &&
          t(
            dialog?.mode === "edit"
              ? "capacity.team.drawerEdit"
              : dialog?.mode === "forecast_edit"
                ? "capacity.team.drawerForecastEdit"
                : "capacity.team.drawerDetails",
            { name: selectedRow.employee_name },
          )
        }
      >
        {selectedRow && dialog && (
          <div
            key={`${selectedRow.employee_id}:${selected?.week}:${dialog.mode}`}
            className="space-y-3"
          >
            {dialog.mode === "details" && (
              <>
                <WorkloadDetails
                  selection={{ ...dialog.selection, row: selectedRow }}
                  defaultAllocationCapPercent={defaultAllocationCapPercent}
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
                    employeeId={selectedRow.employee_id}
                    startWeek={dialog.selection.week}
                    weekRange={dialog.selection.range}
                    knownItems={selectedRow.unavailabilities}
                    canWrite={canEdit(selectedRow)}
                    idPrefix="week-unavailable"
                    submitLabel={t("capacity.team.addLeaveDateBtn")}
                  />
                </section>
                {(() => {
                  const weekLoad = selectedRow.weeks.find(
                    (w) => w.week_start === dialog.selection.week,
                  )
                  const unconfirmed =
                    !!weekLoad && weekLoad.status !== "confirmed"
                  const forecast = !!weekLoad && hasForecast(weekLoad)
                  return (
                    <>
                      {canEdit(selectedRow) && unconfirmed && (
                        <div className="flex flex-wrap gap-1.5 border-t pt-3">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              openDialog({
                                mode: "forecast_edit",
                                row: selectedRow,
                                week: dialog.selection.week,
                              })
                            }
                          >
                            {t("capacity.team.adjustForecastBtn")}
                          </Button>
                          {weekLoad.forecast_source === "manager_override" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={resetForecast.isPending}
                              onClick={() =>
                                resetForecast.mutate({
                                  targetEmployeeId: selectedRow.employee_id,
                                  week: dialog.selection.week,
                                })
                              }
                            >
                              {resetForecast.isPending
                                ? t("capacity.team.resetting")
                                : t("capacity.team.resetForecastBtn")}
                            </Button>
                          )}
                          {forecast && (
                            <Button
                              size="sm"
                              onClick={() =>
                                openDialog({
                                  mode: "edit",
                                  row: selectedRow,
                                  week: dialog.selection.week,
                                  initialPercent:
                                    weekLoad.forecast_other_percent ??
                                    undefined,
                                })
                              }
                            >
                              {t("capacity.team.confirmFormalBtn")}
                            </Button>
                          )}
                        </div>
                      )}
                      <SetupError error={resetForecast.error} />
                      {actions(selectedRow, dialog.selection.week, true)}
                    </>
                  )
                })()}
              </>
            )}
            {dialog.mode === "edit" && canEdit(selectedRow) && (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("capacity.team.editHint")}
                </p>
                <Adjustment
                  orgId={orgId}
                  workload={selectedRow}
                  week={dialog.week}
                  initialPercent={dialog.initialPercent}
                  close={() =>
                    setDialog((current) =>
                      current === dialog ? null : current,
                    )
                  }
                />
              </>
            )}
            {dialog.mode === "forecast_edit" && canEdit(selectedRow) && (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("capacity.team.forecastEditHint")}
                </p>
                <ForecastAdjustment
                  orgId={orgId}
                  workload={selectedRow}
                  week={dialog.week}
                  close={() =>
                    setDialog((current) =>
                      current === dialog ? null : current,
                    )
                  }
                />
              </>
            )}
          </div>
        )}
      </SideDrawer>
      <SideDrawer
        open={policyDrawerOpen}
        onOpenChange={setPolicyDrawerOpen}
        title={t("capacity.team.policyBtn")}
        className="sm:max-w-xl"
      >
        {policyDrawerOpen && (
          <ForecastPolicyPanel
            orgId={orgId}
            mode={isAdmin ? "admin" : "manager"}
          />
        )}
      </SideDrawer>
    </div>
  )
}

const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri"] as const

function weekdaysOf(mondayIso: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mondayIso)) return []
  const base = new Date(`${mondayIso}T00:00:00Z`)
  if (Number.isNaN(base.getTime())) return []
  const locale = getLocale()
  return WEEKDAY_KEYS.map((key, index) => {
    const day = new Date(base)
    day.setUTCDate(base.getUTCDate() + index)
    const iso = day.toISOString().slice(0, 10)
    const datePart =
      locale === "en"
        ? formatDate(iso, { month: "numeric", day: "numeric" })
        : iso.slice(5).replace("-", "/")
    return {
      date: iso,
      label: `${i18n.t(`capacity.team.weekdays.${key}`)} ${datePart}`,
    }
  })
}

function weekLeaveDates(workload: WorkloadPublic, targetWeek: string) {
  return weekdaysOf(targetWeek)
    .map((day) => day.date)
    .filter((day) =>
      (workload.unavailabilities ?? []).some(
        (item) => item.start_date <= day && day <= item.end_date,
      ),
    )
}

function Adjustment({
  orgId,
  workload,
  week,
  initialPercent,
  close,
}: {
  orgId: string
  workload: WorkloadPublic
  week: string
  initialPercent?: number
  close: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [start, setStart] = useState(week)
  const [end, setEnd] = useState(week)
  const activeWeek = /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : week
  const currentWeekLoad = workload.weeks.find(
    (item) => item.week_start === activeWeek,
  )
  const weekDays = weekdaysOf(activeWeek)
  const initialLeaveDates = weekLeaveDates(workload, activeWeek)
  const initialCap = currentWeekLoad?.capacity_percent ?? 100
  const initialLeave =
    initialCap < 100 ||
    initialLeaveDates.length > 0 ||
    (workload.unavailabilities ?? []).some((item) =>
      overlaps(weekRange(activeWeek), item),
    )
  const [percent, setPercent] = useState(
    String(
      initialPercent ??
        currentWeekLoad?.other_percent ??
        workload.last_confirmed?.percent ??
        "",
    ),
  )
  const [capacityCap, setCapacityCap] = useState(String(initialCap))
  const [onLeave, setOnLeave] = useState(initialLeave)
  const [selectedLeaveDates, setSelectedLeaveDates] =
    useState<string[]>(initialLeaveDates)
  const [leaveModified, setLeaveModified] = useState(false)
  const [dateError, setDateError] = useState<string | null>(null)
  const isSingleWeek = start === end
  const parsedCap = Number(capacityCap)
  const validCap =
    capacityCap !== "" &&
    Number.isFinite(parsedCap) &&
    parsedCap >= 0 &&
    parsedCap <= 100 &&
    parsedCap % 20 === 0
  const requiredDays = validCap ? (100 - parsedCap) / 20 : null
  const showWeekdayPicker =
    isSingleWeek && (leaveModified || initialLeaveDates.length > 0)
  const addedDays = selectedLeaveDates.filter(
    (day) => !initialLeaveDates.includes(day),
  )
  const removedDays = initialLeaveDates.filter(
    (day) => !selectedLeaveDates.includes(day),
  )
  const sep = t("capacity.common.listSeparator")
  const semi = t("capacity.common.semicolonSeparator")
  const save = useMutation({
    mutationFn: () =>
      CapacityService.setCapacityWeeks({
        path: { org_id: orgId },
        body: {
          items: [
            {
              employee_id: workload.employee_id,
              other_percent: Number(percent),
              ...(isSingleWeek && leaveModified
                ? {
                    capacity_percent: Number(capacityCap),
                    on_leave: onLeave,
                    leave_dates: selectedLeaveDates,
                  }
                : {}),
            },
          ],
          start_week: start,
          end_week: end,
        },
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["capacity", orgId] })
      client.invalidateQueries({ queryKey: ["inbox", orgId] })
      close()
    },
  })
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!isSingleWeek && leaveModified) {
          setDateError(t("capacity.team.crossWeekError"))
          return
        }
        if (
          isSingleWeek &&
          leaveModified &&
          requiredDays !== null &&
          selectedLeaveDates.length !== requiredDays
        ) {
          setDateError(
            t("capacity.team.leaveDaysMismatchError", {
              cap: parsedCap,
              required: requiredDays,
              selected: selectedLeaveDates.length,
            }),
          )
          return
        }
        setDateError(null)
        save.mutate()
      }}
    >
      <fieldset disabled={save.isPending} className="space-y-4">
        <div className="grid gap-3 min-[420px]:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="start-week">
              {t("capacity.workload.startWeek")}
            </Label>
            <Input
              id="start-week"
              type="date"
              min="1970-01-05"
              step={7}
              required
              value={start}
              onChange={(event) => {
                const next = event.target.value
                setStart(next)
                setDateError(null)
                if (end < next) setEnd(next)
                if (/^\d{4}-\d{2}-\d{2}$/.test(next)) {
                  const nextLoad = workload.weeks.find(
                    (item) => item.week_start === next,
                  )
                  const nextDates = weekLeaveDates(workload, next)
                  const nextCap = nextLoad?.capacity_percent ?? 100
                  setCapacityCap(String(nextCap))
                  setOnLeave(nextCap < 100 || nextDates.length > 0)
                  setSelectedLeaveDates(nextDates)
                  setLeaveModified(false)
                }
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="end-week">{t("capacity.workload.endWeek")}</Label>
            <Input
              id="end-week"
              type="date"
              min={start}
              step={7}
              required
              value={end}
              onChange={(event) => {
                setEnd(event.target.value)
                setDateError(null)
              }}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="base-percent">
            {t("capacity.team.basePercentLabel")}
          </Label>
          <Input
            id="base-percent"
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
          <Label htmlFor="capacity-percent">
            {t("capacity.team.capPercentLabel")}
          </Label>
          <Input
            id="capacity-percent"
            type="number"
            min={0}
            max={100}
            step={20}
            required
            disabled={!isSingleWeek}
            value={capacityCap}
            onChange={(event) => {
              const next = event.target.value
              setCapacityCap(next)
              setLeaveModified(true)
              setDateError(null)
              const parsed = Number(next)
              if (next !== "" && Number.isFinite(parsed)) {
                setOnLeave(parsed < 100)
                if (parsed >= 100) {
                  setSelectedLeaveDates([])
                } else if (parsed === initialCap) {
                  setSelectedLeaveDates(initialLeaveDates)
                }
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            {t("capacity.team.capHint")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="on-leave"
            checked={onLeave}
            disabled={!isSingleWeek}
            onCheckedChange={(checked) => {
              const next = checked === true
              setOnLeave(next)
              setLeaveModified(true)
              setDateError(null)
              if (next && Number(capacityCap) >= 100) {
                setCapacityCap("80")
              } else if (!next) {
                setCapacityCap("100")
                setSelectedLeaveDates([])
              }
            }}
          />
          <Label htmlFor="on-leave">{t("capacity.team.onLeaveLabel")}</Label>
        </div>
        {showWeekdayPicker && (
          <fieldset
            aria-label={t("capacity.team.leavePickerAria")}
            className="space-y-2 rounded-md border bg-muted/30 p-3"
          >
            <legend className="px-1 text-xs font-medium">
              {t("capacity.team.leavePickerLegend", {
                week: weekLabel(activeWeek),
              })}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {weekDays.map((day) => {
                const checked = selectedLeaveDates.includes(day.date)
                return (
                  <div
                    key={day.date}
                    className="flex items-center gap-2 text-xs"
                  >
                    <Checkbox
                      id={`leave-day-${day.date}`}
                      checked={checked}
                      aria-label={day.label}
                      onCheckedChange={(value) => {
                        const isChecked = value === true
                        const nextDates = weekDays
                          .map((d) => d.date)
                          .filter((d) =>
                            isChecked
                              ? d === day.date || selectedLeaveDates.includes(d)
                              : d !== day.date &&
                                selectedLeaveDates.includes(d),
                          )
                        setSelectedLeaveDates(nextDates)
                        setLeaveModified(true)
                        setDateError(null)
                        setCapacityCap(String(100 - nextDates.length * 20))
                        setOnLeave(nextDates.length > 0)
                      }}
                    />
                    <Label
                      htmlFor={`leave-day-${day.date}`}
                      className="cursor-pointer text-xs font-normal"
                    >
                      {day.label}
                    </Label>
                  </div>
                )
              })}
            </div>
            {leaveModified &&
              requiredDays !== null &&
              selectedLeaveDates.length !== requiredDays && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {selectedLeaveDates.length < requiredDays
                    ? t("capacity.team.leaveNeedMore", {
                        count: requiredDays - selectedLeaveDates.length,
                        selected: selectedLeaveDates.length,
                        required: requiredDays,
                      })
                    : t("capacity.team.leaveNeedLess", {
                        count: selectedLeaveDates.length - requiredDays,
                        selected: selectedLeaveDates.length,
                        required: requiredDays,
                      })}
                </p>
              )}
            {leaveModified &&
              (addedDays.length > 0 || removedDays.length > 0) && (
                <p className="text-xs text-muted-foreground">
                  {addedDays.length > 0 &&
                    t("capacity.team.leaveAdded", {
                      days: addedDays.join(sep),
                    })}
                  {addedDays.length > 0 && removedDays.length > 0 && semi}
                  {removedDays.length > 0 &&
                    t("capacity.team.leaveRemoved", {
                      days: removedDays.join(sep),
                    })}
                </p>
              )}
          </fieldset>
        )}
        {!isSingleWeek && (
          <p className="text-xs text-muted-foreground">
            {t("capacity.team.crossWeekNote")}
          </p>
        )}
        {dateError && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 p-3 text-xs text-destructive"
          >
            {dateError}
          </div>
        )}
        <SetupError error={save.error} />
        <Button type="submit">
          {save.isPending
            ? t("capacity.common.saving")
            : t("capacity.team.confirmSettingsBtn")}
        </Button>
      </fieldset>
    </form>
  )
}

function ForecastAdjustment({
  orgId,
  workload,
  week,
  close,
}: {
  orgId: string
  workload: WorkloadPublic
  week: string
  close: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const currentWeekLoad = workload.weeks.find(
    (item) => item.week_start === week,
  )
  const [start, setStart] = useState(week)
  const [end, setEnd] = useState(week)
  const [percent, setPercent] = useState(
    String(
      currentWeekLoad?.forecast_other_percent ??
        workload.last_confirmed?.percent ??
        "",
    ),
  )
  const [note, setNote] = useState("")
  const save = useMutation({
    mutationFn: () =>
      CapacityService.overrideCapacityForecasts({
        path: { org_id: orgId },
        body: {
          employee_id: workload.employee_id,
          start_week: start,
          end_week: end,
          forecast_other_percent: Number(percent),
          note: note.trim() ? note.trim() : null,
        },
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["capacity", orgId] })
      close()
    },
  })
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <fieldset disabled={save.isPending} className="space-y-4">
        <div className="grid gap-3 min-[420px]:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="forecast-start-week">
              {t("capacity.workload.startWeek")}
            </Label>
            <Input
              id="forecast-start-week"
              type="date"
              min="1970-01-05"
              step={7}
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
            <Label htmlFor="forecast-end-week">
              {t("capacity.workload.endWeek")}
            </Label>
            <Input
              id="forecast-end-week"
              type="date"
              min={start}
              step={7}
              required
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="forecast-other-percent">
            {t("capacity.team.forecastOtherLabel")}
          </Label>
          <Input
            id="forecast-other-percent"
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
          <Label htmlFor="forecast-note">
            {t("capacity.team.forecastNoteLabel")}
          </Label>
          <Input
            id="forecast-note"
            maxLength={200}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <SetupError error={save.error} />
        <Button type="submit">
          {save.isPending
            ? t("capacity.common.saving")
            : t("capacity.team.saveForecastBtn")}
        </Button>
      </fieldset>
    </form>
  )
}
