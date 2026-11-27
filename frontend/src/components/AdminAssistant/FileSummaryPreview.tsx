import { useTranslation } from "react-i18next"
import type { FileSummary } from "@/client"

export function FileSummaryPreview({ preview }: { preview: FileSummary }) {
  const { t } = useTranslation()
  const countLabels: Record<string, string> = {
    记录条数: t("adminAssistant.filePreview.countLabels.records"),
    涉及人数: t("adminAssistant.filePreview.countLabels.people"),
    警告: t("adminAssistant.filePreview.countLabels.warnings"),
    错误: t("adminAssistant.filePreview.countLabels.errors"),
    跳过: t("adminAssistant.filePreview.countLabels.skipped"),
  }
  const errors = preview.errors ?? []
  return (
    <section
      aria-label={t("adminAssistant.filePreview.ariaLabel")}
      className="space-y-3"
    >
      <h3 className="font-semibold">{t("adminAssistant.filePreview.title")}</h3>
      <dl className="flex flex-wrap gap-3">
        {Object.entries(preview.counts).map(([label, count]) => (
          <div key={label} className="rounded-lg bg-muted px-3 py-2">
            <dt className="text-xs text-muted-foreground">
              {countLabels[label] ?? label}
            </dt>
            <dd className="text-lg font-semibold">{count}</dd>
          </div>
        ))}
      </dl>
      {!!preview.warnings?.length && (
        <div role="alert" className="space-y-1 text-sm">
          <p>
            {t("adminAssistant.filePreview.warningsSummary", {
              count: preview.counts.警告 ?? preview.warnings.length,
            })}
          </p>
          {preview.warnings.map((warning, index) => (
            <p key={index}>
              {t("adminAssistant.filePreview.issueRow", {
                location: warning.location,
                message: warning.message,
              })}
            </p>
          ))}
        </div>
      )}
      {!!preview.skipped?.length && (
        <div className="space-y-1 text-sm">
          <p>
            {t("adminAssistant.filePreview.skippedSummary", {
              count: preview.counts.跳过 ?? preview.skipped.length,
            })}
          </p>
          {preview.skipped.map((person, index) => (
            <p key={index}>
              {t("adminAssistant.filePreview.issueRow", {
                location: person.location,
                message: person.message,
              })}
            </p>
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <div role="alert" className="overflow-x-auto text-destructive">
          <p>{t("adminAssistant.filePreview.errorsAlert")}</p>
          <table className="w-full text-left">
            <thead>
              <tr>
                <th className="p-2">
                  {t("adminAssistant.filePreview.locationHeader")}
                </th>
                <th className="p-2">
                  {t("adminAssistant.filePreview.reasonHeader")}
                </th>
              </tr>
            </thead>
            <tbody>
              {errors.map((error, index) => (
                <tr key={index}>
                  <td className="p-2 whitespace-nowrap">
                    {error.location ||
                      t("adminAssistant.filePreview.fileFallback")}
                  </td>
                  <td className="p-2 break-words">{error.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
