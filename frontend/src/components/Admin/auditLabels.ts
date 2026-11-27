import type { AuditEventPublic } from "@/client"
import { i18n } from "@/i18n"
import { localeRecord } from "./labels"

export const auditLabels: Record<string, string> = localeRecord(
  {
    "capacity.unavailability_registered": "",
    "capacity.unavailability_deleted": "",
    "capacity.demand_submitted": "",
    "capacity.extension_requested": "",
    "capacity.extension_approved": "",
    "capacity.extension_returned": "",
    "capacity.assignment_created": "",
    "capacity.assignment_updated": "",
    "capacity.commitment_changed": "",
    "capacity.demand_replied": "",
    "capacity.demand_accepted": "",
    "capacity.demand_follow_up": "",
    "capacity.demand_withdrawn": "",
    "capacity.settings_updated": "",
    "capacity.forecast_overridden": "",
    "capacity.forecast_reset": "",
    "capacity.forecast_policy_saved": "",
    "capacity.forecast_policy_deleted": "",
    "capacity.forecast_event_saved": "",
    "capacity.forecast_event_deleted": "",
    "capacity.workload_adjusted": "",
    "capacity.workload_confirmed_from_forecast": "",
    "capacity.workload_carried_over": "",
    "capacity.workload_carry_over_reverted": "",
    "capacity.workload_requested": "",
    "capacity.workload_request_approved": "",
    "capacity.workload_request_returned": "",
    "department.renamed": "",
    "department.moved": "",
    "department.deleted": "",
    "profile.direct_edited": "",
    "profile.exported": "",
    "appeal.open": "",
    "appeal.upheld": "",
    "appeal.reopened": "",
    "oauth.allowed": "",
    "oauth.denied": "",
    "oauth.revoked": "",
    "mcp.tool_called": "",
    "question.answered": "",
    "access_token.created": "",
    "access_token.revoked": "",
    "mcp_setting.updated": "",
    "approval_policy.saved": "",
    "review_delegation.created": "",
    "review_delegation.revoked": "",
    "change_request.policy_published": "",
    "change_request.no_approval_published": "",
    "initial_profiles.handed_over": "",
    "initial_profiles.queued": "",
    "initial_profiles.drafted": "",
    "incremental_profiles.drafted": "",
    "change_request.dictionary_changed": "",
    "profile_import.created": "",
    "change_request.submitted": "",
    "change_request.decided": "",
    "change_request.withdrawn": "",
    "sync_run.succeeded": "",
    "sync_run.queued": "",
    "sync_run.failed": "",
    "source.jira_updated": "",
    "external_identity.linked": "",
    "external_identity.unlinked": "",
    "model_setting.updated": "",
    "model_setting.chatgpt_connected": "",
    "model_setting.chatgpt_disconnected": "",
    "evidence.superseded": "",
    "evidence.retracted": "",
    "account.issued": "",
    "employee.account_linked": "",
    "account.password_reset": "",
    "account.disabled": "",
    "account.enabled": "",
    "role.granted": "",
    "role.revoked": "",
    "setup.initialized": "",
    "setup.step_completed": "",
    "setup.step_skipped": "",
    "department.capabilities_updated": "",
    "department.capabilities_generated": "",
    "org.renamed": "",
    "org.timezone_updated": "",
    "org.employee_fields_updated": "",
    "capability_schema.activated": "",
    "capability_proposal.open": "",
    "capability_proposal.suggested": "",
    "capability_proposal.accepted": "",
    "capability_proposal.dismissed": "",
    "seed.loaded": "",
    "update_settings.updated": "",
    "drafting_settings.updated": "",
    "drafting_note.updated": "",
    "bot_settings.updated": "",
    "im_settings.updated": "",
    "im_binding.code_created": "",
    "im_binding.bound": "",
    "im_binding.unbound": "",
    "employee.auto_draft_changed": "",
    "account.email_changed": "",
    "roster.imported": "",
  },
  "audit.actions",
  (key) => key.replace(/\./g, "_"),
)
export const actorLabels: Record<string, string> = localeRecord(
  {
    system_worker: "",
    agent: "",
    seed: "",
    cli: "",
  },
  "audit.actors",
)
export const targetLabels: Record<string, string> = localeRecord(
  {
    capacity_unavailability: "",
    capacity_setting: "",
    capacity_week_forecast: "",
    capacity_forecast_policy: "",
    capacity_forecast_event: "",
    capacity_demand: "",
    capacity_assignment: "",
    capacity_extension_request: "",
    capacity_workload_request: "",
    capacity_carry_over: "",
    department: "",
    review_delegation: "",
    review_appeal: "",
    approval_policy: "",
    im_binding: "",
    oauth_client: "",
    oauth_grant: "",
    mcp_tool: "",
    pending_question: "",
    personal_access_token: "",
    mcp_setting: "",
    sync_run: "",
    profile_change_request: "",
    source_connection: "",
    external_identity: "",
    model_setting: "",
    evidence: "",
    employee: "",
    update_setting: "",
    drafting_setting: "",
    drafting_note: "",
    bot_setting: "",
    im_setting: "",
    user: "",
    role_grant: "",
    organization: "",
    capability_proposal: "",
    capability_schema_version: "",
    setup_step: "",
    roster_import: "",
  },
  "audit.targets",
)
const stepLabels: Record<string, string> = localeRecord(
  {
    org_profile: "",
    roster: "",
    capabilities: "",
    accounts: "",
    model: "",
    approval_policy: "",
    initial_profiles: "",
  },
  "audit.steps",
)
const countLabels: Record<string, string> = localeRecord(
  {
    added: "",
    updated: "",
    transferred: "",
    manager_changed: "",
    deactivated: "",
    reactivated: "",
  },
  "audit.counts",
)
export function auditSummary({ action, details: d }: AuditEventPublic): string {
  if (action === "org.renamed")
    return i18n.t("audit.summary.orgRenamed", {
      oldName: String(d.old_name ?? ""),
      newName: String(d.new_name ?? ""),
    })
  if (action === "capability_schema.activated")
    return i18n.t("audit.summary.capabilitySchemaActivated", {
      count: d.capability_count,
    })
  if (action === "setup.step_completed" || action === "setup.step_skipped")
    return i18n.t("audit.summary.setupStep", {
      step: stepLabels[String(d.step_key)] ?? d.step_key,
    })
  if (action === "roster.imported")
    return Object.entries(countLabels)
      .filter(([key]) => typeof d[key] === "number" && d[key] > 0)
      .map(([key, label]) =>
        i18n.t("audit.summary.rosterItem", { label, count: d[key] }),
      )
      .join(i18n.t("audit.summary.rosterJoin"))
  if (
    action === "change_request.no_approval_published" &&
    d.policy_version != null
  )
    return i18n.t("audit.summary.noApprovalPublished", {
      version: d.policy_version,
    })
  if (action === "account.password_reset" && d.source === "cli")
    return i18n.t("audit.summary.passwordResetCli")
  return ""
}

export function localMidnight(
  date: string,
  nextDay = false,
): string | undefined {
  if (!date) return undefined
  const value = new Date(`${date}T00:00:00`)
  if (nextDay) value.setDate(value.getDate() + 1)
  return value.toISOString()
}
