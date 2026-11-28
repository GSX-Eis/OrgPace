import { type QueryClient, useQuery } from "@tanstack/react-query"
import { CapacityService, OrgsService } from "@/client"

/** Type-safe TanStack Query keys for the Capacity domain (compatible with localeQuerySync). */
export const capacityKeys = {
  all: (orgId: string) => ["capacity", orgId] as const,
  settings: (orgId?: string) => ["capacity-settings", orgId] as const,
  departments: (orgId: string) => ["capacity", orgId, "departments"] as const,
  orgDepartments: (orgId: string) => ["org-departments", orgId] as const,
  demands: (orgId: string) => ["capacity", orgId, "demands"] as const,
  outgoingDemands: (orgId: string, skip?: number) =>
    skip === undefined
      ? (["capacity", orgId, "outgoing-demands"] as const)
      : (["capacity", orgId, "outgoing-demands", skip] as const),
  incomingActionableDemands: (orgId: string, skip = 0) =>
    ["capacity", orgId, "demands", "incoming", "actionable", skip] as const,
  demandRoot: (orgId: string) => ["capacity", orgId, "demand"] as const,
  demand: (orgId: string, demandId: string) =>
    ["capacity", orgId, "demand", demandId] as const,
  demandHistoryRoot: (orgId: string) => ["capacity", orgId, "history"] as const,
  demandHistory: (orgId: string, demandId: string) =>
    ["capacity", orgId, "history", demandId] as const,
  demandBasisRoot: (orgId: string) =>
    ["capacity", orgId, "demand-basis"] as const,
  demandBasis: (orgId: string, demandId: string) =>
    ["capacity", orgId, "demand-basis", demandId] as const,
  demandOptions: (orgId: string) =>
    ["capacity", orgId, "demand-options"] as const,
  trackingRiskRoot: (orgId: string) =>
    ["capacity", orgId, "tracking-risk"] as const,
  trackingRisk: (orgId: string, demandId: string) =>
    ["capacity", orgId, "tracking-risk", demandId] as const,
  planningAll: (orgId: string) => ["capacity", orgId, "planning"] as const,
  planningDemand: (orgId: string, demandId: string) =>
    ["capacity", orgId, "planning", demandId] as const,
  planning: (orgId: string, demandId: string, hash: string) =>
    ["capacity", orgId, "planning", demandId, hash] as const,
  assignmentsRoot: (orgId: string) =>
    ["capacity", orgId, "assignments"] as const,
  assignments: (orgId: string, demandId: string) =>
    ["capacity", orgId, "assignments", demandId] as const,
  assignmentsMe: (orgId: string) =>
    ["capacity", orgId, "assignments-me"] as const,
  extensions: (orgId: string) => ["capacity", orgId, "extensions"] as const,
  trackingRoot: (orgId: string) => ["capacity", orgId, "tracking"] as const,
  tracking: (orgId: string, assignmentId: string) =>
    ["capacity", orgId, "tracking", assignmentId] as const,
  feedbackAssignments: (orgId: string, demandId?: string) =>
    demandId === undefined
      ? (["capacity", orgId, "feedback-assignments"] as const)
      : (["capacity", orgId, "feedback-assignments", demandId] as const),
  workloadTeam: (orgId: string, fromWeek?: string) =>
    fromWeek === undefined
      ? (["capacity", orgId, "team"] as const)
      : (["capacity", orgId, "team", fromWeek] as const),
  workloadMe: (orgId: string) => ["capacity", orgId, "me"] as const,
  workloadRequests: (orgId: string) => ["capacity", orgId, "requests"] as const,
  carryOverPreview: (orgId: string, department?: string) =>
    department === undefined
      ? (["capacity", orgId, "carry-over-preview"] as const)
      : (["capacity", orgId, "carry-over-preview", department] as const),
  unavailabilityRoot: (orgId: string) =>
    ["capacity", orgId, "unavailability"] as const,
  unavailability: (
    orgId: string,
    employeeId: string,
    fromDate: string,
    toDate: string,
  ) =>
    [
      "capacity",
      orgId,
      "unavailability",
      employeeId,
      fromDate,
      toDate,
    ] as const,
  forecastPolicies: (orgId: string) =>
    ["capacity", orgId, "forecast-policies"] as const,
  forecastEvents: (orgId: string) =>
    ["capacity", orgId, "forecast-events"] as const,
  borrowsRoot: (orgId: string) => ["capacity", orgId, "borrows"] as const,
  borrows: (orgId: string, mine: boolean) =>
    ["capacity", orgId, "borrows", mine] as const,
  activeBorrowAssignments: (orgId: string) =>
    ["capacity", orgId, "active-borrow-assignments"] as const,
  projects: (orgId: string) => ["capacity", orgId, "projects"] as const,
  projectRoot: (orgId: string) => ["capacity", orgId, "project"] as const,
  project: (orgId: string, projectId: string) =>
    ["capacity", orgId, "project", projectId] as const,
  createMutation: (orgId: string, kind: "outgoing" | "projects") =>
    ["capacity", orgId, "create", kind] as const,
} as const

