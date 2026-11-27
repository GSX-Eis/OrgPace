import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { CapacityTrackingService, type TrackingState } from "@/client"
import { ProfileError } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import i18n from "@/i18n"
import { CapacityError, useCapacityRefresh } from "./AssignmentFields"

const trackingStateKeys: Record<TrackingState, string> = {
  status_unknown: "capacity.assignments.tracking.states.status_unknown",
  no_tasks: "capacity.assignments.tracking.states.no_tasks",
  on_track: "capacity.assignments.tracking.states.on_track",
  tasks_done: "capacity.assignments.tracking.states.tasks_done",
  overdue: "capacity.assignments.tracking.states.overdue",
  handed_over: "capacity.assignments.tracking.states.handed_over",
}

export function trackingLabel(state: TrackingState) {
  return i18n.t(trackingStateKeys[state])
}

export function AssignmentTracking({
  orgId,
  assignmentId,
}: {
  orgId: string
  assignmentId: string
}) {
  const { t } = useTranslation()
  const cache = useQueryClient()
  const refresh = useCapacityRefresh(orgId)
  const inputId = useId()
  const [query, setQuery] = useState("")
  const path = { org_id: orgId, assignment_id: assignmentId }
  const key = ["capacity", orgId, "tracking", assignmentId]
  const tracking = useQuery({
    queryKey: key,
    queryFn: async () =>
      (await CapacityTrackingService.trackingGetAssignmentTracking({ path }))
        .data,
  })
  const search = useMutation({
    mutationFn: async (q: string) =>
      (
        await CapacityTrackingService.trackingSearchAssignmentTasks({
          path,
          query: { q },
        })
      ).data,
  })
  const change = useMutation({
    mutationFn: async ({ taskId, link }: { taskId: string; link: boolean }) =>
      link
        ? CapacityTrackingService.trackingLinkAssignmentTask({
            path,
            body: { task_id: taskId },
          })
        : CapacityTrackingService.trackingUnlinkAssignmentTask({
            path: { ...path, task_id: taskId },
          }),
    onSuccess: (result) => {
      cache.setQueryData(key, result.data)
      refresh()
    },
  })
  if (tracking.isPending)
    return (
      <p className="text-sm text-muted-foreground">
        {t("capacity.assignments.tracking.loading")}
      </p>
    )
  if (tracking.isError) return <ProfileError retry={() => tracking.refetch()} />
  const tasks = tracking.data.tasks
  const results = search.data?.filter((candidate) =>
    tasks.every((task) => task.id !== candidate.id),
  )
  return (
    <section
      aria-label={t("capacity.assignments.tracking.sectionAria")}
      className="space-y-2 border-t pt-3 text-sm"
    >
      <p aria-live="polite">
        {t(trackingStateKeys[tracking.data.tracking_state])}
      </p>
      {tasks.length > 0 && (
        <ul
          className="space-y-1"
          aria-label={t("capacity.assignments.tracking.linkedAria")}
        >
          {tasks.map((task) => (
            <li className="flex flex-wrap items-center gap-2" key={task.id}>
              <span>
                {task.external_key} · {task.title}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={change.isPending}
                onClick={() => change.mutate({ taskId: task.id, link: false })}
              >
                {t("capacity.assignments.tracking.unlinkBtn")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="space-y-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (query.trim()) search.mutate(query.trim())
        }}
      >
        <label htmlFor={inputId}>
          {t("capacity.assignments.tracking.searchLabel")}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={100}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={!query.trim() || search.isPending}
          >
            {t("capacity.assignments.tracking.searchBtn")}
          </Button>
        </div>
      </form>
      {search.isSuccess &&
        (results?.length ? (
          <ul
            className="space-y-1"
            aria-label={t("capacity.assignments.tracking.availableAria")}
          >
            {results.map((task) => (
              <li className="flex flex-wrap items-center gap-2" key={task.id}>
                <span>
                  {task.external_key} · {task.title} ({task.source})
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={change.isPending}
                  onClick={() => change.mutate({ taskId: task.id, link: true })}
                >
                  {t("capacity.assignments.tracking.linkBtn")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t("capacity.assignments.tracking.noMatch")}</p>
        ))}
      <CapacityError error={search.error ?? change.error} />
    </section>
  )
}
