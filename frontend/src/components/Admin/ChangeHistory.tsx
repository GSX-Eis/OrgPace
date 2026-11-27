import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AuditService } from "@/client"
import {
  SectionCard,
  SideDrawer,
} from "@/components/Common/WorkbenchPrimitives"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { useOrg } from "@/hooks/useOrg"
import { formatDate } from "@/i18n/format"
import { cn } from "@/lib/utils"
import { actorLabels, auditLabels } from "./auditLabels"

export function ChangeHistory({
  targetType,
  targetIds,
  employeeId,
  variant = "card",
}: {
  targetType?: string
  targetIds?: string[]
  employeeId?: string
  variant?: "card" | "compact" | "drawer"
}) {
  const { t } = useTranslation()
  const { org, roles } = useOrg()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const canRead = !!org && roles.includes("org_admin")
  const query = useQuery({
    queryKey: ["change-history", org?.id, targetType, targetIds, employeeId],
    enabled: canRead && (variant !== "drawer" || open),
    queryFn: async () =>
      (
        await AuditService.readAuditEvents({
          path: { org_id: org!.id },
          query: {
            target_type: targetType,
            target_id: targetIds,
            employee_id: employeeId,
            limit: 20,
          },
        })
      ).data,
  })
  useEffect(
    () =>
      client.getMutationCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "success")
          client.invalidateQueries({ queryKey: ["change-history", org?.id] })
      }),
    [client, org?.id],
  )
  if (!canRead) return null
  const compact = variant !== "card"
  const history = (
    <>
      <SetupError error={query.error} />
      {query.isError && (
        <Button type="button" variant="outline" onClick={() => query.refetch()}>
          {t("audit.history.retry")}
        </Button>
      )}
      {query.isPending && <p role="status">{t("audit.history.loading")}</p>}
      {query.data?.data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("audit.history.empty")}
        </p>
      )}
      <ol className="divide-y">
        {query.data?.data.map((event) => (
          <li
            key={event.id}
            className={cn(
              "flex flex-wrap items-baseline gap-y-1 text-sm",
              compact ? "gap-x-2 py-2" : "gap-x-4 py-3",
            )}
          >
            <time
              dateTime={event.created_at}
              className="text-xs tabular-nums text-muted-foreground"
            >
              {formatDate(event.created_at, {
                dateStyle: "short",
                timeStyle: "medium",
              })}
            </time>
            <span>
              {event.actor?.full_name ||
                event.actor?.username ||
                actorLabels[event.actor_type] ||
                t("audit.history.unknownActor")}
            </span>
            <span className="font-medium">
              {auditLabels[event.action] ?? t("audit.history.otherAction")}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">
              {event.details.via === "admin_assistant"
                ? t("audit.history.viaAssistant")
                : t("audit.history.viaWeb")}
            </span>
          </li>
        ))}
      </ol>
    </>
  )
  if (variant === "drawer") {
    return (
      <SideDrawer
        title={t("audit.history.drawerTitle")}
        trigger={
          <Button type="button" variant="outline" size="sm">
            {t("audit.history.drawerButton")}
          </Button>
        }
        open={open}
        onOpenChange={setOpen}
      >
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("audit.history.recentLimit")}
          </p>
          {history}
        </div>
      </SideDrawer>
    )
  }
  return (
    <SectionCard
      aria-label={t("audit.history.cardAriaLabel")}
      className={compact ? "space-y-2 p-3" : "space-y-4 rounded-xl p-5"}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={cn("font-semibold", compact ? "text-sm" : "text-lg")}>
          {t("audit.history.cardTitle")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t("audit.history.recentLimit")}
        </p>
      </div>
      {history}
    </SectionCard>
  )
}
