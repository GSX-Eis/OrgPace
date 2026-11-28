import type { ComponentProps, Ref } from "react"
import { useTranslation } from "react-i18next"
import type {
  CapabilitiesPublic,
  ChangeRequestPublic,
  ItemInput,
} from "@/client"
import { Button } from "@/components/ui/button"
import { record } from "./fields"
import { characterCount, EXPLANATION_MAX, STATEMENT_MAX } from "./inputLimits"
import { RequestEvidencePicker } from "./RequestEvidencePicker"

export function RequestItemEditor({
  item,
  capability,
  source,
  activeField,
  objectionFocus,
  update,
  onRemove,
  evidencePicker,
}: {
  item: ItemInput
  capability?: CapabilitiesPublic["data"][number]
  source?: ChangeRequestPublic
  activeField?: Ref<HTMLTextAreaElement>
  objectionFocus?: boolean
  update: (changes: Partial<ItemInput>) => void
  onRemove: () => void
  evidencePicker: Omit<
    ComponentProps<typeof RequestEvidencePicker>,
    "item" | "update"
  >
}) {
  const { t } = useTranslation()
  const rubric = capability?.level_rubric
  const levels =
    record(rubric) && Array.isArray(rubric.levels)
      ? rubric.levels.filter(record).filter((l) => typeof l.key === "string")
      : []
  const invalidLevel = item.level && !levels.some((l) => l.key === item.level)
  return (
    <fieldset className="min-w-0 space-y-3 rounded-lg border bg-muted/10 p-4">
      <legend className="px-1 font-semibold">
        {capability?.name ?? t("profile.request.editor.capabilityRetired")}
      </legend>
      {item.op === "attach_evidence" ? (
        <p>{t("profile.request.editor.attachKeepOriginal")}</p>
      ) : item.op === "retract" ? (
        <p>{t("profile.request.editor.retractItem")}</p>
      ) : (
        <>
          <label className="block space-y-1">
            {t("profile.request.editor.statementLabel")}
            <textarea
              ref={!objectionFocus ? activeField : undefined}
              required
              aria-label={t("profile.request.editor.statementLabel")}
              value={item.statement}
              className="block min-h-24 w-full rounded-md border bg-background p-2"
              onChange={(e) => update({ statement: e.target.value })}
            />
          </label>
          <p className="text-sm text-muted-foreground">
            {t("profile.request.editor.charCount", {
              count: characterCount(item.statement),
              max: STATEMENT_MAX,
            })}
          </p>
          <label className="block space-y-1">
            {t("profile.request.editor.levelLabel")}
            <select
              value={item.level ?? ""}
              className="block w-full rounded-md border bg-background p-2"
              onChange={(e) => update({ level: e.target.value || null })}
            >
              <option value="">{t("profile.request.ungraded")}</option>
              {invalidLevel && (
                <option value={item.level!}>
                  {t("profile.request.editor.reselectLevelOption")}
                </option>
              )}
              {levels.map((level) => (
                <option key={String(level.key)} value={String(level.key)}>
                  {String(level.label ?? level.key)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="block space-y-1">
        {t("profile.request.editor.ownerNoteLabel")}
        <textarea
          value={item.owner_statement ?? ""}
          className="block min-h-20 w-full rounded-md border bg-background p-2"
          onChange={(e) =>
            update({
              owner_statement: e.target.value || null,
            })
          }
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {t("profile.request.editor.charCount", {
          count: characterCount(item.owner_statement ?? ""),
          max: EXPLANATION_MAX,
        })}
      </p>
      {(source?.origin === "initial_sync" ||
        source?.origin === "import" ||
        source?.items?.some(
          (original) =>
            original.capability.key === item.capability_key &&
            original.objection,
        ) ||
        item.objection) && (
        <label className="block space-y-1">
          {t("profile.request.editor.objectionLabel")}
          <textarea
            ref={objectionFocus ? activeField : undefined}
            value={item.objection ?? ""}
            aria-label={t("profile.request.editor.objectionLabel")}
            className="block min-h-20 w-full rounded-md border bg-background p-2"
            onChange={(e) =>
              update({
                objection: e.target.value || null,
              })
            }
          />
          <span className="text-sm text-muted-foreground">
            {t("profile.request.editor.charCount", {
              count: characterCount(item.objection ?? ""),
              max: EXPLANATION_MAX,
            })}
          </span>
        </label>
      )}
      <RequestEvidencePicker {...evidencePicker} item={item} update={update} />
      <Button type="button" variant="ghost" onClick={() => onRemove()}>
        {t("profile.request.editor.removeChange")}
      </Button>
    </fieldset>
  )
}
