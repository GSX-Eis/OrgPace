import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import {
  BotService,
  type ProjectDraftAction,
  type ProjectDraftCard,
} from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { useOrg } from "@/hooks/useOrg"

export function ProjectDraftMessage({
  card,
  disabled,
  onConfirm,
  onOpenProject,
}: {
  card: ProjectDraftCard
  disabled: boolean
  onConfirm: (action: ProjectDraftAction) => void
  onOpenProject?: () => void
}) {
  const { t } = useTranslation()
  return (
    <section
      aria-label={t("bot.projectDraftAria")}
      className="space-y-4 rounded-xl border bg-background p-4"
    >
      <h3 className="font-semibold">{t("bot.projectDraftTitle")}</h3>
      <p className="font-medium">{card.project.title}</p>
      {card.project.description && (
        <p className="whitespace-pre-wrap">{card.project.description}</p>
      )}
      <dl className="space-y-3">
        {card.fields.map((field, index) => (
          <div key={field.label}>
            <dt className="font-medium">{field.label}</dt>
            <dd className="whitespace-pre-wrap">{field.value}</dd>
            {card.project.roles[index - 1] && (
              <dd className="whitespace-pre-wrap">
                {card.project.roles[index - 1].description}
              </dd>
            )}
          </div>
        ))}
      </dl>
      {card.project_id ? (
        <p role="status">
          {t("bot.projectCreated")}
          <Link
            className="underline"
            to="/capacity"
            search={{ tab: "projects", project: card.project_id }}
            onClick={onOpenProject}
          >
            {t("bot.viewProjectDemands")}
          </Link>
        </p>
      ) : (
        card.actions?.map((action) => (
          <Button
            key={action.card_id}
            disabled={disabled}
            onClick={() => onConfirm(action)}
          >
            {t("bot.confirmCreateProject")}
          </Button>
        ))
      )}
    </section>
  )
}

export function FeishuProjectDraft({
  orgId,
  draft,
}: {
  orgId: string
  draft: string
}) {
  const { t } = useTranslation()
  const { setOrg } = useOrg()
  const client = useQueryClient()
  const query = { org_id: orgId, draft }
  const preview = useQuery({
    queryKey: ["feishu-project-draft", orgId, draft],
    queryFn: async () =>
      (await BotService.readFeishuProjectDraft({ query })).data,
  })
  const confirm = useMutation({
    mutationFn: async () =>
      (await BotService.confirmFeishuProjectDraft({ query })).data,
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["capacity", orgId] }),
  })
  const result = confirm.data?.messages[0]
  const card = result?.type === "project_draft_card" ? result : preview.data
  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-4">
      {preview.isPending && <p role="status">{t("bot.loadingProjectDraft")}</p>}
      {card && (
        <ProjectDraftMessage
          card={card}
          disabled={confirm.isPending}
          onConfirm={() => confirm.mutate()}
          onOpenProject={() => setOrg(orgId)}
        />
      )}
      {result?.type === "text" && <p role="status">{result.text}</p>}
      <SetupError error={preview.error ?? confirm.error} />
    </main>
  )
}
