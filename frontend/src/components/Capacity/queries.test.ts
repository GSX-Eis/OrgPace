import { deepEqual, equal } from "node:assert/strict"
import { test } from "node:test"
import { QueryObserver } from "@tanstack/react-query"
import {
  createLocaleQueryClient,
  isLocaleReadOnlyPlanningQuery,
} from "@/i18n/localeQuerySync"
import {
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

test("targeted invalidation helpers avoid invalidating static metadata or unrelated demands", async () => {
  const { queryClient } = createLocaleQueryClient(() => {})
  queryClient.setQueryData(capacityKeys.departments("org-1"), [])
  queryClient.setQueryData(capacityKeys.demand("org-1", "dem-1"), { id: "1" })
  queryClient.setQueryData(capacityKeys.demand("org-1", "dem-2"), { id: "2" })
  queryClient.setQueryData(capacityKeys.planning("org-1", "dem-2", ""), {
    id: "case-2",
  })
  queryClient.setQueryData(capacityKeys.workloadTeam("org-1"), [])

  await invalidateDemandMutation(queryClient, "org-1", "dem-1")
  equal(
    queryClient.getQueryState(capacityKeys.departments("org-1"))?.isInvalidated,
    false,
  )
  equal(
    queryClient.getQueryState(capacityKeys.demand("org-1", "dem-1"))
      ?.isInvalidated,
    true,
  )
  equal(
    queryClient.getQueryState(capacityKeys.demand("org-1", "dem-2"))
      ?.isInvalidated,
    false,
  )
  equal(
    queryClient.getQueryState(capacityKeys.planning("org-1", "dem-2", ""))
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
  queryClient.clear()
})
