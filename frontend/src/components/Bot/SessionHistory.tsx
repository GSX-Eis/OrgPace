import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { BotService } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { formatDate } from "@/i18n/format"

export function useBotConversations(
  orgId: string | undefined,
  staleTime = 30_000,
) {
  return useQuery({
    queryKey: ["conversation-history", orgId, false],
    enabled: !!orgId,
    staleTime,
    queryFn: async () =>
      (await BotService.listSessions({ query: { org_id: orgId! } })).data,
  })
}

export function SessionHistory({
  orgId,
  currentId,
  explicitMode,
  onSelect,
}: {
  orgId: string
  currentId?: string | null
  explicitMode: boolean
  onSelect?: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const history = useBotConversations(orgId)
  return (
    <section
      aria-label={t("bot.sessionHistoryAria")}
      className="min-h-0 flex-1 overflow-y-auto text-sm"
    >
      {history.isPending && (
        <p role="status">{t("bot.loadingConversations")}</p>
      )}
      <SetupError error={history.error} />
      {history.data?.data.map((entry) => (
        <button
          key={entry.id}
          type="button"
          aria-current={entry.id === currentId ? "true" : undefined}
          className="block w-full rounded-md px-2 py-2 text-left hover:bg-sidebar-accent aria-current:bg-sidebar-accent"
          onClick={() => {
            navigate({
              to: "/assistant",
              search: {
                mode: explicitMode ? "personal" : undefined,
                session: entry.id,
              },
            })
            onSelect?.()
          }}
        >
          <span className="block truncate">
            {entry.preview || t("bot.conversationFallback")}
          </span>
          <span className="block text-xs text-muted-foreground">
            {formatDate(entry.last_activity_at, {
              year: "numeric",
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        </button>
      ))}
      {history.data?.data.length === 0 && (
        <p className="px-2 py-2 text-muted-foreground">
          {t("bot.noConversations")}
        </p>
      )}
      {history.data && (
        <p className="px-2 py-3 text-xs text-muted-foreground">
          {history.data.retention_days === 0
            ? t("bot.retentionZero")
            : t("bot.retentionDays", { days: history.data.retention_days })}
        </p>
      )}
    </section>
  )
}
