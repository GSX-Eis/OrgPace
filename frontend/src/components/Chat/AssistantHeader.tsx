import { Link, useLocation } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useBotConversations } from "@/components/Bot/SessionHistory"
import { useAdminConversations } from "@/components/Sidebar/AdminConversations"
import { buttonVariants } from "@/components/ui/button"
import { useAssistantWorkspace } from "@/hooks/useAssistantWorkspace"
import { useCurrentConversation } from "@/hooks/useCurrentConversation"
import { useSetup } from "@/hooks/useSetup"

export function AssistantHeader() {
  const { t } = useTranslation()
  const { org, mode, canSwitch, storageKey } = useAssistantWorkspace()
  const { search } = useLocation()
  const admin = mode === "admin"
  const adminHistory = useAdminConversations(
    admin && storageKey ? org?.id : undefined,
  )
  const personalHistory = useBotConversations(
    !admin && storageKey ? org?.id : undefined,
  )
  const setup = useSetup()
  const remembered = useCurrentConversation(storageKey)
  const selected = search.session ?? remembered
  const entry = (admin ? adminHistory : personalHistory).data?.data.find(
    (item) => item.id === selected,
  )
  const title = search.draft
    ? t("common.chat.projectDraft")
    : entry?.purpose === "setup" && !setup.data?.completed
      ? t("common.chat.initialSetup")
      : entry?.preview ||
        (selected && admin
          ? t("common.chat.conversation")
          : t("common.chat.newConversation"))

  return (
    <>
      <nav
        aria-label={t("common.nav.aria.breadcrumb")}
        className="flex min-w-0 flex-1 items-center gap-2 text-sm"
      >
        <h1 className="shrink-0 font-medium">
          {admin
            ? t("common.chat.assistantTitleAdmin")
            : t("common.chat.assistantTitlePersonal")}
        </h1>
        {storageKey && (
          <>
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span
              aria-current="page"
              className="truncate text-muted-foreground"
            >
              {title}
            </span>
          </>
        )}
      </nav>
      {canSwitch && !search.draft && (
        <nav
          aria-label={t("common.chat.assistantModeAria")}
          className="flex shrink-0 gap-0.5 rounded-lg border p-0.5"
        >
          {(
            [
              ["admin", t("common.chat.modeAdmin")],
              ["personal", t("common.chat.modePersonal")],
            ] as const
          ).map(([value, label]) => (
            <Link
              key={value}
              to="/assistant"
              search={{ mode: value }}
              aria-current={mode === value ? "page" : undefined}
              activeOptions={{ exact: true, explicitUndefined: true }}
              className={buttonVariants({
                size: "sm",
                variant: mode === value ? "secondary" : "ghost",
                className: "h-7 px-1.5 text-xs sm:px-2.5",
              })}
            >
              {label}
            </Link>
          ))}
        </nav>
      )}
    </>
  )
}
