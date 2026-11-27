import { Link as RouterLink } from "@tanstack/react-router"
import { LogOut, Monitor, Moon, Settings, Sun } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useTheme } from "@/components/theme-provider"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import useAuth from "@/hooks/useAuth"
import { getInitials } from "@/utils"

interface UserInfoProps {
  fullName?: string
  email?: string | null
}

function UserInfo({ fullName, email }: UserInfoProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2.5 w-full min-w-0">
      <Avatar className="size-8">
        <AvatarFallback className="bg-zinc-600 text-white">
          {getInitials(fullName || t("common.nav.userFallback"))}
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-col items-start min-w-0">
        <p className="text-sm font-medium truncate w-full">{fullName}</p>
        <p className="text-xs text-muted-foreground truncate w-full">{email}</p>
      </div>
    </div>
  )
}

export function User({ user }: { user: any }) {
  const { t } = useTranslation()
  const { logout } = useAuth()
  const { setTheme } = useTheme()
  const { isMobile, setOpenMobile } = useSidebar()

  if (!user) return null

  const handleMenuClick = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }
  const handleLogout = async () => {
    logout()
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="justify-center p-0 data-[state=open]:bg-sidebar-accent"
              aria-label={t("common.nav.aria.userMenu")}
              data-testid="user-menu"
            >
              <Avatar className="size-8">
                <AvatarFallback className="bg-zinc-600 text-white">
                  {getInitials(user.full_name || t("common.nav.userFallback"))}
                </AvatarFallback>
              </Avatar>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <UserInfo fullName={user?.full_name} email={user?.email} />
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <RouterLink to="/settings" onClick={handleMenuClick}>
              <DropdownMenuItem>
                <Settings />
                {t("common.nav.spaces.settings")}
              </DropdownMenuItem>
            </RouterLink>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="theme-button">
                <Sun className="mr-2 size-4" />
                {t("common.theme.label")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  data-testid="light-mode"
                  onClick={() => setTheme("light")}
                >
                  <Sun />
                  {t("common.theme.light")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="dark-mode"
                  onClick={() => setTheme("dark")}
                >
                  <Moon />
                  {t("common.theme.dark")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}>
                  <Monitor />
                  {t("common.theme.system")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onClick={handleLogout}>
              <LogOut />
              {t("common.nav.logout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
