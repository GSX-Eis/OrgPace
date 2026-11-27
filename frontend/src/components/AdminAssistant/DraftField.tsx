import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

export function DraftField({
  changed,
  children,
  label,
}: {
  changed: boolean
  children: ReactNode
  label?: string
}) {
  const { t } = useTranslation()
  return (
    <div
      data-assistant-suggested={changed || undefined}
      className={
        changed
          ? "space-y-2 rounded-lg border border-primary/50 bg-primary/10 p-3"
          : "space-y-2"
      }
    >
      {changed && (
        <p className="text-xs font-medium text-primary">
          {label ?? t("adminAssistant.draftSuggestion")}
        </p>
      )}
      {children}
    </div>
  )
}
