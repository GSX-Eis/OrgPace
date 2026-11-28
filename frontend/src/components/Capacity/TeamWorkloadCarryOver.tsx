import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Undo2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapacityService,
  type CarryOverPlanItem,
  type CarryOverRevertPreview,
} from "@/client"
import { HelpTip } from "@/components/Common/WorkbenchPrimitives"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
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
import { capacityKeys, invalidateWorkloadMutation } from "./queries"
import { formatCapacityPercent, formatDateOptional, weekLabel } from "./shared"

export const carryOverMutationKey = (orgId: string) =>
  ["capacity", orgId, "carry-over-mutation"] as const

export function TeamWorkloadCarryOverControls({
  orgId,
  department,
  onBeforeOpen,
  onMessage,
}: {
  orgId: string
  department: string
  onBeforeOpen: () => void
  onMessage: (message: string) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [previewItems, setPreviewItems] = useState<CarryOverPlanItem[] | null>(
    null,
  )
  const [revertDialogOpen, setRevertDialogOpen] = useState(false)
  const [revertPreview, setRevertPreview] =
    useState<CarryOverRevertPreview | null>(null)

  const carryOverPreview = useQuery({
    queryKey: capacityKeys.carryOverPreview(orgId, department),
    queryFn: async () =>
      (
        await CapacityService.previewCapacityCarryOver({
          path: { org_id: orgId },
          query: {
            department_id: department === "all" ? undefined : department,
          },
        })
      ).data,
  })

  const planItems = carryOverPreview.data?.items ?? []
  const skippedCount = carryOverPreview.data?.skipped_no_baseline ?? 0
  const reversibleCount = carryOverPreview.data?.reversible_count ?? 0
  const latestBatch = carryOverPreview.data?.latest_batch ?? null
  const sep = t("capacity.common.listSeparator")
  const semi = t("capacity.common.semicolonSeparator")

  const confirm = useMutation({
    mutationKey: carryOverMutationKey(orgId),
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
      onMessage(
        t("capacity.team.carrySuccess", { count: response.data.items.length }),
      )
      void invalidateWorkloadMutation(client, orgId, { inbox: true })
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
    mutationKey: carryOverMutationKey(orgId),
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
      onMessage(
        t("capacity.team.revertSuccess", {
          name: response.data.created_by_name,
          weeks,
          count: response.data.items.length,
        }),
      )
      void invalidateWorkloadMutation(client, orgId, { inbox: true })
    },
    onError: () => {
      void invalidateWorkloadMutation(client, orgId)
    },
  })

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
            onBeforeOpen()
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
              <DialogTitle>{t("capacity.team.carryOverTitle")}</DialogTitle>
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
                <Button variant="outline" disabled={confirm.isPending}>
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
            onBeforeOpen()
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
            <DialogTitle>{t("capacity.team.revertDialogTitle")}</DialogTitle>
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
          {!previewRevert.isPending && revertPreview?.latest_batch && (
            <div className="min-h-0 space-y-3 overflow-y-auto">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border bg-muted/30 p-3 text-sm">
                <dt className="text-muted-foreground">
                  {t("capacity.team.revertOperator")}
                </dt>
                <dd className="font-medium">
                  {t("capacity.team.revertOperatorValue", {
                    name: revertPreview.latest_batch.created_by_name,
                    date: formatDateOptional(
                      revertPreview.latest_batch.created_at,
                    ),
                  })}
                </dd>
                <dt className="text-muted-foreground">
                  {t("capacity.team.revertDepts")}
                </dt>
                <dd>
                  {revertPreview.latest_batch.department_names.length
                    ? revertPreview.latest_batch.department_names.join(sep)
                    : t("capacity.gantt.unassignedDept")}
                </dd>
                <dt className="text-muted-foreground">
                  {t("capacity.team.revertEmployees")}
                </dt>
                <dd>
                  {t("capacity.team.revertEmployeesValue", {
                    names: revertPreview.latest_batch.employee_names.join(sep),
                    count: revertPreview.latest_batch.employee_names.length,
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
                        : formatCapacityPercent(item.before_percent)}
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
  )
}
