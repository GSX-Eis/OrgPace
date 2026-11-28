import type {
  DepartmentPublic,
  ForecastEventInput,
  ForecastEventPublic,
  ForecastModifierKind,
  ForecastPolicyInput,
  ForecastPolicyPublic,
} from "@/client"
import i18n from "@/i18n"
import { formatNumber } from "@/i18n/format"
import {
  currentMondayIso,
  DAY_MS,
  isMondayIso,
  parseIsoDateUtc,
} from "./dateUtils"

export const ORG_SCOPE_VALUE = "__org__"

export const RECOMMENDED_RETENTION_RATES = [
  {
    value: "0",
    rate: 0,
    labelKey: "capacity.forecastPolicy.rates.pulseLabel",
    hintKey: "capacity.forecastPolicy.rates.pulseHint",
  },
  {
    value: "0.5",
    rate: 0.5,
    labelKey: "capacity.forecastPolicy.rates.balancedLabel",
    hintKey: "capacity.forecastPolicy.rates.balancedHint",
  },
  {
    value: "0.8",
    rate: 0.8,
    labelKey: "capacity.forecastPolicy.rates.projectLabel",
    hintKey: "capacity.forecastPolicy.rates.projectHint",
  },
] as const

export type PolicyDraft = {
  departmentValue: string
  jobFamily: string
  retentionRate: string
  note: string
}

export type PolicyFormMode =
  | { kind: "create" }
  | { kind: "orgDefault" }
  | { kind: "edit"; scope: string }

export type EventDraft = {
  editingId: string | null
  title: string
  departmentValue: string
  jobFamily: string
  startWeek: string
  endWeek: string
  modifierKind: ForecastModifierKind
  modifierValue: string
  reason: string
}

function round5(value: number): number {
  return Math.min(200, Math.max(0, Math.floor((value + 2.5) / 5) * 5))
}

export function formatRetentionPreview(rawValue: string): string {
  const trimmed = rawValue.trim()
  const rate = Number(trimmed)
  if (!trimmed || !Number.isFinite(rate) || rate < 0 || rate > 1) {
    return i18n.t("capacity.forecastPolicy.previewInvalid")
  }
  if (rate === 0) {
    return i18n.t("capacity.forecastPolicy.previewZero")
  }
  const w1 = round5(80 * rate)
  const w4 = round5(80 * rate ** 4)
  const w8 = round5(80 * rate ** 8)
  return i18n.t("capacity.forecastPolicy.previewDecay", { w1, w4, w8 })
}

export function formatEventModifier(
  kind: ForecastModifierKind,
  value: number,
): string {
  if (kind === "multiplier") return `×${formatNumber(value)}`
  return value >= 0 ? `+${value}%` : `${value}%`
}

export function policyScopeLabel(policy: ForecastPolicyPublic): string {
  if (!policy.department_id && !policy.job_family)
    return i18n.t("capacity.forecastPolicy.scopeOrgDefault")
  if (!policy.department_id && policy.job_family) {
    return i18n.t("capacity.forecastPolicy.scopeOrgJobFamily", {
      jobFamily: policy.job_family,
    })
  }
  const dept =
    policy.department_name ??
    i18n.t("capacity.forecastPolicy.scopeDeptFallback")
  return policy.job_family ? `${dept} · ${policy.job_family}` : dept
}

export function eventScopeLabel(event: ForecastEventPublic): string {
  const dept =
    event.department_name ?? i18n.t("capacity.forecastPolicy.scopeAllOrg")
  return event.job_family ? `${dept} · ${event.job_family}` : dept
}

export function defaultPolicyDraft(
  mode: "admin" | "manager",
  editableDepartments: DepartmentPublic[],
  defaultRetentionRate: number,
): PolicyDraft {
  return {
    departmentValue:
      mode === "admin" ? ORG_SCOPE_VALUE : (editableDepartments[0]?.id ?? ""),
    jobFamily: "",
    retentionRate: String(defaultRetentionRate),
    note: "",
  }
}

export function policyToDraft(policy: ForecastPolicyPublic): PolicyDraft {
  return {
    departmentValue: policy.department_id ?? ORG_SCOPE_VALUE,
    jobFamily: policy.job_family ?? "",
    retentionRate: String(policy.retention_rate),
    note: policy.note ?? "",
  }
}

