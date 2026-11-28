import { AxiosError, AxiosHeaders } from "axios"
import { useSyncExternalStore } from "react"
import type { ErrorEvent, TextEvent, ToolEvent, UserMessage } from "@/client"
import { rememberConversation } from "@/hooks/useCurrentConversation"
import i18n from "@/i18n"
import { buildClientRequest } from "@/lib/clientRequest"
import {
  getAssistantTurn,
  type PendingUserMessage,
  startAssistantTurn,
  stopAssistantTurn,
  subscribeToAssistantTurns,
  updateAssistantTurn,
} from "./assistantTurnStore"

export type ToolProgress = ToolEvent

const emptyTools: ToolProgress[] = []

function streamError(message: string): AxiosError {
  return new AxiosError(message, undefined, undefined, undefined, {
    data: { detail: message },
    status: 200,
    statusText: "OK",
    headers: {},
    config: { headers: new AxiosHeaders() },
  })
}

export function useStreamingTurn<Input, Response>({
  storageKey,
  sessionId,
  url,
  resolveSession,
  onComplete,
}: {
  storageKey: string
  sessionId?: string
  url: (id: string) => string
  resolveSession?: (signal: AbortSignal) => Promise<string>
  onComplete: (
    id: string,
    user: PendingUserMessage,
    response: Response,
    completedAt: string,
  ) => void
}) {
  const turn = useSyncExternalStore(subscribeToAssistantTurns, () =>
    getAssistantTurn(storageKey, sessionId),
  )

  async function run(body: Input, payload: UserMessage) {
    const user: PendingUserMessage = {
      role: "user",
      payload,
      created_at: new Date().toISOString(),
    }
    // Image previews download immediately and need the resolved session ID.
    const abort = startAssistantTurn(
      storageKey,
      sessionId,
      sessionId ? user : { ...user, payload: { ...payload, attachments: [] } },
    )
    if (!abort) return
    let text = ""
    const tools: ToolProgress[] = []
    try {
      const id = sessionId ?? (await resolveSession?.(abort.signal))
      if (abort.signal.aborted) return
      if (!id) throw streamError(i18n.t("common.chat.cannotStartConversation"))
      if (!sessionId) {
        updateAssistantTurn(storageKey, abort, {
          sessionId: id,
          pendingUserMessage: user,
        })
        rememberConversation(storageKey, id)
      }
      const request = await buildClientRequest(url(id), {
        "Content-Type": "application/json",
      })
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      })
      if (!response.ok)
        throw new AxiosError(
          i18n.t("common.chat.streamConnectionFailed"),
          undefined,
          undefined,
          undefined,
          {
            data: await response.json().catch(() => null),
            status: response.status,
            statusText: response.statusText,
            headers: {},
            config: { headers: new AxiosHeaders() },
          },
        )
      if (!response.body)
        throw streamError(i18n.t("common.chat.streamInterrupted"))
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ""
      let final: Response | undefined
      try {
        while (true) {
          const { value, done } = await reader.read()
          pending += decoder.decode(value, { stream: !done })
          const lines = pending.split("\n")
          pending = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.trim()) continue
            const event = JSON.parse(line) as
              | TextEvent
              | ToolEvent
              | ErrorEvent
              | { type: "final"; response: Response }
            if (abort.signal.aborted) return
            if (event.type === "error") throw streamError(event.message)
            if (event.type === "text") {
              text += event.text
              updateAssistantTurn(storageKey, abort, { text })
            }
            if (event.type === "tool") {
              tools.push(event)
              updateAssistantTurn(storageKey, abort, { tools: [...tools] })
            }
            if (event.type === "final") final = event.response
          }
          if (done) break
        }
        if (final === undefined || pending.trim())
          throw streamError(i18n.t("common.chat.streamInterrupted"))
      } finally {
        await reader.cancel()
      }
      if (abort.signal.aborted) return
      onComplete(id, user, final, new Date().toISOString())
      updateAssistantTurn(storageKey, abort, {
        pendingUserMessage: undefined,
        text: "",
        tools: [],
        status: "completed",
        controller: null,
      })
      return id
    } catch (error) {
      if (abort.signal.aborted) return
      const problem =
        error instanceof Error && !(error instanceof TypeError)
          ? error
          : streamError(i18n.t("common.chat.streamInterrupted"))
      updateAssistantTurn(storageKey, abort, {
        pendingUserMessage: undefined,
        text: "",
        tools: [],
        status: "error",
        error: problem,
        controller: null,
      })
      throw problem
    }
  }

  return {
    run,
    sessionId: turn?.sessionId,
    pendingUserMessage: turn?.pendingUserMessage,
    isPending: turn?.status === "streaming",
    stopped: turn?.status === "stopped",
    error: turn?.error ?? null,
    text: turn?.text ?? "",
    tools: turn?.tools ?? emptyTools,
    stop: () => stopAssistantTurn(storageKey, sessionId),
  }
}
