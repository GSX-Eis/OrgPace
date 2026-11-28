import { deepEqual, equal } from "node:assert/strict"
import { test } from "node:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type {
  BorrowRequest,
  DemandPublic,
  ExtensionPublic,
  WorkloadRequestPublic,
} from "@/client"
import {
  pendingApprovalGates,
  summarizePendingApprovals,
} from "./usePendingApprovals"

test("pendingApprovalGates prevents unauthorized fan-out queries for plain employees", () => {
  deepEqual(
    pendingApprovalGates({
      orgId: "org-1",
      capacityEnabled: true,
      canReview: false,
      manages: false,
      hasEmployee: true,
    }),
    {
      reviews: false,
      workloads: false,
      extensions: false,
      incoming: false,
      selection: false,
      consent: true,
    },
  )

  // Pure reporting-line delegate without dept_manager role can review profiles/workloads/extensions.
  deepEqual(
    pendingApprovalGates({
      orgId: "org-1",
      capacityEnabled: true,
      canReview: true,
      manages: false,
      hasEmployee: true,
    }),
    {
      reviews: true,
      workloads: true,
      extensions: true,
      incoming: false,
      selection: false,
      consent: true,
    },
  )

  deepEqual(
    pendingApprovalGates({
      orgId: "org-1",
      capacityEnabled: false,
      canReview: true,
      manages: true,
      hasEmployee: true,
    }),
    {
      reviews: true,
      workloads: false,
      extensions: false,
      incoming: false,
      selection: false,
      consent: false,
    },
  )
})

test("summarizePendingApprovals filters pending items, non-actionable demands, and computes counts", () => {
  const result = summarizePendingApprovals({
    canReview: true,
    manages: true,
    capacityEnabled: true,
    hasEmployee: true,
    profileCount: 2,
    workloads: [
      { id: "w1", status: "pending" } as WorkloadRequestPublic,
      { id: "w2", status: "approved" } as WorkloadRequestPublic,
    ],
    extensions: [
      { id: "e1", status: "pending" } as ExtensionPublic,
      { id: "e3", status: "returned" } as ExtensionPublic,
    ],
    incomingData: {
      count: 1,
      data: [
        { id: "d1", can_reply: true } as DemandPublic,
        { id: "d2", can_reply: false } as DemandPublic,
      ],
    },
    selectionBorrows: [
      { id: "b1", status: "pending_selection" } as BorrowRequest,
      { id: "b2", status: "selected" } as BorrowRequest,
    ],
    consentBorrows: [
      { id: "b3", status: "pending_consent" } as BorrowRequest,
      { id: "b4", status: "waiting_commitment" } as BorrowRequest,
    ],
  })

  equal(result.pendingWorkloads.length, 1)
  equal(result.pendingExtensions.length, 1)
  equal(result.pendingExtensions[0].id, "e1")
  equal(result.demands.length, 1)
  equal(result.borrows.length, 2)
  deepEqual(result.counts, {
    profile: 2,
    workload: 2,
    demand: 1,
    borrow: 2,
  })
  equal(result.totalCount, 7)
})

test("disabled QueryObserver stays pending/idle so gated-off profile must be omitted from section queries", () => {
  const client = new QueryClient()
  const profile = new QueryObserver(client, {
    queryKey: ["reviews", "org-test"],
    queryFn: async () => ({ count: 0, data: [] }),
    enabled: false,
  }).getCurrentResult()
  equal(profile.fetchStatus, "idle")
  equal(profile.isPending, true)
  equal(profile.isSuccess, false)

  const gates = pendingApprovalGates({
    orgId: "org-test",
    capacityEnabled: true,
    canReview: false,
    manages: false,
    hasEmployee: true,
  })
  const sectionQueries = gates.reviews ? [profile] : []
  equal(
    sectionQueries.some((q) => q.isPending),
    false,
  )
  equal(
    sectionQueries.every((q) => q.isSuccess),
    true,
  )
  client.clear()
})
