import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapacityService,
  type ForecastEventInput,
  type ForecastPolicyInput,
} from "@/client"
import { ProfileError } from "@/components/Profile/QueryState"
import { Skeleton } from "@/components/ui/skeleton"
import { useOrg } from "@/hooks/useOrg"
import { ForecastEventForm } from "./ForecastEventForm"
import { ForecastEventList } from "./ForecastEventList"
import { ForecastPolicyForm } from "./ForecastPolicyForm"
import { ForecastPolicyList } from "./ForecastPolicyList"
import {
  defaultEventDraft,
  defaultPolicyDraft,
  type EventDraft,
  eventToDraft,
  type PolicyDraft,
  type PolicyFormMode,
  policyScopeLabel,
  policyToDraft,
  validateEventDraft,
  validatePolicyDraft,
} from "./ForecastPolicyShared"
import {
  capacityKeys,
  invalidateWorkloadMutation,
  useOrgDepartments,
} from "./queries"

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
    queryKey: capacityKeys.forecastPolicies(orgId),
    queryFn: async () =>
      (
        await CapacityService.listCapacityForecastPolicies({
          path: { org_id: orgId },
        })
      ).data,
  })
  const eventsQuery = useQuery({
    queryKey: capacityKeys.forecastEvents(orgId),
    queryFn: async () =>
      (
        await CapacityService.listCapacityForecastEvents({
          path: { org_id: orgId },
          query: { include_past: false },
        })
      ).data,
  })
  const departmentsQuery = useOrgDepartments(orgId)

  const refreshCapacityData = async (message: string) => {
    setStatusMessage(message)
    await invalidateWorkloadMutation(client, orgId, { forecastConfig: true })
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

    const result = validatePolicyDraft(policyDraft, mode)
    if ("error" in result) {
      setPolicyValidationError(result.error)
      return
    }
    upsertPolicy.mutate(result.body)
  }

  const submitEvent = (event: React.FormEvent) => {
    event.preventDefault()
    if (!eventDraft) return
    setEventValidationError(null)
    saveEvent.reset()

    const result = validateEventDraft(eventDraft, mode)
    if ("error" in result) {
      setEventValidationError(result.error)
      return
    }
    saveEvent.mutate({
      editingId: eventDraft.editingId,
      body: result.body,
    })
  }

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

      <ForecastPolicyList
        mode={mode}
        config={config}
        canCreateInMode={canCreateInMode}
        hasDraft={!!policyDraft}
        hasOrgDefaultPolicy={hasOrgDefaultPolicy}
        isDeletePending={deletePolicy.isPending}
        deleteError={deletePolicy.error}
        onCreate={() => {
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
        onConfigOrgDefault={() => {
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
        onEdit={(policy) => {
          upsertPolicy.reset()
          setPolicyValidationError(null)
          setPolicyFormMode({
            kind: "edit",
            scope: policyScopeLabel(policy),
          })
          setPolicyDraft(policyToDraft(policy))
        }}
        onDelete={(policyId) => {
          deletePolicy.reset()
          deletePolicy.mutate(policyId)
        }}
      >
        {policyDraft && (
          <ForecastPolicyForm
            mode={mode}
            title={policyFormTitle}
            draft={policyDraft}
            editableDepartments={editableDepartments}
            jobFamilies={config.job_families}
            isPending={upsertPolicy.isPending}
            validationError={policyValidationError}
            submitError={upsertPolicy.error}
            onChange={(updater) =>
              setPolicyDraft((prev) => (prev ? updater(prev) : prev))
            }
            onClearValidation={() => setPolicyValidationError(null)}
            onCancel={() => {
              setPolicyDraft(null)
              setPolicyValidationError(null)
            }}
            onSubmit={submitPolicy}
          />
        )}
      </ForecastPolicyList>

      <ForecastEventList
        events={events}
        canCreateInMode={canCreateInMode}
        hasDraft={!!eventDraft}
        isDeletePending={deleteEvent.isPending}
        deleteError={deleteEvent.error}
        onCreate={() => {
          saveEvent.reset()
          setEventValidationError(null)
          setEventDraft(defaultEventDraft(mode, editableDepartments))
        }}
        onEdit={(item) => {
          saveEvent.reset()
          setEventValidationError(null)
          setEventDraft(eventToDraft(item))
        }}
        onDelete={(eventId) => {
          deleteEvent.reset()
          deleteEvent.mutate(eventId)
        }}
      >
        {eventDraft && (
          <ForecastEventForm
            mode={mode}
            draft={eventDraft}
            editableDepartments={editableDepartments}
            jobFamilies={config.job_families}
            isPending={saveEvent.isPending}
            validationError={eventValidationError}
            submitError={saveEvent.error}
            onChange={(updater) =>
              setEventDraft((prev) => (prev ? updater(prev) : prev))
            }
            onCancel={() => {
              setEventDraft(null)
              setEventValidationError(null)
            }}
            onSubmit={submitEvent}
          />
        )}
      </ForecastEventList>
    </div>
  )
}
