import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { SourcesService, type SyncRunPublic } from "@/client"
import { localeRecord } from "@/components/Admin/labels"
import { formatDate } from "@/i18n/format"

export function useSourceRuns(orgId: string, kind: SyncRunPublic["kind"]) {
  return useQuery({
    queryKey: ["source-runs", orgId, kind],
    queryFn: async () =>
      (
        await SourcesService.listSyncRuns({
          path: { org_id: orgId },
          query: { kind, limit: kind === "jira" ? 1 : 3 },
        })
      ).data.data,
    refetchInterval: (query) =>
      query.state.data?.some(
        (run) => run.status === "queued" || run.status === "running",
      )
        ? 3000
        : false,
  })
}

const statuses = localeRecord(
  {
    queued: "",
    running: "",
    succeeded: "",
    failed: "",
  },
  "sources.lastSync.statuses",
)
const counts: Record<string, string> = localeRecord(
  {
    records: "",
    tasks_added: "",
    tasks_updated: "",
    evidence_added: "",
    evidence_superseded: "",
    evidence_retracted: "",
    people_unlinked: "",
    evidence_unchanged: "",
    events_updated: "",
    events_added: "",
  },
  "sources.lastSync.counts",
)

export function LastSyncStatus({ run }: { run?: SyncRunPublic }) {
  const { t } = useTranslation()
  if (!run)
    return (
      <p className="text-sm text-muted-foreground">
        {t("sources.lastSync.empty")}
      </p>
    )
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border bg-muted/30 p-4 text-sm"
    >
      <p className="font-medium">
        {t("sources.lastSync.heading", {
          kind:
            run.kind === "jira"
              ? t("sources.lastSync.kindJira")
              : t("sources.lastSync.kindCsv"),
          status: statuses[run.status],
        })}
      </p>
      <p className="break-all text-muted-foreground">
        {run.filename} ·{" "}
        {formatDate(run.finished_at ?? run.started_at ?? run.created_at, {
          dateStyle: "short",
          timeStyle: "medium",
        })}
      </p>
      <p>
        {Object.entries(run.counts)
          .map(
            ([key, value]) =>
              `${counts[key] ?? t("sources.lastSync.otherCount")} ${value}`,
          )
          .join(" · ")}
      </p>
      {run.error && <p className="text-destructive">{run.error}</p>}
      {run.status === "succeeded" && (
        <p>
          <Link
            to="/admin/data-ai"
            search={{ tab: "work-records", sync_run_id: run.id }}
            className="text-xs font-medium text-primary hover:underline"
          >
            {t("sources.lastSync.viewBatchRecords")}
          </Link>
        </p>
      )}
    </div>
  )
}
