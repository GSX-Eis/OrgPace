import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { SourcesService } from "@/client"
import { localeRecord } from "@/components/Admin/labels"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { SetupError } from "@/components/Setup/SetupError"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatDate } from "@/i18n/format"

const statuses = localeRecord(
  {
    queued: "",
    running: "",
    succeeded: "",
    failed: "",
  },
  "sources.syncRuns.statuses",
)
const countLabels: Record<string, string> = localeRecord(
  {
    records: "",
    evidence_added: "",
    evidence_superseded: "",
    evidence_retracted: "",
    people_unlinked: "",
    tasks_added: "",
    tasks_updated: "",
    events_added: "",
    events_updated: "",
    evidence_unchanged: "",
  },
  "sources.syncRuns.counts",
)
export function SyncRunTable({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [skip, setSkip] = useState(0)
  const runs = useQuery({
    queryKey: ["sync-runs", orgId, skip],
    queryFn: async () =>
      (
        await SourcesService.listSyncRuns({
          path: { org_id: orgId },
          query: { skip, limit: 20 },
        })
      ).data,
    refetchInterval: (q) =>
      q.state.data?.data.some(
        (r) => r.status === "queued" || r.status === "running",
      )
        ? 5000
        : false,
  })
  const retry = useMutation({
    mutationFn: (id: string) =>
      SourcesService.retrySync({ path: { org_id: orgId, run_id: id } }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["sync-runs", orgId] }),
        client.invalidateQueries({ queryKey: ["source-runs", orgId] }),
      ]),
  })
  return (
    <SectionCard
      className="space-y-2 p-3"
      aria-label={t("sources.syncRuns.ariaLabel")}
    >
      <h2 className="text-sm font-semibold">{t("sources.syncRuns.heading")}</h2>
      <SetupError error={runs.error ?? retry.error} />
      {runs.isError && (
        <Button onClick={() => runs.refetch()}>
          {t("sources.syncRuns.retryLoading")}
        </Button>
      )}
      {runs.isPending && <p role="status">{t("sources.syncRuns.loading")}</p>}
      {runs.data?.count === 0 && <p>{t("sources.syncRuns.empty")}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="h-10 border-b bg-muted/30 text-muted-foreground">
              {[
                t("sources.syncRuns.columns.source"),
                t("sources.syncRuns.columns.scope"),
                t("sources.syncRuns.columns.statusAttempts"),
                t("sources.syncRuns.columns.results"),
                t("sources.syncRuns.columns.error"),
                t("sources.syncRuns.columns.time"),
                t("sources.syncRuns.columns.actions"),
              ].map((h) => (
                <th
                  className="whitespace-nowrap px-2 py-1 text-xs font-medium"
                  key={h}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.data?.data.map((run) => {
              const entries = Object.entries(run.counts)
              const overview = entries.filter(
                ([key]) => key === "records" || key === "evidence_added",
              )
              const additional = entries.filter(
                ([key]) => key !== "records" && key !== "evidence_added",
              )
              return (
                <tr key={run.id} className="h-11 border-b last:border-b-0">
                  <td className="px-2 py-1">
                    {run.kind === "jira"
                      ? t("sources.syncRuns.kindJira")
                      : t("sources.syncRuns.kindCsv")}
                    {run.filename && (
                      <p className="break-all text-xs text-muted-foreground">
                        {run.filename}
                      </p>
                    )}
                  </td>
                  <td className="max-w-48 px-2 py-1 [overflow-wrap:anywhere]">
                    {run.kind === "jira"
                      ? run.project_keys?.length
                        ? run.project_keys.join(t("sources.syncRuns.joinSep"))
                        : t("sources.syncRuns.allProjects")
                      : "—"}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">
                    <Badge
                      variant={
                        run.status === "failed" ? "destructive" : "secondary"
                      }
                    >
                      {statuses[run.status]}
                    </Badge>{" "}
                    <span className="text-xs text-muted-foreground">
                      {t("sources.syncRuns.attemptsCount", {
                        count: run.attempts,
                      })}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-xs">
                    <div className="flex gap-2">
                      {overview.map(([key, n]) => (
                        <span key={key}>
                          {t("sources.syncRuns.countItem", {
                            label: countLabels[key],
                            count: n,
                          })}
                        </span>
                      ))}
                    </div>
                    {additional.length > 0 && (
                      <details className="inline-block">
                        <summary className="cursor-pointer text-primary">
                          {t("sources.syncRuns.otherCounts")}
                        </summary>
                        {additional.map(([key, n]) => (
                          <p key={key}>
                            {t("sources.syncRuns.countItem", {
                              label:
                                countLabels[key] ??
                                t("sources.syncRuns.otherLabel"),
                              count: n,
                            })}
                          </p>
                        ))}
                      </details>
                    )}
                  </td>
                  <td className="max-w-48 px-2 py-1 text-xs">
                    {run.error && (
                      <details>
                        <summary className="cursor-pointer whitespace-nowrap text-destructive">
                          {t("sources.syncRuns.viewError")}
                        </summary>
                        <p className="break-words">{run.error}</p>
                      </details>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-xs tabular-nums">
                    {formatDate(run.created_at, {
                      dateStyle: "short",
                      timeStyle: "medium",
                    })}
                    {run.finished_at && (
                      <p className="text-muted-foreground">
                        {t("sources.syncRuns.finishedAt", {
                          time: formatDate(run.finished_at, {
                            dateStyle: "short",
                            timeStyle: "medium",
                          }),
                        })}
                      </p>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    {run.status === "failed" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(run.id)}
                      >
                        {t("sources.syncRuns.retry")}
                      </Button>
                    )}
                    {run.status === "succeeded" && (
                      <Link
                        to="/admin/data-ai"
                        search={{ tab: "work-records", sync_run_id: run.id }}
                        className="whitespace-nowrap text-xs font-medium text-primary hover:underline"
                      >
                        {t("sources.syncRuns.viewRecords")}
                      </Link>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!!runs.data?.count && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button
            variant="outline"
            size="sm"
            disabled={skip === 0}
            onClick={() => setSkip(skip - 20)}
          >
            {t("sources.syncRuns.prevPage")}
          </Button>
          <span>
            {t("sources.syncRuns.pageRange", {
              from: skip + 1,
              to: Math.min(skip + 20, runs.data.count),
              total: runs.data.count,
            })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={skip + 20 >= runs.data.count}
            onClick={() => setSkip(skip + 20)}
          >
            {t("sources.syncRuns.nextPage")}
          </Button>
        </div>
      )}
    </SectionCard>
  )
}
