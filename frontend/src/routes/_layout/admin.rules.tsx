import { createFileRoute, redirect } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { AdminSection, tabSearch } from "@/components/Admin/AdminTabs"
import { ApprovalPolicy } from "@/components/Admin/ApprovalPolicy"
import { UpdateSettings } from "@/components/Admin/UpdateSettings"
import { CapacitySettings } from "@/components/Capacity/CapacitySettings"
import { CapabilityDictionary } from "@/components/Setup/CapabilityDictionary"
import { useOrg } from "@/hooks/useOrg"
import { i18n } from "@/i18n"

function Approval() {
  const { org } = useOrg()
  return org && <ApprovalPolicy key={org.id} orgId={org.id} />
}

function Reminders() {
  const { org } = useOrg()
  return org && <UpdateSettings key={org.id} orgId={org.id} />
}

export const Route = createFileRoute("/_layout/admin/rules")({
  component: Rules,
  validateSearch: tabSearch,
  beforeLoad: ({ search }) => {
    if (search.tab === "profile-import")
      throw redirect({ to: "/admin/assistant", replace: true })
    if (search.tab === "drafting")
      throw redirect({
        to: "/admin/data-ai",
        search: { tab: "model" },
        replace: true,
      })
  },
  head: () => ({ meta: [{ title: i18n.t("admin.routes.rulesPageTitle") }] }),
})

function Rules() {
  const { t } = useTranslation()
  const { roles } = useOrg()
  const { tab } = Route.useSearch()
  const sections = [
    {
      value: "dictionary",
      title: t("admin.routes.rulesTabs.dictionary"),
      component: CapabilityDictionary,
    },
    {
      value: "approval",
      title: t("admin.routes.rulesTabs.approval"),
      component: Approval,
    },
    {
      value: "reminders",
      title: t("admin.routes.rulesTabs.reminders"),
      component: Reminders,
    },
    {
      value: "capacity",
      title: t("admin.routes.rulesTabs.capacity"),
      component: CapacitySettings,
    },
  ]
  return (
    <AdminSection
      sections={roles.includes("org_admin") ? sections : sections.slice(0, 1)}
      tab={tab}
    />
  )
}
