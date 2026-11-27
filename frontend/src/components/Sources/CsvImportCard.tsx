import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { AxiosError } from "axios"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { SourcesService, type WorkRecordIssue } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LastSyncStatus, useSourceRuns } from "./LastSyncStatus"

export function CsvImportCard({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const runs = useSourceRuns(orgId, "csv")
  const [issues, setIssues] = useState<WorkRecordIssue[]>([])
  const upload = useMutation({
    mutationFn: (file: File) =>
      SourcesService.importWorkRecords({
        path: { org_id: orgId },
        body: { file },
      }),
    onSuccess: ({ data }) => {
      setIssues(data.issues)
      return Promise.all([
        client.invalidateQueries({ queryKey: ["source-runs", orgId] }),
        client.invalidateQueries({ queryKey: ["sync-runs", orgId] }),
      ])
    },
    onError: (error) => {
      if (
        error instanceof AxiosError &&
        error.response?.status === 422 &&
        error.response.data?.detail?.code === "work_records_invalid"
      ) {
        setIssues(error.response.data.detail.issues)
      }
    },
  })
  const template = useMutation({
    mutationFn: async (format: "xlsx" | "csv") => {
      const { data } = await SourcesService.workRecordsTemplate({
        path: { org_id: orgId },
        query: { format },
        responseType: "blob",
      })
      if (!(data instanceof Blob))
        throw new Error(t("sources.csv.templateDownloadFailed"))
      const url = URL.createObjectURL(data)
      const link = document.createElement("a")
      link.href = url
      link.download = `${t("sources.csv.templateFilename")}.${format}`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
  })
  const recent = runs.data ?? []
  return (
    <section
      aria-label={t("sources.csv.sectionAriaLabel")}
      className="space-y-4"
    >
      <p className="text-sm text-muted-foreground">
        {t("sources.csv.description")}
      </p>
      <p className="text-sm">{t("sources.csv.requiredColumns")}</p>
      <div className="flex flex-wrap gap-2">
        {(["xlsx", "csv"] as const).map((format) => (
          <Button
            key={format}
            variant="outline"
            disabled={template.isPending}
            onClick={() => template.mutate(format)}
          >
            {format === "xlsx"
              ? t("sources.csv.downloadExcel")
              : t("sources.csv.downloadCsv")}
          </Button>
        ))}
      </div>
      <div className="space-y-2">
        <Input
          id="work-records"
          className="peer sr-only"
          type="file"
          accept=".csv,.xlsx"
          disabled={upload.isPending}
          onChange={(event) => {
            const file = event.target.files?.[0]
            setIssues([])
            if (file) upload.mutate(file)
            event.target.value = ""
          }}
        />
        <Label
          htmlFor="work-records"
          className="inline-flex h-9 cursor-pointer items-center rounded-md border px-3 peer-focus-visible:ring-2 peer-disabled:opacity-50"
        >
          {t("sources.csv.selectFile")}
        </Label>
      </div>
      <SetupError error={upload.error ?? template.error ?? runs.error} />
      {upload.isPending && <p role="status">{t("sources.csv.uploading")}</p>}
      {upload.isSuccess && (
        <div role="status" className="space-y-1">
          <p>{t("sources.csv.importStarted")}</p>
          <p className="text-sm">
            <Link
              to="/admin/data-ai"
              search={{
                tab: "work-records",
                sync_run_id: upload.data.data.run.id,
              }}
              className="font-medium text-primary hover:underline"
            >
              {t("sources.csv.previewLink")}
            </Link>
          </p>
        </div>
      )}
      {upload.isError && issues.length > 0 && (
        <p role="alert">{t("sources.csv.fileHasErrors")}</p>
      )}
      {issues.length > 0 && (
        <div className="overflow-x-auto">
          <table
            className="w-full text-left text-sm"
            aria-label={t("sources.csv.issuesTableAriaLabel")}
          >
            <thead>
              <tr>
                {[
                  t("sources.csv.colRow"),
                  t("sources.csv.colColumn"),
                  t("sources.csv.colType"),
                  t("sources.csv.colMessage"),
                ].map((title) => (
                  <th key={title} className="border-b p-2">
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {issues.map((issue, index) => (
                <tr key={`${issue.row_number}:${issue.column}:${index}`}>
                  <td className="p-2">
                    {issue.row_number ?? t("sources.csv.entireFile")}
                  </td>
                  <td className="p-2">{issue.column ?? "—"}</td>
                  <td className="p-2">
                    {issue.level === "error"
                      ? t("sources.csv.typeError")
                      : t("sources.csv.typeWarning")}
                  </td>
                  <td className="p-2">{issue.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h4 className="text-sm font-medium">{t("sources.csv.recentTitle")}</h4>
      {recent.length ? (
        recent.map((run) => <LastSyncStatus key={run.id} run={run} />)
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("sources.csv.empty")}
        </p>
      )}
    </section>
  )
}
