import { useLocation } from "@tanstack/react-router"
import { useLayoutEffect } from "react"
import useAuth from "@/hooks/useAuth"
import { useOrg } from "@/hooks/useOrg"

export type AssistantMode = "admin" | "personal"

declare module "@tanstack/react-router" {
  interface HistoryState {
    assistantRestart?: number
  }
}

let lastWorkspace: { scope: string; mode?: AssistantMode } | undefined

export function useAssistantWorkspace() {
  const { org, employeeId, roles } = useOrg()
  const { user } = useAuth()
  const { pathname, search, state } = useLocation()
  const isAdmin = roles.includes("org_admin")
  const canSwitch = isAdmin && !!employeeId
  const scope = user && org ? `${user.id}:${org.id}` : undefined
  const isAssistant = pathname === "/assistant"
  const legacyAdmin = pathname === "/admin/assistant"
  const canResume =
    !isAssistant ||
    !(search.session || search.prompt || search.find || state.assistantRestart)
  const requested = legacyAdmin
    ? "admin"
    : ((isAssistant ? search.mode : undefined) ??
      (canResume && canSwitch && lastWorkspace?.scope === scope
        ? lastWorkspace?.mode
        : undefined))
  const mode =
    isAssistant && search.draft
      ? "personal"
      : requested === "admin" || (isAdmin && !employeeId)
        ? "admin"
        : "personal"
  const storageKey =
    user && org
      ? mode === "admin"
        ? isAdmin
          ? `admin-assistant:${user.id}:${org.id}`
          : undefined
        : employeeId
          ? `bot-session:${user.id}:${org.id}:${employeeId}`
          : undefined
      : undefined
  const searchMode =
    storageKey && (mode === "admin" || requested === "personal")
      ? mode
      : undefined
  const rememberMode = (isAssistant && !search.draft) || legacyAdmin
  useLayoutEffect(() => {
    if (rememberMode && canSwitch && scope)
      lastWorkspace = { scope, mode: searchMode }
  }, [canSwitch, rememberMode, scope, searchMode])

  return {
    org,
    employeeId,
    mode,
    canSwitch,
    storageKey,
    searchMode,
  } as const
}
