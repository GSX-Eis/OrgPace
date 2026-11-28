import { ListFilter } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { InboxKind, InboxList, InboxPublic } from "@/client"
import { dateLabel } from "@/components/Profile/fields"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { messageText } from "./inboxTarget"
import { inboxKinds, KindBadge, kindLabel } from "./KindBadge"

export function InboxListPane({
  data,
  isPending,
  isError,
  refetch,
  rows,
  selectedId,
  hasSelection,
  pendingOnly,
  unreadOnly,
  kind,
  skip,
  onPendingChange,
  onUnreadChange,
  onKindChange,
  onPageChange,
  onSelect,
}: {
  data: InboxList | undefined
  isPending: boolean
  isError: boolean
  refetch: () => void
  rows: InboxPublic[]
  selectedId: string | undefined
  hasSelection: boolean
  pendingOnly: boolean
  unreadOnly: boolean
  kind: InboxKind | undefined
  skip: number
  onPendingChange: (pending: boolean) => void
  onUnreadChange: (unread: boolean) => void
  onKindChange: (kind: InboxKind | undefined) => void
  onPageChange: (nextSkip: number) => void
  onSelect: (row: InboxPublic) => void
}) {
  const { t } = useTranslation()
  return (
    <aside
      aria-label={t("inbox.list.ariaLabel")}
      className={cn(
        "min-w-0 border-surface-border bg-surface md:h-[calc(100dvh-3rem)] md:overflow-y-auto md:border-r",
        hasSelection && "hidden md:block",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-surface-border border-b px-3 py-2.5">
        <fieldset className="inline-flex min-w-0 gap-0.5 rounded-md bg-muted p-0.5">
          <legend className="sr-only">{t("inbox.list.viewLegend")}</legend>
          {[true, false].map((pending) => (
            <Button
              key={String(pending)}
              variant="ghost"
              size="sm"
              className="h-7 aria-pressed:bg-surface aria-pressed:shadow-xs"
              aria-pressed={pendingOnly === pending}
              onClick={() => onPendingChange(pending)}
            >
              {pending ? t("inbox.list.pendingTab") : t("inbox.list.allTab")}
              <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">
                {(pending ? data?.pending_count : data?.total_count) ?? 0}
              </span>
            </Button>
          ))}
        </fieldset>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-7", (unreadOnly || kind) && "text-primary")}
            >
              <ListFilter aria-hidden="true" /> {t("inbox.list.filterButton")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuCheckboxItem
              checked={unreadOnly}
              onCheckedChange={onUnreadChange}
            >
              {t("inbox.list.unreadOnly")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("inbox.list.byKind")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={kind ?? "all"}
              onValueChange={(value) =>
                onKindChange(inboxKinds.find((entry) => entry === value))
              }
            >
              <DropdownMenuRadioItem value="all">
                {t("inbox.list.allKinds")}
              </DropdownMenuRadioItem>
              {inboxKinds.map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {kindLabel(value, t)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {isPending ? (
        <ProfileLoading />
      ) : isError ? (
        <ProfileError retry={refetch} />
      ) : (
        <>
          {!rows.length && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {t("inbox.list.empty")}
            </p>
          )}
          <ul className="divide-y divide-surface-border border-surface-border border-b">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  aria-current={selectedId === row.id ? "true" : undefined}
                  onClick={() => onSelect(row)}
                  className="flex w-full min-w-0 items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/70 focus-visible:outline-primary aria-current:bg-primary/5"
                >
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      !row.read_at && "bg-blue-600",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center justify-between gap-1">
                      <KindBadge kind={row.kind} />
                      <time
                        dateTime={row.created_at}
                        className="text-xs text-muted-foreground"
                      >
                        {dateLabel(row.created_at)}
                      </time>
                    </span>
                    {!row.read_at && (
                      <span className="sr-only">
                        {t("inbox.list.unreadSr")}
                      </span>
                    )}
                    <span
                      className={cn(
                        "block truncate text-sm",
                        !row.read_at && "font-semibold",
                      )}
                    >
                      {messageText(row)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {data && data.count > 20 && (
            <nav
              aria-label={t("inbox.list.paginationAria")}
              className="flex flex-wrap items-center justify-between gap-1 p-2 text-xs"
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={skip === 0}
                onClick={() => onPageChange(skip - 20)}
              >
                {t("inbox.list.prevPage")}
              </Button>
              {t("inbox.list.pageSummary", {
                page: skip / 20 + 1,
                count: data.count,
              })}
              <Button
                variant="ghost"
                size="sm"
                disabled={skip + 20 >= data.count}
                onClick={() => onPageChange(skip + 20)}
              >
                {t("inbox.list.nextPage")}
              </Button>
            </nav>
          )}
        </>
      )}
    </aside>
  )
}
