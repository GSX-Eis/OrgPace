import { useNavigate } from "@tanstack/react-router"
import { useEffect, useLayoutEffect, useRef } from "react"
import type { AssistantMode } from "@/hooks/useAssistantWorkspace"
import {
  discardAssistantTurn,
  getAssistantTurn,
  selectAssistantSession,
} from "./assistantTurnStore"

export type StorageSyncDecision =
  | { sync: false }
  | { sync: true; sessionId: string | undefined; discardActiveTurn: boolean }

/** Decide whether a cross-tab StorageEvent requires route synchronization and turn cleanup. */
export function resolveStorageSyncDecision({
  storageKey,
  eventKey,
  newValue,
  activeTurnSessionId,
  syncEmptyStorage = false,
}: {
  storageKey: string
  eventKey: string | null
  newValue: string | null
  activeTurnSessionId?: string
  syncEmptyStorage?: boolean
}): StorageSyncDecision {
  if (eventKey !== storageKey) return { sync: false }
  if (!syncEmptyStorage && !newValue) return { sync: false }
  return {
    sync: true,
    sessionId: newValue || undefined,
    discardActiveTurn:
      syncEmptyStorage && activeTurnSessionId !== (newValue ?? null),
  }
}

/** Discard any in-flight turn belonging to a different session when switching conversations. */
export function discardStaleTurn(storageKey: string, selectedSession?: string) {
  if (
    selectedSession &&
    getAssistantTurn(storageKey)?.sessionId !== selectedSession
  ) {
    discardAssistantTurn(storageKey)
  }
}

/** Determine whether the chat panel should scroll to the bottom sentinel. */
export function shouldScrollToBottom({
  messageCount,
  streamText,
  tools,
  busy = false,
  setupIntro = false,
  pendingMessage,
}: {
  messageCount: number
  streamText: string
  tools: readonly unknown[]
  busy?: boolean
  setupIntro?: boolean
  pendingMessage?: unknown
}): boolean {
  return (
    (!setupIntro || Boolean(pendingMessage)) &&
    Boolean(messageCount || busy || streamText || tools.length)
  )
}

/** Shared cross-tab storage sync, session-switch turn cleanup, and auto-scroll hook for assistant panels. */
export function useSessionPanelSync({
  storageKey,
  mode,
  selectedSession,
  syncEmptyStorage = false,
  replaceOnStorageSync = false,
  onStorageSync,
  scroll,
}: {
  storageKey: string
  mode?: AssistantMode
  selectedSession?: string
  syncEmptyStorage?: boolean
  replaceOnStorageSync?: boolean
  onStorageSync?: () => void
  scroll: {
    messageCount: number
    streamText: string
    tools: readonly unknown[]
    busy?: boolean
    setupIntro?: boolean
    pendingMessage?: unknown
  }
}) {
  const navigate = useNavigate()
  const bottom = useRef<HTMLDivElement>(null)
  const preserveText = useRef(false)
  const onStorageSyncRef = useRef(onStorageSync)
  onStorageSyncRef.current = onStorageSync

  useEffect(() => {
    const follow = (event: StorageEvent) => {
      const decision = resolveStorageSyncDecision({
        storageKey,
        eventKey: event.key,
        newValue: event.newValue,
        activeTurnSessionId: getAssistantTurn(storageKey)?.sessionId,
        syncEmptyStorage,
      })
      if (!decision.sync) return
      if (decision.discardActiveTurn) discardAssistantTurn(storageKey)
      if (syncEmptyStorage) {
        selectAssistantSession(storageKey, event.newValue ?? "")
      }
      onStorageSyncRef.current?.()
      preserveText.current = true
      navigate({
        to: "/assistant",
        search: { mode, session: decision.sessionId },
        ...(replaceOnStorageSync ? { replace: true } : {}),
      })
    }
    window.addEventListener("storage", follow)
    return () => window.removeEventListener("storage", follow)
  }, [mode, navigate, replaceOnStorageSync, storageKey, syncEmptyStorage])

  useLayoutEffect(() => {
    discardStaleTurn(storageKey, selectedSession)
  }, [storageKey, selectedSession])

  useEffect(() => {
    if (
      shouldScrollToBottom({
        messageCount: scroll.messageCount,
        streamText: scroll.streamText,
        tools: scroll.tools,
        busy: scroll.busy,
        setupIntro: scroll.setupIntro,
        pendingMessage: scroll.pendingMessage,
      })
    ) {
      bottom.current?.scrollIntoView({ block: "end" })
    }
  }, [
    scroll.messageCount,
    scroll.streamText,
    scroll.tools,
    scroll.busy,
    scroll.setupIntro,
    scroll.pendingMessage,
  ])

  return { bottom, preserveText }
}
