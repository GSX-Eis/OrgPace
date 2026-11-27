import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { isAxiosError } from "axios"
import { ArrowRight } from "lucide-react"
import { type KeyboardEvent, useLayoutEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import {
  type EmployeeAccount,
  type EmployeeSummary,
  ProfilesService,
} from "@/client"
import { SideDrawer } from "@/components/Common/WorkbenchPrimitives"
import { Button } from "@/components/ui/button"
import { LevelBadge } from "./LevelBadge"
import { StatusBadge } from "./StatusBadge"

export function preventRowEnterDefault(event: KeyboardEvent) {
  // The row opens the drawer on keydown. Enter must not also click its focused close button.
  if (event.key === "Enter" && event.target instanceof HTMLTableRowElement)
    event.preventDefault()
}

export function EmployeeQuickPeekDrawer({
  orgId,
  employee,
  onClose,
}: {
  orgId: string
  employee: EmployeeSummary | EmployeeAccount | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const employeeId = employee?.id
  const trigger = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (employeeId && document.activeElement instanceof HTMLElement)
      trigger.current = document.activeElement
  }, [employeeId])
  const profile = useQuery({
    queryKey: ["profile", orgId, employeeId],
    queryFn: async ({ signal }) =>
      (
        await ProfilesService.readProfile({
          path: { org_id: orgId, employee_id: employeeId! },
          signal,
        })
      ).data,
    enabled: !!employeeId,
    retry: false,
  })
  const forbidden =
    isAxiosError(profile.error) &&
    [403, 404].includes(profile.error.response?.status ?? 0)
  const progress = profile.isSuccess
    ? profile.data.employee.progress
    : employee && "progress" in employee
      ? employee.progress
      : undefined
  const claims = profile.isSuccess
    ? profile.data.items.filter((item) => item.claim && !item.retired)
    : []

  return (
    <SideDrawer
      title={t("people.quickPeek.title")}
      open={!!employee}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
          requestAnimationFrame(() => trigger.current?.focus())
        }
      }}
    >
      {employee && (
        <div className="flex min-h-full flex-col gap-4">
          <div className="flex items-center gap-3 border-surface-border border-b pb-4">
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 font-semibold text-primary"
            >
              {Array.from(employee.display_name)[0]}
            </span>
            <div className="min-w-0 wrap-anywhere">
              <h3 className="font-semibold">
                {employee.display_name}{" "}
                <span className="font-normal text-muted-foreground text-xs">
                  {employee.employee_code}
                </span>
              </h3>
              <p className="text-muted-foreground text-sm">
                {[employee.title, employee.department?.name]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </div>
          {progress && (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div className="space-y-1 rounded-md border border-surface-border bg-surface-muted p-2.5">
                <dt className="text-muted-foreground text-xs">
                  {t("people.quickPeek.reviewStatus")}
                </dt>
                <dd>
                  <StatusBadge
                    kind="review_status"
                    value={progress.review_status}
                  />
                </dd>
              </div>
              <div className="space-y-1 rounded-md border border-surface-border bg-surface-muted p-2.5">
                <dt className="text-muted-foreground text-xs">
                  {t("people.quickPeek.fillStatus")}
                </dt>
                <dd>
                  <StatusBadge
                    kind="fill_status"
                    value={progress.fill_status}
                  />
                </dd>
              </div>
            </dl>
          )}
          <section className="space-y-2">
            <h4 className="font-medium text-sm">
              {t("people.quickPeek.coreCapabilities")}
            </h4>
            {profile.isPending ? (
              <p role="status" className="text-muted-foreground text-sm">
                {t("people.quickPeek.loadingProfile")}
              </p>
            ) : profile.isError ? (
              <div
                role="alert"
                className="space-y-2 text-muted-foreground text-sm"
              >
                <p>
                  {forbidden
                    ? t("people.quickPeek.forbidden")
                    : t("people.quickPeek.loadFailed")}
                </p>
                {!forbidden && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => profile.refetch()}
                  >
                    {t("people.quickPeek.retry")}
                  </Button>
                )}
              </div>
            ) : claims.length ? (
              <ul className="space-y-1.5">
                {claims.slice(0, 3).map((item) => {
                  const { capability, claim, status } = item
                  const level = claim?.level
                  const ungraded = status === "confirmed" && !level
                  return (
                    <li
                      key={capability.id}
                      className="flex flex-wrap items-center gap-1.5 text-sm"
                    >
                      <span className="wrap-anywhere">{capability.name}</span>
                      <LevelBadge
                        rubric={capability.level_rubric}
                        level={level}
                        adjusted={item.level_adjusted}
                      />
                      {!ungraded && (
                        <StatusBadge kind="assessment_status" value={status} />
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">
                {t("people.quickPeek.emptyClaims")}
              </p>
            )}
          </section>
          <div className="mt-auto flex justify-end border-surface-border border-t pt-3">
            {!forbidden && (
              <Button size="sm" asChild>
                <Link
                  to="/employees/$employeeId"
                  params={{ employeeId: employee.id }}
                >
                  {t("people.quickPeek.enterFullProfile")}{" "}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            )}
          </div>
        </div>
      )}
    </SideDrawer>
  )
}
