import { useTranslation } from "react-i18next"
import { ModelSettingForm } from "@/components/Model/ModelSettingForm"

export function ModelStep({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <p>{t("setup.modelStep.description")}</p>
      <ModelSettingForm orgId={orgId} />
    </div>
  )
}
