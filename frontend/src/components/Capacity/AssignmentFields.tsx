import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AxiosError } from "axios"
import { type ComponentProps, useId } from "react"
import { useTranslation } from "react-i18next"
import { CapacityService } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Input } from "@/components/ui/input"
import { capacityKeys, invalidateCapacityAssignments } from "./queries"
import { formatCapacityPercent } from "./shared"

export function useCapacityRefresh(orgId: string) {
  const cache = useQueryClient()
  return () => {
    void invalidateCapacityAssignments(cache, orgId)
  }
}

export function CapacityError({ error }: { error: Error | null }) {
  const { t } = useTranslation()
  const detail: unknown =
    error instanceof AxiosError ? error.response?.data?.detail : null
  if (Array.isArray(detail)) {
    return (
      <div role="alert" className="text-sm text-destructive">
        {detail.map((item, index) => (
          <p key={index}>{item.msg}</p>
        ))}
      </div>
    )
  }
  if (
    detail &&
    typeof detail === "object" &&
    "message" in detail &&
    typeof detail.message === "string" &&
    ("weeks" in detail || "over_weeks" in detail)
  ) {
    const weeks =
      "weeks" in detail && Array.isArray(detail.weeks) ? detail.weeks : []
    const over =
      "over_weeks" in detail && Array.isArray(detail.over_weeks)
        ? detail.over_weeks
        : []
    return (
      <div role="alert" className="space-y-1 text-sm text-destructive">
        <p>{detail.message}</p>
        <ul>
          {weeks.map((week) => (
            <li key={week.week_start}>
              {t("capacity.demandDetail.unconfirmedWeekLine", {
                week: week.week_start,
                status:
                  week.status === "stale"
                    ? t("capacity.workload.statusStale")
                    : t("capacity.workload.statusUnconfirmed"),
              })}
            </li>
          ))}
          {over.map((week) => (
            <li key={week.week_start}>
              {t("capacity.demandDetail.overWeekLine", {
                week: week.week_start,
                percent: formatCapacityPercent(week.over_percent),
              })}
            </li>
          ))}
        </ul>
        <a href="/capacity?tab=team" className="underline">
          {t("capacity.demandDetail.confirmTeamLoadLink")}
        </a>
      </div>
    )
  }
  return <SetupError error={error} />
}

export function commitmentBody(data: FormData) {
  const end = String(data.get("new_committed_end_date") ?? "")
  return end
    ? {
        new_committed_end_date: end,
        commitment_note: String(data.get("commitment_note")).trim(),
      }
    : {}
}

export function CommitmentFields({
  dueDate,
  committedEndDate,
}: {
  dueDate: string
  committedEndDate: string | null
}) {
  const { t } = useTranslation()
  if (!committedEndDate || dueDate <= committedEndDate) return null
  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="text-sm font-medium">
        {t("capacity.assignments.commitmentDelayNotice")}
      </p>
      <DateField
        label={t("capacity.assignments.newCommittedEndDate")}
        name="new_committed_end_date"
        min={dueDate}
      />
      <NoteField
        label={t("capacity.assignments.commitmentNoteLabel")}
        name="commitment_note"
      />
      <p className="text-xs text-muted-foreground">
        {t("capacity.assignments.commitmentNoteHint")}
      </p>
    </div>
  )
}

export function DateField({
  label,
  ...props
}: ComponentProps<typeof Input> & { label: string }) {
  const id = useId()
  return (
    <label htmlFor={id} className="block space-y-2 text-sm">
      <span>{label}</span>
      <Input id={id} type="date" required {...props} />
    </label>
  )
}

export function NoteField({
  label,
  ...props
}: ComponentProps<"textarea"> & { label: string }) {
  return (
    <label className="block space-y-2 text-sm">
      <span>{label}</span>
      <textarea
        required
        maxLength={500}
        className="min-h-20 w-full rounded-md border bg-background p-3"
        {...props}
      />
    </label>
  )
}

export function useMyAssignments(orgId: string, enabled = true) {
  return useQuery({
    queryKey: capacityKeys.assignmentsMe(orgId),
    queryFn: async () =>
      (await CapacityService.listMyAssignments({ path: { org_id: orgId } }))
        .data,
    enabled,
  })
}

export function useExtensions(
  orgId: string,
  enabled = true,
  excludeOwn = false,
) {
  return useQuery({
    queryKey: capacityKeys.extensions(orgId, excludeOwn),
    queryFn: async () =>
      (
        await CapacityService.listExtensionRequests({
          path: { org_id: orgId },
          query: excludeOwn ? { exclude_own: true } : undefined,
        })
      ).data,
    enabled,
  })
}
