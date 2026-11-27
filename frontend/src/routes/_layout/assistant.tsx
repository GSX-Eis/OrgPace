import { createFileRoute, useLocation } from "@tanstack/react-router"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { AdminAssistantPanel } from "@/components/AdminAssistant/AdminAssistantPanel"
import { BotConversation } from "@/components/Bot/BotPanel"
import { FeishuProjectDraft } from "@/components/Bot/ProjectDraftMessage"
import { useBotConversations } from "@/components/Bot/SessionHistory"
import { OrgState } from "@/components/Profile/OrgState"
import { PeopleSearchFallback } from "@/components/Profile/PeopleSearchFallback"
import { useAdminConversations } from "@/components/Sidebar/AdminConversations"
import {
  type AssistantMode,
  useAssistantWorkspace,
} from "@/hooks/useAssistantWorkspace"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"

const assistantSearch = (
  search: Record<string, unknown>,
): {
  mode?: AssistantMode
  prompt?: string
  session?: string
  draft?: string
  org?: string
  find?: boolean
} => ({
  mode:
    search.mode === "admin" || search.mode === "personal"
      ? search.mode
      : undefined,
  prompt: typeof search.prompt === "string" ? search.prompt : undefined,
  session: typeof search.session === "string" ? search.session : undefined,
  draft: typeof search.draft === "string" ? search.draft : undefined,
  org: typeof search.org === "string" ? search.org : undefined,
  find: search.find === true ? true : undefined,
})

export const Route = createFileRoute("/_layout/assistant")({
  component: AssistantPage,
  validateSearch: assistantSearch,
  head: () => ({ meta: [{ title: i18n.t("bot.pageTitle") }] }),
})

function AssistantPage() {
  const { t } = useTranslation()
  const { memberships, roles, managedDepartmentIds } = useOrg()
  const { org, employeeId, mode, searchMode, storageKey } =
    useAssistantWorkspace()
  const location = useLocation()
  const {
    prompt,
    session,
    draft,
    org: linkedOrg,
    find,
  } = assistantSearch(location.search)
  const prefill = useMemo(() => ({ text: prompt ?? "" }), [prompt])
  const personal = mode === "personal"
  const isOrgAdmin = roles.includes("org_admin")
  const canFindPeople = isOrgAdmin || roles.includes("dept_manager")
  const historyOrgId = canFindPeople && !draft ? org?.id : undefined
  const useAdminHistory = isOrgAdmin && (!personal || !employeeId)
  const botHistory = useBotConversations(
    useAdminHistory ? undefined : historyOrgId,
    0,
  )
  const adminHistory = useAdminConversations(
    useAdminHistory ? historyOrgId : undefined,
    0,
  )
  const modelAvailable = (useAdminHistory ? adminHistory : botHistory).data
    ?.model_available
  if (!org) return <OrgState />
  if (draft) {
    const membership = memberships.find((item) => item.org.id === linkedOrg)
    return membership?.employee_id ? (
      <FeishuProjectDraft key={draft} orgId={membership.org.id} draft={draft} />
    ) : (
      <p role="alert">{t("bot.cannotOpenProjectDraft")}</p>
    )
  }
  return (
    <section
      aria-label={
        personal ? t("bot.assistantAria") : t("adminAssistant.assistantAria")
      }
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      {canFindPeople &&
        (modelAvailable === false ? (
          <PeopleSearchFallback
            key={`${org.id}:${find ?? false}`}
            orgId={org.id}
            timezone={org.timezone ?? "Asia/Shanghai"}
            initiallyOpen={find ?? false}
            isOrgAdmin={isOrgAdmin}
            managedDepartmentIds={managedDepartmentIds}
          />
        ) : find ? (
          <div className="shrink-0 border-b px-4 py-3 md:px-6">
            <h2 className="text-sm font-semibold">
              {t("bot.findPeopleHeading")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("bot.findPeopleDesc")}
            </p>
          </div>
        ) : null)}
      {!storageKey ? (
        <p role="alert" className="p-4">
          {personal
            ? t("bot.noEmployeeIdentity")
            : t("adminAssistant.adminRequired")}
        </p>
      ) : personal && employeeId ? (
        <BotConversation
          key={storageKey}
          orgId={org.id}
          employeeId={employeeId}
          storageKey={storageKey}
          selectedSession={session}
          restart={location.state.assistantRestart}
          mode={searchMode}
          prompt={prompt}
        />
      ) : (
        <AdminAssistantPanel
          key={storageKey}
          orgId={org.id}
          storageKey={storageKey}
          sessionId={session}
          navigationKey={location.state.__TSR_key}
          restart={location.state.assistantRestart}
          prefill={prefill}
        />
      )}
    </section>
  )
}
