import { deepEqual, equal } from "node:assert/strict"
import { test } from "node:test"
import type { InboxTargetType } from "@/client"
import { messageText, resolveInboxTarget } from "./inboxTarget"

const SAMPLE_ID = "00000000-0000-0000-0000-000000000123"

test("resolveInboxTarget maps all structured target types deterministically", () => {
  const cases: Array<
    [InboxTargetType, string | null, ReturnType<typeof resolveInboxTarget>]
  > = [
    [
      "capacity_plans",
      SAMPLE_ID,
      {
        to: "/capacity",
        search: { tab: "incoming", demand: SAMPLE_ID, plans: 1 },
        labelKey: "inbox.capacityLinks.openPlans",
      },
    ],
    [
      "capacity_incoming",
      SAMPLE_ID,
      {
        to: "/capacity",
        search: { tab: "incoming", demand: SAMPLE_ID },
        labelKey: "inbox.capacityLinks.viewDetails",
      },
    ],
    [
      "capacity_incoming",
      null,
      {
        to: "/reviews",
        search: { type: "demand" },
        labelKey: "inbox.capacityLinks.viewDetails",
      },
    ],
    [
      "capacity_outgoing",
      SAMPLE_ID,
      {
        to: "/capacity",
        search: { tab: "outgoing", demand: SAMPLE_ID },
        labelKey: "inbox.capacityLinks.viewDetails",
      },
    ],
    [
      "capacity_outgoing",
      null,
      {
        to: "/capacity",
        search: { tab: "outgoing" },
        labelKey: "inbox.capacityLinks.viewDetails",
      },
    ],
    [
      "capacity_borrows",
      null,
      {
        to: "/capacity",
        search: { tab: "borrows" },
        labelKey: "inbox.capacityLinks.openBorrows",
      },
    ],
    [
      "capacity_team",
      null,
      {
        to: "/capacity",
        search: { tab: "team" },
        labelKey: "inbox.capacityLinks.viewDetails",
      },
    ],
    [
      "capacity",
      null,
      {
        to: "/capacity",
        search: {},
        labelKey: "inbox.capacityLinks.viewDetails",
      },
    ],
    [
      "reviews_borrow",
      null,
      {
        to: "/reviews",
        search: { type: "borrow" },
        labelKey: "inbox.capacityLinks.viewReviews",
      },
    ],
    [
      "reviews_workload",
      null,
      {
        to: "/reviews",
        search: { type: "workload" },
        labelKey: "inbox.capacityLinks.viewReviews",
      },
    ],
    [
      "reviews_demand",
      null,
      {
        to: "/reviews",
        search: { type: "demand" },
        labelKey: "inbox.capacityLinks.viewDetails",
      },
    ],
    [
      "assistant_admin",
      null,
      {
        to: "/assistant",
        search: { mode: "admin" },
        labelKey: "inbox.capacityLinks.openAdminAssistant",
      },
    ],
  ]

  for (const [target_type, target_id, expected] of cases) {
    deepEqual(
      resolveInboxTarget({ kind: "capacity", target_type, target_id }),
      expected,
    )
  }
})

test("resolveInboxTarget falls back safely when target_type is absent", () => {
  deepEqual(resolveInboxTarget({ kind: "capacity" }), {
    to: "/capacity",
    search: {},
    labelKey: "inbox.capacityLinks.viewDetails",
  })
  deepEqual(resolveInboxTarget({ kind: "admin_todos" }), {
    to: "/assistant",
    search: { mode: "admin" },
    labelKey: "inbox.capacityLinks.openAdminAssistant",
  })
  equal(resolveInboxTarget({ kind: "profile_edited" }), null)
})

test("messageText strips trailing capacity URLs without altering non-capacity items", () => {
  equal(
    messageText({
      kind: "capacity",
      message: `Reply received.\n/capacity?tab=outgoing&demand=${SAMPLE_ID}`,
    }),
    "Reply received.",
  )
  equal(
    messageText({
      kind: "capacity",
      message: "Tracking update.\n/capacity?tab=borrows",
    }),
    "Tracking update.",
  )
  equal(
    messageText({
      kind: "admin_todos",
      message: "You have 3 admin to-dos.",
    }),
    "You have 3 admin to-dos.",
  )
})
