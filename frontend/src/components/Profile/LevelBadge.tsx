import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import i18n from "@/i18n"
import { cn } from "@/lib/utils"
import { record } from "./fields"

const LEVEL_STYLES = [
  "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800/80 dark:bg-sky-950/60 dark:text-sky-300",
  "border-sky-300 bg-sky-100 text-sky-800 dark:border-sky-700/80 dark:bg-sky-900/60 dark:text-sky-200",
  "border-blue-300 bg-blue-100 text-blue-800 dark:border-blue-700/80 dark:bg-blue-900/60 dark:text-blue-200",
  "border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-600 dark:text-white",
  "border-indigo-800 bg-indigo-800 text-white dark:border-indigo-400 dark:bg-indigo-700 dark:text-white",
] as const

export const UNGRADED_LEVEL_CLASS =
  "border-zinc-300 bg-zinc-200/80 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-700/80 dark:text-zinc-200"

export type LevelBadgeInfo =
  | { kind: "adjusted"; label: string }
  | { kind: "ungraded"; label: string }
  | {
      kind: "ranked"
      code: string
      label: string
      description?: string
      rank: number
      total: number
      styleIndex: number
    }
  | { kind: "unlisted"; label: string }

export function levelBadgeInfo(
  rubric: unknown,
  level: string | null | undefined,
  options?: { fallbackLabel?: string | null; adjusted?: boolean },
): LevelBadgeInfo {
  if (options?.adjusted) {
    return { kind: "adjusted", label: i18n.t("profile.levelBadge.adjusted") }
  }
  if (!level) {
    return { kind: "ungraded", label: i18n.t("profile.levelBadge.ungraded") }
  }
  const levels =
    record(rubric) && Array.isArray(rubric.levels)
      ? rubric.levels
          .filter(record)
          .filter((entry) => typeof entry.key === "string")
      : []
  const index = levels.findIndex((entry) => entry.key === level)
  if (index === -1) {
    return {
      kind: "unlisted",
      label: options?.fallbackLabel || level,
    }
  }
  const entry = levels[index]
  const total = levels.length
  const styleIndex =
    total <= 1
      ? 2
      : Math.round((index / (total - 1)) * (LEVEL_STYLES.length - 1))
  const label =
    typeof entry.label === "string" && entry.label
      ? entry.label
      : options?.fallbackLabel || level
  const description =
    typeof entry.description === "string" && entry.description
      ? entry.description
      : undefined
  return {
    kind: "ranked",
    code: `L${index + 1}`,
    label,
    description,
    rank: index + 1,
    total,
    styleIndex,
  }
}

export function LevelBadge({
  rubric,
  level,
  fallbackLabel,
  adjusted = false,
  showDescription = true,
  className,
}: {
  rubric?: unknown
  level?: string | null
  fallbackLabel?: string | null
  adjusted?: boolean
  showDescription?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const info = levelBadgeInfo(rubric, level, { fallbackLabel, adjusted })
  if (info.kind === "adjusted") {
    return (
      <Badge
        variant="outline"
        className={cn(
          "max-w-full whitespace-normal [overflow-wrap:anywhere]",
          className,
        )}
      >
        {info.label}
      </Badge>
    )
  }
  if (info.kind === "ungraded") {
    return (
      <Badge variant="outline" className={cn(UNGRADED_LEVEL_CLASS, className)}>
        {info.label}
      </Badge>
    )
  }
  if (info.kind === "unlisted") {
    return (
      <Badge
        variant="outline"
        className={cn(
          "max-w-full whitespace-normal [overflow-wrap:anywhere]",
          className,
        )}
      >
        {info.label}
      </Badge>
    )
  }
  const title = info.description
    ? t("profile.levelBadge.titleWithDesc", {
        code: info.code,
        label: info.label,
        description: info.description,
      })
    : `${info.code} · ${info.label}`
  return (
    <span
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-1.5",
        className,
      )}
      title={title}
    >
      <Badge
        variant="outline"
        data-level-code={info.code}
        data-level-step={info.styleIndex}
        className={cn(
          "font-semibold tabular-nums",
          LEVEL_STYLES[info.styleIndex],
        )}
      >
        {info.code}
      </Badge>
      {showDescription && (
        <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {info.label}
        </span>
      )}
    </span>
  )
}
