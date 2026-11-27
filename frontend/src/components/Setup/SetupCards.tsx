import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { SetupService } from "@/client"
import { Button } from "@/components/ui/button"
import { useSetup } from "@/hooks/useSetup"
import { ModelStep } from "./ModelStep"
import { OrgProfileStep } from "./OrgProfileStep"
import { SetupError } from "./SetupError"

export function SetupCard({
  orgId,
  step,
  showCompanyEditor,
}: {
  orgId: string
  step?: "org_profile" | "model"
  showCompanyEditor?: boolean
}) {
  const { t } = useTranslation()
  const setup = useSetup()
  const client = useQueryClient()
  const update = useMutation({
    mutationFn: ({ key, skip }: { key: string; skip?: boolean }) =>
      (skip ? SetupService.skipStep : SetupService.completeStep)({
        path: { org_id: orgId, key },
      }),
    onSuccess: ({ data }) => {
      client.setQueryData(["setup", orgId], data)
      client.invalidateQueries({
        queryKey: ["admin-assistant-availability", orgId],
      })
      client.invalidateQueries({ queryKey: ["admin-overview", orgId] })
      client.invalidateQueries({
        queryKey: ["conversation-history", orgId, true],
      })
    },
  })
  if (setup.isPending) return <p role="status">{t("setup.cards.loading")}</p>
  if (setup.isError)
    return (
      <div>
        <SetupError error={setup.error} />
        <Button onClick={() => setup.refetch()}>
          {t("setup.cards.retry")}
        </Button>
      </div>
    )
  const state = setup.data.steps.find((item) => item.key === step)
  const title =
    step === "org_profile"
      ? t("setup.cards.stepOrgProfile")
      : t("setup.cards.stepModel")
  const form =
    step === "org_profile" ? (
      <section className="space-y-4" aria-label={t("setup.cards.orgAriaLabel")}>
        <OrgProfileStep
          orgId={orgId}
          onComplete={() => update.mutate({ key: step })}
        />
        <Button type="submit" form="org-profile" disabled={update.isPending}>
          {t("setup.cards.saveOrgName")}
        </Button>
      </section>
    ) : (
      <section
        className="space-y-4"
        aria-label={t("setup.cards.modelAriaLabel")}
      >
        <ModelStep orgId={orgId} />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={update.isPending}
            onClick={() => update.mutate({ key: "model" })}
          >
            {t("setup.cards.completeModel")}
          </Button>
          {state?.status === "pending" && (
            <Button
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ key: "model", skip: true })}
            >
              {t("setup.cards.skipModel")}
            </Button>
          )}
        </div>
      </section>
    )
  return (
    <div className="space-y-3 rounded-xl border bg-background p-4">
      {step ? (
        state?.status === "completed" ? (
          <details>
            <summary className="cursor-pointer font-medium">
              {t("setup.cards.completedSummary", { title })}
            </summary>
            <div className="pt-4">{form}</div>
          </details>
        ) : (
          <>
            <h3 className="font-medium">{title}</h3>
            {form}
            {step === "model" && state?.status === "skipped" && (
              <p role="status">
                {t("setup.cards.modelSkippedNotice")}
                <Link
                  to="/admin/data-ai"
                  search={{ tab: "model" }}
                  className="underline"
                >
                  {t("setup.cards.modelSettingsLink")}
                </Link>
              </p>
            )}
          </>
        )
      ) : (
        <ol aria-label={t("setup.cards.stepsAriaLabel")} className="divide-y">
          {setup.data.steps.map((item) => (
            <li
              key={item.key}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span>
                {item.title}
                {item.required && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t("setup.cards.required")}
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                {item.status === "completed"
                  ? t("setup.cards.statusCompleted")
                  : item.status === "skipped"
                    ? t("setup.cards.statusSkipped")
                    : t("setup.cards.statusPending")}
                {item.skippable && item.status === "pending" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("setup.cards.skipAriaLabel", {
                      title: item.title,
                    })}
                    disabled={update.isPending}
                    onClick={() => update.mutate({ key: item.key, skip: true })}
                  >
                    {t("setup.cards.skip")}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {showCompanyEditor &&
        setup.data.steps.some(
          (item) => item.key === "org_profile" && item.status === "completed",
        ) && <SetupCard orgId={orgId} step="org_profile" />}
      <SetupError error={update.error} />
    </div>
  )
}
