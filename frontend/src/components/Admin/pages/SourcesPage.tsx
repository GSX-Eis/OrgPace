import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ChangeHistory } from "@/components/Admin/ChangeHistory"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { OrgState } from "@/components/Profile/OrgState"
import { SyncRunTable } from "@/components/Progress/SyncRunTable"
import { SourceForms } from "@/components/Sources/SourceForms"
import { Button } from "@/components/ui/button"
import { useOrg } from "@/hooks/useOrg"

export function SourcesPage() {
  const { t } = useTranslation()
  const { org, roles } = useOrg()
  if (!org) return <OrgState />
  if (!roles.includes("org_admin"))
    return <p role="alert">{t("sources.page.orgAdminDenied")}</p>
  return (
    <div className="space-y-4">
      <h1 className="sr-only">{t("sources.page.heading")}</h1>
      <TopbarActions>
        <Button variant="outline" size="sm" asChild>
          <Link to="/admin/data-ai" search={{ tab: "work-records" }}>
            {t("sources.page.viewWorkRecords")}
          </Link>
        </Button>
        <ChangeHistory targetType="source_connection" variant="drawer" />
      </TopbarActions>
      <SourceForms key={org.id} orgId={org.id} />
      <div id="sync-runs">
        <SyncRunTable key={org.id} orgId={org.id} />
      </div>
    </div>
  )
}
