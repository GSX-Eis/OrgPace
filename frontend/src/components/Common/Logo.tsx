import { Link } from "@tanstack/react-router"
import { UsersRound } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

interface LogoProps {
  variant?: "full" | "icon" | "responsive"
  className?: string
  asLink?: boolean
}

export function Logo({
  variant = "full",
  className,
  asLink = true,
}: LogoProps) {
  const { t } = useTranslation()
  const content = (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-semibold tracking-tight",
        className,
      )}
    >
      <UsersRound className="size-6 shrink-0 text-primary" aria-hidden="true" />
      <span
        className={
          variant === "icon"
            ? "sr-only"
            : variant === "responsive"
              ? "group-data-[collapsible=icon]:sr-only"
              : ""
        }
      >
        {t("common.appTitle")}
      </span>
    </span>
  )
  return asLink ? <Link to="/">{content}</Link> : content
}
