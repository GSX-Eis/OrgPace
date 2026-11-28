import { useTranslation } from "react-i18next"
import type { EvidenceList, ItemInput } from "@/client"
import { Button } from "@/components/ui/button"

export function RequestEvidencePicker({
  item,
  update,
  evidence,
  evidenceTitles,
  pickedTitles,
  evidenceSkip,
  setEvidenceSkip,
  onPickTitle,
  onEvidence,
}: {
  item: ItemInput
  update: (changes: Partial<ItemInput>) => void
  evidence?: EvidenceList
  evidenceTitles: Map<string, string>
  pickedTitles: Record<string, string>
  evidenceSkip: number
  setEvidenceSkip: (skip: number) => void
  onPickTitle: (id: string, title: string) => void
  onEvidence?: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      {!!item.evidence_ids?.length && (
        <ul
          aria-label={t("profile.request.editor.selectedEvidenceAria")}
          className="space-y-2"
        >
          {item.evidence_ids.map((id) => (
            <li
              key={id}
              className="flex flex-wrap items-center gap-x-2 text-sm"
            >
              <span className="min-w-0">
                {evidenceTitles.get(id) ??
                  pickedTitles[id] ??
                  t("profile.request.editor.evidenceRefFallback")}
              </span>
              {onEvidence && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => onEvidence(id)}
                >
                  {t("profile.request.editor.view")}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  update({
                    evidence_ids: item.evidence_ids?.filter(
                      (selected) => selected !== id,
                    ),
                  })
                }
              >
                {t("profile.request.editor.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer">
          {t("profile.request.editor.selectEvidenceSummary", {
            count: item.evidence_ids?.length ?? 0,
          })}
        </summary>
        <div className="max-h-48 space-y-2 overflow-y-auto py-3">
          {evidence?.data.map((entry) => (
            <label key={entry.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={item.evidence_ids?.includes(entry.id) ?? false}
                onChange={(e) => {
                  if (e.target.checked) {
                    onPickTitle(entry.id, entry.title)
                  }
                  update({
                    evidence_ids: e.target.checked
                      ? [...(item.evidence_ids ?? []), entry.id]
                      : item.evidence_ids?.filter((id) => id !== entry.id),
                  })
                }}
              />
              {entry.title}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!evidenceSkip}
            onClick={() => setEvidenceSkip(evidenceSkip - 100)}
          >
            {t("profile.request.editor.prevEvidence")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={evidenceSkip + 100 >= (evidence?.count ?? 0)}
            onClick={() => setEvidenceSkip(evidenceSkip + 100)}
          >
            {t("profile.request.editor.nextEvidence")}
          </Button>
        </div>
      </details>
    </>
  )
}
