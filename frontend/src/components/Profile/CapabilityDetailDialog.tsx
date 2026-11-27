import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { ChangeRequestPublic, ProfileItem } from "@/client"
import { SideDrawer } from "@/components/Common/WorkbenchPrimitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { AppealItem } from "./AppealItem"
import { EvidenceRows } from "./EvidenceList"
import { dateLabel, record } from "./fields"
import { LevelBadge } from "./LevelBadge"
import { StatusBadge } from "./StatusBadge"

const PENDING_BADGE_CLASS =
  "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"

export function CapabilityDetailDialog({
  item,
  compact,
  directEdit,
  onEdit,
  onEvidence,
  onViewVersions,
  onViewRequest,
  appeals,
}: {
  item: ProfileItem
  compact: boolean
  directEdit: boolean
  onEdit?: (item: ProfileItem, retract?: boolean) => void
  onEvidence: (id: string) => void
  onViewVersions?: () => void
  onViewRequest?: (requestId: string) => void
  appeals?: { orgId: string; requests: ChangeRequestPublic[] }
}) {
  const { t } = useTranslation()
  const sources: Record<string, string> = {
    seed: t("profile.capabilityDetail.sources.seed"),
    agent: t("profile.capabilityDetail.sources.agent"),
    human: t("profile.capabilityDetail.sources.human"),
    user: t("profile.capabilityDetail.sources.user"),
  }
  const [open, setOpen] = useState(false)
  const { capability, claim, status, pending_change, latest_review } = item
  const level = claim?.level
  const rubric = capability.level_rubric
  const levelEntry =
    level && record(rubric) && Array.isArray(rubric.levels)
      ? rubric.levels.find(
          (entry: unknown) => record(entry) && entry.key === level,
        )
      : undefined
  const levelDescription = item.level_adjusted
    ? item.original_level_description
    : record(levelEntry) && typeof levelEntry.description === "string"
      ? levelEntry.description
      : undefined
  const evidence = claim?.evidence ?? []
  const actor = claim?.generated_by.actor_type

  return (
    <SideDrawer
      title={capability.name}
      className="[overflow-wrap:anywhere]"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          className="text-left [overflow-wrap:anywhere] after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          {capability.name}
        </button>
      }
    >
      <div className="flex min-h-full flex-col gap-4 text-sm [overflow-wrap:anywhere]">
        <div className="flex flex-wrap items-center gap-2">
          {claim ? (
            <LevelBadge
              rubric={rubric}
              level={level}
              adjusted={item.level_adjusted}
            />
          ) : (
            pending_change &&
            (pending_change.op === "add" || pending_change.op === "modify") && (
              <LevelBadge rubric={rubric} level={pending_change.level} />
            )
          )}
          {!(status === "confirmed" && claim && !level) && (
            <StatusBadge kind="assessment_status" value={status} />
          )}
          {pending_change && (
            <Badge variant="outline" className={PENDING_BADGE_CLASS}>
              {t("profile.capabilityDetail.pendingReview")}
            </Badge>
          )}
          {capability.category && (
            <Badge variant="outline">{capability.category}</Badge>
          )}
        </div>
        {pending_change && (
          <section
            aria-label={t("profile.capabilityDetail.pendingChangeAria")}
            className="space-y-2 rounded-md border border-amber-500/35 bg-amber-500/5 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={PENDING_BADGE_CLASS}>
                  {t("profile.capabilityDetail.pendingReview")}
                </Badge>
                {(pending_change.op === "add" ||
                  pending_change.op === "modify") && (
                  <LevelBadge rubric={rubric} level={pending_change.level} />
                )}
              </div>
              {onViewRequest && (
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  className="h-auto p-0 text-xs"
                  onClick={() => {
                    setOpen(false)
                    onViewRequest(pending_change.request_id)
                  }}
                >
                  {t("profile.capabilityDetail.viewRequest")}
                </Button>
              )}
            </div>
            <p className="whitespace-pre-wrap leading-relaxed">
              {pending_change.op === "retract"
                ? t("profile.capabilityDetail.pendingRetract")
                : pending_change.op === "attach_evidence"
                  ? t("profile.capabilityDetail.pendingAttach")
                  : pending_change.statement}
            </p>
          </section>
        )}
        {latest_review && (
          <section
            aria-label={t("profile.capabilityDetail.latestReviewAria")}
            className="space-y-2 rounded-md border border-surface-border bg-muted/35 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                >
                  {t("profile.capabilityDetail.rejected")}
                </Badge>
                {latest_review.decided_at && (
                  <span className="text-xs text-muted-foreground">
                    {dateLabel(latest_review.decided_at)}
                  </span>
                )}
              </div>
              {onViewRequest && (
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  className="h-auto p-0 text-xs"
                  onClick={() => {
                    setOpen(false)
                    onViewRequest(latest_review.request_id)
                  }}
                >
                  {t("profile.capabilityDetail.viewRequest")}
                </Button>
              )}
            </div>
            <p className="whitespace-pre-wrap text-xs leading-relaxed">
              {t("profile.capabilityDetail.managerReason", {
                reason:
                  latest_review.reason?.trim() ||
                  t("profile.capabilityDetail.noReason"),
              })}
            </p>
          </section>
        )}
        {(levelDescription || item.level_adjusted) && (
          <div className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">
              {item.level_adjusted
                ? t("profile.capabilityDetail.adjustedLevelDesc")
                : t("profile.capabilityDetail.levelDesc")}
            </h3>
            {levelDescription && <p>{levelDescription}</p>}
          </div>
        )}
        <section className="space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t("profile.capabilityDetail.currentStatement")}
          </h3>
          <p className="whitespace-pre-wrap rounded-md border border-surface-border bg-muted/35 p-3 leading-relaxed">
            {claim?.statement ?? t("profile.capabilityDetail.noStatement")}
          </p>
        </section>
        {claim && (
          <div className="space-y-2 text-xs text-muted-foreground">
            {!compact && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span>{t("profile.capabilityDetail.confidence")}</span>
                  <Tooltip>
                    <TooltipTrigger className="cursor-help rounded focus-visible:outline-ring">
                      <StatusBadge kind="confidence" value={claim.confidence} />
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("profile.capabilityDetail.confidenceTooltip")}
                    </TooltipContent>
                  </Tooltip>
                  {actor && (
                    <span>
                      {t("profile.capabilityDetail.sourcePrefix", {
                        source: sources[actor] ?? actor,
                      })}
                    </span>
                  )}
                </div>
                {claim.explanation?.trim() && (
                  <p className="whitespace-pre-wrap">{claim.explanation}</p>
                )}
              </>
            )}
            {claim.created_at && (
              <p>
                {t("profile.capabilityDetail.updatedAt", {
                  date: dateLabel(claim.created_at),
                })}
              </p>
            )}
          </div>
        )}
        {evidence.length > 0 && (
          <section className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("profile.capabilityDetail.evidenceTitle", {
                count: evidence.length,
              })}
            </h3>
            <div className="rounded-md border border-surface-border">
              <EvidenceRows
                items={evidence.map((ref) => ({ ...ref, id: ref.evidence_id }))}
                onSelect={onEvidence}
              />
            </div>
          </section>
        )}
        {onViewVersions && (
          <Button
            type="button"
            size="sm"
            variant="link"
            className="self-start px-0"
            onClick={() => {
              setOpen(false)
              onViewVersions()
            }}
          >
            {t("profile.capabilityDetail.viewVersions")}
          </Button>
        )}
        {open &&
          appeals?.requests.flatMap((request) =>
            (request.items ?? [])
              .filter(
                (change) =>
                  change.capability.key === capability.key &&
                  (change.decision === "rejected" ||
                    change.decision === "changes_requested") &&
                  !!change.appeal_id,
              )
              .map((change) => (
                <div
                  key={change.id}
                  className="space-y-2 border-t border-surface-border pt-3"
                >
                  <p className="text-xs text-muted-foreground">
                    {t("profile.capabilityDetail.historicalAppeal", {
                      date: dateLabel(request.created_at),
                    })}
                  </p>
                  <AppealItem orgId={appeals.orgId} item={change} />
                </div>
              )),
          )}
        {onEdit && !item.retired && (
          <div className="sticky -bottom-4 -mx-4 mt-auto -mb-4 flex flex-wrap justify-end gap-2 border-t border-surface-border bg-surface px-4 py-3">
            {claim && !directEdit && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onEdit(item, true)
                  setOpen(false)
                }}
              >
                {t("profile.capabilityDetail.retract")}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                onEdit(item)
                setOpen(false)
              }}
            >
              {directEdit
                ? t("profile.capabilityDetail.directEdit")
                : claim
                  ? t("profile.capabilityDetail.edit")
                  : t("profile.capabilityDetail.fill")}
            </Button>
          </div>
        )}
      </div>
    </SideDrawer>
  )
}
