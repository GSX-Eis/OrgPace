import { useTranslation } from "react-i18next"
import { HelpTip } from "@/components/Common/WorkbenchPrimitives"

export function ProfileVisibility({ tooltip = false }: { tooltip?: boolean }) {
  const { t } = useTranslation()
  const content = (
    <div className="space-y-2">
      <p>{t("profile.visibility.p1")}</p>
      <p>{t("profile.visibility.p2")}</p>
      <p>{t("profile.visibility.p3")}</p>
      <p>{t("profile.visibility.p4")}</p>
    </div>
  )
  if (tooltip)
    return <HelpTip label={t("profile.visibility.label")} content={content} />
  return (
    <details className="rounded-lg border p-3 text-sm text-muted-foreground">
      <summary className="cursor-pointer font-medium">
        {t("profile.visibility.label")}
      </summary>
      <div className="mt-2">{content}</div>
    </details>
  )
}
