import { AxiosError } from "axios"
import i18n from "@/i18n"

export function safeNext(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    Array.from(value).some((char) => char.charCodeAt(0) <= 32)
  )
    return "/"
  const url = new URL(value, "https://platform.invalid")
  if (
    url.origin !== "https://platform.invalid" ||
    url.pathname.startsWith("//")
  )
    return "/"
  return url.pathname + url.search + url.hash
}

export function authReturnPath(
  pathname: string,
  search: string,
): string | undefined {
  const assistant = pathname === "/assistant" || pathname === "/admin/assistant"
  if (pathname === "/oauth/consent" || (assistant && search))
    return pathname + search
}

export function redirectToPasswordChange(err: unknown): boolean {
  if (
    err instanceof AxiosError &&
    err.response?.status === 403 &&
    err.response.data?.detail?.code === "password_change_required"
  ) {
    if (window.location.pathname !== "/change-password") {
      const next = authReturnPath(
        window.location.pathname,
        window.location.search,
      )
      window.location.href = `/change-password${next ? `?next=${encodeURIComponent(next)}` : ""}`
    }
    return true
  }
  return false
}

function extractErrorMessage(err: Error): string {
  if (err instanceof AxiosError) {
    if (!err.response) return i18n.t("common.errors.network")
    if (err.response.status === 422) return i18n.t("common.errors.validation")
    const detail: unknown = err.response.data?.detail
    if (typeof detail === "string") return detail
    if (
      typeof detail === "object" &&
      detail !== null &&
      "message" in detail &&
      typeof detail.message === "string"
    )
      return detail.message
    const statusKeys: Record<number, string> = {
      400: "common.errors.http400",
      401: "common.errors.http401",
      403: "common.errors.http403",
      404: "common.errors.http404",
      409: "common.errors.http409",
      429: "common.errors.http429",
      500: "common.errors.http500",
      502: "common.errors.http502",
      503: "common.errors.http503",
    }
    const key = statusKeys[err.response.status]
    return key ? i18n.t(key) : i18n.t("common.errors.fallback")
  }
  return i18n.t("common.errors.fallback")
}

export const handleError = function (this: (msg: string) => void, err: Error) {
  const errorMessage = extractErrorMessage(err)
  this(errorMessage)
}

export const getInitials = (name: string): string => {
  return name
    .split(" ")
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase()
}
