import { useTranslation } from "react-i18next"
import type { FeasibilityCard as FeasibilityMessage } from "@/client"
import { Badge } from "@/components/ui/badge"

export function FeasibilityCard({ card }: { card: FeasibilityMessage }) {
  const { t } = useTranslation()
  const loadLevels = {
    low: [t("bot.feasibility.loadLevels.low"), "stroke-emerald-500"],
    medium: [t("bot.feasibility.loadLevels.medium"), "stroke-blue-500"],
    high: [t("bot.feasibility.loadLevels.high"), "stroke-amber-500"],
    very_high: [t("bot.feasibility.loadLevels.very_high"), "stroke-red-500"],
    unknown: [t("bot.feasibility.loadLevels.unknown"), ""],
    withheld: [t("bot.feasibility.loadLevels.withheld"), ""],
  }
  const conclusions = {
    can_do: [
      t("bot.feasibility.conclusions.can_do"),
      "text-emerald-700 dark:text-emerald-300",
    ],
    later: [
      t("bot.feasibility.conclusions.later"),
      "text-blue-700 dark:text-blue-300",
    ],
    needs_confirmation: [
      t("bot.feasibility.conclusions.needs_confirmation"),
      "text-amber-800 dark:text-amber-300",
    ],
    cannot_do: [
      t("bot.feasibility.conclusions.cannot_do"),
      "text-muted-foreground",
    ],
  }
  const missingDates = {
    can_do: t("bot.feasibility.missingDates.can_do"),
    later: t("bot.feasibility.missingDates.later"),
    needs_confirmation: t("bot.feasibility.missingDates.needs_confirmation"),
    cannot_do: t("bot.feasibility.missingDates.cannot_do"),
  }
  const dataSources: Record<string, string> = {
    confirmed: t("bot.feasibility.dataSources.confirmed"),
    forecast_baseline: t("bot.feasibility.dataSources.forecast_baseline"),
    mixed: t("bot.feasibility.dataSources.mixed"),
  }
  const cap = card.allocation_cap_percent ?? 70
  const capAngle = (cap / 100) * 2 * Math.PI
  const tickX1 = (20.5 * Math.cos(capAngle)).toFixed(2)
  const tickY1 = (20.5 * Math.sin(capAngle)).toFixed(2)
  const tickX2 = (27.5 * Math.cos(capAngle)).toFixed(2)
  const tickY2 = (27.5 * Math.sin(capAngle)).toFixed(2)
  const showFooterNotice = card.departments.some(
    (row) =>
      row.data_source === "forecast_baseline" ||
      row.data_source === "mixed" ||
      ((row.needs_elastic || row.exceeds_regular_cap) &&
        row.load_level !== "withheld"),
  )
  return (
    <section
      aria-label={t("bot.feasibility.ariaLabel", {
        name: card.capability_name,
      })}
      className="min-w-0 space-y-3 rounded-xl border bg-background p-4 [overflow-wrap:anywhere]"
    >
      <header>
        <h3 className="font-semibold">{card.capability_name}</h3>
        <p className="text-xs text-muted-foreground">
          {t("bot.feasibility.windowSummary", {
            start: card.window_start,
            end: card.window_end,
            cap,
            elastic: 100 - cap,
          })}
        </p>
      </header>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-2">
        {card.departments.map((row, index) => {
          const level = row.load_level ?? "unknown"
          const [load, stroke] = loadLevels[level]
          const percent = stroke ? (row.department_load_percent ?? null) : null
          const progress = Math.min(100, Math.max(0, percent ?? 0))
          const isOverloaded = (percent ?? 0) > 100
          const regularSeg = Math.min(progress, cap)
          const elasticSeg = Math.max(0, progress - cap)
          const regularStroke =
            level === "low" ? "stroke-emerald-500" : "stroke-blue-500"
          const elasticStroke =
            (percent ?? 0) >= 90 ? "stroke-orange-600" : "stroke-amber-500"
          const [conclusion, color] = conclusions[row.conclusion]
          const sourceLabel = row.data_source
            ? dataSources[row.data_source]
            : undefined
          const showHeadroom =
            level !== "withheld" &&
            level !== "unknown" &&
            row.regular_headroom_percent != null &&
            row.elastic_headroom_percent != null
          const showSplitUsage =
            showHeadroom &&
            row.regular_used_percent != null &&
            row.elastic_used_percent != null
          return (
            <li
              key={`${row.department_name}-${index}`}
              className="flex min-w-0 items-center gap-3 rounded-lg border bg-muted/25 p-3"
            >
              <div className="relative grid size-14 shrink-0 place-items-center">
                <svg
                  aria-hidden="true"
                  viewBox="-28 -28 56 56"
                  className="absolute inset-0 size-full -rotate-90"
                  fill="none"
                  strokeWidth="4"
                >
                  <circle r="24" className="stroke-muted-foreground/20" />
                  {percent !== null && isOverloaded && (
                    <circle
                      r="24"
                      pathLength="100"
                      strokeDasharray="100 100"
                      className="stroke-red-500"
                    />
                  )}
                  {percent !== null && !isOverloaded && regularSeg > 0 && (
                    <circle
                      r="24"
                      pathLength="100"
                      strokeDasharray={`${regularSeg} 100`}
                      className={regularStroke}
                    />
                  )}
                  {percent !== null && !isOverloaded && elasticSeg > 0 && (
                    <circle
                      r="24"
                      pathLength="100"
                      strokeDasharray={`${elasticSeg} 100`}
                      strokeDashoffset={-cap}
                      className={elasticStroke}
                    />
                  )}
                  {percent !== null && (
                    <line
                      x1={tickX1}
                      y1={tickY1}
                      x2={tickX2}
                      y2={tickY2}
                      strokeWidth="1.5"
                      className="stroke-foreground/70"
                      data-cap={cap}
                    />
                  )}
                </svg>
                <span className="text-sm font-semibold tabular-nums">
                  {percent === null ? "—" : `${percent}%`}
                </span>
              </div>
              <div className="min-w-0 space-y-1">
                <h4 className="font-medium">{row.department_name}</h4>
                <p className="text-xs text-muted-foreground">{load}</p>
                {showSplitUsage ? (
                  <div className="space-y-0.5 text-xs text-muted-foreground tabular-nums">
                    <p>
                      {t("bot.feasibility.regularQuotaSplit", {
                        cap,
                        used: row.regular_used_percent,
                        headroom: row.regular_headroom_percent,
                      })}
                    </p>
                    <p>
                      {t("bot.feasibility.elasticQuotaSplit", {
                        elastic: 100 - cap,
                        used: row.elastic_used_percent,
                        headroom: row.elastic_headroom_percent,
                      })}
                    </p>
                  </div>
                ) : (
                  showHeadroom && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {t("bot.feasibility.headroomSummary", {
                        regular: row.regular_headroom_percent,
                        elastic: row.elastic_headroom_percent,
                      })}
                    </p>
                  )
                )}
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline" className={color}>
                    {conclusion}
                  </Badge>
                  {sourceLabel ? (
                    <Badge variant="secondary">{sourceLabel}</Badge>
                  ) : (
                    row.is_estimated && (
                      <Badge variant="secondary">
                        {t("bot.feasibility.estimatedReference")}
                      </Badge>
                    )
                  )}
                  {row.exceeds_regular_cap && level !== "withheld" && (
                    <Badge
                      variant="outline"
                      className="max-w-full whitespace-normal border-orange-500/50 bg-orange-50 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300"
                    >
                      {t("bot.feasibility.exceedsRegularCap", {
                        percent: row.elastic_used_percent ?? 0,
                      })}
                    </Badge>
                  )}
                  {row.needs_elastic && level !== "withheld" && (
                    <Badge
                      variant="outline"
                      className="max-w-full whitespace-normal border-amber-500/50 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                    >
                      {t("bot.feasibility.needsElastic")}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("bot.feasibility.earliestStart", {
                    start:
                      row.earliest_start_date ?? missingDates[row.conclusion],
                  })}
                </p>
              </div>
            </li>
          )
        })}
      </ul>
      {showFooterNotice && (
        <p className="text-xs text-muted-foreground">
          {t("bot.feasibility.footerNotice")}
        </p>
      )}
    </section>
  )
}
