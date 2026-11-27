import { useQuery } from "@tanstack/react-query"
import { LockKeyhole } from "lucide-react"
import { useTranslation } from "react-i18next"
import { type EvidenceDetail, EvidenceService } from "@/client"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { relationLabels } from "./EvidenceList"
import { dateLabel, named, record, text } from "./fields"
import { labels } from "./labels"
import { ProfileError, ProfileLoading } from "./QueryState"
import { StatusBadge } from "./StatusBadge"

function EvidenceContent({ evidence }: { evidence: EvidenceDetail }) {
  const { t } = useTranslation()
  const content = record(evidence.content) ? evidence.content : {}
  if (evidence.redacted)
    return (
      <p className="flex gap-2 rounded-lg border bg-muted/30 p-4 text-sm">
        <LockKeyhole className="size-5 shrink-0" />
        {t("profile.evidence.redactedNotice")}
      </p>
    )
  if (evidence.source === "assignment_feedback")
    return <p className="whitespace-pre-wrap">{text(content.comment)}</p>
  if (evidence.kind === "work_record") {
    const url = evidence.task?.url
    const safeUrl = url && /^https?:\/\//i.test(url) ? url : null
    return (
      <div className="space-y-3">
        <p>
          {safeUrl ? (
            <a
              className="text-primary underline"
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {evidence.source_ref}
            </a>
          ) : (
            evidence.source_ref
          )}
        </p>
        <h3 className="font-medium">{text(content.summary)}</h3>
        <p className="text-sm text-muted-foreground">
          {t("profile.evidence.workRecordMeta", {
            type: named(content.issuetype),
            status: named(content.status),
          })}
        </p>
      </div>
    )
  }
  if (evidence.kind === "self_report")
    return (
      <div className="space-y-3">
        <p className="whitespace-pre-wrap leading-relaxed">
          {text(content.text ?? content.statement)}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("profile.evidence.relatedTasks")}
          {Array.isArray(content.related_task_keys)
            ? content.related_task_keys
                .filter((key: unknown) => typeof key === "string")
                .join("、") || "—"
            : "—"}
        </p>
      </div>
    )
  const answers: Record<string, { label: string }> = labels.review_answer
  return (
    <dl className="space-y-3">
      <div>
        <dt className="text-sm text-muted-foreground">
          {t("profile.evidence.question")}
        </dt>
        <dd>{text(content.question)}</dd>
      </div>
      <div>
        <dt className="text-sm text-muted-foreground">
          {t("profile.evidence.answer")}
        </dt>
        <dd>{answers[text(content.answer)]?.label ?? text(content.answer)}</dd>
      </div>
      <div>
        <dt className="text-sm text-muted-foreground">
          {t("profile.evidence.comment")}
        </dt>
        <dd className="whitespace-pre-wrap">{text(content.comment)}</dd>
      </div>
    </dl>
  )
}

export function EvidenceSheet({
  orgId,
  evidenceId,
  requestId,
  onClose,
}: {
  orgId: string
  evidenceId: string | null
  requestId?: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ["evidence-detail", orgId, evidenceId, requestId ?? null],
    // Review access can expire; discard restricted content when its view closes.
    gcTime: 0,
    queryFn: async () =>
      (
        await EvidenceService.readEvidence({
          path: { org_id: orgId, evidence_id: evidenceId! },
          query: requestId ? { request_id: requestId } : undefined,
        })
      ).data,
    enabled: evidenceId !== null,
  })
  const evidence = query.data
  const statusLabels = {
    active: t("profile.evidence.status.active"),
    retracted: t("profile.evidence.status.retracted"),
    superseded: t("profile.evidence.status.superseded"),
  }
  return (
    <Sheet
      open={evidenceId !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent
        aria-describedby={undefined}
        className="w-full overflow-y-auto sm:max-w-xl"
      >
        <SheetHeader>
          <SheetTitle>
            {evidence?.title ?? t("profile.evidence.sheetTitle")}
          </SheetTitle>
        </SheetHeader>
        <div className="space-y-6 px-6 pb-8">
          {query.isPending ? (
            <ProfileLoading />
          ) : query.isError ? (
            <ProfileError retry={() => query.refetch()} />
          ) : (
            evidence && (
              <>
                <div className="flex items-center gap-3">
                  <StatusBadge kind="evidence_kind" value={evidence.kind} />
                  <span className="text-sm text-muted-foreground">
                    {dateLabel(evidence.occurred_at)} ·{" "}
                    {statusLabels[evidence.status]}
                  </span>
                </div>
                <EvidenceContent evidence={evidence} />
                <section className="space-y-3 border-t pt-5">
                  <h3 className="font-semibold">
                    {t("profile.evidence.sourceInfo")}
                  </h3>
                  <p className="break-words text-sm">
                    {evidence.source} · {evidence.source_ref}
                  </p>
                  <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-4 text-xs">
                    {JSON.stringify(evidence.provenance, null, 2)}
                  </pre>
                </section>
                <section className="space-y-3 border-t pt-5">
                  <h3 className="font-semibold">
                    {t("profile.evidence.relatedClaims")}
                  </h3>
                  {evidence.claims.length ? (
                    <ul className="space-y-2 text-sm">
                      {evidence.claims.map((claim) => (
                        <li key={claim.claim_id}>
                          {claim.capability_name} ·{" "}
                          {relationLabels[claim.relation]}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t("profile.evidence.noClaims")}
                    </p>
                  )}
                </section>
              </>
            )
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
