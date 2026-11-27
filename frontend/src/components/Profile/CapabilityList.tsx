import { Link } from "@tanstack/react-router"
import type { TFunction } from "i18next"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { ChangeRequestPublic, ProfileItem } from "@/client"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CapabilityDetailDialog } from "./CapabilityDetailDialog"
import { CapabilityPicker } from "./CapabilityPicker"
import { dateLabel } from "./fields"
import { LevelBadge } from "./LevelBadge"
import { labels } from "./labels"
import { StatusBadge } from "./StatusBadge"

const PENDING_BADGE_CLASS =
  "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"

function pendingStatement(
  pending: NonNullable<ProfileItem["pending_change"]>,
  t: TFunction,
): string {
  if (pending.op === "retract")
    return t("profile.capabilityList.pendingRetract")
  if (pending.op === "attach_evidence")
    return t("profile.capabilityList.pendingAttach")
  return pending.statement ?? ""
}

function assessmentLabel(item: ProfileItem) {
  return item.status === "confirmed" && item.claim && !item.claim.level
    ? "ungraded"
    : item.status
}

export function CapabilityList({
  items,
  onEvidence,
  onViewVersions,
  onViewRequest,
  pendingCapabilityIds,
  onEdit,
  departmentConfigured,
  canConfigureDepartment,
  compact = false,
  directEdit = false,
  appeals,
}: {
  directEdit?: boolean
  compact?: boolean
  items: ProfileItem[]
  onEvidence: (id: string) => void
  onViewVersions?: () => void
  onViewRequest?: (requestId: string) => void
  pendingCapabilityIds?: Set<string>
  onEdit?: (item: ProfileItem, retract?: boolean) => void
  departmentConfigured?: boolean
  canConfigureDepartment?: boolean
  appeals?: { orgId: string; requests: ChangeRequestPublic[] }
}) {
  const { t } = useTranslation()
  const filters = [
    ["all", t("profile.capabilityList.all")],
    ...Object.entries(labels.assessment_status).map(([status, { label }]) => [
      status,
      label,
    ]),
    ["ungraded", t("profile.capabilityList.ungraded")],
  ]
  const [added, setAdded] = useState(new Set<string>())
  const [picking, setPicking] = useState(false)
  const [filter, setFilter] = useState("all")
  const rejectedCapabilityKeys = new Set(
    appeals?.requests.flatMap((request) =>
      (request.items ?? [])
        .filter((item) => item.decision === "rejected")
        .map((item) => item.capability.key),
    ),
  )
  // Historical snapshots omit departmentConfigured and keep every frozen item.
  const visible = items.filter(
    (item) =>
      departmentConfigured === undefined ||
      (departmentConfigured && item.in_department) ||
      item.status !== "unknown" ||
      !!item.pending_change ||
      !!item.latest_review ||
      pendingCapabilityIds?.has(item.capability.id) ||
      rejectedCapabilityKeys.has(item.capability.key) ||
      added.has(item.capability.id),
  )
  const available = items.filter((item) => !item.retired)
  const counts = new Map<string, number>()
  const groups = new Map<string, ProfileItem[]>()
  for (const item of visible) {
    const status = assessmentLabel(item)
    counts.set(status, (counts.get(status) ?? 0) + 1)
    const ungraded = item.claim && !item.claim.level
    if (ungraded && status !== "ungraded")
      counts.set("ungraded", (counts.get("ungraded") ?? 0) + 1)
    if (
      filter !== "all" &&
      filter !== status &&
      !(filter === "ungraded" && ungraded)
    )
      continue
    const category = item.retired
      ? t("profile.capabilityList.retiredCategory")
      : (item.capability.category ?? t("profile.capabilityList.otherCategory"))
    groups.set(category, [...(groups.get(category) ?? []), item])
  }
  return (
    <div className="space-y-3">
      {onEdit && (
        <TopbarActions>
          <Button size="sm" onClick={() => setPicking(true)}>
            {t("profile.capabilityList.addCapability")}
          </Button>
        </TopbarActions>
      )}
      {departmentConfigured === false && (
        <p className="text-xs text-muted-foreground">
          {t("profile.capabilityList.deptNotConfigured")}
          {canConfigureDepartment && (
            <Link to="/org-chart" className="ml-2 text-primary underline">
              {t("profile.capabilityList.goToOrgChart")}
            </Link>
          )}
        </p>
      )}
      <section
        className="flex flex-wrap gap-1.5"
        aria-label={t("profile.capabilityList.statsAria")}
      >
        {filters.map(([status, label]) => (
          <Button
            key={status}
            size="sm"
            variant="outline"
            aria-pressed={filter === status}
            className="h-7 gap-1 rounded-full border-surface-border bg-surface px-2.5 text-xs text-muted-foreground shadow-none aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary"
            onClick={() => setFilter(status)}
          >
            {label}{" "}
            <span className="tabular-nums">
              {status === "all" ? visible.length : (counts.get(status) ?? 0)}
            </span>
          </Button>
        ))}
      </section>
      {groups.size === 0 && (
        <p className="rounded-lg border border-surface-border bg-surface p-4 text-sm text-muted-foreground">
          {filter === "all"
            ? t("profile.capabilityList.emptyAll")
            : t("profile.capabilityList.emptyFiltered")}
        </p>
      )}
      {Array.from(groups, ([category, entries]) => (
        <section key={category} className="space-y-2">
          <h2 className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            {category}
            <span className="rounded-full bg-muted px-1.5 tabular-nums">
              {entries.length}
            </span>
          </h2>
          <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {entries.map((item) => {
              const { capability, claim, pending_change, latest_review } = item
              const evidenceCount = claim?.evidence?.length ?? 0
              return (
                <article
                  key={capability.id}
                  aria-label={capability.name}
                  className="relative flex min-w-0 flex-col gap-2 rounded-lg border border-surface-border bg-surface p-3 transition-colors hover:border-primary/45"
                >
                  <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
                    <h3 className="min-w-0 font-semibold text-sm">
                      <CapabilityDetailDialog
                        item={item}
                        compact={compact}
                        directEdit={directEdit}
                        onEdit={onEdit}
                        onEvidence={onEvidence}
                        onViewVersions={onViewVersions}
                        onViewRequest={onViewRequest}
                        appeals={appeals}
                      />
                    </h3>
                    {claim
                      ? (claim.level ||
                          assessmentLabel(item) !== "ungraded") && (
                          <LevelBadge
                            rubric={capability.level_rubric}
                            level={claim.level}
                            adjusted={item.level_adjusted}
                          />
                        )
                      : pending_change &&
                        (pending_change.op === "add" ||
                          pending_change.op === "modify") && (
                          <LevelBadge
                            rubric={capability.level_rubric}
                            level={pending_change.level}
                          />
                        )}
                  </div>
                  {claim ? (
                    <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                      {claim.statement}
                    </p>
                  ) : pending_change ? (
                    <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                      {pendingStatement(pending_change, t)}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t("profile.capabilityList.noRecordHint")}
                    </p>
                  )}
                  {claim && pending_change && (
                    <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant="outline"
                          className={PENDING_BADGE_CLASS}
                        >
                          {t("profile.capabilityList.pendingReview")}
                        </Badge>
                        {(pending_change.op === "add" ||
                          pending_change.op === "modify") && (
                          <LevelBadge
                            rubric={capability.level_rubric}
                            level={pending_change.level}
                          />
                        )}
                      </div>
                      <p className="line-clamp-2 text-foreground/90 [overflow-wrap:anywhere]">
                        {pendingStatement(pending_change, t)}
                      </p>
                    </div>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-surface-border pt-2 text-xs text-muted-foreground">
                    {assessmentLabel(item) === "ungraded" ? (
                      <LevelBadge
                        rubric={capability.level_rubric}
                        level={null}
                      />
                    ) : claim || !pending_change ? (
                      <StatusBadge
                        kind="assessment_status"
                        value={item.status}
                      />
                    ) : (
                      <Badge variant="outline" className={PENDING_BADGE_CLASS}>
                        {t("profile.capabilityList.pendingReview")}
                      </Badge>
                    )}
                    {pending_change && onViewRequest && (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="relative z-10 h-auto p-0 text-xs"
                        onClick={() => onViewRequest(pending_change.request_id)}
                      >
                        {t("profile.capabilityList.viewRequest")}
                      </Button>
                    )}
                    {departmentConfigured !== undefined &&
                      !item.in_department &&
                      item.status !== "unknown" && (
                        <Badge variant="outline">
                          {t("profile.capabilityList.otherBadge")}
                        </Badge>
                      )}
                    {!compact && item.evidence_stale && (
                      <Badge variant="outline">
                        {t("profile.capabilityList.staleEvidence")}
                      </Badge>
                    )}
                    {!pending_change && latest_review && (
                      <Badge
                        variant="outline"
                        className="border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                      >
                        {t("profile.capabilityList.rejected")}
                      </Badge>
                    )}
                    {!pending_change &&
                      pendingCapabilityIds?.has(capability.id) && (
                        <span>{t("profile.capabilityList.pendingUpdate")}</span>
                      )}
                    {(evidenceCount > 0 || claim?.created_at) && (
                      <span className="ml-auto tabular-nums">
                        {evidenceCount > 0 &&
                          t("profile.capabilityList.evidenceCount", {
                            count: evidenceCount,
                          })}
                        {evidenceCount > 0 && claim?.created_at && " · "}
                        {claim?.created_at && dateLabel(claim.created_at)}
                      </span>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      ))}
      {picking && onEdit && (
        <CapabilityPicker
          capabilities={available.map((item) => ({
            ...item.capability,
            profileStatus: visible.includes(item)
              ? item.status === "unknown" && !item.claim
                ? "unfilled"
                : "recorded"
              : undefined,
          }))}
          onClose={() => setPicking(false)}
          onSelect={(key) => {
            const item = available.find((item) => item.capability.key === key)!
            setAdded((old) => new Set([...old, item.capability.id]))
            setPicking(false)
            setFilter("all")
            onEdit(item)
          }}
        />
      )}
    </div>
  )
}
