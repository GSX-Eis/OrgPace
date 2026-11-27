import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { OauthService } from "@/client"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatDate } from "@/i18n/format"
import { handleError } from "@/utils"

export function AuthorizedClients({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [message, setMessage] = useState("")
  const queryKey = ["oauth-grants", orgId]
  const grants = useQuery({
    queryKey,
    queryFn: async () =>
      (await OauthService.readGrants({ query: { org_id: orgId } })).data,
  })
  const revoke = useMutation({
    mutationFn: (id: string) =>
      OauthService.revokeAuthorization({
        query: { org_id: orgId },
        path: { grant_id: id },
      }),
    onSuccess: () => {
      setMessage(t("settings.clients.revokedToast"))
      client.invalidateQueries({ queryKey })
    },
    onError: handleError.bind(setMessage),
  })
  return (
    <section className="divide-y" aria-label={t("settings.clients.title")}>
      <div className="px-4 py-2.5">
        <h3 className="font-medium">{t("settings.clients.title")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("settings.clients.description")}
        </p>
      </div>
      {grants.isPending ? (
        <ProfileLoading />
      ) : grants.isError ? (
        <ProfileError retry={() => grants.refetch()} />
      ) : grants.data.length === 0 ? (
        <p className="px-4 py-2.5 text-muted-foreground">
          {t("settings.clients.empty")}
        </p>
      ) : (
        grants.data.map((grant) => (
          <fieldset
            key={grant.id}
            aria-label={grant.client_name}
            className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 wrap-anywhere font-medium">
                  {grant.client_name}
                </p>
                <Badge
                  variant="outline"
                  className="border-primary/20 bg-primary/5 text-primary"
                >
                  {t("settings.clients.authorizedBadge")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.clients.meta", {
                  createdAt: formatDate(grant.created_at, {
                    dateStyle: "short",
                    timeStyle: "medium",
                  }),
                  lastUsed: grant.last_used_at
                    ? formatDate(grant.last_used_at, {
                        dateStyle: "short",
                        timeStyle: "medium",
                      })
                    : t("settings.ai.neverUsed"),
                })}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(grant.id)}
            >
              {t("settings.clients.revoke")}
            </Button>
          </fieldset>
        ))
      )}
      {message && (
        <p role="status" className="px-4 py-2.5">
          {message}
        </p>
      )}
    </section>
  )
}
