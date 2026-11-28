import { deepEqual, equal } from "node:assert/strict"
import { test } from "node:test"
import { QueryObserver } from "@tanstack/react-query"
import {
  createLocaleQueryClient,
  isLocaleReadOnlyPlanningQuery,
} from "@/i18n/localeQuerySync"
import {
  capacityDepartmentsQueryOptions,
  capacityKeys,
  invalidateDemandMutation,
  invalidateWorkloadMutation,
} from "./queries"

test("capacityKeys keeps localeQuerySync-compatible prefix structure", () => {
  const planningKey = capacityKeys.planning("org-1", "dem-1", "case=c1")
  equal(planningKey[0], "capacity")
  equal(planningKey[1], "org-1")
  equal(planningKey[2], "planning")
  deepEqual(planningKey.slice(0, 2), capacityKeys.all("org-1"))
  deepEqual(planningKey.slice(0, 3), capacityKeys.planningAll("org-1"))
  deepEqual(
    planningKey.slice(0, 4),
    capacityKeys.planningDemand("org-1", "dem-1"),
  )
  deepEqual(capacityKeys.workloadTeam("org-1", "2027-01-04").slice(0, 3), [
    "capacity",
    "org-1",
    "team",
  ])
})

test("capacityKeys.planning works with localeQuerySync read-only refresh", async () => {
  const { queryClient, refreshForLocaleChange } = createLocaleQueryClient(
    () => {},
  )
  const key = capacityKeys.planning("org-1", "dem-1", "")
  queryClient.setQueryData(key, { id: "case-1" })
  let readOnlyObserved = false
  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    queryFn: async () => {
      readOnlyObserved = isLocaleReadOnlyPlanningQuery(queryClient, key)
      return { id: "case-1" }
    },
  })
  const unsubscribe = observer.subscribe(() => {})
  refreshForLocaleChange()
  await new Promise((resolve) => setTimeout(resolve, 10))
  unsubscribe()
  equal(readOnlyObserved, true)
  queryClient.clear()
})

test("invalidateDemandMutation refreshes cross-demand holds, extensions, and carry-over while preserving cross-org and static metadata", async () => {
  const { queryClient } = createLocaleQueryClient(() => {})
  const extKey = capacityKeys.extensions("org-1")
  let serverEnd = "2027-02-28"
  const extObserver = new QueryObserver(queryClient, {
    queryKey: extKey,
    queryFn: async () => serverEnd,
  })
  const stopExt = extObserver.subscribe(() => {})
  await extObserver.refetch()
  serverEnd = "2027-02-21"

  const otherPlanKey = capacityKeys.planning("org-1", "dem-2", "")
  let otherPlanVersion = 0
  const planObserver = new QueryObserver(queryClient, {
    queryKey: otherPlanKey,
    queryFn: async () => otherPlanVersion,
  })
  const stopPlan = planObserver.subscribe(() => {})
  await planObserver.refetch()
  otherPlanVersion = 1

  queryClient.setQueryData(capacityKeys.departments("org-1"), [])
  queryClient.setQueryData(capacityKeys.demandOptions("org-1"), {})
  queryClient.setQueryData(capacityKeys.demand("org-1", "dem-1"), { id: "1" })
  queryClient.setQueryData(capacityKeys.demandBasis("org-1", "dem-2"), {})
  queryClient.setQueryData(capacityKeys.assignmentsMe("org-1"), [])
  queryClient.setQueryData(capacityKeys.carryOverPreview("org-1", "all"), {})
  queryClient.setQueryData(capacityKeys.planning("org-2", "dem-2", ""), {
    id: "other-org",
  })
  queryClient.setQueryData(capacityKeys.workloadTeam("org-1"), [])

  await invalidateDemandMutation(queryClient, "org-1", "dem-1")
  equal(queryClient.getQueryData(extKey), "2027-02-21")
  equal(queryClient.getQueryData(otherPlanKey), 1)
  equal(
    queryClient.getQueryState(capacityKeys.demandBasis("org-1", "dem-2"))
      ?.isInvalidated,
    true,
  )
  equal(
    queryClient.getQueryState(capacityKeys.assignmentsMe("org-1"))
      ?.isInvalidated,
    true,
  )
  equal(
    queryClient.getQueryState(capacityKeys.carryOverPreview("org-1", "all"))
      ?.isInvalidated,
    true,
  )
  equal(
    queryClient.getQueryState(capacityKeys.departments("org-1"))?.isInvalidated,
    false,
  )
  equal(
    queryClient.getQueryState(capacityKeys.demandOptions("org-1"))
      ?.isInvalidated,
    false,
  )
  equal(
    queryClient.getQueryState(capacityKeys.planning("org-2", "dem-2", ""))
      ?.isInvalidated,
    false,
  )

  await invalidateWorkloadMutation(queryClient, "org-1")
  equal(
    queryClient.getQueryState(capacityKeys.workloadTeam("org-1"))
      ?.isInvalidated,
    true,
  )
  equal(
    queryClient.getQueryState(capacityKeys.departments("org-1"))?.isInvalidated,
    false,
  )

  stopExt()
  stopPlan()
  queryClient.clear()
})

test("capacityDepartmentsQueryOptions shares the capacity departments cache key", () => {
  deepEqual(
    capacityDepartmentsQueryOptions("org-1").queryKey,
    capacityKeys.departments("org-1"),
  )
})
