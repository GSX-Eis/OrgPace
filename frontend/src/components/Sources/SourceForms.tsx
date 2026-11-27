import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Cloud, FileSpreadsheet, Server } from "lucide-react"
import { useTranslation } from "react-i18next"
import { SourcesService, type SyncRunPublic } from "@/client"
import { IntegrationCard } from "@/components/Admin/pages/IntegrationCard"
import { PageDraft } from "@/components/AdminAssistant/PageDraft"
import { usePageDraft } from "@/components/AdminAssistant/usePageDraft"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { CsvImportCard } from "@/components/Sources/CsvImportCard"
import { JiraSourceForm } from "@/components/Sources/JiraSourceForm"
import { formatDate } from "@/i18n/format"
import { useSourceRuns } from "./LastSyncStatus"

function runTime(run: SyncRunPublic) {
  return formatDate(run.finished_at ?? run.started_at ?? run.created_at, {
    dateStyle: "short",
    timeStyle: "medium",
  })
}

export function SourceForms({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const jiraTypes = {
    cloud: {
      name: t("sources.forms.cloudName"),
      Icon: Cloud,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-300",
      description: t("sources.forms.cloudDescription"),
    },
    data_center: {
      name: t("sources.forms.dcName"),
      Icon: Server,
      color: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
      description: t("sources.forms.dcDescription"),
    },
  }
  const assistant = usePageDraft(orgId, "update_jira_connection")
  const connection = useQuery({
    queryKey: ["jira", orgId],
    queryFn: async () =>
      (await SourcesService.getJira({ path: { org_id: orgId } })).data,
  })
  const jiraRuns = useSourceRuns(orgId, "jira")
  const csvRuns = useSourceRuns(orgId, "csv")
  const savedDeployment = connection.data?.config?.deployment
  const previewDeployment = assistant.values({
    deployment: savedDeployment ?? "cloud",
  }).deployment
  const jiraLatest = jiraRuns.data?.[0]
  const csvLatest = csvRuns.data?.[0]
  return (
    <div className="space-y-3">
      <PageDraft
        orgId={orgId}
        draft={assistant.draft}
        error={assistant.error}
      />
      <p className="text-sm text-muted-foreground">
        {t("sources.forms.intro")}
        <Link
          to="/admin/data-ai"
          search={{ tab: "work-records" }}
          className="ml-2 font-medium text-primary hover:underline"
        >
          {t("sources.forms.viewWorkRecords")}
        </Link>
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(["cloud", "data_center"] as const).map((deployment) => {
          const { name, Icon, color, description } = jiraTypes[deployment]
          const configured =
            savedDeployment === deployment && !!connection.data?.has_secret
          const suggested = !!assistant.item && previewDeployment === deployment
          return (
            <IntegrationCard
              key={deployment}
              name={name}
              icon={
                <Icon
                  aria-hidden="true"
                  className={`size-8 rounded-lg p-2 ${color}`}
                />
              }
              description={description}
              status={
                connection.isPending
                  ? t("sources.forms.statusLoading")
                  : connection.isError
                    ? t("sources.forms.statusLoadFailed")
                    : configured
                      ? t("sources.forms.statusConfigured")
                      : t("sources.forms.statusNotConfigured")
              }
              active={configured}
              detail={
                configured && jiraLatest
                  ? t("sources.forms.detailLastSync", {
                      time: runTime(jiraLatest),
                    })
                  : configured
                    ? t("sources.forms.detailNoRuns")
                    : t("sources.forms.detailNoCredentials")
              }
              suggested={suggested}
              disabled={!!assistant.item && !suggested}
            >
              {assistant.item && !suggested ? (
                <p className="text-sm">
                  {t("sources.forms.drawerOtherDraftNotice")}
                </p>
              ) : connection.isPending ? (
                <ProfileLoading />
              ) : connection.isError ? (
                <ProfileError retry={() => connection.refetch()} />
              ) : (
                <JiraSourceForm
                  key={assistant.draft?.id}
                  orgId={orgId}
                  connection={connection.data}
                  deployment={deployment}
                  assistant={assistant}
                />
              )}
            </IntegrationCard>
          )
        })}
        <IntegrationCard
          name={t("sources.forms.csvTitle")}
          icon={
            <FileSpreadsheet
              aria-hidden="true"
              className="size-8 rounded-lg bg-emerald-500/10 p-2 text-emerald-700 dark:text-emerald-300"
            />
          }
          description={t("sources.forms.csvDescription")}
          status={
            csvLatest
              ? t("sources.forms.csvStatusHasRuns")
              : t("sources.forms.csvStatusOnDemand")
          }
          active={csvLatest?.status === "succeeded"}
          detail={
            csvLatest
              ? t("sources.forms.csvDetailLastImport", {
                  time: runTime(csvLatest),
                })
              : t("sources.forms.csvDetailNoRuns")
          }
          action={t("sources.forms.csvAction")}
        >
          <CsvImportCard orgId={orgId} />
        </IntegrationCard>
      </div>
    </div>
  )
}
