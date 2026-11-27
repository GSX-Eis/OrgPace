import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ExternalIdentitiesService } from "@/client"
import { IdentityTable } from "@/components/Identities/IdentityTable"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

export function UnmatchedIdentities({
  orgId,
  initiallyOpen,
}: {
  orgId: string
  initiallyOpen: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(initiallyOpen)
  const query = useQuery({
    queryKey: ["identities", orgId, "unmatched-count"],
    queryFn: async () =>
      (
        await ExternalIdentitiesService.identitiesGetIdentities({
          path: { org_id: orgId },
          query: { status: "unlinked", source: "jira", limit: 1 },
        })
      ).data.count,
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <SetupError error={query.error} />
      {query.isError ? (
        <Button onClick={() => query.refetch()}>
          {t("sources.identities.unmatched.retry")}
        </Button>
      ) : (
        <DialogTrigger asChild>
          <Button variant="outline" disabled={query.isPending}>
            {t("sources.identities.unmatched.triggerCount", {
              count: query.data ?? "—",
            })}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {t("sources.identities.unmatched.dialogTitle")}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("sources.identities.unmatched.dialogDesc")}
        </p>
        <IdentityTable orgId={orgId} initialSource="jira" />
      </DialogContent>
    </Dialog>
  )
}
