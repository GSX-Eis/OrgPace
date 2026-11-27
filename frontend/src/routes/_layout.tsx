import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import axios, { AxiosError } from "axios"
import { ChevronRight, Menu, PanelLeft } from "lucide-react"
import { useTranslation } from "react-i18next"
import { UsersService } from "@/client"
import { AssistantHeader } from "@/components/Chat/AssistantHeader"
import { LanguageSwitch } from "@/components/Common/LanguageSwitch"
import { TOPBAR_ACTIONS_ID } from "@/components/Common/TopbarSlot"
import AppSidebar from "@/components/Sidebar/AppSidebar"
import {
  SpacePanel,
  spaceTitleKeys,
  useWorkspaceNavigation,
} from "@/components/Sidebar/SpacePanel"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { clearAuthToken, isLoggedIn } from "@/hooks/useAuth"
import { getLocale, syncUserLocale } from "@/i18n"
import { cn } from "@/lib/utils"
import { authReturnPath } from "@/utils"

export const Route = createFileRoute("/_layout")({
  component: Layout,
  beforeLoad: async ({ location }) => {
    if (
      location.pathname.replace(/\/$/, "") === "/employees" &&
      new URLSearchParams(location.searchStr).get("view") === "org-chart"
    )
      throw redirect({ to: "/org-chart", replace: true })
    const search = authReturnPath(location.pathname, location.searchStr)
      ? { next: location.href }
      : undefined
    if (!isLoggedIn()) {
      throw redirect({
        to: "/login",
        search,
      })
    }
    try {
      // The route guard handles auth errors without the global reload interceptor.
      const { data: user } = await UsersService.readUserMe({
        axios,
        headers: { "Accept-Language": getLocale() },
      })
      syncUserLocale(user.preferred_locale)
      if (user.must_change_password) {
        throw redirect({ to: "/change-password", search })
      }
    } catch (error) {
      if (
        error instanceof AxiosError &&
        [401, 403].includes(error.response?.status ?? 0)
      ) {
        if (error.response?.data?.detail?.code === "password_change_required") {
          throw redirect({ to: "/change-password", search })
        }
        clearAuthToken()
        throw redirect({ to: "/login", search })
      }
      throw error
    }
  },
})

function Layout() {
  return (
    <SidebarProvider>
      <Workspace />
    </SidebarProvider>
  )
}

function Workspace() {
  const { t } = useTranslation()
  const { open, openMobile, setOpenMobile, toggleSidebar, isMobile } =
    useSidebar()
  const navigation = useWorkspaceNavigation()
  const { space, pageTitle, isAssistant } = navigation
  return (
    <>
      <AppSidebar {...navigation} />
      {open && !isMobile && (
        <aside
          id="workspace-navigation"
          className={cn(
            "sticky top-0 hidden h-dvh shrink-0 flex-col border-r md:flex",
            isAssistant
              ? "w-64 bg-sidebar"
              : "w-60 border-surface-border bg-workspace-panel",
          )}
        >
          <SpacePanel {...navigation} />
        </aside>
      )}
      <div
        className={`flex min-w-0 flex-1 flex-col ${isAssistant ? "h-dvh" : ""}`}
      >
        <header
          className={cn(
            "sticky top-0 z-10 flex h-12 shrink-0 items-center gap-1 border-b px-1.5 sm:gap-2 sm:px-3 md:px-4",
            isAssistant ? "bg-background" : "border-surface-border bg-surface",
          )}
        >
          {isMobile ? (
            <Sheet open={openMobile} onOpenChange={setOpenMobile}>
              <SheetTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="max-sm:size-7"
                  aria-label={t("common.nav.aria.openSpaceNav")}
                >
                  <Menu aria-hidden="true" />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                aria-describedby={undefined}
                className={cn(
                  "max-w-full gap-0",
                  isAssistant
                    ? "w-64 bg-sidebar"
                    : "w-60 border-surface-border bg-workspace-panel",
                )}
              >
                <SheetTitle className="sr-only">
                  {t("common.nav.aria.spaceNav")}
                </SheetTitle>
                <SpacePanel
                  {...navigation}
                  onNavigate={() => setOpenMobile(false)}
                />
              </SheetContent>
            </Sheet>
          ) : (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={
                open
                  ? t("common.nav.aria.collapseSpaceNav")
                  : t("common.nav.aria.expandSpaceNav")
              }
              aria-expanded={open}
              aria-controls={open ? "workspace-navigation" : undefined}
              onClick={toggleSidebar}
            >
              <PanelLeft aria-hidden="true" />
            </Button>
          )}
          {isAssistant ? (
            <>
              <AssistantHeader />
              <LanguageSwitch />
            </>
          ) : (
            <>
              <nav
                aria-label={t("common.nav.aria.breadcrumb")}
                className="flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap text-[13px] sm:shrink sm:gap-1.5"
              >
                <span
                  className={cn(
                    "truncate text-muted-foreground",
                    pageTitle && "hidden sm:inline",
                  )}
                >
                  {t(spaceTitleKeys[space])}
                </span>
                {pageTitle && (
                  <>
                    <ChevronRight
                      aria-hidden="true"
                      className="hidden size-3 shrink-0 text-muted-foreground sm:inline"
                    />
                    <span
                      aria-current="page"
                      className="truncate font-semibold"
                    >
                      {pageTitle}
                    </span>
                  </>
                )}
              </nav>
              <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-1.5 md:max-w-[75%] md:gap-2">
                <div
                  id={TOPBAR_ACTIONS_ID}
                  className="flex min-w-0 items-center gap-0.5 empty:hidden max-sm:overflow-x-auto max-sm:[&>*]:shrink-0 max-sm:[&>a:has(>svg:only-child)]:size-7 max-sm:[&>a:has(>svg:only-child)]:p-0 max-sm:[&>button:has(>svg+span.sr-only)]:size-7 max-sm:[&>button:has(>svg+span.sr-only)]:p-0 sm:gap-1 md:gap-2"
                />
                <LanguageSwitch />
              </div>
            </>
          )}
        </header>
        {/* Keep the outlet mounted while the router resolves the next match. */}
        <main
          data-workspace={isAssistant ? undefined : ""}
          className={
            isAssistant
              ? "min-h-0 flex-1"
              : "min-w-0 flex-1 bg-canvas [&:not(:has([data-workspace-page]))]:p-3 md:[&:not(:has([data-workspace-page]))]:p-4"
          }
        >
          <div className={isAssistant ? "h-full min-h-0" : undefined}>
            <Outlet />
          </div>
        </main>
      </div>
    </>
  )
}
