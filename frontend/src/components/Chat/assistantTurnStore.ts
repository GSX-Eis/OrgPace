import type { ToolEvent, UserMessage } from "@/client"

export type PendingUserMessage = {
  role: "user"
  payload: UserMessage
  created_at: string
}

type AssistantTurn = {
  sessionId?: string
  pendingUserMessage?: PendingUserMessage
  text: string
  tools: ToolEvent[]
  status: "streaming" | "completed" | "stopped" | "error"
  error?: Error
  controller: AbortController | null
}

// Each assistant workspace has one active session, including while it is being created.
const turns = new Map<string, AssistantTurn>()
const selectedSessions = new Map<string, string>()
const listeners = new Set<() => void>()
const restarts = new Map<string, number>()

function notify() {
  for (const listener of listeners) listener()
}

export function subscribeToAssistantTurns(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAssistantTurn(storageKey: string, sessionId?: string) {
  const turn = turns.get(storageKey)
  return sessionId && turn?.sessionId !== sessionId ? undefined : turn
}

export function getAssistantSession(storageKey: string) {
  return selectedSessions.get(storageKey)
}

export function selectAssistantSession(storageKey: string, sessionId: string) {
  if (selectedSessions.get(storageKey) === sessionId) return
  selectedSessions.set(storageKey, sessionId)
  notify()
}

export function startAssistantTurn(
  storageKey: string,
  sessionId: string | undefined,
  pendingUserMessage: PendingUserMessage,
) {
  if (turns.get(storageKey)?.controller) return
  const controller = new AbortController()
  turns.set(storageKey, {
    sessionId,
    pendingUserMessage,
    text: "",
    tools: [],
    status: "streaming",
    controller,
  })
  notify()
  return controller
}

export function updateAssistantTurn(
  storageKey: string,
  controller: AbortController,
  update: Partial<AssistantTurn>,
) {
  const turn = turns.get(storageKey)
  if (turn?.controller !== controller) return
  turns.set(storageKey, { ...turn, ...update })
  notify()
}

export function stopAssistantTurn(storageKey: string, sessionId?: string) {
  const controller = getAssistantTurn(storageKey, sessionId)?.controller
  if (!controller) return
  controller.abort()
  updateAssistantTurn(storageKey, controller, {
    pendingUserMessage: undefined,
    text: "",
    tools: [],
    status: "stopped",
    controller: null,
  })
}

export function discardAssistantTurn(storageKey: string) {
  const turn = turns.get(storageKey)
  if (!turn) return
  turns.delete(storageKey)
  turn.controller?.abort()
  notify()
}

export function beginAssistantRestart(storageKey: string, restart: number) {
  if (restart <= (restarts.get(storageKey) ?? 0)) return false
  restarts.set(storageKey, restart)
  discardAssistantTurn(storageKey)
  return true
}

export function clearAssistantTurns() {
  restarts.clear()
  selectedSessions.clear()
  for (const storageKey of turns.keys()) discardAssistantTurn(storageKey)
  notify()
}
