import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CapacityService, type WorkloadPublic } from "@/client"
import { HelpTip, SideDrawer } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useOrg } from "@/hooks/useOrg"
import { cn } from "@/lib/utils"
import { addWeeks } from "./dateUtils"
import { ForecastPolicyPanel } from "./ForecastPolicyPanel"
import { Unavailability } from "./MyWorkload"
import { capacityKeys, invalidateWorkloadMutation } from "./queries"
import {
  hasForecast,
  useCapacitySettings,
  weekLabel,
  workloadNotice,
} from "./shared"
import { Adjustment, ForecastAdjustment } from "./TeamWorkloadAdjustment"
import {
  carryOverMutationKey,
  TeamWorkloadCarryOverControls,
} from "./TeamWorkloadCarryOver"
import {
  TeamWorkloadGantt,
  WorkloadDetails,
  WorkloadLegend,
  type WorkloadSelection,
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
    queryKey: capacityKeys.workloadTeam(orgId),
    queryFn: () => list(),
  })
  const canCarryOver = !isAdmin && !!managedDepartmentIds.length
  const canRefreshForecasts = isAdmin || !!managedDepartmentIds.length
  const isCarryOverMutating =
    useIsMutating({ mutationKey: carryOverMutationKey(orgId) }) > 0
  const currentWeek = current.data?.[0]?.weeks[0]?.week_start
  const fromWeek =
    currentWeek && offset ? addWeeks(currentWeek, offset) : undefined
  const shifted = useQuery({
    queryKey: capacityKeys.workloadTeam(orgId, fromWeek),
    queryFn: () => list(fromWeek),
    enabled: !!fromWeek,
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
      void invalidateWorkloadMutation(client, orgId)
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
      void invalidateWorkloadMutation(client, orgId)
    },
  })

  const chart = fromWeek ? shifted : current
  const departments = useMemo(
    () =>
      new Map(
        (current.data ?? []).flatMap((row) =>
          row.department_id && row.department_name
            ? [[row.department_id, row.department_name] as const]
            : [],
        ),
      ),
    [current.data],
  )
  const visibleRows = useMemo(
    () =>
      (chart.data ?? []).filter(
        (row) => department === "all" || row.department_id === department,
      ),
    [chart.data, department],
  )
  const selected = dialog?.mode === "details" ? dialog.selection : dialog
  const selectedEmployeeId = selected?.row.employee_id
  const selectedRow = useMemo(
    () => visibleRows.find((row) => row.employee_id === selectedEmployeeId),
    [visibleRows, selectedEmployeeId],
  )

  if (current.isPending) return <ProfileLoading />
  if (current.isError) return <ProfileError retry={() => current.refetch()} />

  const canEdit = (row: WorkloadPublic) =>
    !isAdmin &&
    row.employee_id !== employeeId &&
    !!row.department_id &&
    managedDepartmentIds.includes(row.department_id)
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
                  disabled={refreshForecast.isPending || isCarryOverMutating}
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
              <TeamWorkloadCarryOverControls
                orgId={orgId}
                department={department}
                onBeforeOpen={() => setDialog(null)}
                onMessage={setCarryMessage}
              />
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
            rows={visibleRows}
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