export function defaultEventDraft(
  mode: "admin" | "manager",
  editableDepartments: DepartmentPublic[],
): EventDraft {
  const monday = currentMondayIso()
  return {
    editingId: null,
    title: "",
    departmentValue:
      mode === "admin" ? ORG_SCOPE_VALUE : (editableDepartments[0]?.id ?? ""),
    jobFamily: "",
    startWeek: monday,
    endWeek: monday,
    modifierKind: "multiplier",
    modifierValue: "",
    reason: "",
  }
}

export function eventToDraft(event: ForecastEventPublic): EventDraft {
  return {
    editingId: event.id,
    title: event.title,
    departmentValue: event.department_id ?? ORG_SCOPE_VALUE,
    jobFamily: event.job_family ?? "",
    startWeek: event.start_week,
    endWeek: event.end_week,
    modifierKind: event.modifier_kind,
    modifierValue: String(event.modifier_value),
    reason: event.reason,
  }
}

export function validatePolicyDraft(
  draft: PolicyDraft,
  mode: "admin" | "manager",
): { error: string } | { body: ForecastPolicyInput } {
  const departmentId =
    draft.departmentValue === ORG_SCOPE_VALUE
      ? null
      : draft.departmentValue || null
  if (mode === "manager" && !departmentId) {
    return { error: i18n.t("capacity.forecastPolicy.valSelectDept") }
  }
  const jobFamily = draft.jobFamily.trim() || null
  if (jobFamily && jobFamily.length > 50) {
    return { error: i18n.t("capacity.forecastPolicy.valJobFamilyLen") }
  }
  const retentionRate = Number(draft.retentionRate)
  if (
    draft.retentionRate.trim() === "" ||
    !Number.isFinite(retentionRate) ||
    retentionRate < 0 ||
    retentionRate > 1
  ) {
    return { error: i18n.t("capacity.forecastPolicy.valRetentionRange") }
  }
  const note = draft.note.trim() || null
  if (note && note.length > 200) {
    return { error: i18n.t("capacity.forecastPolicy.valNoteLen") }
  }
  return {
    body: {
      department_id: departmentId,
      job_family: jobFamily,
      retention_rate: retentionRate,
      note,
    },
  }
}

export function validateEventDraft(
  draft: EventDraft,
  mode: "admin" | "manager",
): { error: string } | { body: ForecastEventInput } {
  const departmentId =
    draft.departmentValue === ORG_SCOPE_VALUE
      ? null
      : draft.departmentValue || null
  if (mode === "manager" && !departmentId) {
    return { error: i18n.t("capacity.forecastPolicy.valSelectDept") }
  }
  const title = draft.title.trim()
  if (!title || title.length > 100) {
    return { error: i18n.t("capacity.forecastPolicy.valTitleLen") }
  }
  const jobFamily = draft.jobFamily.trim() || null
  if (jobFamily && jobFamily.length > 50) {
    return { error: i18n.t("capacity.forecastPolicy.valJobFamilyLen") }
  }
  if (!isMondayIso(draft.startWeek) || !isMondayIso(draft.endWeek)) {
    return { error: i18n.t("capacity.forecastPolicy.valMonday") }
  }
  const startDate = parseIsoDateUtc(draft.startWeek)
  const endDate = parseIsoDateUtc(draft.endWeek)
  const diffDays =
    startDate && endDate
      ? (endDate.getTime() - startDate.getTime()) / DAY_MS
      : -1
  if (diffDays < 0 || diffDays > 25 * 7) {
    return { error: i18n.t("capacity.forecastPolicy.valWeekRange") }
  }
  const modifierValue = Number(draft.modifierValue)
  if (draft.modifierValue.trim() === "" || !Number.isFinite(modifierValue)) {
    return { error: i18n.t("capacity.forecastPolicy.valModifierRequired") }
  }
  if (
    draft.modifierKind === "multiplier" &&
    (modifierValue < 0 || modifierValue > 2)
  ) {
    return { error: i18n.t("capacity.forecastPolicy.valMultiplierRange") }
  }
  if (
    draft.modifierKind === "delta" &&
    (modifierValue < -100 || modifierValue > 100)
  ) {
    return { error: i18n.t("capacity.forecastPolicy.valDeltaRange") }
  }
  const reason = draft.reason.trim()
  if (!reason || reason.length > 300) {
    return { error: i18n.t("capacity.forecastPolicy.valReasonLen") }
  }
  return {
    body: {
      department_id: departmentId,
      job_family: jobFamily,
      title,
      start_week: draft.startWeek,
      end_week: draft.endWeek,
      modifier_kind: draft.modifierKind,
      modifier_value: modifierValue,
      reason,
    },
  }
}
