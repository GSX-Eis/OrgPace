import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import {
  Bell,
  BookOpen,
  Bot,
  BriefcaseBusiness,
  ChartGantt,
  ClipboardList,
  Cpu,
  Database,
  FileText,
  Gauge,
  Inbox,
  Link2,
  type LucideIcon,
  MessageSquare,
  Network,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareCheck,
  UserRound,
  Users,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { SessionHistory } from "@/components/Bot/SessionHistory"
import { discardAssistantTurn } from "@/components/Chat/assistantTurnStore"
import { AdminConversations } from "@/components/Sidebar/AdminConversations"
import { Button } from "@/components/ui/button"
import {
  type AssistantMode,
  useAssistantWorkspace,
} from "@/hooks/useAssistantWorkspace"
import {
  rememberConversation,
  useCurrentConversation,
} from "@/hooks/useCurrentConversation"
import { useInbox } from "@/hooks/useInbox"
import { useOrg } from "@/hooks/useOrg"
import { usePendingApprovals } from "@/hooks/usePendingApprovals"
import { cn } from "@/lib/utils"

export const spaceTitleKeys = {
  collab: "common.nav.spaces.collab",
  org: "common.nav.spaces.org",
  plan: "common.nav.spaces.plan",
  settings: "common.nav.spaces.settings",
} as const

export type Space = keyof typeof spaceTitleKeys

type Item = {
  title: string
  icon: LucideIcon
  to: string
  search?:
    | { tab: string }
    | { mode: AssistantMode }
    | { section: "account" | "integrations" | "preferences" }
  badge?: number
}

type Group = { title?: string; items: Item[] }

function tabItem(to: string, tab: string, title: string, icon: LucideIcon) {
  return { to, title, icon, search: { tab } }
}

export function useWorkspaceNavigation() {
  const { t } = useTranslation()
  const { org, roles, employeeId } = useOrg()
  const inbox = useInbox()
  const { capacity, totalCount: pending } = usePendingApprovals()
  const { pathname, search } = useLocation()
  const path = pathname.replace(/\/$/, "") || "/"
  const isAdmin = roles.includes("org_admin")
  const isManager = roles.includes("dept_manager")
  const managesEmployees = isAdmin || isManager
  const assistant = "/assistant"
  const isAssistant = [assistant, "/admin/assistant"].includes(path)
  const { searchMode } = useAssistantWorkspace()
  const assistantSearch = searchMode ? { mode: searchMode } : undefined
  const ownProfile = employeeId ? `/employees/${employeeId}` : undefined
  const unread = inbox.data?.unread_count ?? 0
  const dictionary = tabItem(
    "/admin/rules",
    "dictionary",
    t("common.nav.items.dictionary"),
    BookOpen,
  )
  const canPlan = capacity.data?.enabled && (employeeId || managesEmployees)
  const myLoad = tabItem(
    "/capacity",
    "mine",
    t("common.nav.items.myWorkload"),
    Gauge,
  )
  const teamLoad = tabItem(
    "/capacity",
    "team",
    t("common.nav.items.teamWorkload"),
    ChartGantt,
  )

  const groups: Record<Space, Group[]> = {
    collab: [
      {
        items: [
          ...(isAdmin || employeeId
            ? [
                {
                  title: t("common.nav.items.aiAssistant"),
                  icon: Sparkles,
                  to: assistant,
                  search: assistantSearch,
                },
              ]
            : []),
          ...(org
            ? [
                {
                  title: t("common.nav.items.inbox"),
                  icon: Inbox,
                  to: "/inbox",
                  badge: unread,
                },
              ]
            : []),
          ...(managesEmployees || pending
            ? [
                {
                  title: t("common.nav.items.reviews"),
                  icon: SquareCheck,
                  to: "/reviews",
                  badge: pending,
                },
              ]
            : []),
        ],
      },
    ],
    org: [
      {
        title: t("common.nav.groups.membersAndOrg"),
        items: [
          ...(ownProfile
            ? [
                {
                  title: t("common.nav.items.myProfile"),
                  icon: UserRound,
                  to: ownProfile,
                },
              ]
            : []),
          ...(managesEmployees
            ? [
                {
                  title: isAdmin
                    ? t("common.nav.items.employees")
                    : t("common.nav.items.myTeam"),
                  icon: Users,
                  to: "/employees",
                },
                {
                  title: t("common.nav.items.orgChart"),
                  icon: Network,
                  to: "/org-chart",
                },
              ]
            : []),
        ],
      },
      {
        title: t("common.nav.groups.capabilitiesAndRules"),
        items: [
          dictionary,
          ...(isAdmin
            ? [
                tabItem(
                  "/admin/rules",
                  "approval",
                  t("common.nav.items.approvalRules"),
                  ShieldCheck,
                ),
                tabItem(
                  "/admin/rules",
                  "reminders",
                  t("common.nav.items.reminders"),
                  Bell,
                ),
                tabItem(
                  "/admin/rules",
                  "capacity",
                  t("common.nav.items.capacityRules"),
                  SlidersHorizontal,
                ),
              ]
            : []),
        ],
      },
    ],
    plan: canPlan
      ? [
          {
            items: [
              ...(employeeId ? [myLoad] : []),
              ...(managesEmployees
                ? [
                    teamLoad,
                    tabItem(
                      "/capacity",
                      "borrows",
                      t("common.nav.items.borrowRequests"),
                      BriefcaseBusiness,
                    ),
                  ]
                : []),
            ],
          },
        ]
      : [],
    settings: [
      {
        title: t("common.nav.groups.personal"),
        items: [
          {
            title: t("common.nav.items.accountSecurity"),
            icon: UserRound,
            to: "/settings",
            search: { section: "account" },
          },
          {
            title: t("common.nav.items.integrations"),
            icon: Link2,
            to: "/settings",
            search: { section: "integrations" },
          },
          {
            title: t("common.nav.items.preferences"),
            icon: SlidersHorizontal,
            to: "/settings",
            search: { section: "preferences" },
          },
        ],
      },
      ...(isAdmin
        ? [
            {
              title: t("common.nav.groups.orgAdmin"),
              items: [
                tabItem(
                  "/admin/data-ai",
                  "sources",
                  t("common.nav.items.sources"),
                  Database,
                ),
                tabItem(
                  "/admin/data-ai",
                  "work-records",
                  t("common.nav.items.workRecords"),
                  ClipboardList,
                ),
                tabItem(
                  "/admin/data-ai",
                  "model",
                  t("common.nav.items.model"),
                  Cpu,
                ),
                tabItem(
                  "/admin/data-ai",
                  "bot",
                  t("common.nav.items.builtInBot"),
                  Bot,
                ),
                tabItem(
                  "/admin/data-ai",
                  "im",
                  t("common.nav.items.imChannels"),
                  MessageSquare,
                ),
                {
                  title: t("common.nav.items.auditLogs"),
                  icon: FileText,
                  to: "/admin/audit",
                },
              ],
            },
          ]
        : []),
    ],
  }
  let space: Space = "org"
  if (
    path === "/" ||
    isAssistant ||
    path === "/inbox" ||
    /^\/reviews(?:\/|$)/.test(path)
  ) {
    space = "collab"
  } else if (path === "/capacity") {
    space = "plan"
  } else if (
    [
      "/settings",
      "/admin/data-ai",
      "/admin/work-records",
      "/admin/audit",
      "/oauth/consent",
    ].includes(path)
  ) {
    space = "settings"
  }

  const pagePath = isAssistant
    ? assistant
    : path.startsWith("/reviews/")
      ? "/reviews"
      : path
  const candidates = groups[space]
    .flatMap((group) => group.items)
    .filter((item) => item.to === pagePath)
  const active =
    candidates.find(
      (item) =>
        !item.search ||
        ("tab" in item.search
          ? item.search.tab === search.tab
          : "section" in item.search
            ? item.search.section === search.section
            : true),
    ) ??
    (path !== "/capacity" ||
    !["incoming", "outgoing", "projects"].includes(String(search.tab))
      ? candidates[0]
      : undefined)

  const pageTitle =
    active?.title ??
    (path.startsWith("/employees/")
      ? t("common.nav.titles.employeeDetail")
      : path === "/capacity"
        ? t("common.nav.titles.capacityAndWorkload")
        : path === "/find-people"
          ? t("common.nav.titles.findPeople")
          : path === "/oauth/consent"
            ? t("common.nav.titles.oauthConsent")
            : undefined)

  return {
    space,
    pageTitle,
    isAssistant,
    groups: groups[space],
    active,
    destinations: {
      collab: {
        to: assistant,
        search: assistantSearch,
        badge: unread + pending,
      },
      org: ownProfile
        ? { to: ownProfile }
        : managesEmployees
          ? { to: "/employees" }
          : dictionary,
      plan: canPlan ? (employeeId ? myLoad : teamLoad) : undefined,
      settings: { to: "/settings" },
    },
  }
}

export function SpacePanel({
  space,
  groups,
  active,
  isAssistant,
  onNavigate,
}: Pick<
  ReturnType<typeof useWorkspaceNavigation>,
  "space" | "groups" | "active" | "isAssistant"
> & {
  onNavigate?: () => void
}) {
  const { t } = useTranslation()
  const { org, mode, searchMode, storageKey } = useAssistantWorkspace()
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const remembered = useCurrentConversation(storageKey)
  const session =
    pathname === "/assistant" &&
    !search.draft &&
    typeof search.session === "string"
      ? search.session
      : undefined
  const showHistory = space === "collab" && org && storageKey

  return (
    <nav
      aria-label={t("common.nav.aria.spaceNav")}
      className={cn(
        "min-h-0 flex-1 pb-4",
        isAssistant ? "px-3" : "px-2",
        showHistory ? "flex flex-col" : "overflow-y-auto",
      )}
    >
      <p
        className={cn(
          "font-semibold tracking-tight",
          isAssistant
            ? "px-2 py-4 text-lg"
            : "-mx-2 mb-2.5 flex h-12 shrink-0 items-center justify-between gap-2 border-surface-border border-b px-3.5 pr-10 text-sm md:pr-3.5",
        )}
      >
        <span className="shrink-0">{t(spaceTitleKeys[space])}</span>
        {!isAssistant && org && (
          <span
            className="truncate rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
            title={org.name}
          >
            {org.name}
          </span>
        )}
      </p>
      {groups
        .filter((group) => group.items.length)
        .map(({ title, items }) => (
          <div
            className={cn("shrink-0", isAssistant ? "mb-5" : "mb-3.5")}
            key={title ?? space}
          >
            {title && (
              <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">
                {title}
              </p>
            )}
            <ul className="space-y-0.5">
              {items.map((item) => (
                <li key={item.title} className="flex items-center gap-1">
                  <Link
                    to={item.to}
                    search={item.search}
                    activeOptions={{ exact: true }}
                    aria-current={item === active ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-md hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring",
                      isAssistant
                        ? "min-h-9 border-transparent border-l-2 px-2.5 py-1 text-sm aria-[current=page]:border-primary aria-[current=page]:bg-primary/10 aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                        : "min-h-8 px-2.5 py-1 text-[13px] text-muted-foreground aria-[current=page]:bg-blue-50 aria-[current=page]:font-semibold aria-[current=page]:text-blue-700 dark:aria-[current=page]:bg-blue-500/15 dark:aria-[current=page]:text-blue-300",
                    )}
                  >
                    {!isAssistant && (
                      <item.icon
                        className="size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span>{item.title}</span>
                    {!!item.badge && (
                      <span className="ml-auto rounded-full bg-primary/10 px-1.5 text-xs tabular-nums text-primary">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                  {item.to === "/assistant" && storageKey && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("common.nav.newConversation")}
                      title={t("common.nav.newConversation")}
                      onClick={() => {
                        discardAssistantTurn(storageKey)
                        rememberConversation(storageKey, "")
                        navigate({
                          to: "/assistant",
                          search: { mode: searchMode },
                          state: { assistantRestart: Date.now() },
                        })
                        onNavigate?.()
                      }}
                    >
                      <Plus aria-hidden="true" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {showHistory && (
        <>
          <h2 className="mb-1 px-2 text-xs font-medium text-muted-foreground">
            {t("common.nav.recentConversations")}
          </h2>
          {mode === "admin" ? (
            <AdminConversations
              orgId={org.id}
              selected={
                isAssistant ? (session ?? remembered ?? undefined) : undefined
              }
              onSelect={onNavigate}
            />
          ) : (
            <SessionHistory
              orgId={org.id}
              currentId={
                pathname === "/assistant" && !search.draft
                  ? (session ?? remembered)
                  : undefined
              }
              explicitMode={searchMode === "personal"}
              onSelect={onNavigate}
            />
          )}
        </>
      )}
    </nav>
  )
}
