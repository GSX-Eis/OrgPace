import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { AdminService } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

const levelColors = {
  ok: "border-l-emerald-600",
  off: "border-l-muted-foreground",
  warn: "border-l-amber-500",
  error: "border-l-destructive",
} as const

export function TodayPanel({
  orgId,
  onPrompt,
}: {
  orgId: string
  onPrompt?: (prompt: string) => void
}) {
  const { t } = useTranslation()
  const overview = useQuery({
    queryKey: ["admin-overview", orgId],
    queryFn: async () =>
      (await AdminService.getOverview({ path: { org_id: orgId } })).data,
    refetchInterval: 30000,
  })
  function assistantButton(prompt: string) {
    return onPrompt ? (
      <Button variant="link" onClick={() => onPrompt(prompt)}>
        {t("admin.todayPanel.askAssistant")}
      </Button>
    ) : (
      <Button variant="link" asChild>
        <a href={`/admin/assistant?prompt=${encodeURIComponent(prompt)}`}>
          {t("admin.todayPanel.askAssistant")}
        </a>
      </Button>
    )
  }
  return (
    <section
      className="space-y-4"
      aria-label={t("admin.todayPanel.sectionAriaLabel")}
    >
      <h2 className="text-2xl font-semibold">
        {t("admin.todayPanel.heading")}
      </h2>
      <SetupError error={overview.error} />
      {overview.isError && (
        <Button variant="outline" onClick={() => overview.refetch()}>
          {t("admin.todayPanel.refresh")}
        </Button>
      )}
      {overview.isPending && <p role="status">{t("admin.common.loading")}</p>}
      {overview.data && (
        <>
          <div className="grid items-start gap-3 lg:grid-cols-2">
            {overview.data.status_cards.map((card) => (
              <Card
                key={card.key}
                role="article"
                aria-label={card.title}
                className={`gap-2 rounded-md border-l-4 p-4 shadow-none ${levelColors[card.level]}`}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <h3 className="font-semibold">{card.title}</h3>
                  <span className="text-xs text-muted-foreground">
                    {t(`admin.todayPanel.levels.${card.level}`)}
                  </span>
                  <p>{card.summary}</p>
                </div>
                {(card.level === "warn" || card.level === "error") && (
                  <>
                    <ul className="list-disc pl-5 text-sm text-muted-foreground">
                      {card.fix_steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ul>
                    <Button variant="link" asChild className="self-start px-0">
                      <a href={card.page}>{t("admin.todayPanel.goHandle")}</a>
                    </Button>
                    {assistantButton(card.assistant_prompt)}
                  </>
                )}
              </Card>
            ))}
          </div>
          {overview.data.todos.length === 0 && (
            <p className="py-4 text-muted-foreground">
              {t("admin.todayPanel.empty")}
            </p>
          )}
          <ul className="divide-y rounded-md border px-4">
            {overview.data.todos.map((todo) => (
              <li
                key={todo.kind}
                className="flex flex-wrap items-center justify-between gap-4 py-2"
              >
                <span>{todo.title}</span>
                {todo.steps && todo.steps.length > 0 ? (
                  <ul className="w-full space-y-1">
                    {todo.steps.map((step) => (
                      <li
                        key={step.title}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <span>{step.title}</span>
                        <div className="flex flex-wrap">
                          <Button variant="link" asChild>
                            <a href={step.page}>
                              {t("admin.todayPanel.goHandle")}
                            </a>
                          </Button>
                          {assistantButton(step.assistant_prompt)}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="flex shrink-0 flex-wrap">
                    <Button variant="link" asChild>
                      <a href={todo.page}>{t("admin.todayPanel.goHandle")}</a>
                    </Button>
                    {assistantButton(todo.assistant_prompt)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
