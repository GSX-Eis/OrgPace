import type {
  ChangeItemPublic,
  ChangeRequestPublic,
  ClaimEvidencePublic,
  ItemInput,
  ProfileItem,
} from "@/client"
import i18n from "@/i18n"

export function activeEvidence(evidence: ClaimEvidencePublic[] = []) {
  return evidence.filter((e) => (e.status ?? "active") === "active")
}

export function requestItemInput(item: ChangeItemPublic): ItemInput {
  return {
    op: item.op,
    capability_key: item.capability.key,
    statement:
      item.after?.statement ??
      (item.op === "attach_evidence"
        ? i18n.t("profile.request.attachEvidenceFallback")
        : i18n.t("profile.request.retractFallback")),
    level: item.after?.level,
    owner_statement: item.owner_statement,
    objection: item.objection,
    uncertainty: item.uncertainty,
    evidence_ids: (item.evidence ?? []).map((e) => e.evidence_id),
  }
}

export function cloneWithdrawnItems(
  request: ChangeRequestPublic,
  profileItems: ProfileItem[],
): ItemInput[] {
  return (request.items ?? []).flatMap((item) => {
    if (item.decision === "approved") return []
    const profileEntry = profileItems.find(
      (entry) => entry.capability.key === item.capability.key,
    )
    if (profileEntry?.retired) return []
    const hasClaim = !!profileEntry?.claim
    const updatesClaim = item.op === "add" || item.op === "modify"
    if (!updatesClaim && !hasClaim) return []
    return [
      {
        ...requestItemInput(item),
        op: updatesClaim ? (hasClaim ? "modify" : "add") : item.op,
        evidence_ids: [
          ...new Set(
            activeEvidence(item.evidence)
              .filter((e) => e.kind !== "manager_review")
              .map((e) => e.evidence_id),
          ),
        ],
      },
    ]
  })
}
