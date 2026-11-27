import { QueryClientProvider } from "@tanstack/react-query"
import { createRouter, RouterProvider } from "@tanstack/react-router"
import { AxiosError } from "axios"
import { StrictMode } from "react"
import ReactDOM from "react-dom/client"
import { client } from "./client/client.gen"
import { ThemeProvider } from "./components/theme-provider"
import { Toaster } from "./components/ui/sonner"
import "./index.css"
import { clearAuthToken } from "./hooks/useAuth"
import { getLocale, i18n, registerLocaleRouter } from "./i18n"
import { createLocaleQueryClient } from "./i18n/localeQuerySync"
import { routeTree } from "./routeTree.gen"
import { authReturnPath, redirectToPasswordChange } from "./utils"

client.setConfig({
  baseURL: import.meta.env.VITE_API_URL ?? "",
  auth: () => localStorage.getItem("access_token") || "",
})

client.instance.interceptors.request.use((config) => {
  config.headers.set("Accept-Language", getLocale())
  return config
})

const handleApiError = (error: Error) => {
  if (redirectToPasswordChange(error)) return
  if (error instanceof AxiosError && error.response?.status === 401) {
    clearAuthToken()
    const next = authReturnPath(
      window.location.pathname,
      window.location.search,
    )
    window.location.href = `/login${next ? `?next=${encodeURIComponent(next)}` : ""}`
  }
}
client.instance.interceptors.response.use(undefined, (error: unknown) => {
  if (error instanceof Error) handleApiError(error)
  return Promise.reject(error)
})
const { queryClient, refreshForLocaleChange } =
  createLocaleQueryClient(handleApiError)
i18n.on("languageChanged", refreshForLocaleChange)

const router = createRouter({ routeTree })
registerLocaleRouter(() => router.invalidate())
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster richColors closeButton />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
