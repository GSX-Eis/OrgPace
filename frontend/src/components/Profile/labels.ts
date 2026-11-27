import type {
  EvidenceQuality,
  FillStatus,
  InferenceStatus,
  ProgressReviewStatus,
} from "@/client"
import i18n from "@/i18n"

const neutral = "bg-muted text-muted-foreground"
const positive = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
const pending = "bg-amber-500/10 text-amber-700 dark:text-amber-300"
const active =
  "bg-sky-500/10 text-sky-700 dark:text-sky-300 workspace:bg-blue-500/10 workspace:text-blue-700 workspace:dark:text-blue-300"
const negative = "bg-rose-500/10 text-rose-700 dark:text-rose-300"
type Label = { label: string; className: string }

function labelEntry(key: string, className: string): Label {
  return {
    get label() {
      return i18n.t(key)
    },
    className,
  }
}

export const unknownStatus: Label = labelEntry(
  "profile.labels.unknown",
  neutral,
)

export const labels = {
  assessment_status: {
    confirmed: labelEntry(
      "profile.labels.assessment_status.confirmed",
      positive,
    ),
    tentative: labelEntry(
      "profile.labels.assessment_status.tentative",
      pending,
    ),
    unknown: unknownStatus,
    disputed: labelEntry("profile.labels.assessment_status.disputed", negative),
  } satisfies Record<string, Label>,
  fill_status: {
    not_started: labelEntry("profile.labels.fill_status.not_started", neutral),
    in_progress: labelEntry("profile.labels.fill_status.in_progress", active),
    submitted: labelEntry("profile.labels.fill_status.submitted", positive),
  } satisfies Record<FillStatus, Label>,
  inference_status: {
    pending: labelEntry("profile.labels.inference_status.pending", neutral),
    running: labelEntry("profile.labels.inference_status.running", active),
    generated: labelEntry(
      "profile.labels.inference_status.generated",
      positive,
    ),
    failed: labelEntry("profile.labels.inference_status.failed", negative),
  } satisfies Record<InferenceStatus, Label>,
  review_status: {
    none: labelEntry("profile.labels.review_status.none", neutral),
    pending_employee: labelEntry(
      "profile.labels.review_status.pending_employee",
      pending,
    ),
    pending_manager: labelEntry(
      "profile.labels.review_status.pending_manager",
      active,
    ),
    published: labelEntry("profile.labels.review_status.published", positive),
    disputed: labelEntry("profile.labels.review_status.disputed", negative),
  } satisfies Record<ProgressReviewStatus, Label>,
  evidence_quality: {
    sufficient: labelEntry(
      "profile.labels.evidence_quality.sufficient",
      positive,
    ),
    weak: labelEntry("profile.labels.evidence_quality.weak", pending),
    conflicting: labelEntry(
      "profile.labels.evidence_quality.conflicting",
      negative,
    ),
    unknown: unknownStatus,
  } satisfies Record<EvidenceQuality, Label>,
  confidence: {
    low: labelEntry("profile.labels.confidence.low", neutral),
    medium: labelEntry("profile.labels.confidence.medium", pending),
    high: labelEntry("profile.labels.confidence.high", active),
  } satisfies Record<string, Label>,
  review_answer: {
    needs_support: labelEntry(
      "profile.labels.review_answer.needs_support",
      pending,
    ),
    routine: labelEntry("profile.labels.review_answer.routine", active),
    independent_complex: labelEntry(
      "profile.labels.review_answer.independent_complex",
      positive,
    ),
    not_sure: labelEntry("profile.labels.review_answer.not_sure", neutral),
  } satisfies Record<string, Label>,
  evidence_kind: {
    work_record: labelEntry("profile.labels.evidence_kind.work_record", active),
    self_report: labelEntry(
      "profile.labels.evidence_kind.self_report",
      neutral,
    ),
    manager_review: labelEntry(
      "profile.labels.evidence_kind.manager_review",
      pending,
    ),
  } satisfies Record<string, Label>,
}
