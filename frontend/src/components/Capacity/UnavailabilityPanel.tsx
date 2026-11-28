import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CapacityService, type WorkloadUnavailabilitySegment } from "@/client"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { type DateRange, overlaps } from "./dateUtils"
import { capacityKeys, invalidateWorkloadMutation } from "./queries"
import { formatIsoDateRange } from "./shared"

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
    queryKey: capacityKeys.unavailability(orgId, employeeId, fromDate, toDate),
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
      void invalidateWorkloadMutation(client, orgId, { unavailability: true })
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
