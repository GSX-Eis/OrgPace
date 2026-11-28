import type { InboxPublic, InboxTargetType } from "@/client"

const demandLink =
  /\n\/capacity\?tab=(incoming|outgoing)&demand=([0-9a-f-]{36})(&plans=1)?$/
const borrowLink = /\n\/capacity\?tab=borrows$/

export type InboxTargetLink =
  | {
      to: "/capacity"
      search: {
        tab?: "incoming" | "outgoing" | "borrows" | "team"
        demand?: string
        plans?: 1
      }
      labelKey:
        | "inbox.capacityLinks.openPlans"
        | "inbox.capacityLinks.openBorrows"
        | "inbox.capacityLinks.viewDetails"
    }
  | {
      to: "/reviews"
      search: { type: "borrow" | "workload" | "demand" }
      labelKey:
        | "inbox.capacityLinks.viewReviews"
        | "inbox.capacityLinks.viewDetails"
    }
  | {
      to: "/assistant"
      search: { mode: "admin" }
      labelKey: "inbox.capacityLinks.openAdminAssistant"
    }

const STATIC_TARGETS: Partial<Record<InboxTargetType, InboxTargetLink>> = {
  capacity_borrows: {
    to: "/capacity",
    search: { tab: "borrows" },
    labelKey: "inbox.capacityLinks.openBorrows",
  },
  capacity_team: {
    to: "/capacity",
    search: { tab: "team" },
    labelKey: "inbox.capacityLinks.viewDetails",
  },
  capacity: {
    to: "/capacity",
    search: {},
    labelKey: "inbox.capacityLinks.viewDetails",
  },
  reviews_borrow: {
    to: "/reviews",
    search: { type: "borrow" },
    labelKey: "inbox.capacityLinks.viewReviews",
  },
  reviews_workload: {
    to: "/reviews",
    search: { type: "workload" },
    labelKey: "inbox.capacityLinks.viewReviews",
  },
  reviews_demand: {
    to: "/reviews",
    search: { type: "demand" },
    labelKey: "inbox.capacityLinks.viewDetails",
  },
  assistant_admin: {
    to: "/assistant",
    search: { mode: "admin" },
    labelKey: "inbox.capacityLinks.openAdminAssistant",
  },
}

export function messageText(
  item: Pick<InboxPublic, "kind" | "message">,
): string {
  return item.kind === "capacity"
    ? item.message.replace(demandLink, "").replace(borrowLink, "")
    : item.message
}

export function resolveInboxTarget(
  item: Pick<
    InboxPublic,
    | "kind"
    | "target_type"
    | "target_id"
    | "workload_request_id"
    | "extension_request_id"
  >,
): InboxTargetLink | null {
  const id = item.target_id ?? undefined
  if (item.target_type === "capacity_plans")
    return {
      to: "/capacity",
      search: id ? { tab: "incoming", demand: id, plans: 1 } : {},
      labelKey: "inbox.capacityLinks.openPlans",
    }
  if (item.target_type === "capacity_incoming")
    return id
      ? {
          to: "/capacity",
          search: { tab: "incoming", demand: id },
          labelKey: "inbox.capacityLinks.viewDetails",
        }
      : STATIC_TARGETS.reviews_demand!
  if (item.target_type === "capacity_outgoing")
    return {
      to: "/capacity",
      search: id ? { tab: "outgoing", demand: id } : { tab: "outgoing" },
      labelKey: "inbox.capacityLinks.viewDetails",
    }
  if (item.target_type && STATIC_TARGETS[item.target_type])
    return STATIC_TARGETS[item.target_type]!
  if (
    item.kind === "capacity" ||
    item.workload_request_id ||
    item.extension_request_id
  )
    return STATIC_TARGETS.capacity!
  if (item.kind === "admin_todos") return STATIC_TARGETS.assistant_admin!
  return null
}
