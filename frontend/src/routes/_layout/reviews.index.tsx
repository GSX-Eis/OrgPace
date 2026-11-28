import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ChevronDown } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { DemandPublic, PendingReviews } from "@/client"
import { Approvals } from "@/components/Capacity/Approvals"
import { BorrowRequestCard } from "@/components/Capacity/BorrowRequests"
import { WorkspacePage } from "@/components/Common/WorkbenchPrimitives"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import {
  requestClientName,
  viaLabels,
} from "@/components/Profile/RequestTimeline"
import { Button } from "@/components/ui/button"
import { useOrg } from "@/hooks/useOrg"
import {
  PENDING_DEMAND_PAGE_SIZE,
  pendingDemandPageOptions,
  usePendingApprovals,
} from "@/hooks/usePendingApprovals"
import i18n from "@/i18n"
import { formatDate, formatDateRange } from "@/i18n/format"
import { cn } from "@/lib/utils"

const filterKeys = ["all", "profile", "workload", "demand", "borrow"] as const

type ApprovalType = (typeof filterKeys)[number]

const filterStyles = {
  all: "aria-[current=page]:border-primary/40 aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary",
  profile:
    "aria-[current=page]:border-primary/40 aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary",
  workload:
    "aria-[current=page]:border-muted-foreground/40 aria-[current=page]:bg-muted",
  demand:
    "aria-[current=page]:border-amber-500/40 aria-[current=page]:bg-amber-500/10 aria-[current=page]:text-amber-800 dark:aria-[current=page]:text-amber-300",
  borrow:
    "aria-[current=page]:border-violet-500/40 aria-[current=page]:bg-violet-500/10 aria-[current=page]:text-violet-700 dark:aria-[current=page]:text-violet-300",
}

const rowClass =
  "flex min-h-11 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm"
const badgeClass =
  "rounded-full border border-surface-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"

export const Route = createFileRoute("/_layout/reviews/")({
  component: ReviewsPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { type?: ApprovalType } => ({
    type:
      typeof search.type === "string" &&
      (filterKeys as readonly string[]).includes(search.type)
        ? (search.type as ApprovalType)
        : undefined,
  }),
  head: () => ({ meta: [{ title: i18n.t("reviews.list.pageTitle") }] }),
})

