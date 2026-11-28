import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { ForecastConfigPublic, ForecastPolicyPublic } from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { SetupError } from "@/components/Setup/SetupError"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { policyScopeLabel } from "./ForecastPolicyShared"

export function ForecastPolicyList({
  mode,
  config,
  canCreateInMode,
  hasDraft,
  hasOrgDefaultPolicy,
  isDeletePending,
  deleteError,
  onCreate,
  onConfigOrgDefault,
  onEdit,
  onDelete,
  children,
}: {
  mode: "admin" | "manager"
  config: ForecastConfigPublic
  canCreateInMode: boolean
  hasDraft: boolean
  hasOrgDefaultPolicy: boolean
  isDeletePending: boolean
  deleteError: Error | null
  onCreate: () => void
  onConfigOrgDefault: () => void
  onEdit: (policy: ForecastPolicyPublic) => void
  onDelete: (policyId: string) => void
  children?: ReactNode
}) {
  const { t } = useTranslation()

  return (
    <SectionCard
      aria-label={t("capacity.forecastPolicy.sectionAria")}
      className="space-y-3 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-semibold">
            {t("capacity.forecastPolicy.sectionTitle")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("capacity.forecastPolicy.sectionDesc", {
              cap: config.default_allocation_cap_percent,
            })}
          </p>
        </div>
        {canCreateInMode && !hasDraft && (
          <Button size="sm" variant="outline" onClick={onCreate}>
            {t("capacity.forecastPolicy.addPolicyBtn")}
          </Button>
        )}
      </div>

      <SetupError error={deleteError} />

      <ul
        aria-label={t("capacity.forecastPolicy.policyListAria")}
        className="space-y-2"
      >
        {!hasOrgDefaultPolicy && (
          <li className="rounded-md border border-dashed bg-muted/30 p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-foreground">
                  {t("capacity.forecastPolicy.scopeOrgDefault")}
                </span>
                <Badge variant="secondary">
                  {t("capacity.forecastPolicy.systemDefaultBadge", {
                    rate: config.default_retention_rate,
                  })}
                </Badge>
                {mode === "manager" && (
                  <Badge variant="outline">
                    {t("capacity.forecastPolicy.readonlyInheritedBadge")}
                  </Badge>
                )}
              </div>
              {mode === "admin" && !hasDraft && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onConfigOrgDefault}
                >
                  {t("capacity.forecastPolicy.configOrgDefaultBtn")}
                </Button>
              )}
            </div>
            <p className="mt-1 text-muted-foreground">
              {t("capacity.forecastPolicy.orgDefaultHint", {
                rate: config.default_retention_rate,
                cap: config.default_allocation_cap_percent,
                elastic: 100 - config.default_allocation_cap_percent,
              })}
            </p>
          </li>
        )}

        {config.policies.map((policy) => (
          <li
            key={policy.id}
            className="space-y-1.5 rounded-md border bg-background p-3 text-xs"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="font-medium break-words text-foreground">
                  {policyScopeLabel(policy)}
                </span>
                <Badge variant="secondary">{policy.label}</Badge>
                {!policy.can_edit && (
                  <Badge variant="outline">
                    {t("capacity.forecastPolicy.readonlyInheritedBadge")}
                  </Badge>
                )}
              </div>
              {policy.can_edit && (
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isDeletePending}
                    onClick={() => onEdit(policy)}
                  >
                    {t("capacity.common.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isDeletePending}
                    onClick={() => onDelete(policy.id)}
                  >
                    {t("capacity.common.delete")}
                  </Button>
                </div>
              )}
            </div>
            <p className="text-muted-foreground tabular-nums">
              {t("capacity.forecastPolicy.retentionLine", {
                rate: policy.retention_rate,
              })}
            </p>
            {policy.note && (
              <p className="break-words text-muted-foreground">
                {t("capacity.forecastPolicy.noteLine", {
                  note: policy.note,
                })}
              </p>
            )}
          </li>
        ))}
      </ul>

      {!canCreateInMode && (
        <p className="text-xs text-muted-foreground">
          {t("capacity.forecastPolicy.noManagedDeptHint")}
        </p>
      )}

      {children}
    </SectionCard>
  )
}
