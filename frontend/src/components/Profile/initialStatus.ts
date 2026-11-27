import type { InitialProfileStatus } from "@/client"
import i18n from "@/i18n"

const initialStatusLabelKeys: Record<InitialProfileStatus, string> = {
  waiting_source: "profile.initialStatus.labels.waiting_source",
  no_records: "profile.initialStatus.labels.no_records",
  waiting_draft: "profile.initialStatus.labels.waiting_draft",
  drafting: "profile.initialStatus.labels.drafting",
  pending_owner: "profile.initialStatus.labels.pending_owner",
  no_judgment: "profile.initialStatus.labels.no_judgment",
  failed: "profile.initialStatus.labels.failed",
  owner_reviewed: "profile.initialStatus.labels.owner_reviewed",
  direct_edited: "profile.initialStatus.labels.direct_edited",
}

export function initialStatusLabel(status: InitialProfileStatus | undefined) {
  return status
    ? i18n.t(initialStatusLabelKeys[status])
    : i18n.t("profile.initialStatus.unknown")
}

export function initialStatusReason(
  status: InitialProfileStatus | undefined,
  owner: boolean,
) {
  switch (status) {
    case undefined:
      return i18n.t("profile.initialStatus.reason.undefined")
    case "waiting_source":
      return i18n.t("profile.initialStatus.reason.waiting_source")
    case "no_records":
      return i18n.t(
        owner
          ? "profile.initialStatus.reason.no_records_owner"
          : "profile.initialStatus.reason.no_records_other",
      )
    case "waiting_draft":
      return i18n.t(
        owner
          ? "profile.initialStatus.reason.waiting_draft_owner"
          : "profile.initialStatus.reason.waiting_draft_other",
      )
    case "drafting":
      return i18n.t(
        owner
          ? "profile.initialStatus.reason.drafting_owner"
          : "profile.initialStatus.reason.drafting_other",
      )
    case "pending_owner":
      return i18n.t(
        owner
          ? "profile.initialStatus.reason.pending_owner_owner"
          : "profile.initialStatus.reason.pending_owner_other",
      )
    case "no_judgment":
      return i18n.t("profile.initialStatus.reason.no_judgment")
    case "failed":
      return i18n.t("profile.initialStatus.reason.failed")
    case "owner_reviewed":
      return i18n.t(
        owner
          ? "profile.initialStatus.reason.owner_reviewed_owner"
          : "profile.initialStatus.reason.owner_reviewed_other",
      )
    case "direct_edited":
      return i18n.t(
        owner
          ? "profile.initialStatus.reason.direct_edited_owner"
          : "profile.initialStatus.reason.direct_edited_other",
      )
  }
}
