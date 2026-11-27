import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { OrgState } from "@/components/Profile/OrgState"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"

export const Route = createFileRoute("/_layout/find-people")({
  component: FindPeoplePage,
  head: () => ({ meta: [{ title: i18n.t("people.findPeople.pageTitle") }] }),
})

function FindPeoplePage() {
  const { t } = useTranslation()
  const { org, roles } = useOrg()
  if (!org) return <OrgState />
  const isAdmin = roles.includes("org_admin")
  if (!isAdmin && !roles.includes("dept_manager"))
    return <p role="alert">{t("people.findPeople.noPermission")}</p>
  return (
    <Navigate
      to="/assistant"
      search={{ mode: isAdmin ? "admin" : "personal", find: true }}
      replace
    />
  )
}
