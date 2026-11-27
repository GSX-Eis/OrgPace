import { useTranslation } from "react-i18next"
import type { ChangeSetPublic } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { ChangeSetCard } from "./ChangeSetCard"

export function PageDraft({
  orgId,
  draft,
  error,
}: {
  orgId: string
  draft?: ChangeSetPublic
  error: Error | null
}) {
  const { t } = useTranslation()
  return (
    <>
      <SetupError error={error} />
      {draft && (
        <div className="space-y-3">
          <p className="text-sm">
            {t("adminAssistant.pageDraftSummary", {
              count: draft.items.length,
            })}
          </p>
          <ChangeSetCard
            key={draft.id}
            orgId={orgId}
            changeSet={draft}
            disabled={false}
            inline
          />
        </div>
      )}
    </>
  )
}
