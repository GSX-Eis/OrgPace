import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId } from "react"
import { useTranslation } from "react-i18next"
import { DraftingSettingsService } from "@/client"
import { HelpTip, SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"

export function AutoDraftSetting({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const labelId = useId()
  const client = useQueryClient()
  const queryKey = ["auto-draft", orgId]
  const query = useQuery({
    queryKey,
    queryFn: async () =>
      (
        await DraftingSettingsService.settingsGetAutoDraft({
          path: { org_id: orgId },
        })
      ).data,
  })
  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      DraftingSettingsService.settingsPutAutoDraft({
        path: { org_id: orgId },
        body: { enabled },
      }),
    onSuccess: ({ data }) => {
      client.setQueryData(queryKey, data)
      client.invalidateQueries({ queryKey: ["drafting-settings", orgId] })
    },
  })
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  return (
    <SectionCard
      aria-label={t("profile.autoDraft.ariaLabel")}
      className="space-y-2 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span id={labelId} className="text-sm font-medium">
            {t("profile.autoDraft.title")}
          </span>
          <HelpTip
            label={t("profile.autoDraft.helpLabel")}
            content={t("profile.autoDraft.helpContent")}
          />
        </div>
        <Button
          type="button"
          size="sm"
          role="switch"
          aria-labelledby={labelId}
          aria-checked={query.data.enabled}
          disabled={save.isPending}
          variant={query.data.enabled ? "default" : "outline"}
          onClick={() => save.mutate(!query.data.enabled)}
        >
          {query.data.enabled
            ? t("profile.autoDraft.enabled")
            : t("profile.autoDraft.disabled")}
        </Button>
      </div>
      {query.data.org_disabled && (
        <p className="text-sm">{t("profile.autoDraft.orgDisabled")}</p>
      )}
      {save.isError && <p role="alert">{t("profile.autoDraft.saveError")}</p>}
    </SectionCard>
  )
}
