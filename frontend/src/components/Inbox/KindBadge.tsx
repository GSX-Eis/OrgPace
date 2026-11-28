import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import type { InboxKind } from "@/client"
import { cn } from "@/lib/utils"

export const inboxKinds: InboxKind[] = [
  "capacity",
  "profile_edited",
  "initial_review",
  "question",
  "submitted",
  "status_changed",
  "admin_todos",
  "dictionary_changed",
  "review_requested",
  "decided",
]

export function kindLabel(kind: InboxKind, t: TFunction) {
  return t(`inbox.kinds.${kind}`)
}

export function KindBadge({ kind }: { kind: InboxKind }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs leading-none",
        kind === "question" || kind === "initial_review"
          ? "border-primary/20 bg-primary/10 text-primary"
          : "border-surface-border bg-muted text-muted-foreground",
      )}
    >
      {kindLabel(kind, t)}
    </span>
  )
}
