import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { toast } from "sonner"

import {
  type Body_login_login_access_token as AccessToken,
  LoginService,
  type UserPublic,
  UsersService,
} from "@/client"
import { clearAssistantTurns } from "@/components/Chat/assistantTurnStore"
import i18n, { syncUserLocale } from "@/i18n"
import { handleError, safeNext } from "@/utils"

const isLoggedIn = () => {
  return localStorage.getItem("access_token") !== null
}

export function clearAuthToken() {
  clearAssistantTurns()
  localStorage.removeItem("access_token")
}

const useAuth = (next?: string) => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  useEffect(() => {
    const syncAuth = (event: StorageEvent) => {
      if (event.key === "access_token" || event.key === null) {
        clearAssistantTurns()
        queryClient.clear()
      }
    }
    window.addEventListener("storage", syncAuth)
    return () => window.removeEventListener("storage", syncAuth)
  }, [queryClient])

  const { data: user } = useQuery<UserPublic | null, Error>({
    queryKey: ["currentUser"],
    queryFn: async () => {
      const { data } = await UsersService.readUserMe()
      syncUserLocale(data.preferred_locale)
      return data
    },
    enabled: isLoggedIn(),
  })

  const login = async (data: AccessToken) => {
    const response = await LoginService.loginAccessToken({
      body: data,
    })
    clearAssistantTurns()
    localStorage.setItem("access_token", response.data.access_token)
    queryClient.clear()
  }

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: () => {
      navigate({ href: safeNext(next) })
    },
    onError: handleError.bind((description: string) =>
      toast.error(i18n.t("account.loginFailed"), { description }),
    ),
  })

  const logout = () => {
    clearAuthToken()
    queryClient.clear()
    sessionStorage.setItem("logged_out", "true")
    navigate({ to: "/login" })
  }

  return {
    loginMutation,
    logout,
    user,
  }
}

export { isLoggedIn }
export default useAuth
