import { Link } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { InboxPublic } from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { dateLabel } from "@/components/Profile/fields"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { InboxApprovalDetail } from "./InboxApprovalDetail"
import { messageText, resolveInboxTarget } from "./inboxTarget"
import { KindBadge } from "./KindBadge"
import { QuestionAnswer } from "./QuestionAnswer"

function InboxTargetButton({
  item,
  onClick,
}: {
  item: InboxPublic
  onClick: () => void
}) {
  const { t } = useTranslation()
  const target = resolveInboxTarget(item)
  if (!target) return null
  return (
    <Button variant="outline" asChild>
      <Link to={target.to} search={target.search} onClick={onClick}>
        {t(target.labelKey)}
      </Link>
    </Button>
  )
}

export function InboxDetailPane({
  orgId,
  employeeId,
  item,
  canMarkRead,
  reading,
  mobileVisible,
  onBack,
  onMarkRead,
  onAnswerStart,
  onAnswered,
}: {
  orgId: string
  employeeId: string | null | undefined
  item: InboxPublic | undefined
  canMarkRead: boolean
  reading: boolean
  mobileVisible: boolean
  onBack: () => void
  onMarkRead: () => void
  onAnswerStart: () => void
  onAnswered: () => void
}) {
  const { t } = useTranslation()
  const target = item ? resolveInboxTarget(item) : null
  const hasDetailBody =
    !!item &&
    Boolean(
      item.question_id ||
        item.request_id ||
        item.workload_request_id ||
        item.extension_request_id ||
        target,
    )
  return (
    <div
      className={cn(
        "min-w-0 p-3 md:max-h-[calc(100dvh-3rem)] md:overflow-y-auto md:p-4",
        (!item || !mobileVisible) && "hidden md:block",
      )}
    >
      {item && (
        <>
          <Button
            className="mb-2 md:hidden"
            variant="ghost"
            size="sm"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden="true" /> {t("inbox.detailPane.backToList")}
          </Button>
          <SectionCard
            aria-label={t("inbox.detailPane.ariaLabel")}
            className="p-0"
          >
            <header className="flex flex-wrap items-center gap-2 border-surface-border border-b px-3 py-2 sm:px-4">
              <KindBadge kind={item.kind} />
              <time
                dateTime={item.created_at}
                className="text-xs text-muted-foreground"
              >
                {dateLabel(item.created_at)}
              </time>
              {canMarkRead && (
                <Button
                  className="ml-auto"
                  variant="ghost"
                  size="sm"
                  disabled={reading}
                  onClick={onMarkRead}
                >
                  {t("inbox.detailPane.markRead")}
                </Button>
              )}
            </header>
            <h2 className="whitespace-pre-wrap wrap-anywhere px-3 py-3 text-base font-semibold sm:px-4">
              {messageText(item)}
            </h2>
            {hasDetailBody && (
              <div className="space-y-3 border-surface-border border-t p-3 sm:p-4">
                {(item.request_id ||
                  item.workload_request_id ||
                  item.extension_request_id) && (
                  <InboxApprovalDetail
                    key={item.id}
                    orgId={orgId}
                    item={item}
                    employeeId={employeeId}
                    onActionClick={onMarkRead}
                  />
                )}
                {item.question_id && (
                  <QuestionAnswer
                    key={item.question_id}
                    orgId={orgId}
                    questionId={item.question_id}
                    onAnswerStart={onAnswerStart}
                    onAnswered={onAnswered}
                  />
                )}
                {target && (
                  <InboxTargetButton item={item} onClick={onMarkRead} />
                )}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  )
}