function ReviewsPage() {
  const { t } = useTranslation()
  const filters: Record<ApprovalType, string> = {
    all: t("reviews.list.filters.all"),
    profile: t("reviews.list.filters.profile"),
    workload: t("reviews.list.filters.workload"),
    demand: t("reviews.list.filters.demand"),
    borrow: t("reviews.list.filters.borrow"),
  }
  const { type = "all" } = Route.useSearch()
  const { org, employeeId } = useOrg()
  const pending = usePendingApprovals()
  if (!org) return <OrgState />
  const { capacity, profile, counts, totalCount } = pending
  const sections = [
    {
      type: "profile",
      queries: [profile],
      count: counts.profile,
      content: <ProfileReviews data={profile.data} />,
    },
    {
      type: "workload",
      queries: pending.workloadQueries,
      count: counts.workload,
      content: (
        <Approvals
          orgId={org.id}
          pendingWorkloads={pending.pendingWorkloads}
          pendingExtensions={pending.pendingExtensions}
        />
      ),
    },
    {
      type: "demand",
      queries: pending.demandQueries,
      count: counts.demand,
      content: (
        <DemandReviews
          key={org.id}
          orgId={org.id}
          employeeId={employeeId}
          firstPage={pending.demands}
          count={counts.demand}
        />
      ),
    },
    {
      type: "borrow",
      queries: pending.borrowQueries,
      count: counts.borrow,
      content: pending.borrows.map(({ request, mine }) => (
        <details
          key={request.id}
          className="group border-surface-border border-b last:border-0"
        >
          <summary
            className={cn(
              rowClass,
              "cursor-pointer list-none hover:bg-muted/60 [&::-webkit-details-marker]:hidden",
            )}
          >
            <span className={badgeClass}>{t("reviews.list.borrowBadge")}</span>
            <span className="min-w-0 grow wrap-anywhere font-medium">
              {request.capability_name} · {request.borrower_department} ·{" "}
              {request.description}
            </span>
            <span className="text-xs text-muted-foreground">
              {mine
                ? t("reviews.list.borrowMine")
                : t("reviews.list.borrowSelect")}
            </span>
            <span className="ml-auto inline-flex items-center gap-1 text-primary">
              {t("reviews.list.handleAction")}{" "}
              <ChevronDown
                aria-hidden="true"
                className="size-4 group-open:rotate-180"
              />
            </span>
          </summary>
          <div className="p-3">
            <BorrowRequestCard orgId={org.id} request={request} mine={mine} />
          </div>
        </details>
      )),
    },
  ] as const
  return (
    <WorkspacePage className="space-y-3">
      <header>
        <h1 className="sr-only">{t("reviews.list.heading")}</h1>
        <nav
          aria-label={t("reviews.list.filterNavAria")}
          className="flex flex-wrap gap-2"
        >
          {filterKeys.map((filter) => (
            <Link
              key={filter}
              to="/reviews"
              search={{ type: filter === "all" ? undefined : filter }}
              activeOptions={{
                exact: true,
                includeSearch: true,
                explicitUndefined: true,
              }}
              aria-current={type === filter ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-surface-border bg-surface px-3 py-1 text-sm hover:bg-muted aria-[current=page]:font-medium",
                filterStyles[filter],
              )}
            >
              {filters[filter]}
              <span className="tabular-nums">
                {filter === "all" ? totalCount : counts[filter]}
              </span>
            </Link>
          ))}
        </nav>
      </header>
      {type !== "profile" && capacity.isLoading && <ProfileLoading />}
      {type !== "profile" && capacity.isError && (
        <ProfileError retry={() => capacity.refetch()} />
      )}
      {type === "all" &&
        !totalCount &&
        capacity.isSuccess &&
        sections.every(({ queries }) =>
          queries.every((query) => query.isSuccess),
        ) && (
          <p role="status" className="text-muted-foreground">
            {t("reviews.list.emptyAll")}
          </p>
        )}
      <div className="divide-y divide-surface-border rounded-lg border border-surface-border bg-surface empty:hidden">
        {sections
          .filter(
            ({ type: sectionType }) =>
              (type === "all" || sectionType === type) &&
              (sectionType === "profile" || capacity.isSuccess),
          )
          .map((section) => {
            const loading = section.queries.some((query) => query.isPending)
            const failed = section.queries.some((query) => query.isError)
            if (type === "all" && !section.count && !loading && !failed)
              return null
            return (
              <section
                key={section.type}
                aria-label={filters[section.type]}
                className="min-w-0"
              >
                <h2 className="sr-only">{filters[section.type]}</h2>
                {loading ? (
                  <ProfileLoading />
                ) : failed ? (
                  <ProfileError
                    retry={() =>
                      section.queries.forEach((query) => void query.refetch())
                    }
                  />
                ) : section.type === "profile" ||
                  section.type === "workload" ||
                  section.count ? (
                  section.content
                ) : (
                  <p
                    role="status"
                    className="p-3 text-sm text-muted-foreground"
                  >
                    {t("reviews.list.emptyAll")}
                  </p>
                )}
              </section>
            )
          })}
      </div>
    </WorkspacePage>
  )
}

