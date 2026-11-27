import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ProfilesService } from "@/client"
import { Button } from "@/components/ui/button"
import { formatDate } from "@/i18n/format"
import { CapabilityList } from "./CapabilityList"
import { ProfileError, ProfileLoading } from "./QueryState"
import { viaLabels } from "./RequestTimeline"

export function VersionHistory({
  orgId,
  employeeId,
  onEvidence,
  onRequest,
}: {
  orgId: string
  employeeId: string
  onEvidence: (id: string) => void
  onRequest: (id: string) => void
}) {
  const { t } = useTranslation()
  const [revision, setRevision] = useState<number | null>(null)
  const path = { org_id: orgId, employee_id: employeeId }
  const versions = useQuery({
    queryKey: ["profile-versions", orgId, employeeId],
    queryFn: async () =>
      (await ProfilesService.readProfileVersions({ path })).data,
  })
  const snapshot = useQuery({
    queryKey: ["profile-version", orgId, employeeId, revision],
    queryFn: async () =>
      (
        await ProfilesService.readProfileVersion({
          path: { ...path, revision: revision! },
        })
      ).data,
    enabled: revision !== null,
  })
  if (versions.isPending) return <ProfileLoading />
  if (versions.isError) return <ProfileError retry={() => versions.refetch()} />
  if (!versions.data.data.length)
    return (
      <p className="py-8 text-muted-foreground">
        {t("profile.versions.empty")}
      </p>
    )
  return (
    <div className="space-y-6">
      <ul className="divide-y rounded-lg border">
        {[...versions.data.data]
          .sort((a, b) => b.revision - a.revision)
          .map((version) => (
            <li key={version.revision}>
              <div className="px-5 pt-4 text-sm text-muted-foreground">
                {version.via && viaLabels[version.via]}
                {version.request_id && (
                  <>
                    {" "}
                    ·{" "}
                    <button
                      type="button"
                      className="text-primary underline"
                      onClick={() => onRequest(version.request_id!)}
                    >
                      {t("profile.versions.sourceRequest")}
                    </button>
                  </>
                )}
              </div>
              <Button
                variant="ghost"
                aria-expanded={revision === version.revision}
                className="h-auto w-full justify-between gap-4 whitespace-normal px-5 py-4 text-left"
                onClick={() =>
                  setRevision(
                    revision === version.revision ? null : version.revision,
                  )
                }
              >
                <span>
                  r{version.revision} ·{" "}
                  {formatDate(version.published_at, {
                    year: "numeric",
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false,
                  })}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t("profile.versions.publishedBy", {
                    name: version.published_by.display_name ?? "—",
                  })}
                </span>
              </Button>
            </li>
          ))}
      </ul>
      {revision !== null && (
        <section
          aria-label={t("profile.versions.snapshotTitle", { revision })}
          className="space-y-4"
        >
          <h2 className="text-lg font-semibold">
            {t("profile.versions.snapshotTitle", { revision })}
          </h2>
          {snapshot.isPending ? (
            <ProfileLoading />
          ) : snapshot.isError ? (
            <ProfileError retry={() => snapshot.refetch()} />
          ) : (
            <CapabilityList
              items={snapshot.data.items}
              onEvidence={onEvidence}
            />
          )}
        </section>
      )}
    </div>
  )
}
