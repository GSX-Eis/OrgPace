import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { type AppealPublic, AppealsService } from "@/client"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { useOrg } from "@/hooks/useOrg"

export function useDisputes(orgId?: string, employeeId?: string) {
  return useQuery({
    queryKey: ["disputes", orgId, employeeId],
    enabled: !!orgId,
    queryFn: async () =>
      (
        await AppealsService.listDisputes({
          path: { org_id: orgId! },
          query: { employee_id: employeeId },
        })
      ).data,
  })
}

export function Disputes({
  orgId,
  employeeId,
}: {
  orgId: string
  employeeId?: string
}) {
  const { t } = useTranslation()
  const { employeeId: currentEmployeeId } = useOrg()
  const query = useDisputes(orgId, employeeId)
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-2xl font-semibold">{t("admin.disputes.heading")}</h1>
      <p>{t("admin.disputes.description")}</p>
      <p role="status">
        {t("admin.disputes.pendingCount", { count: query.data.length })}
      </p>
      {query.data.map((appeal) => (
        <Resolve
          key={appeal.id}
          orgId={orgId}
          appeal={appeal}
          isOwn={appeal.employee_id === currentEmployeeId}
        />
      ))}
    </div>
  )
}
function Resolve({
  orgId,
  appeal,
  isOwn,
}: {
  orgId: string
  appeal: AppealPublic
  isOwn: boolean
}) {
  const { t } = useTranslation()
  const [reason, setReason] = useState("")
  const client = useQueryClient()
  const resolve = useMutation({
    mutationFn: (status: "upheld" | "reopened") =>
      AppealsService.resolveAppeal({
        path: { org_id: orgId, appeal_id: appeal.id },
        body: { status, reason },
      }),
    onSuccess: () => client.invalidateQueries(),
  })
  return (
    <section
      aria-label={t("admin.disputes.itemAriaLabel")}
      className="space-y-3 rounded-xl border p-5"
    >
      <Link
        className="text-primary underline"
        to="/employees/$employeeId"
        params={{ employeeId: appeal.employee_id }}
      >
        {t("admin.disputes.viewProfileLink")}
      </Link>
      <p className="whitespace-pre-wrap break-words">
        {t("admin.disputes.appealReason", { reason: appeal.reason })}
      </p>
      <SetupError error={resolve.error} />
      {isOwn && (
        <p id={`self-appeal-${appeal.id}`}>
          {t("admin.disputes.ownAppealNotice")}
        </p>
      )}
      {!isOwn && (
        <>
          <label className="block" htmlFor={`resolution-${appeal.id}`}>
            {t("admin.disputes.resolutionLabel")}
            <textarea
              className="w-full rounded-md border bg-background p-3"
              id={`resolution-${appeal.id}`}
              aria-label={t("admin.disputes.resolutionAriaLabel")}
              maxLength={4000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            {(["upheld", "reopened"] as const).map((status) => (
              <Button
                key={status}
                disabled={!reason.trim() || resolve.isPending}
                onClick={() => resolve.mutate(status)}
              >
                {status === "upheld"
                  ? t("admin.disputes.uphold")
                  : t("admin.disputes.reopen")}
              </Button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
