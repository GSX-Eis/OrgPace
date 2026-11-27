import { Building2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { useOrg } from "@/hooks/useOrg"

export function OrgState() {
  const { t } = useTranslation()
  const { isPending, isError, refetch } = useOrg()
  if (isPending) return <p role="status">{t("common.nav.orgState.loading")}</p>
  if (isError)
    return (
      <div role="alert">
        {t("common.nav.orgState.loadFailed")}
        <Button variant="outline" onClick={() => refetch()}>
          {t("common.actions.retry")}
        </Button>
      </div>
    )
  return (
    <div className="flex min-h-80 flex-col items-center justify-center gap-4 rounded-xl border border-dashed bg-muted/20 text-center">
      <Building2 className="size-10 text-muted-foreground" />
      <h1 className="text-xl font-semibold">
        {t("common.nav.orgState.noOrg")}
      </h1>
    </div>
  )
}