function DemandReviews({
  orgId,
  employeeId,
  firstPage,
  count,
}: {
  orgId: string
  employeeId?: string | null
  firstPage: DemandPublic[]
  count: number
}) {
  const { t } = useTranslation()
  const [skip, setSkip] = useState(0)
  const laterPage = useQuery({
    ...pendingDemandPageOptions(orgId, skip),
    enabled: skip > 0,
  })
  const rows = skip
    ? (laterPage.data?.data.filter((row) => row.can_reply === true) ?? [])
    : firstPage
  return (
    <>
      {(count > PENDING_DEMAND_PAGE_SIZE || skip > 0) && (
        <nav
          aria-label={t("reviews.list.demand.paginationAria")}
          className="flex items-center justify-between gap-2 border-surface-border border-b p-2"
        >
          <Button
            variant="outline"
            disabled={skip === 0}
            onClick={() => setSkip(skip - PENDING_DEMAND_PAGE_SIZE)}
          >
            {t("reviews.list.demand.prevPage")}
          </Button>
          <span role="status" className="text-sm">
            {t("reviews.list.demand.pageSummary", {
              page: skip / PENDING_DEMAND_PAGE_SIZE + 1,
              count,
            })}
          </span>
          <Button
            variant="outline"
            disabled={
              skip + PENDING_DEMAND_PAGE_SIZE >= count ||
              (skip > 0 && !laterPage.isSuccess)
            }
            onClick={() => setSkip(skip + PENDING_DEMAND_PAGE_SIZE)}
          >
            {t("reviews.list.demand.nextPage")}
          </Button>
        </nav>
      )}
      {skip > 0 && laterPage.isPending ? (
        <ProfileLoading />
      ) : skip > 0 && laterPage.isError ? (
        <ProfileError retry={() => laterPage.refetch()} />
      ) : rows.length ? (
        rows.map((row) => (
          <article
            key={row.id}
            className={cn(
              rowClass,
              "border-surface-border border-b last:border-0",
            )}
          >
            <span className={badgeClass}>
              {row.status === "replied"
                ? t("reviews.list.demand.legacyRepliedBadge")
                : t("reviews.list.demand.badge")}
            </span>
            <div className="min-w-0 grow basis-40 wrap-anywhere">
              <h3 className="truncate font-medium">
                {row.capability_name}
                {row.project &&
                  ` · ${row.project.title} · ${row.project.role_name}`}
              </h3>
              <p
                className="truncate text-xs text-muted-foreground"
                title={row.description}
              >
                {row.description}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {formatDateRange(row.window_start, row.window_end)}
            </p>
            <div className="ml-auto flex flex-wrap gap-1">
              <Button size="sm" variant="outline" asChild>
                <Link
                  to="/capacity"
                  search={{ tab: "incoming", demand: row.id }}
                >
                  {t("reviews.list.demand.viewDetails")}
                </Link>
              </Button>
              {employeeId && (
                <Button size="sm" variant="outline" asChild>
                  <Link
                    to="/assistant"
                    search={{
                      mode: "personal",
                      prompt: t("reviews.list.demand.assistantPrompt", {
                        id: row.id,
                        capability: row.capability_name,
                        start: row.window_start,
                        end: row.window_end,
                      }),
                    }}
                  >
                    {t("reviews.list.demand.draftWithAssistant")}
                  </Link>
                </Button>
              )}
            </div>
          </article>
        ))
      ) : (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          {t("reviews.list.demand.empty")}
        </p>
      )}
    </>
  )
}

function ProfileReviews({ data }: { data?: PendingReviews }) {
  const { t } = useTranslation()
  return (
    <>
      <p
        role="status"
        className={
          data?.count ? "sr-only" : "p-3 text-sm text-muted-foreground"
        }
      >
        {t("reviews.list.profile.countStatus", { count: data?.count ?? 0 })}
      </p>
      <ul className="divide-y divide-surface-border">
        {(data?.data ?? []).map((request) => {
          const via = request.submitted_via
          const source =
            via === "mcp"
              ? t("reviews.list.profile.mcpSource")
              : via === "web"
                ? t("reviews.list.profile.webSource")
                : via && viaLabels[via]
          return (
            <li key={request.id} className={rowClass}>
              <span className={cn(badgeClass, "bg-primary/10 text-primary")}>
                {t("reviews.list.profile.badge")}
              </span>
              <h3 className="min-w-0 grow basis-40 wrap-anywhere font-medium">
                {request.employee_name}
                <span className="ml-2 font-normal text-muted-foreground">
                  {request.department_name ??
                    t("reviews.list.profile.deptEmpty")}
                </span>
              </h3>
              <span>
                {t("reviews.list.profile.itemCount", {
                  count: request.item_count,
                })}
              </span>
              {!request.owner_reviewed && (
                <span className="text-xs text-amber-700 dark:text-amber-300">
                  {t("reviews.list.profile.ownerUnreviewed")}
                </span>
              )}
              {source && (
                <span
                  className={cn(
                    badgeClass,
                    "wrap-anywhere",
                    via === "mcp" &&
                      "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300",
                    via === "bot" && "bg-primary/10 text-primary",
                  )}
                >
                  {source}
                  {request.client_name &&
                    ` · ${requestClientName(request.client_name, via)}`}
                </span>
              )}
              {request.submitted_at && (
                <time
                  dateTime={request.submitted_at}
                  className="text-xs whitespace-nowrap text-muted-foreground"
                >
                  {formatDate(request.submitted_at, {
                    year: "numeric",
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false,
                  })}
                </time>
              )}
              {request.can_decide ? (
                <Button size="sm" variant="outline" className="ml-auto" asChild>
                  <Link
                    to="/reviews/$requestId"
                    params={{ requestId: request.id }}
                  >
                    {t("reviews.list.profile.reviewAction")}
                  </Link>
                </Button>
              ) : (
                <p
                  role="status"
                  className="ml-auto text-xs text-muted-foreground"
                >
                  {request.unavailable_reason}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
