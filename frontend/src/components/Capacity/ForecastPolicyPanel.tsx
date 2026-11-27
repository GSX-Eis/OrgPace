import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapacityService,
  type DepartmentPublic,
  type ForecastEventInput,
  type ForecastEventPublic,
  type ForecastModifierKind,
  type ForecastPolicyInput,
  type ForecastPolicyPublic,
  OrgsService,
} from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"
import { formatNumber } from "@/i18n/format"
import { cn } from "@/lib/utils"
import { formatIsoDateRange, weekLabel } from "./shared"

const ORG_SCOPE_VALUE = "__org__"

const RECOMMENDED_RETENTION_RATES = [
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

type PolicyDraft = {
  departmentValue: string
  jobFamily: string
  retentionRate: string
  note: string
}

type PolicyFormMode =
  | { kind: "create" }
  | { kind: "orgDefault" }
  | { kind: "edit"; scope: string }

function round5(value: number): number {
  return Math.min(200, Math.max(0, Math.floor((value + 2.5) / 5) * 5))
}

function formatRetentionPreview(rawValue: string): string {
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

type EventDraft = {
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

function currentMondayIso(): string {
  const now = new Date()
  const day = now.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + diff,
  )
  const y = monday.getFullYear()
  const m = String(monday.getMonth() + 1).padStart(2, "0")
  const d = String(monday.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function isMondayIso(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const parsed = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.getUTCDay() === 1
}

function formatEventModifier(
  kind: ForecastModifierKind,
  value: number,
): string {
  if (kind === "multiplier") return `×${formatNumber(value)}`
  return value >= 0 ? `+${value}%` : `${value}%`
}

function policyScopeLabel(policy: ForecastPolicyPublic): string {
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

function eventScopeLabel(event: ForecastEventPublic): string {
  const dept =
    event.department_name ?? i18n.t("capacity.forecastPolicy.scopeAllOrg")
  return event.job_family ? `${dept} · ${event.job_family}` : dept
}

function defaultPolicyDraft(
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

function policyToDraft(policy: ForecastPolicyPublic): PolicyDraft {
  return {
    departmentValue: policy.department_id ?? ORG_SCOPE_VALUE,
    jobFamily: policy.job_family ?? "",
    retentionRate: String(policy.retention_rate),
    note: policy.note ?? "",
  }
}

function defaultEventDraft(
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

function eventToDraft(event: ForecastEventPublic): EventDraft {
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

export function ForecastPolicyPanel({
  orgId,
  mode,
}: {
  orgId: string
  mode: "admin" | "manager"
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const { managedDepartmentIds } = useOrg()
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft | null>(null)
  const [policyFormMode, setPolicyFormMode] = useState<PolicyFormMode>({
    kind: "create",
  })
  const [policyValidationError, setPolicyValidationError] = useState<
    string | null
  >(null)
  const [eventDraft, setEventDraft] = useState<EventDraft | null>(null)
  const [eventValidationError, setEventValidationError] = useState<
    string | null
  >(null)

  const configQuery = useQuery({
    queryKey: ["capacity", orgId, "forecast-policies"],
    queryFn: async () =>
      (
        await CapacityService.listCapacityForecastPolicies({
          path: { org_id: orgId },
        })
      ).data,
  })
  const eventsQuery = useQuery({
    queryKey: ["capacity", orgId, "forecast-events"],
    queryFn: async () =>
      (
        await CapacityService.listCapacityForecastEvents({
          path: { org_id: orgId },
          query: { include_past: false },
        })
      ).data,
  })
  const departmentsQuery = useQuery({
    queryKey: ["org-departments", orgId],
    queryFn: async () =>
      (await OrgsService.readDepartments({ path: { org_id: orgId } })).data
        .data,
  })

  const refreshCapacityData = async (message: string) => {
    setStatusMessage(message)
    await Promise.all([
      client.invalidateQueries({ queryKey: ["capacity", orgId] }),
      client.invalidateQueries({
        queryKey: ["capacity", orgId, "forecast-policies"],
      }),
      client.invalidateQueries({
        queryKey: ["capacity", orgId, "forecast-events"],
      }),
    ])
  }

  const upsertPolicy = useMutation({
    mutationFn: (body: ForecastPolicyInput) =>
      CapacityService.upsertCapacityForecastPolicy({
        path: { org_id: orgId },
        body,
      }),
    onSuccess: async (res) => {
      setPolicyDraft(null)
      setPolicyValidationError(null)
      await refreshCapacityData(
        t("capacity.forecastPolicy.savedPolicyStatus", {
          count: res.data.updated_rows,
        }),
      )
    },
  })

  const deletePolicy = useMutation({
    mutationFn: (policyId: string) =>
      CapacityService.deleteCapacityForecastPolicy({
        path: { org_id: orgId, policy_id: policyId },
      }),
    onSuccess: async (res) => {
      await refreshCapacityData(
        t("capacity.forecastPolicy.deletedPolicyStatus", {
          count: res.data.updated_rows,
        }),
      )
    },
  })

  const saveEvent = useMutation({
    mutationFn: ({
      editingId,
      body,
    }: {
      editingId: string | null
      body: ForecastEventInput
    }) =>
      editingId
        ? CapacityService.updateCapacityForecastEvent({
            path: { org_id: orgId, event_id: editingId },
            body,
          })
        : CapacityService.createCapacityForecastEvent({
            path: { org_id: orgId },
            body,
          }),
    onSuccess: async (res) => {
      setEventDraft(null)
      setEventValidationError(null)
      await refreshCapacityData(
        t("capacity.forecastPolicy.savedEventStatus", {
          count: res.data.updated_rows,
        }),
      )
    },
  })

  const deleteEvent = useMutation({
    mutationFn: (eventId: string) =>
      CapacityService.deleteCapacityForecastEvent({
        path: { org_id: orgId, event_id: eventId },
      }),
    onSuccess: async (res) => {
      await refreshCapacityData(
        t("capacity.forecastPolicy.deletedEventStatus", {
          count: res.data.updated_rows,
        }),
      )
    },
  })

  if (
    configQuery.isPending ||
    eventsQuery.isPending ||
    departmentsQuery.isPending
  ) {
    return (
      <section
        aria-busy="true"
        aria-label={t("capacity.forecastPolicy.loadingAria")}
        className="space-y-4 py-6"
      >
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </section>
    )
  }
  if (configQuery.isError) {
    return <ProfileError retry={() => configQuery.refetch()} />
  }
  if (eventsQuery.isError) {
    return <ProfileError retry={() => eventsQuery.refetch()} />
  }
  if (departmentsQuery.isError) {
    return <ProfileError retry={() => departmentsQuery.refetch()} />
  }

  const config = configQuery.data
  const events = eventsQuery.data.data
  const allDepartments = departmentsQuery.data
  const editableDepartments =
    mode === "admin"
      ? allDepartments
      : allDepartments.filter((dept) => managedDepartmentIds.includes(dept.id))
  const canCreateInMode = mode === "admin" || editableDepartments.length > 0
  const hasOrgDefaultPolicy = config.policies.some(
    (policy) => policy.department_id === null && policy.job_family === null,
  )

  const policyFormTitle =
    policyFormMode.kind === "orgDefault"
      ? t("capacity.forecastPolicy.configOrgDefaultTitle")
      : policyFormMode.kind === "edit"
        ? t("capacity.forecastPolicy.editPolicyTitle", {
            scope: policyFormMode.scope,
          })
        : t("capacity.forecastPolicy.addPolicyBtn")

  const submitPolicy = (event: React.FormEvent) => {
    event.preventDefault()
    if (!policyDraft) return
    setPolicyValidationError(null)
    upsertPolicy.reset()

    const departmentId =
      policyDraft.departmentValue === ORG_SCOPE_VALUE
        ? null
        : policyDraft.departmentValue || null
    if (mode === "manager" && !departmentId) {
      setPolicyValidationError(t("capacity.forecastPolicy.valSelectDept"))
      return
    }
    const jobFamily = policyDraft.jobFamily.trim() || null
    if (jobFamily && jobFamily.length > 50) {
      setPolicyValidationError(t("capacity.forecastPolicy.valJobFamilyLen"))
      return
    }
    const retentionRate = Number(policyDraft.retentionRate)
    if (
      policyDraft.retentionRate.trim() === "" ||
      !Number.isFinite(retentionRate) ||
      retentionRate < 0 ||
      retentionRate > 1
    ) {
      setPolicyValidationError(t("capacity.forecastPolicy.valRetentionRange"))
      return
    }
    const note = policyDraft.note.trim() || null
    if (note && note.length > 200) {
      setPolicyValidationError(t("capacity.forecastPolicy.valNoteLen"))
      return
    }

    upsertPolicy.mutate({
      department_id: departmentId,
      job_family: jobFamily,
      retention_rate: retentionRate,
      note,
    })
  }

  const submitEvent = (event: React.FormEvent) => {
    event.preventDefault()
    if (!eventDraft) return
    setEventValidationError(null)
    saveEvent.reset()

    const departmentId =
      eventDraft.departmentValue === ORG_SCOPE_VALUE
        ? null
        : eventDraft.departmentValue || null
    if (mode === "manager" && !departmentId) {
      setEventValidationError(t("capacity.forecastPolicy.valSelectDept"))
      return
    }
    const title = eventDraft.title.trim()
    if (!title || title.length > 100) {
      setEventValidationError(t("capacity.forecastPolicy.valTitleLen"))
      return
    }
    const jobFamily = eventDraft.jobFamily.trim() || null
    if (jobFamily && jobFamily.length > 50) {
      setEventValidationError(t("capacity.forecastPolicy.valJobFamilyLen"))
      return
    }
    if (
      !isMondayIso(eventDraft.startWeek) ||
      !isMondayIso(eventDraft.endWeek)
    ) {
      setEventValidationError(t("capacity.forecastPolicy.valMonday"))
      return
    }
    const diffDays =
      (Date.parse(`${eventDraft.endWeek}T00:00:00Z`) -
        Date.parse(`${eventDraft.startWeek}T00:00:00Z`)) /
      86_400_000
    if (diffDays < 0 || diffDays > 25 * 7) {
      setEventValidationError(t("capacity.forecastPolicy.valWeekRange"))
      return
    }
    const modifierValue = Number(eventDraft.modifierValue)
    if (
      eventDraft.modifierValue.trim() === "" ||
      !Number.isFinite(modifierValue)
    ) {
      setEventValidationError(t("capacity.forecastPolicy.valModifierRequired"))
      return
    }
    if (
      eventDraft.modifierKind === "multiplier" &&
      (modifierValue < 0 || modifierValue > 2)
    ) {
      setEventValidationError(t("capacity.forecastPolicy.valMultiplierRange"))
      return
    }
    if (
      eventDraft.modifierKind === "delta" &&
      (modifierValue < -100 || modifierValue > 100)
    ) {
      setEventValidationError(t("capacity.forecastPolicy.valDeltaRange"))
      return
    }
    const reason = eventDraft.reason.trim()
    if (!reason || reason.length > 300) {
      setEventValidationError(t("capacity.forecastPolicy.valReasonLen"))
      return
    }

    saveEvent.mutate({
      editingId: eventDraft.editingId,
      body: {
        department_id: departmentId,
        job_family: jobFamily,
        title,
        start_week: eventDraft.startWeek,
        end_week: eventDraft.endWeek,
        modifier_kind: eventDraft.modifierKind,
        modifier_value: modifierValue,
        reason,
      },
    })
  }

  const parsedRetention = policyDraft
    ? Number(policyDraft.retentionRate.trim())
    : Number.NaN
  const activeHintKey =
    policyDraft &&
    policyDraft.retentionRate.trim() !== "" &&
    Number.isFinite(parsedRetention)
      ? RECOMMENDED_RETENTION_RATES.find(
          (item) => item.rate === parsedRetention,
        )?.hintKey
      : undefined

  return (
    <div className="@container min-w-0 space-y-4">
      {statusMessage && (
        <p
          role="status"
          className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-200"
        >
          {statusMessage}
        </p>
      )}

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
          {canCreateInMode && !policyDraft && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                upsertPolicy.reset()
                setPolicyValidationError(null)
                setPolicyFormMode({ kind: "create" })
                setPolicyDraft(
                  defaultPolicyDraft(
                    mode,
                    editableDepartments,
                    config.default_retention_rate,
                  ),
                )
              }}
            >
              {t("capacity.forecastPolicy.addPolicyBtn")}
            </Button>
          )}
        </div>

        <SetupError error={deletePolicy.error} />

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
                {mode === "admin" && !policyDraft && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      upsertPolicy.reset()
                      setPolicyValidationError(null)
                      setPolicyFormMode({ kind: "orgDefault" })
                      setPolicyDraft(
                        defaultPolicyDraft(
                          "admin",
                          editableDepartments,
                          config.default_retention_rate,
                        ),
                      )
                    }}
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
                      disabled={deletePolicy.isPending}
                      onClick={() => {
                        upsertPolicy.reset()
                        setPolicyValidationError(null)
                        setPolicyFormMode({
                          kind: "edit",
                          scope: policyScopeLabel(policy),
                        })
                        setPolicyDraft(policyToDraft(policy))
                      }}
                    >
                      {t("capacity.common.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={deletePolicy.isPending}
                      onClick={() => {
                        deletePolicy.reset()
                        deletePolicy.mutate(policy.id)
                      }}
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

        {policyDraft && (
          <form
            aria-label={policyFormTitle}
            className="space-y-3 rounded-md border bg-muted/20 p-3"
            onSubmit={submitPolicy}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{policyFormTitle}</h3>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={upsertPolicy.isPending}
                onClick={() => {
                  setPolicyDraft(null)
                  setPolicyValidationError(null)
                }}
              >
                {t("capacity.common.cancel")}
              </Button>
            </div>

            <fieldset
              disabled={upsertPolicy.isPending}
              className="min-w-0 space-y-3"
            >
              <div className="grid gap-3 @sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="policy-department">
                    {t("capacity.forecastPolicy.deptLabel")}
                  </Label>
                  <Select
                    value={policyDraft.departmentValue}
                    onValueChange={(value) =>
                      setPolicyDraft((prev) =>
                        prev ? { ...prev, departmentValue: value } : prev,
                      )
                    }
                  >
                    <SelectTrigger id="policy-department" className="w-full">
                      <SelectValue
                        placeholder={t(
                          "capacity.forecastPolicy.deptPlaceholder",
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {mode === "admin" && (
                        <SelectItem value={ORG_SCOPE_VALUE}>
                          {t("capacity.forecastPolicy.scopeOrgDefault")}
                        </SelectItem>
                      )}
                      {editableDepartments.map((dept) => (
                        <SelectItem key={dept.id} value={dept.id}>
                          {dept.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="policy-job-family">
                    {t("capacity.forecastPolicy.jobFamilyLabel")}
                  </Label>
                  <Input
                    id="policy-job-family"
                    list="policy-job-family-options"
                    maxLength={50}
                    placeholder={t(
                      "capacity.forecastPolicy.jobFamilyPlaceholder",
                    )}
                    value={policyDraft.jobFamily}
                    onChange={(e) =>
                      setPolicyDraft((prev) =>
                        prev ? { ...prev, jobFamily: e.target.value } : prev,
                      )
                    }
                  />
                  <datalist id="policy-job-family-options">
                    {config.job_families.map((jf) => (
                      <option key={jf} value={jf} />
                    ))}
                  </datalist>
                  {config.job_families.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      <button
                        type="button"
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[11px]",
                          !policyDraft.jobFamily.trim()
                            ? "border-primary bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-muted",
                        )}
                        onClick={() =>
                          setPolicyDraft((prev) =>
                            prev ? { ...prev, jobFamily: "" } : prev,
                          )
                        }
                      >
                        {t("capacity.forecastPolicy.unlimitedJobFamily")}
                      </button>
                      {config.job_families.map((jf) => (
                        <button
                          key={jf}
                          type="button"
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[11px]",
                            policyDraft.jobFamily.trim() === jf
                              ? "border-primary bg-primary/10 text-primary"
                              : "text-muted-foreground hover:bg-muted",
                          )}
                          onClick={() =>
                            setPolicyDraft((prev) =>
                              prev ? { ...prev, jobFamily: jf } : prev,
                            )
                          }
                        >
                          {jf}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium">
                  {t("capacity.forecastPolicy.recommendedLabel")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {RECOMMENDED_RETENTION_RATES.map((item) => {
                    const selected =
                      policyDraft.retentionRate.trim() !== "" &&
                      parsedRetention === item.rate
                    return (
                      <Button
                        key={item.value}
                        type="button"
                        size="sm"
                        variant={selected ? "default" : "outline"}
                        aria-pressed={selected}
                        onClick={() => {
                          setPolicyValidationError(null)
                          setPolicyDraft((prev) =>
                            prev
                              ? { ...prev, retentionRate: item.value }
                              : prev,
                          )
                        }}
                      >
                        {t(item.labelKey)}
                      </Button>
                    )
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  {activeHintKey
                    ? t(activeHintKey)
                    : t("capacity.forecastPolicy.recommendedFallbackHint")}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="policy-retention-rate">
                  {t("capacity.forecastPolicy.retentionRateLabel")}
                </Label>
                <Input
                  id="policy-retention-rate"
                  type="number"
                  min={0}
                  max={1}
                  step="0.05"
                  required
                  value={policyDraft.retentionRate}
                  onChange={(e) =>
                    setPolicyDraft((prev) =>
                      prev ? { ...prev, retentionRate: e.target.value } : prev,
                    )
                  }
                />
                <p className="text-[11px] text-muted-foreground">
                  {t("capacity.forecastPolicy.retentionRateHint")}
                </p>
                <output
                  aria-label={t("capacity.forecastPolicy.previewAria")}
                  className="block rounded-md border border-dashed bg-background px-2.5 py-1.5 text-xs text-muted-foreground tabular-nums"
                >
                  {formatRetentionPreview(policyDraft.retentionRate)}
                </output>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="policy-note">
                  {t("capacity.forecastPolicy.policyNoteLabel")}
                </Label>
                <Input
                  id="policy-note"
                  maxLength={200}
                  placeholder={t(
                    "capacity.forecastPolicy.policyNotePlaceholder",
                  )}
                  value={policyDraft.note}
                  onChange={(e) =>
                    setPolicyDraft((prev) =>
                      prev ? { ...prev, note: e.target.value } : prev,
                    )
                  }
                />
              </div>

              {policyValidationError && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
                >
                  {policyValidationError}
                </p>
              )}
              <SetupError error={upsertPolicy.error} />

              <div className="flex flex-wrap gap-2">
                <Button size="sm" type="submit">
                  {upsertPolicy.isPending
                    ? t("capacity.common.saving")
                    : t("capacity.forecastPolicy.savePolicyBtn")}
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setPolicyDraft(null)
                    setPolicyValidationError(null)
                  }}
                >
                  {t("capacity.common.cancel")}
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </SectionCard>

      <SectionCard
        aria-label={t("capacity.forecastPolicy.eventsAria")}
        className="space-y-3 p-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-sm font-semibold">
              {t("capacity.forecastPolicy.eventsTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("capacity.forecastPolicy.eventsDesc")}
            </p>
          </div>
          {canCreateInMode && !eventDraft && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                saveEvent.reset()
                setEventValidationError(null)
                setEventDraft(defaultEventDraft(mode, editableDepartments))
              }}
            >
              {t("capacity.forecastPolicy.addEventBtn")}
            </Button>
          )}
        </div>

        <SetupError error={deleteEvent.error} />

        {!events.length ? (
          <p className="text-xs text-muted-foreground">
            {t("capacity.forecastPolicy.noEvents")}
          </p>
        ) : (
          <ul
            aria-label={t("capacity.forecastPolicy.eventsListAria")}
            className="space-y-2"
          >
            {events.map((item) => (
              <li
                key={item.id}
                className="space-y-1.5 rounded-md border bg-background p-3 text-xs"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="font-medium break-words text-foreground">
                      {item.title}
                    </span>
                    <Badge variant="secondary">
                      {formatEventModifier(
                        item.modifier_kind,
                        item.modifier_value,
                      )}
                    </Badge>
                    <Badge variant="outline">{eventScopeLabel(item)}</Badge>
                    {!item.can_edit && (
                      <Badge variant="outline">
                        {t("capacity.forecastPolicy.readonlyBadge")}
                      </Badge>
                    )}
                  </div>
                  {item.can_edit && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={deleteEvent.isPending}
                        onClick={() => {
                          saveEvent.reset()
                          setEventValidationError(null)
                          setEventDraft(eventToDraft(item))
                        }}
                      >
                        {t("capacity.common.edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={deleteEvent.isPending}
                        onClick={() => {
                          deleteEvent.reset()
                          deleteEvent.mutate(item.id)
                        }}
                      >
                        {t("capacity.common.delete")}
                      </Button>
                    </div>
                  )}
                </div>
                <p className="text-muted-foreground tabular-nums">
                  {t("capacity.forecastPolicy.effectiveWeeks", {
                    startWeek: weekLabel(item.start_week),
                    startDate: item.start_week,
                    endWeek: weekLabel(item.end_week),
                    endDate: item.end_week,
                  })}
                  {item.start_week === item.end_week
                    ? ""
                    : ` (${formatIsoDateRange(item.start_week, item.end_week)})`}
                </p>
                <p className="break-words text-muted-foreground">
                  {t("capacity.forecastPolicy.reasonLine", {
                    reason: item.reason,
                  })}
                </p>
              </li>
            ))}
          </ul>
        )}

        {eventDraft && (
          <form
            aria-label={
              eventDraft.editingId
                ? t("capacity.forecastPolicy.editEventTitle")
                : t("capacity.forecastPolicy.addEventBtn")
            }
            className="space-y-3 rounded-md border bg-muted/20 p-3"
            onSubmit={submitEvent}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">
                {eventDraft.editingId
                  ? t("capacity.forecastPolicy.editEventTitle")
                  : t("capacity.forecastPolicy.addEventBtn")}
              </h3>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saveEvent.isPending}
                onClick={() => {
                  setEventDraft(null)
                  setEventValidationError(null)
                }}
              >
                {t("capacity.common.cancel")}
              </Button>
            </div>

            <fieldset
              disabled={saveEvent.isPending}
              className="min-w-0 space-y-3"
            >
              <div className="space-y-1.5">
                <Label htmlFor="event-title">
                  {t("capacity.forecastPolicy.eventTitleLabel")}
                </Label>
                <Input
                  id="event-title"
                  maxLength={100}
                  required
                  placeholder={t(
                    "capacity.forecastPolicy.eventTitlePlaceholder",
                  )}
                  value={eventDraft.title}
                  onChange={(e) =>
                    setEventDraft((prev) =>
                      prev ? { ...prev, title: e.target.value } : prev,
                    )
                  }
                />
              </div>

              <div className="grid gap-3 @sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="event-department">
                    {t("capacity.forecastPolicy.deptLabel")}
                  </Label>
                  <Select
                    value={eventDraft.departmentValue}
                    onValueChange={(value) =>
                      setEventDraft((prev) =>
                        prev ? { ...prev, departmentValue: value } : prev,
                      )
                    }
                  >
                    <SelectTrigger id="event-department" className="w-full">
                      <SelectValue
                        placeholder={t(
                          "capacity.forecastPolicy.deptPlaceholder",
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {mode === "admin" && (
                        <SelectItem value={ORG_SCOPE_VALUE}>
                          {t("capacity.forecastPolicy.scopeAllOrg")}
                        </SelectItem>
                      )}
                      {editableDepartments.map((dept) => (
                        <SelectItem key={dept.id} value={dept.id}>
                          {dept.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="event-job-family">
                    {t("capacity.forecastPolicy.jobFamilyLabel")}
                  </Label>
                  <Input
                    id="event-job-family"
                    list="event-job-family-options"
                    maxLength={50}
                    placeholder={t(
                      "capacity.forecastPolicy.eventJobFamilyPlaceholder",
                    )}
                    value={eventDraft.jobFamily}
                    onChange={(e) =>
                      setEventDraft((prev) =>
                        prev ? { ...prev, jobFamily: e.target.value } : prev,
                      )
                    }
                  />
                  <datalist id="event-job-family-options">
                    {config.job_families.map((jf) => (
                      <option key={jf} value={jf} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div className="grid gap-3 @sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="event-start-week">
                    {t("capacity.forecastPolicy.startWeekMonday")}
                  </Label>
                  <Input
                    id="event-start-week"
                    type="date"
                    min="1970-01-05"
                    step={7}
                    required
                    value={eventDraft.startWeek}
                    onChange={(e) => {
                      const next = e.target.value
                      setEventDraft((prev) =>
                        prev
                          ? {
                              ...prev,
                              startWeek: next,
                              endWeek:
                                prev.endWeek.localeCompare(next) < 0
                                  ? next
                                  : prev.endWeek,
                            }
                          : prev,
                      )
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="event-end-week">
                    {t("capacity.forecastPolicy.endWeekMonday")}
                  </Label>
                  <Input
                    id="event-end-week"
                    type="date"
                    min={eventDraft.startWeek}
                    step={7}
                    required
                    value={eventDraft.endWeek}
                    onChange={(e) =>
                      setEventDraft((prev) =>
                        prev ? { ...prev, endWeek: e.target.value } : prev,
                      )
                    }
                  />
                </div>
              </div>

              <div className="grid gap-3 @sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="event-modifier-kind">
                    {t("capacity.forecastPolicy.modifierKindLabel")}
                  </Label>
                  <Select
                    value={eventDraft.modifierKind}
                    onValueChange={(value) =>
                      setEventDraft((prev) =>
                        prev
                          ? {
                              ...prev,
                              modifierKind:
                                value === "delta" ? "delta" : "multiplier",
                            }
                          : prev,
                      )
                    }
                  >
                    <SelectTrigger id="event-modifier-kind" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="multiplier">
                        {t("capacity.forecastPolicy.modifierMultiplier")}
                      </SelectItem>
                      <SelectItem value="delta">
                        {t("capacity.forecastPolicy.modifierDelta")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="event-modifier-value">
                    {t("capacity.forecastPolicy.modifierValueLabel")}
                  </Label>
                  <Input
                    id="event-modifier-value"
                    type="number"
                    min={eventDraft.modifierKind === "multiplier" ? 0 : -100}
                    max={eventDraft.modifierKind === "multiplier" ? 2 : 100}
                    step={
                      eventDraft.modifierKind === "multiplier" ? "0.05" : "1"
                    }
                    required
                    placeholder={
                      eventDraft.modifierKind === "multiplier"
                        ? t(
                            "capacity.forecastPolicy.modifierPlaceholderMultiplier",
                          )
                        : t("capacity.forecastPolicy.modifierPlaceholderDelta")
                    }
                    value={eventDraft.modifierValue}
                    onChange={(e) =>
                      setEventDraft((prev) =>
                        prev
                          ? { ...prev, modifierValue: e.target.value }
                          : prev,
                      )
                    }
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {eventDraft.modifierKind === "multiplier"
                      ? t("capacity.forecastPolicy.modifierHintMultiplier")
                      : t("capacity.forecastPolicy.modifierHintDelta")}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="event-reason">
                  {t("capacity.forecastPolicy.eventReasonLabel")}
                </Label>
                <Input
                  id="event-reason"
                  maxLength={300}
                  required
                  placeholder={t(
                    "capacity.forecastPolicy.eventReasonPlaceholder",
                  )}
                  value={eventDraft.reason}
                  onChange={(e) =>
                    setEventDraft((prev) =>
                      prev ? { ...prev, reason: e.target.value } : prev,
                    )
                  }
                />
              </div>

              {eventValidationError && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
                >
                  {eventValidationError}
                </p>
              )}
              <SetupError error={saveEvent.error} />

              <div className="flex flex-wrap gap-2">
                <Button size="sm" type="submit">
                  {saveEvent.isPending
                    ? t("capacity.common.saving")
                    : t("capacity.forecastPolicy.saveEventBtn")}
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEventDraft(null)
                    setEventValidationError(null)
                  }}
                >
                  {t("capacity.common.cancel")}
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </SectionCard>
    </div>
  )
}