/** Shared query for departments accessible to capacity requesters/planners. */
export function useCapacityDepartments(orgId: string, enabled = true) {
  return useQuery({
    queryKey: capacityKeys.departments(orgId),
    enabled,
    queryFn: async () =>
      (
        await CapacityService.listCapacityDepartments({
          path: { org_id: orgId },
        })
      ).data.data,
  })
}

/** Shared query for organization departments (used by forecast policy config). */
export function useOrgDepartments(orgId: string, enabled = true) {
  return useQuery({
    queryKey: capacityKeys.orgDepartments(orgId),
    enabled,
    queryFn: async () =>
      (await OrgsService.readDepartments({ path: { org_id: orgId } })).data
        .data,
  })
}

function invalidateKeys(
  client: QueryClient,
  keys: readonly (readonly unknown[])[],
) {
  return Promise.all(
    keys.map((queryKey) => client.invalidateQueries({ queryKey })),
  )
}

export function invalidateCapacityAll(client: QueryClient, orgId: string) {
  return client.invalidateQueries({ queryKey: capacityKeys.all(orgId) })
}

export function invalidateDemandCreation(
  client: QueryClient,
  orgId: string,
  includeInbox = true,
) {
  const keys: (readonly unknown[])[] = [
    capacityKeys.outgoingDemands(orgId),
    capacityKeys.demands(orgId),
    capacityKeys.projects(orgId),
    capacityKeys.projectRoot(orgId),
  ]
  if (includeInbox) keys.push(["inbox", orgId])
  return invalidateKeys(client, keys)
}

export function invalidateDemandMutation(
  client: QueryClient,
  orgId: string,
  demandId: string,
) {
  return invalidateKeys(client, [
    capacityKeys.demand(orgId, demandId),
    capacityKeys.demandHistory(orgId, demandId),
    capacityKeys.demandBasis(orgId, demandId),
    capacityKeys.assignments(orgId, demandId),
    capacityKeys.planningDemand(orgId, demandId),
    capacityKeys.trackingRisk(orgId, demandId),
    capacityKeys.outgoingDemands(orgId),
    capacityKeys.demands(orgId),
    capacityKeys.projects(orgId),
    capacityKeys.projectRoot(orgId),
    capacityKeys.borrowsRoot(orgId),
    capacityKeys.activeBorrowAssignments(orgId),
    capacityKeys.workloadTeam(orgId),
    capacityKeys.workloadMe(orgId),
    ["inbox", orgId],
  ])
}

export function invalidateWorkloadMutation(
  client: QueryClient,
  orgId: string,
  options?: {
    inbox?: boolean
    unavailability?: boolean
    forecastConfig?: boolean
  },
) {
  const keys: (readonly unknown[])[] = [
    capacityKeys.workloadTeam(orgId),
    capacityKeys.workloadMe(orgId),
    capacityKeys.workloadRequests(orgId),
    capacityKeys.carryOverPreview(orgId),
    capacityKeys.planningAll(orgId),
    capacityKeys.demandBasisRoot(orgId),
  ]
  if (options?.unavailability) keys.push(capacityKeys.unavailabilityRoot(orgId))
  if (options?.forecastConfig) {
    keys.push(
      capacityKeys.forecastPolicies(orgId),
      capacityKeys.forecastEvents(orgId),
    )
  }
  if (options?.inbox) keys.push(["inbox", orgId])
  return invalidateKeys(client, keys)
}

export function invalidateCapacityAssignments(
  client: QueryClient,
  orgId: string,
) {
  return invalidateKeys(client, [
    capacityKeys.assignmentsRoot(orgId),
    capacityKeys.assignmentsMe(orgId),
    capacityKeys.extensions(orgId),
    capacityKeys.trackingRoot(orgId),
    capacityKeys.trackingRiskRoot(orgId),
    capacityKeys.feedbackAssignments(orgId),
    capacityKeys.borrowsRoot(orgId),
    capacityKeys.activeBorrowAssignments(orgId),
    capacityKeys.demands(orgId),
    capacityKeys.outgoingDemands(orgId),
    capacityKeys.demandRoot(orgId),
    capacityKeys.demandHistoryRoot(orgId),
    capacityKeys.demandBasisRoot(orgId),
    capacityKeys.planningAll(orgId),
    capacityKeys.workloadTeam(orgId),
    capacityKeys.workloadMe(orgId),
    capacityKeys.projects(orgId),
    capacityKeys.projectRoot(orgId),
    ["inbox", orgId],
  ])
}
