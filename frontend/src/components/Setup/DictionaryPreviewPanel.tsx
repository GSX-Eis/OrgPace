import { useTranslation } from "react-i18next"
import type { DictionaryPreview } from "@/client"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"

export function DictionaryPreviewPanel({
  preview,
  busy,
  redraft,
  onRedraft,
  onSave,
}: {
  preview: DictionaryPreview
  busy: boolean
  redraft: boolean
  onRedraft: (value: boolean) => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  const sep = t("setup.preview.joinSeparator")
  const none = t("setup.preview.none")
  return (
    <section className="space-y-4" aria-label={t("setup.preview.ariaLabel")}>
      <h3 className="font-semibold">
        {t("setup.preview.saveAsVersion", {
          version: preview.expected_version + 1,
        })}
      </h3>
      {(
        [
          [t("setup.preview.added"), preview.added],
          [t("setup.preview.modified"), preview.modified],
          [t("setup.preview.removed"), preview.removed],
        ] as const
      ).map(([label, keys]) => (
        <p key={label}>
          {t("setup.preview.changeSummary", {
            label,
            count: keys.length,
            items: keys.join(sep) || none,
          })}
        </p>
      ))}
      {preview.warnings?.map((message) => (
        <p key={message} role="status" className="text-sm text-amber-700">
          {message}
        </p>
      ))}
      {preview.errors.length > 0 && (
        <ul role="alert" className="space-y-2 text-destructive">
          {preview.errors.map((message, index) => (
            <li key={`${index}:${message}`}>{message}</li>
          ))}
        </ul>
      )}
      {preview.removed.map((key) => (
        <p key={key} className="text-sm">
          {t("setup.preview.removedNote", {
            key,
            claimCount: preview.removed_claim_counts[key] ?? 0,
            itemCount: preview.removed_item_counts[key] ?? 0,
          })}
        </p>
      ))}
      <p className="text-sm text-muted-foreground">
        {t("setup.preview.removedHelp")}
      </p>
      <label className="flex items-start gap-3" htmlFor="dictionary-redraft">
        <Checkbox
          id="dictionary-redraft"
          checked={redraft}
          disabled={busy}
          onCheckedChange={(value) => onRedraft(value === true)}
        />
        <span>{t("setup.preview.redraftLabel")}</span>
      </label>
      <Button
        disabled={
          busy || preview.errors.length > 0 || !preview.definitions.length
        }
        onClick={onSave}
      >
        {busy ? t("setup.preview.saving") : t("setup.preview.confirmSave")}
      </Button>
    </section>
  )
}
