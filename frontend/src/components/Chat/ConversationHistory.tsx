import type { UseQueryResult } from "@tanstack/react-query"
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { SessionList, SessionSummary } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"

/** Shared React Query hook for assistant conversation history lists. */
export function useConversationHistoryQuery(
  orgId: string | undefined,
  isAdmin: boolean,
  fetchSessions: (orgId: string) => Promise<SessionList>,
  staleTime = 30_000,
) {
  return useQuery({
    queryKey: ["conversation-history", orgId, isAdmin],
    enabled: !!orgId,
    staleTime,
    queryFn: () => fetchSessions(orgId!),
  })
}

/** Shared sidebar conversation history list handling loading, error, empty, and retention states. */
export function ConversationHistory({
  ariaLabel,
  className = "min-h-0 flex-1 overflow-y-auto",
  history,
  loadingText,
  loadingClassName,
  retryText,
  emptyText,
  emptyClassName = "px-2 py-2 text-muted-foreground",
  retentionText,
  retentionClassName = "px-2 py-3 text-xs text-muted-foreground",
  renderItem,
}: {
  ariaLabel: string
  className?: string
  history: UseQueryResult<SessionList>
  loadingText: string
  loadingClassName?: string
  retryText?: string
  emptyText: string
  emptyClassName?: string
  retentionText: (retentionDays: number) => string
  retentionClassName?: string
  renderItem: (entry: SessionSummary) => ReactNode
}) {
  const entries = history.data?.data ?? []
  return (
    <section aria-label={ariaLabel} className={className}>
      {history.isPending && (
        <p role="status" className={loadingClassName}>
          {loadingText}
        </p>
      )}
      <SetupError error={history.error} />
      {history.isError && retryText && (
        <Button variant="ghost" onClick={() => history.refetch()}>
          {retryText}
        </Button>
      )}
      {entries.map(renderItem)}
      {history.data && entries.length === 0 && (
        <p className={emptyClassName}>{emptyText}</p>
      )}
      {history.data && (
        <p className={retentionClassName}>
          {retentionText(history.data.retention_days)}
        </p>
      )}
    </section>
  )
}
