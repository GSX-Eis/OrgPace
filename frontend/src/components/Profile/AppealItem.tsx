import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { AppealsService, type ChangeItemPublic } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"

export function AppealItem({
  orgId,
  item,
}: {
  orgId: string
  item: ChangeItemPublic
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ["appeal", orgId, item.appeal_id],
    enabled: !!item.appeal_id,
    queryFn: async () =>
      (
        await AppealsService.readAppeal({
          path: { org_id: orgId, appeal_id: item.appeal_id! },
        })
      ).data,
  })
  if (!item.appeal_id) return null
  return (
    <div className="space-y-1">
      <SetupError error={query.error} />
      {query.data && (
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {t("profile.appeal.prefix")}
          {query.data.status === "open"
            ? t("profile.appeal.open")
            : query.data.status === "upheld"
              ? t("profile.appeal.upheld")
              : t("profile.appeal.resubmitAllowed")}
          {query.data.resolution_note && ` · ${query.data.resolution_note}`}
        </p>
      )}
    </div>
  )
}
