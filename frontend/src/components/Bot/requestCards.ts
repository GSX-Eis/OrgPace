import type { TurnResponse } from "@/client"
import i18n from "@/i18n"

type Card = TurnResponse["messages"][number]
export type RequestCard = Extract<
  Card,
  { type: "preview_card" | "status_card" }
>

export function requestCardHistory(cards: Card[]) {
  const laterCards = new Map<
    string,
    { next: RequestCard; latest: RequestCard }
  >()
  const history = new Map<RequestCard, RequestCard>()
  for (const card of [...cards].reverse()) {
    if (card.type !== "status_card" && card.type !== "preview_card") continue
    const id = card.type === "preview_card" ? card.request_id : card.id
    const later = laterCards.get(id)
    if (later)
      history.set(
        card,
        card.type === "preview_card" && later.next.type === "preview_card"
          ? later.next
          : later.latest,
      )
    laterCards.set(id, { next: card, latest: later?.latest ?? card })
  }
  return history
}

export function foldedStatusCards(cards: Card[]): Set<RequestCard> {
  const seen = new Set<string>()
  const folded = new Set<RequestCard>()
  for (const card of cards) {
    if (card.type === "preview_card") {
      seen.add(card.request_id)
    } else if (card.type === "status_card") {
      if (seen.has(card.id)) folded.add(card)
      else seen.add(card.id)
    }
  }
  return folded
}

export function previewHistoryLabel(
  card: Extract<RequestCard, { type: "preview_card" }>,
  later: RequestCard | undefined,
) {
  if (!later && card.actions.length) return undefined
  if (later?.type === "status_card") {
    if (later.status === "withdrawn")
      return i18n.t("bot.historyStatus.withdrawn")
    if (later.status === "approved") return i18n.t("bot.historyStatus.approved")
    if (later.status === "changes_requested")
      return i18n.t("bot.historyStatus.rejected")
    if (later.status === "rejected") return i18n.t("bot.historyStatus.rejected")
    if (later.status !== "draft" && later.status !== "pending_owner")
      return i18n.t("bot.historyStatus.submitted")
  }
  return i18n.t("bot.historyStatus.expired")
}
