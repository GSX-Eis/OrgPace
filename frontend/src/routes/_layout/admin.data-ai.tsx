import { createFileRoute, redirect } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { AdminSection } from "@/components/Admin/AdminTabs"
import { BotPage } from "@/components/Admin/pages/BotPage"
import { ImPage } from "@/components/Admin/pages/ImPage"
import { ModelPage } from "@/components/Admin/pages/ModelPage"
import { SourcesPage } from "@/components/Admin/pages/SourcesPage"
import { WorkRecordsPage } from "@/components/Admin/pages/WorkRecordsPage"
import { i18n } from "@/i18n"

const sections = [
  { value: "sources", component: SourcesPage },
  { value: "work-records", component: WorkRecordsPage },
  { value: "model", component: ModelPage },
  { value: "bot", component: BotPage },
  { value: "im", component: ImPage },
]

export const Route = createFileRoute("/_layout/admin/data-ai")({
  component: DataAi,
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: string; sync_run_id?: string; source?: string } => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
    sync_run_id:
      typeof search.sync_run_id === "string" ? search.sync_run_id : undefined,
    source: typeof search.source === "string" ? search.source : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.tab === "mcp") {
      throw redirect({
        to: "/admin/data-ai",
        search: { tab: "sources" },
        replace: true,
      })
    }
  },
  head: () => ({ meta: [{ title: i18n.t("admin.routes.dataAiPageTitle") }] }),
})

function DataAi() {
  const { t } = useTranslation()
  const { tab } = Route.useSearch()
  return (
    <AdminSection
      sections={sections}
      tab={tab}
      deniedMessage={t("admin.common.orgAdminRequired")}
    />
  )
}
