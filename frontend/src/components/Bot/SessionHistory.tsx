import { useNavigate } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { BotService } from "@/client"
import {
  ConversationHistory,
  useConversationHistoryQuery,
} from "@/components/Chat/ConversationHistory"
import { formatDate } from "@/i18n/format"

export function useBotConversations(
  orgId: string | undefined,
  staleTime = 30_000,
) {
  return useConversationHistoryQuery(
    orgId,
    false,
    async (id) =>
      (await BotService.listSessions({ query: { org_id: id } })).data,
    staleTime,
  )
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
    <ConversationHistory
      ariaLabel={t("bot.sessionHistoryAria")}
      className="min-h-0 flex-1 overflow-y-auto text-sm"
      history={history}
      loadingText={t("bot.loadingConversations")}
      emptyText={t("bot.noConversations")}
      retentionText={(days) =>
        days === 0 ? t("bot.retentionZero") : t("bot.retentionDays", { days })
      }
      renderItem={(entry) => (
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
      )}
    />
  )
}
