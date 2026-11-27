import { useSyncExternalStore } from "react"
import {
  getAssistantSession,
  selectAssistantSession,
  subscribeToAssistantTurns,
} from "@/components/Chat/assistantTurnStore"

function subscribe(callback: () => void) {
  const unsubscribe = subscribeToAssistantTurns(callback)
  window.addEventListener("storage", callback)
  return () => {
    unsubscribe()
    window.removeEventListener("storage", callback)
  }
}

export function getCurrentConversation(key: string) {
  return getAssistantSession(key) ?? localStorage.getItem(key)
}

export function useCurrentConversation(key: string | undefined) {
  return useSyncExternalStore(subscribe, () =>
    key ? getCurrentConversation(key) : null,
  )
}

export function rememberConversation(key: string, id: string) {
  selectAssistantSession(key, id)
  localStorage.setItem(key, id)
  window.dispatchEvent(new Event("storage"))
}
