import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { ForecastEventPublic } from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { SetupError } from "@/components/Setup/SetupError"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { eventScopeLabel, formatEventModifier } from "./ForecastPolicyShared"
import { formatIsoDateRange, weekLabel } from "./shared"

export function ForecastEventList({
  events,
  canCreateInMode,
  hasDraft,
  isDeletePending,
  deleteError,
  onCreate,
  onEdit,
  onDelete,
  children,
}: {
  events: ForecastEventPublic[]
  canCreateInMode: boolean
  hasDraft: boolean
  isDeletePending: boolean
  deleteError: Error | null
  onCreate: () => void
  onEdit: (item: ForecastEventPublic) => void
  onDelete: (eventId: string) => void
  children?: ReactNode
}) {
  const { t } = useTranslation()

  return (
    <SectionCard
      aria-label={t("capacity.forecastPolicy.eventsAria")}
      className="space-y-3 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-semibold">
            {t("capacity.forecastPolicy.eventsTitle")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("capacity.forecastPolicy.eventsDesc")}
          </p>
        </div>
        {canCreateInMode && !hasDraft && (
          <Button size="sm" variant="outline" onClick={onCreate}>
            {t("capacity.forecastPolicy.addEventBtn")}
          </Button>
        )}
      </div>

      <SetupError error={deleteError} />

      {!events.length ? (
        <p className="text-xs text-muted-foreground">
          {t("capacity.forecastPolicy.noEvents")}
        </p>
      ) : (
        <ul
          aria-label={t("capacity.forecastPolicy.eventsListAria")}
          className="space-y-2"
        >
          {events.map((item) => (
            <li
              key={item.id}
              className="space-y-1.5 rounded-md border bg-background p-3 text-xs"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="font-medium break-words text-foreground">
                    {item.title}
                  </span>
                  <Badge variant="secondary">
                    {formatEventModifier(
                      item.modifier_kind,
                      item.modifier_value,
                    )}
                  </Badge>
                  <Badge variant="outline">{eventScopeLabel(item)}</Badge>
                  {!item.can_edit && (
                    <Badge variant="outline">
                      {t("capacity.forecastPolicy.readonlyBadge")}
                    </Badge>
                  )}
                </div>
                {item.can_edit && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isDeletePending}
                      onClick={() => onEdit(item)}
                    >
                      {t("capacity.common.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isDeletePending}
                      onClick={() => onDelete(item.id)}
                    >
                      {t("capacity.common.delete")}
                    </Button>
                  </div>
                )}
              </div>
              <p className="text-muted-foreground tabular-nums">
                {t("capacity.forecastPolicy.effectiveWeeks", {
                  startWeek: weekLabel(item.start_week),
                  startDate: item.start_week,
                  endWeek: weekLabel(item.end_week),
                  endDate: item.end_week,
                })}
                {item.start_week === item.end_week
                  ? ""
                  : ` (${formatIsoDateRange(item.start_week, item.end_week)})`}
              </p>
              <p className="break-words text-muted-foreground">
                {t("capacity.forecastPolicy.reasonLine", {
                  reason: item.reason,
                })}
              </p>
            </li>
          ))}
        </ul>
      )}

      {children}
    </SectionCard>
  )
}
