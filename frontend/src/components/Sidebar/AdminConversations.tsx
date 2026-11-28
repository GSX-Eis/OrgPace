import { Link } from "@tanstack/react-router"
import { Bot, ListChecks } from "lucide-react"
import { useTranslation } from "react-i18next"
import { AdminAssistantService } from "@/client"
import {
  ConversationHistory,
  useConversationHistoryQuery,
} from "@/components/Chat/ConversationHistory"
import { useSetup } from "@/hooks/useSetup"
import { formatDate } from "@/i18n/format"

export function useAdminConversations(
  orgId: string | undefined,
  staleTime = 30_000,
) {
  return useConversationHistoryQuery(
    orgId,
    true,
    async (id) =>
      (
        await AdminAssistantService.assistantListSessions({
          query: { org_id: id },
        })
      ).data,
    staleTime,
  )
}

export function AdminConversations({
  orgId,
  selected,
  onSelect,
}: {
  orgId: string
  selected?: string
  onSelect?: () => void
}) {
  const { t } = useTranslation()
  const setup = useSetup()
  const remaining =
    setup.data?.steps.filter((step) => step.status === "pending").length ?? 0
  const history = useAdminConversations(orgId)
  return (
    <ConversationHistory
      ariaLabel={t("common.adminConversations.ariaLabel")}
      history={history}
      loadingText={t("common.adminConversations.loading")}
      loadingClassName="p-3 text-sm"
      retryText={t("common.adminConversations.retry")}
      emptyText={t("common.adminConversations.empty")}
      emptyClassName="p-3 text-sm text-muted-foreground"
      retentionText={(days) =>
        days
          ? t("common.adminConversations.retentionDays", { days })
          : t("common.adminConversations.ephemeralRetention")
      }
      retentionClassName="px-3 py-4 text-xs text-muted-foreground"
      renderItem={(entry) => {
        const onboarding = entry.purpose === "setup" && !setup.data?.completed
        const title = onboarding
          ? t("common.adminConversations.initialSetup")
          : entry.preview || t("common.adminConversations.conversation")
        const Icon = onboarding ? ListChecks : Bot
        const activity = new Date(entry.last_activity_at)
        const today = activity.toDateString() === new Date().toDateString()
        return (
          <Link
            key={entry.id}
            to="/assistant"
            search={{ mode: "admin", session: entry.id }}
            aria-label={
              onboarding
                ? t("common.adminConversations.setupAriaLabel", {
                    count: remaining,
                  })
                : title
            }
            aria-current={selected === entry.id ? "page" : undefined}
            onClick={onSelect}
            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 hover:bg-sidebar-accent aria-current:bg-sidebar-accent"
            title={title}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-background">
              <Icon className="size-4 text-muted-foreground" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {title}
                </span>
                <time
                  dateTime={entry.last_activity_at}
                  className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                >
                  {today
                    ? formatDate(activity, {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })
                    : `${activity.getMonth() + 1}/${activity.getDate()}`}
                </time>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {onboarding
                  ? t("common.adminConversations.stepsRemaining", {
                      count: remaining,
                    })
                  : t("common.adminConversations.subtitleTurns", {
                      count: entry.turn_count,
                    })}
              </p>
            </div>
          </Link>
        )
      }}
    />
  )
}
