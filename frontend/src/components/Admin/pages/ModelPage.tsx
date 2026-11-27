import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { ModelSettingService } from "@/client"
import { ChangeHistory } from "@/components/Admin/ChangeHistory"
import {
  SectionCard,
  WorkspacePage,
} from "@/components/Common/WorkbenchPrimitives"
import { ModelSettingForm } from "@/components/Model/ModelSettingForm"
import { OrgState } from "@/components/Profile/OrgState"
import { DraftProgress } from "@/components/Progress/DraftProgress"
import { Badge } from "@/components/ui/badge"
import { useOrg } from "@/hooks/useOrg"
import { DraftingPage } from "./DraftingPage"

export function ModelPage() {
  const { t } = useTranslation()
  const { org, roles } = useOrg()
  if (!org) return <OrgState />
  if (!roles.includes("org_admin"))
    return <p role="alert">{t("admin.common.orgAdminRequired")}</p>
  return (
    <WorkspacePage key={org.id} variant="form">
      <h1 className="sr-only">{t("admin.modelPage.heading")}</h1>
      <div className="grid items-start gap-4 min-[1100px]:grid-cols-[minmax(0,65fr)_minmax(0,35fr)]">
        <div className="min-w-0 space-y-4">
          <SectionCard aria-labelledby="model-configuration">
            <h2 id="model-configuration" className="mb-3 text-sm font-semibold">
              {t("admin.modelPage.configHeading")}
            </h2>
            <ModelSettingForm orgId={org.id} />
          </SectionCard>
          <DraftingPage orgId={org.id} />
        </div>
        <aside className="min-w-0 space-y-4">
          <ModelStatus orgId={org.id} />
          <div id="draft-progress" className="scroll-mt-4">
            <DraftProgress orgId={org.id} />
          </div>
          <SectionCard aria-labelledby="model-history">
            <h2 id="model-history" className="text-sm font-semibold">
              {t("admin.modelPage.historyHeading")}
            </h2>
            <div className="mt-2 divide-y divide-surface-border">
              {(
                ["model_setting", "drafting_setting", "drafting_note"] as const
              ).map((targetType) => {
                const label = t(`admin.modelPage.historyTypes.${targetType}`)
                return (
                  <section
                    key={targetType}
                    aria-label={t("admin.modelPage.historySectionAriaLabel", {
                      label,
                    })}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 last:pb-0"
                  >
                    <span className="text-sm">{label}</span>
                    <ChangeHistory targetType={targetType} variant="drawer" />
                  </section>
                )
              })}
            </div>
          </SectionCard>
        </aside>
      </div>
    </WorkspacePage>
  )
}

function ModelStatus({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const model = useQuery({
    queryKey: ["model-setting", orgId],
    queryFn: async () =>
      (
        await ModelSettingService.settingGetModelSetting({
          path: { org_id: orgId },
        })
      ).data,
  })
  const saved = model.data
  return (
    <SectionCard aria-labelledby="model-status" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="model-status" className="text-sm font-semibold">
          {t("admin.modelPage.statusHeading")}
        </h2>
        {saved && (
          <Badge variant={saved.enabled ? "default" : "secondary"}>
            {saved.enabled
              ? t("admin.modelPage.enabledBadge")
              : t("admin.modelPage.disabledBadge")}
          </Badge>
        )}
      </div>
      {model.isPending && (
        <p role="status" className="text-sm">
          {t("admin.modelPage.statusLoading")}
        </p>
      )}
      {model.isError && (
        <p className="text-sm text-muted-foreground">
          {t("admin.modelPage.statusError")}
        </p>
      )}
      {saved?.enabled && (
        <dl className="space-y-2 text-sm">
          <div className="space-y-1">
            <dt className="text-muted-foreground">
              {t("admin.modelPage.effectiveModel")}
            </dt>
            <dd className="break-all font-medium">{saved.model || "—"}</dd>
          </div>
          {saved.kind === "chatgpt_subscription" && (
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">
                {t("admin.modelPage.chatgptSub")}
              </dt>
              <dd>
                {saved.chatgpt?.needs_relogin
                  ? t("admin.modelPage.chatgptRelogin")
                  : saved.chatgpt?.connected
                    ? t("admin.modelPage.chatgptConnected")
                    : t("admin.modelPage.chatgptDisconnected")}
              </dd>
            </div>
          )}
        </dl>
      )}
    </SectionCard>
  )
}
