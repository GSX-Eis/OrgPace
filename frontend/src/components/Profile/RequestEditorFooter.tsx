import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"

export function RequestEditorFooter({
  showPreview,
  busy,
  canSubmit,
  canSave,
  canPreview,
  formId,
  onBack,
  onSubmit,
  onSave,
}: {
  showPreview: boolean
  busy: boolean
  canSubmit: boolean
  canSave: boolean
  canPreview: boolean
  formId: string
  onBack: () => void
  onSubmit: () => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex shrink-0 flex-wrap gap-3 border-t pt-4">
      {showPreview ? (
        <>
          <Button variant="outline" disabled={busy} onClick={onBack}>
            {t("profile.request.editor.backToEdit")}
          </Button>
          <Button disabled={busy || !canSubmit} onClick={onSubmit}>
            {t("profile.request.editor.confirmSubmit")}
          </Button>
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            disabled={!canSave}
            onClick={onSave}
          >
            {t("profile.request.editor.saveDraft")}
          </Button>
          <Button type="submit" form={formId} disabled={!canPreview}>
            {t("profile.request.editor.previewAndSubmit")}
          </Button>
        </>
      )}
    </div>
  )
}
