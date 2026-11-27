import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { EmployeeRequestsService } from "@/client"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export function ExternalIdentities({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const [skip, setSkip] = useState(0)
  const query = useQuery({
    queryKey: ["my-external-identities", orgId, skip],
    queryFn: async () =>
      (
        await EmployeeRequestsService.readMyExternalIdentities({
          path: { org_id: orgId },
          query: { skip, limit: 50 },
        })
      ).data,
  })
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  return (
    <section aria-label={t("settings.identities.ariaLabel")}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <div>
          <h3 className="text-sm font-medium">
            {t("settings.identities.title")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("settings.identities.description")}
          </p>
        </div>
        {!query.data.count && (
          <p className="ml-auto text-sm text-muted-foreground">
            {t("settings.identities.empty")}
          </p>
        )}
      </div>
      <ul className="divide-y [&:not(:empty)]:border-t">
        {query.data.data.map((identity) => (
          <li
            key={identity.id}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-sm"
          >
            <div className="min-w-0 wrap-anywhere">
              <p className="font-medium">
                {identity.source_label} · {identity.external_id}
              </p>
              {(identity.display_name || identity.email) && (
                <p className="text-xs text-muted-foreground">
                  {identity.display_name} {identity.email}
                </p>
              )}
            </div>
            <Badge
              variant="outline"
              className="ml-auto border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            >
              {t("settings.identities.linkedBadge")}
            </Badge>
          </li>
        ))}
      </ul>
      {(skip > 0 || skip + 50 < query.data.count) && (
        <div className="flex justify-end gap-2 px-4 py-2.5">
          <Button
            variant="outline"
            size="sm"
            disabled={skip === 0}
            onClick={() => setSkip(skip - 50)}
          >
            {t("common.actions.previousPage")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={skip + 50 >= query.data.count}
            onClick={() => setSkip(skip + 50)}
          >
            {t("common.actions.nextPage")}
          </Button>
        </div>
      )}
    </section>
  )
}
