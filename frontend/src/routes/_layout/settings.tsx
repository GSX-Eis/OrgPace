import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Appearance } from "@/components/Common/Appearance"
import {
  SectionCard,
  WorkspacePage,
} from "@/components/Common/WorkbenchPrimitives"
import { AutoDraftSetting } from "@/components/Profile/AutoDraftSetting"
import ChangePassword from "@/components/UserSettings/ChangePassword"
import { ExternalIdentities } from "@/components/UserSettings/ExternalIdentities"
import { ImBindings } from "@/components/UserSettings/ImBindings"
import { ReviewDelegation } from "@/components/UserSettings/ReviewDelegation"
import UserInformation from "@/components/UserSettings/UserInformation"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import useAuth from "@/hooks/useAuth"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"

export const Route = createFileRoute("/_layout/settings")({
  component: UserSettings,
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    section?: "account" | "integrations" | "preferences"
  } => ({
    section:
      search.section === "account" ||
      search.section === "integrations" ||
      search.section === "preferences"
        ? search.section
        : undefined,
  }),
  head: () => ({ meta: [{ title: i18n.t("settings.pageTitle") }] }),
})

function UserSettings() {
  const { t } = useTranslation()
  const { user: currentUser } = useAuth()
  const { org, employeeId } = useOrg()
  const { section = "account" } = Route.useSearch()

  if (!currentUser) return null

  return (
    <WorkspacePage variant="form" className="space-y-4" key={org?.id}>
      {section === "account" && (
        <>
          <h1 className="sr-only">{t("settings.sections.account")}</h1>
          <UserInformation />
          <PasswordSetting />
          <SectionCard
            aria-label={t("settings.appearance.title")}
            className="flex items-center justify-between gap-3"
          >
            <div>
              <h2 className="text-sm font-semibold">
                {t("settings.appearance.title")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("settings.appearance.description")}
              </p>
            </div>
            <Appearance />
          </SectionCard>
        </>
      )}
      {section === "integrations" && (
        <>
          <h1 className="sr-only">{t("settings.sections.integrations")}</h1>
          <SectionCard className="divide-y overflow-hidden p-0">
            <h2 className="bg-muted/40 px-4 py-2.5 text-sm font-semibold">
              {t("settings.sections.integrationsHeading")}
            </h2>
            <ImBindings />
            {org && employeeId && <ExternalIdentities orgId={org.id} />}
          </SectionCard>
        </>
      )}
      {section === "preferences" && (
        <>
          <h1 className="sr-only">{t("settings.sections.preferences")}</h1>
          {org && employeeId && <AutoDraftSetting orgId={org.id} />}
          <ReviewDelegation />
        </>
      )}
    </WorkspacePage>
  )
}

function PasswordSetting() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <SectionCard className="flex items-center justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold">
          {t("settings.password.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("settings.password.description")}
        </p>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            {t("settings.password.button")}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settings.password.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.password.dialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <ChangePassword onSuccess={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </SectionCard>
  )
}
