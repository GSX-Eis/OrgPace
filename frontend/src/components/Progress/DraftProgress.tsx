import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import {
  ApprovalPolicyService,
  DraftingSettingsService,
  InitialProfilesService,
} from "@/client"
import { localeRecord } from "@/components/Admin/labels"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { formatDate } from "@/i18n/format"

const labels = localeRecord(
  {
    processed: "",
    drafted: "",
    no_content: "",
    pending: "",
    running: "",
    failed: "",
    not_started: "",
    excluded: "",
  },
  "admin.draftProgress.labels",
)

export function DraftProgress({
  orgId,
  wizard = false,
}: {
  orgId: string
  wizard?: boolean
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const path = { org_id: orgId }
  const settings = useQuery({
    queryKey: ["drafting-settings", orgId],
    queryFn: async () =>
      (await DraftingSettingsService.settingsGetDraftingSettings({ path }))
        .data,
  })
  const policy = useQuery({
    queryKey: ["approval-policy", orgId],
    queryFn: async () =>
      (await ApprovalPolicyService.policyGetApprovalPolicy({ path })).data,
    enabled: !wizard,
  })
  const progress = useQuery({
    queryKey: ["draft-progress", orgId],
    queryFn: async () =>
      (await InitialProfilesService.profilesProgress({ path })).data,
    refetchInterval: 5000,
  })
  const handover = useQuery({
    queryKey: ["handover", orgId],
    queryFn: async () =>
      (await InitialProfilesService.profilesPreviewHandover({ path })).data,
    enabled: !wizard,
    refetchInterval: 5000,
  })
  const send = useMutation({
    mutationFn: () => InitialProfilesService.profilesConfirmHandover({ path }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["draft-progress", orgId] })
      client.invalidateQueries({ queryKey: ["handover", orgId] })
    },
  })
  // Saved pending progress can outlive its job; the API rejects concurrent drafts.
  const draft = useMutation({
    mutationFn: (scope: "all" | "failed") =>
      InitialProfilesService.profilesDraft({ path, body: { scope } }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["draft-progress", orgId] })
      client.invalidateQueries({ queryKey: ["setup", orgId] })
    },
  })
  const data = progress.data
  const counts = data?.counts ?? {}
  const processed = counts.processed ?? 0
  const drafted = counts.drafted ?? 0
  const noContent = counts.no_content ?? 0
  const eligible =
    processed +
    (counts.pending ?? 0) +
    (counts.running ?? 0) +
    (counts.not_started ?? 0)
  return (
    <SectionCard
      className="space-y-3 text-sm"
      aria-label={t("admin.draftProgress.sectionAriaLabel")}
    >
      <h2 className="text-sm font-semibold">
        {t("admin.draftProgress.heading")}
      </h2>
      <SetupError error={progress.error ?? draft.error} />
      {progress.isPending && (
        <p role="status">{t("admin.draftProgress.loading")}</p>
      )}
      {progress.isError && (
        <Button onClick={() => progress.refetch()}>
          {t("admin.draftProgress.retry")}
        </Button>
      )}
      {data && (
        <>
          {!settings.data?.enabled && (
            <p>{t("admin.draftProgress.autoDraftDisabled")}</p>
          )}
          {data.mode === "none" && (
            <div role="alert" className="rounded-lg border p-2">
              <p>{t("admin.draftProgress.noModelNotice")}</p>
              <Link className="underline" to="/admin/model">
                {t("admin.draftProgress.goConfigureModel")}
              </Link>
            </div>
          )}
          {data.paused_until && (
            <div
              role="alert"
              className="rounded-lg border border-amber-500 bg-amber-500/10 p-2 text-amber-900 dark:text-amber-200"
            >
              <p>
                {data.pause_reason ?? t("admin.draftProgress.pausedFallback")}
              </p>
              <p>
                {t("admin.draftProgress.pausedUntil", {
                  time: formatDate(data.paused_until, {
                    dateStyle: "short",
                    timeStyle: "medium",
                  }),
                })}
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <div className="flex flex-wrap justify-between gap-x-2">
              <span className="text-muted-foreground">
                {t("admin.draftProgress.processedLabel")}
              </span>
              <span className="font-medium tabular-nums">
                {t("admin.draftProgress.processedCount", {
                  processed,
                  eligible,
                })}
              </span>
            </div>
            <progress
              aria-label={t("admin.draftProgress.processedLabel")}
              value={processed}
              max={eligible || 1}
              className="block h-1.5 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
            />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            {Object.entries(labels).map(([key, label]) => (
              <div key={key} className="flex justify-between gap-2">
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className="font-medium tabular-nums">{counts[key] ?? 0}</dd>
              </div>
            ))}
          </dl>
          {noContent > 0 && (
            <p className="text-muted-foreground">
              {t("admin.draftProgress.noContentHint")}
              {!wizard && (
                <span>{t("admin.draftProgress.noContentJiraHint")}</span>
              )}
            </p>
          )}
          {processed > 0 && processed === eligible && (
            <p role="status">
              {t("admin.draftProgress.completedSummary", {
                processed,
                drafted,
                noContent,
              })}
            </p>
          )}
          {!!counts.excluded && (
            <p>
              {t("admin.draftProgress.excludedCount", {
                count: counts.excluded,
              })}
            </p>
          )}
          {data.failed.length > 0 && (
            <ul className="space-y-2">
              {data.failed.map((person) => (
                <li
                  key={person.employee_id}
                  className="rounded-lg border border-destructive/30 p-3"
                >
                  {t("admin.draftProgress.failedItem", {
                    name: person.display_name,
                    error: person.error,
                  })}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            draft.isPending ||
            !data ||
            data.mode === "none" ||
            !settings.data?.enabled
          }
          onClick={() => {
            if (
              wizard ||
              window.confirm(t("admin.draftProgress.confirmRedraft"))
            )
              draft.mutate("all")
          }}
        >
          {wizard
            ? t("admin.draftProgress.draftWizard")
            : t("admin.draftProgress.redraftAll")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            draft.isPending ||
            !counts.failed ||
            data?.mode === "none" ||
            !settings.data?.enabled
          }
          onClick={() => draft.mutate("failed")}
        >
          {t("admin.draftProgress.retryFailed")}
        </Button>
      </div>
      {!wizard && (
        <div className="space-y-2 border-t border-surface-border pt-3">
          <p>
            {t("admin.draftProgress.handoverCount", {
              days: policy.data?.current.owner_review_days ?? "—",
              count: handover.data?.count ?? "—",
            })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("admin.draftProgress.handoverNote")}
          </p>
          <SetupError error={handover.error ?? send.error} />
          <Button
            size="sm"
            variant="outline"
            disabled={send.isPending || !handover.data?.count}
            onClick={async () => {
              const latest = await handover.refetch()
              if (
                latest.isSuccess &&
                latest.data.count > 0 &&
                window.confirm(
                  t("admin.draftProgress.confirmHandover", {
                    count: latest.data.count,
                  }),
                )
              )
                send.mutate()
            }}
          >
            {t("admin.draftProgress.batchHandover")}
          </Button>
          {send.isSuccess && (
            <p role="status">
              {t("admin.draftProgress.handoverSent", {
                count: send.data.data.count,
              })}
            </p>
          )}
        </div>
      )}
    </SectionCard>
  )
}
