import { useTranslation } from "react-i18next"
import type { RequestPreview } from "@/client"
import { Button } from "@/components/ui/button"
import { formatDate } from "@/i18n/format"
import { levelLabel } from "./fields"
import { RequestReviewers } from "./RequestReviewers"

export function ChangeRequestPreview({
  displayedPreview,
  onEvidence,
}: {
  displayedPreview: RequestPreview | null | undefined
  onEvidence?: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      {!displayedPreview && (
        <p role="status">{t("profile.request.editor.loadingPreview")}</p>
      )}
      {displayedPreview && (
        <RequestReviewers
          reviewers={displayedPreview.reviewers}
          requiresManager={displayedPreview.requires_manager}
          partialAutoPublish={displayedPreview.partial_auto_publish}
          preview
        />
      )}
      {displayedPreview?.items.map(
        ({ before, after, warning, current_changed_at, submission_notice }) => (
          <section key={after.id} className="space-y-3 rounded-lg border p-4">
            <h3 className="font-semibold">{after.capability.name}</h3>
            <p>{submission_notice}</p>
            {current_changed_at && (
              <p role="status" className="text-sm text-muted-foreground">
                {t("profile.request.editor.currentChangedAt", {
                  time: formatDate(current_changed_at, {
                    year: "numeric",
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    timeZone: "Asia/Shanghai",
                    hour12: false,
                  }),
                })}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">
                  {t("profile.request.editor.previewBefore")}
                </p>
                <p>
                  {before?.statement ?? t("profile.request.compactNoRecord")}
                </p>
                <p>
                  {t("profile.request.levelColon")}
                  {before?.level
                    ? levelLabel(after.capability.level_rubric, before.level)
                    : t("profile.request.ungraded")}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  {t("profile.request.editor.previewAfter")}
                </p>
                <p>
                  {after.op === "attach_evidence"
                    ? t("profile.request.editor.attachKeepOriginal")
                    : after.op === "retract"
                      ? t("profile.request.editor.retractItem")
                      : after.after?.statement}
                </p>
                <p>
                  {t("profile.request.levelColon")}
                  {after.after?.level
                    ? levelLabel(
                        after.capability.level_rubric,
                        after.after.level,
                      )
                    : t("profile.request.ungraded")}
                </p>
              </div>
            </div>
            {after.owner_statement && (
              <p>
                {t("profile.request.editor.ownerNote", {
                  text: after.owner_statement,
                })}
              </p>
            )}
            {after.uncertainty && (
              <p>
                {t("profile.request.editor.uncertaintyNote", {
                  text: after.uncertainty,
                })}
              </p>
            )}
            {after.objection && (
              <p>
                {t("profile.request.editor.objectionNote", {
                  text: after.objection,
                })}
              </p>
            )}
            <div className="text-sm">
              <p>{t("profile.request.editor.relatedEvidence")}</p>
              {after.evidence?.length ? (
                <ul className="space-y-1">
                  {after.evidence.map((entry) => (
                    <li key={entry.evidence_id}>
                      {onEvidence ? (
                        <Button
                          type="button"
                          variant="link"
                          className="h-auto min-h-8 max-w-full justify-start px-0 text-left whitespace-normal"
                          onClick={() => onEvidence(entry.evidence_id)}
                        >
                          {entry.title}
                        </Button>
                      ) : (
                        entry.title
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t("profile.request.editor.none")}</p>
              )}
            </div>
            {warning && (
              <p role="alert">
                {t("profile.request.editor.reselectLevelWarning", {
                  warning,
                })}
              </p>
            )}
          </section>
        ),
      )}
    </>
  )
}
