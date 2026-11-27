import { createFileRoute } from "@tanstack/react-router"
import { OrgChart } from "@/components/OrgChart/OrgChart"
import i18n from "@/i18n"

export const Route = createFileRoute("/_layout/org-chart")({
  component: OrgChart,
  head: () => ({ meta: [{ title: i18n.t("people.orgChart.pageTitle") }] }),
})
