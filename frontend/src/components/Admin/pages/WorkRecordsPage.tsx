import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Info, TriangleAlert } from "lucide-react"
import { useTranslation } from "react-i18next"
import { SourcesService } from "@/client"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { WorkspacePage } from "@/components/Common/WorkbenchPrimitives"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import { useOrg } from "@/hooks/useOrg"

import { useWorkRecordFilters, WorkRecordFilters } from "./WorkRecordFilters"
import { WorkRecordResults } from "./WorkRecordResults"

export function WorkRecordsPage() {
  const { t } = useTranslation()
  const { org, roles } = useOrg()
  if (!org) return <OrgState />
  if (!roles.includes("org_admin"))
    return <p role="alert">{t("sources.workRecords.orgAdminRequired")}</p>
  return <WorkRecordsView key={org.id} orgId={org.id} />
}

function WorkRecordsView({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const filters = useWorkRecordFilters(orgId)
  const {
    source,
    employeeId,
    departmentId,
    syncRunId,
    dateFrom,
    dateTo,
    pagination,
    setPagination,
  } = filters
  const records = useQuery({
    queryKey: [
      "work-records",
      orgId,
      source,
      employeeId,
      departmentId,
      syncRunId,
      dateFrom,
      dateTo,
      pagination,
    ],
    queryFn: async () =>
      (
        await SourcesService.readWorkRecords({
          path: { org_id: orgId },
          query: {
            source: source === "all" ? undefined : source,
            employee_id: employeeId === "all" ? undefined : employeeId,
            department_id: departmentId === "all" ? undefined : departmentId,
            sync_run_id: syncRunId === "all" ? undefined : syncRunId,
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            skip: pagination.pageIndex * pagination.pageSize,
            limit: pagination.pageSize,
          },
        })
      ).data,
  })

  return (
    <WorkspacePage className="space-y-3">
      <h1 className="sr-only">{t("sources.workRecords.heading")}</h1>
      <TopbarActions>
        <Button variant="outline" size="sm" asChild>
          <Link to="/admin/data-ai" search={{ tab: "sources" }}>
            {t("sources.workRecords.sourceSettingsLink")}
          </Link>
        </Button>
      </TopbarActions>
      <p className="text-sm text-muted-foreground">
        {t("sources.workRecords.intro")}
      </p>

      <WorkRecordFilters filters={filters} records={records.data} />

      {syncRunId !== "all" && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-sm text-sky-950 dark:text-sky-100"
        >
          <Info
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-sky-700 dark:text-sky-300"
          />
          <p>
            <span className="font-medium">
              {t("sources.workRecords.batchNoticeTitle")}
            </span>
            {t("sources.workRecords.batchNoticeBody")}
          </p>
        </div>
      )}

      {records.data?.warning && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
        >
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
          />
          <p>{records.data.warning}</p>
        </div>
      )}

      {records.isPending ? (
        <ProfileLoading />
      ) : records.isError ? (
        <ProfileError retry={() => records.refetch()} />
      ) : (
        <WorkRecordResults
          records={records.data}
          pagination={pagination}
          setPagination={setPagination}
        />
      )}
    </WorkspacePage>
  )
}
