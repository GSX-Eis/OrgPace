import { queryOptions, useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import {
  type BorrowRequest,
  CapacityService,
  type DemandPublic,
  type ExtensionPublic,
  type WorkloadRequestPublic,
} from "@/client"
import { useExtensions } from "@/components/Capacity/AssignmentFields"
import { capacityKeys } from "@/components/Capacity/queries"
import { useCapacitySettings } from "@/components/Capacity/shared"
import { useOrg } from "./useOrg"
import { useReviews } from "./useReviews"

export function useBorrowRequests(
  orgId: string,
  mine: boolean,
  enabled = true,
) {
  return useQuery({
    queryKey: capacityKeys.borrows(orgId, mine),
    queryFn: async ({ signal }) =>
      (
        await CapacityService.listBorrowRequests({
          path: { org_id: orgId },
          query: { mine },
          signal,
        })
      ).data,
    enabled,
  })
}

export const PENDING_DEMAND_PAGE_SIZE = 100

export function pendingDemandPageOptions(orgId: string, skip = 0) {
  return queryOptions({
    queryKey: capacityKeys.incomingActionableDemands(orgId, skip),
    queryFn: async ({ signal }) =>
      (
        await CapacityService.listDemands({
          path: { org_id: orgId },
          query: {
            side: "incoming",
            actionable_only: true,
            limit: PENDING_DEMAND_PAGE_SIZE,
            skip: skip || undefined,
          },
          signal,
        })
      ).data,
  })
}

export function pendingApprovalGates(params: {
  orgId: string
  capacityEnabled: boolean
  canReview: boolean
  manages: boolean
  hasEmployee: boolean
}) {
  const hasOrg = Boolean(params.orgId)
  const cap = hasOrg && params.capacityEnabled
  return {
    reviews: hasOrg && params.canReview,
    workloads: cap && params.canReview,
    extensions: cap && params.canReview,
    incoming: cap && params.manages,
    selection: cap && params.manages,
    consent: cap && params.hasEmployee,
  }
}

export function summarizePendingApprovals(params: {
  canReview: boolean
  manages: boolean
  capacityEnabled: boolean
  hasEmployee: boolean
  profileCount: number
  workloads?: readonly WorkloadRequestPublic[]
  extensions?: readonly ExtensionPublic[]
  incomingData?: { count?: number; data?: readonly DemandPublic[] }
  selectionBorrows?: readonly BorrowRequest[]
  consentBorrows?: readonly BorrowRequest[]
}) {
  const { canReview, manages, capacityEnabled, hasEmployee } = params
  const pendingWorkloads =
    capacityEnabled && canReview
      ? (params.workloads ?? []).filter((row) => row.status === "pending")
      : []
  const pendingExtensions =
    capacityEnabled && canReview
      ? (params.extensions ?? []).filter((row) => row.status === "pending")
      : []
  const demands =
    capacityEnabled && manages
      ? (params.incomingData?.data ?? []).filter(
          (row) => row.can_reply === true,
        )
      : []
  const borrows = new Map<string, { request: BorrowRequest; mine: boolean }>()
  if (capacityEnabled && manages) {
    for (const request of params.selectionBorrows ?? []) {
      if (request.status === "pending_selection")
        borrows.set(request.id, { request, mine: false })
    }
  }
  if (capacityEnabled && hasEmployee) {
    for (const request of params.consentBorrows ?? []) {
      if (request.status === "pending_consent")
        borrows.set(request.id, { request, mine: true })
    }
  }
  const counts = {
    profile: canReview ? params.profileCount : 0,
    workload: pendingWorkloads.length + pendingExtensions.length,
    demand: capacityEnabled && manages ? (params.incomingData?.count ?? 0) : 0,
    borrow: borrows.size,
  }
  return {
    pendingWorkloads,
    pendingExtensions,
    demands,
    borrows: [...borrows.values()],
    counts,
    totalCount:
      counts.profile + counts.workload + counts.demand + counts.borrow,
  }
}

export function usePendingApprovals() {
  const { org, roles, canReview, employeeId } = useOrg()
  const orgId = org?.id ?? ""
  const manages = roles.includes("org_admin") || roles.includes("dept_manager")
  const capacity = useCapacitySettings(org?.id)
  const enabled = capacity.data?.enabled === true
  const gates = pendingApprovalGates({
    orgId,
    capacityEnabled: enabled,
    canReview,
    manages,
    hasEmployee: Boolean(employeeId),
  })
  const profile = useReviews(gates.reviews)
  const workloads = useQuery({
    queryKey: capacityKeys.workloadRequests(orgId),
    queryFn: async ({ signal }) =>
      (
        await CapacityService.listWorkloadRequests({
          path: { org_id: orgId },
          signal,
        })
      ).data,
    enabled: gates.workloads,
  })
  const extensions = useExtensions(orgId, gates.extensions, true)
  const incoming = useQuery({
    ...pendingDemandPageOptions(orgId),
    enabled: gates.incoming,
  })
  const selection = useBorrowRequests(orgId, false, gates.selection)
  const consent = useBorrowRequests(orgId, true, gates.consent)

  const summary = useMemo(
    () =>
      summarizePendingApprovals({
        canReview,
        manages,
        capacityEnabled: enabled,
        hasEmployee: Boolean(employeeId),
        profileCount: profile.data?.count ?? 0,
        workloads: workloads.data?.data,
        extensions: extensions.data?.data,
        incomingData: incoming.data,
        selectionBorrows: selection.data,
        consentBorrows: consent.data,
      }),
    [
      canReview,
      manages,
      enabled,
      employeeId,
      profile.data?.count,
      workloads.data?.data,
      extensions.data?.data,
      incoming.data,
      selection.data,
      consent.data,
    ],
  )
  const workloadQueries = useMemo(
    () => (gates.workloads ? [workloads, extensions] : []),
    [gates.workloads, workloads, extensions],
  )
  const demandQueries = useMemo(
    () => (gates.incoming ? [incoming] : []),
    [gates.incoming, incoming],
  )
  const borrowQueries = useMemo(
    () =>
      enabled
        ? [
            ...(gates.selection ? [selection] : []),
            ...(gates.consent ? [consent] : []),
          ]
        : [],
    [enabled, gates.selection, gates.consent, selection, consent],
  )
  return {
    capacity,
    profile,
    ...summary,
    workloadQueries,
    demandQueries,
    borrowQueries,
  }
}
