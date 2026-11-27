import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { ReviewDelegationsService } from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { useOrg } from "@/hooks/useOrg"

export function ReviewDelegation() {
  const { org } = useOrg()
  return org ? <Delegations key={org.id} orgId={org.id} /> : null
}

function Delegations({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ["review-delegations", orgId],
    queryFn: async () =>
      (
        await ReviewDelegationsService.delegationsReadDelegations({
          path: { org_id: orgId },
        })
      ).data,
  })
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={query.refetch} />
  const { is_reviewer_role: isReviewerRole, auto_delegates: autoDelegates } =
    query.data
  return (
    <SectionCard
      aria-label={t("settings.delegation.title")}
      className="space-y-3"
    >
      <header className="space-y-1">
        <h2 className="text-sm font-semibold">
          {t("settings.delegation.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("settings.delegation.description")}
        </p>
      </header>
      {!isReviewerRole ? (
        <p className="border-t pt-3 text-sm text-muted-foreground">
          {t("settings.delegation.notReviewer")}
        </p>
      ) : autoDelegates.length === 0 ? (
        <p className="border-t pt-3 text-sm text-muted-foreground">
          {t("settings.delegation.noDelegates")}
        </p>
      ) : (
        <section
          className="divide-y border-t"
          aria-label={t("settings.delegation.listAria")}
        >
          {autoDelegates.map((delegate) => {
            const subtitle = [delegate.department_name, delegate.title]
              .filter(Boolean)
              .join(" · ")
            return (
              <div
                key={delegate.user_id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
              >
                <div className="min-w-0 wrap-anywhere">
                  <p className="font-medium">{delegate.name}</p>
                  {subtitle && (
                    <p className="text-sm text-muted-foreground">{subtitle}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {delegate.relations.map((relation) => (
                    <span
                      key={relation}
                      className="rounded-full border border-surface-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {relation}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </section>
      )}
    </SectionCard>
  )
}
