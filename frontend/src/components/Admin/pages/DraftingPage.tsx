import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import {
  DraftingSettingsService,
  InitialProfilesService,
  ModelSettingService,
} from "@/client"
import { DraftField } from "@/components/AdminAssistant/DraftField"
import { PageDraft } from "@/components/AdminAssistant/PageDraft"
import { usePageDraft } from "@/components/AdminAssistant/usePageDraft"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { DraftingNoteForm } from "./DraftingNoteForm"

export function DraftingPage({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const path = { org_id: orgId }
  const suggestion = usePageDraft(orgId, "set_auto_drafting")
  const settings = useQuery({
    queryKey: ["drafting-settings", orgId],
    queryFn: async () =>
      (await DraftingSettingsService.settingsGetDraftingSettings({ path }))
        .data,
  })
  const model = useQuery({
    queryKey: ["model-setting", orgId],
    queryFn: async () =>
      (await ModelSettingService.settingGetModelSetting({ path })).data,
  })
  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      DraftingSettingsService.settingsPutDraftingSettings({
        path,
        body: { enabled },
      }),
    onSuccess: ({ data }) => {
      client.setQueryData(["drafting-settings", orgId], data)
      client.invalidateQueries({ queryKey: ["auto-draft", orgId] })
      client.invalidateQueries({ queryKey: ["admin-overview", orgId] })
    },
  })
  const start = useMutation({
    mutationFn: () =>
      InitialProfilesService.profilesDraft({ path, body: { scope: "all" } }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["draft-progress", orgId] }),
  })
  if (settings.isPending || model.isPending) return <ProfileLoading />
  if (settings.isError || model.isError)
    return (
      <ProfileError
        retry={() => {
          settings.refetch()
          model.refetch()
        }}
      />
    )
  const current = suggestion.values(settings.data)
  return (
    <SectionCard
      aria-label={t("admin.draftingPage.ariaLabel")}
      className="space-y-3"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="auto-drafting-title" className="text-sm font-semibold">
          {t("admin.draftingPage.title")}
        </h2>
        <DraftField changed={suggestion.changed("enabled")}>
          <Button
            size="sm"
            role="switch"
            aria-labelledby="auto-drafting-title"
            aria-checked={current.enabled}
            disabled={
              !model.data?.enabled || save.isPending || suggestion.blocked
            }
            variant={current.enabled ? "default" : "outline"}
            onClick={() => save.mutate(!current.enabled)}
          >
            {current.enabled
              ? t("admin.draftingPage.enabled")
              : t("admin.draftingPage.disabled")}
          </Button>
        </DraftField>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("admin.draftingPage.description")}
      </p>
      {!model.data?.enabled && (
        <p role="status" className="text-sm">
          {t("admin.draftingPage.modelDisabledNotice")}
        </p>
      )}
      <PageDraft
        orgId={orgId}
        draft={suggestion.draft}
        error={suggestion.error}
      />
      <SetupError error={save.error ?? start.error} />
      <div className="flex flex-wrap items-center gap-4">
        <Button
          size="sm"
          disabled={
            !settings.data?.enabled ||
            !model.data?.enabled ||
            start.isPending ||
            suggestion.blocked
          }
          onClick={() => {
            if (window.confirm(t("admin.draftingPage.confirmRedraft")))
              start.mutate()
          }}
        >
          {start.isPending
            ? t("admin.draftingPage.queuing")
            : t("admin.draftingPage.startDrafting")}
        </Button>
        <a className="text-sm underline" href="#draft-progress">
          {t("admin.draftingPage.viewProgress")}
        </a>
      </div>
      {start.isSuccess && (
        <p role="status" className="text-sm">
          {t("admin.draftingPage.queuedCount", {
            count: start.data.data.queued,
          })}
        </p>
      )}
      <DraftingNoteForm orgId={orgId} />
    </SectionCard>
  )
}
