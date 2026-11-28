import { useMutation, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CheckCheck } from "lucide-react"
import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  EmployeeRequestsService,
  type InboxKind,
  type InboxList,
  type InboxPublic,
  type InboxReadAllInput,
} from "@/client"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { WorkspacePage } from "@/components/Common/WorkbenchPrimitives"
import { InboxDetailPane } from "@/components/Inbox/InboxDetailPane"
import { InboxListPane } from "@/components/Inbox/InboxListPane"
import { OrgState } from "@/components/Profile/OrgState"
import { Button } from "@/components/ui/button"
import { useInbox } from "@/hooks/useInbox"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"
import { handleError } from "@/utils"

export const Route = createFileRoute("/_layout/inbox")({
  component: InboxPage,
  head: () => ({ meta: [{ title: i18n.t("inbox.pageTitle") }] }),
})

function InboxPage() {
  const { org, employeeId } = useOrg()
  if (!org) return <OrgState />
  return (
    <InboxContent
      key={`${org.id}:${employeeId}`}
      orgId={org.id}
      employeeId={employeeId}
    />
  )
}

function InboxContent({
  orgId,
  employeeId,
}: {
  orgId: string
  employeeId: string | null | undefined
}) {
  const { t } = useTranslation()
  const [skip, setSkip] = useState(0)
  const [selected, setSelected] = useState<{
    item: InboxPublic
    answered?: boolean
  } | null>(null)
  const [pendingOnly, setPendingOnly] = useState(false)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [kind, setKind] = useState<InboxKind>()
  const [error, setError] = useState("")
  const query = useInbox({ skip, pendingOnly, unreadOnly, kind })
  const cache = useQueryClient()
  const pendingReadIds = useRef(new Set<string>())
  const read = useMutation({
    mutationFn: (id: string) =>
      EmployeeRequestsService.readInboxItem({
        path: { org_id: orgId, inbox_id: id },
      }),
    onMutate: async (id) => {
      setError("")
      pendingReadIds.current.add(id)
      await cache.cancelQueries({ queryKey: ["inbox", orgId] })
      const previous = cache.getQueriesData<InboxList>({
        queryKey: ["inbox", orgId],
      })
      const now = new Date().toISOString()
      cache.setQueriesData<InboxList>(
        { queryKey: ["inbox", orgId] },
        (data) => {
          if (!data) return data
          const target = data.data.find((row) => row.id === id)
          if (target?.read_at) return data
          return {
            ...data,
            unread_count: Math.max(0, data.unread_count - 1),
            filtered_unread_count: target
              ? Math.max(0, data.filtered_unread_count - 1)
              : data.filtered_unread_count,
            data: data.data.map((row) =>
              row.id === id && !row.read_at ? { ...row, read_at: now } : row,
            ),
          }
        },
      )
      setSelected((current) =>
        current?.item.id === id && !current.item.read_at
          ? { ...current, item: { ...current.item, read_at: now } }
          : current,
      )
      return { previous }
    },
    onError: (err, id, context) => {
      for (const [key, snapshot] of context?.previous ?? []) {
        cache.setQueryData(key, snapshot)
      }
      setSelected((current) =>
        current?.item.id === id
          ? { ...current, item: { ...current.item, read_at: null } }
          : current,
      )
      handleError.call(setError, err)
    },
    onSettled: (_data, _err, id) => {
      pendingReadIds.current.delete(id)
      cache.invalidateQueries({ queryKey: ["inbox", orgId] })
    },
  })
  const readAll = useMutation({
    mutationFn: (filters: InboxReadAllInput) =>
      EmployeeRequestsService.readAllInbox({
        path: { org_id: orgId },
        body: filters,
      }),
    onMutate: () => setError(""),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["inbox", orgId] }),
    onError: (err) => handleError.call(setError, err),
  })
  const rows = query.data?.data ?? []
  if (skip > 0 && query.isSuccess && !query.isFetching && !rows.length) {
    setSkip(0)
    if (!selected?.answered) setSelected(null)
  }
  const currentRow = selected
    ? rows.find((row) => row.id === selected.item.id)
    : rows[0]
  const item = currentRow ?? selected?.item
  const filtered = pendingOnly || unreadOnly || kind !== undefined
  const reading = read.isPending || readAll.isPending
  const markItemRead = (id: string) => {
    if (!pendingReadIds.current.has(id)) read.mutate(id)
  }
  const openItem = (row: InboxPublic) => {
    setSelected({ item: row })
    if (!row.read_at) markItemRead(row.id)
  }
  const markRead = () => {
    if (currentRow && !currentRow.read_at) markItemRead(currentRow.id)
  }
  return (
    <WorkspacePage
      variant="split"
      className="grid items-start md:grid-cols-[minmax(0,min(360px,44%))_minmax(0,1fr)]"
    >
      <h1 className="sr-only">{t("inbox.heading")}</h1>
      <TopbarActions>
        <Button
          variant="outline"
          size="sm"
          title={
            filtered
              ? t("inbox.toolbar.markFilteredTitle")
              : t("inbox.toolbar.markAllTitle")
          }
          disabled={!query.data?.filtered_unread_count || reading}
          onClick={() =>
            readAll.mutate({
              pending_only: pendingOnly,
              unread_only: unreadOnly,
              kind,
            })
          }
        >
          <CheckCheck aria-hidden="true" />
          {filtered
            ? t("inbox.toolbar.markFiltered")
            : t("inbox.toolbar.markAll")}
        </Button>
      </TopbarActions>
      <p role="status" className="sr-only">
        {t("inbox.toolbar.statusSummary", {
          unread: query.data?.unread_count ?? 0,
          pending: query.data?.pending_count ?? 0,
        })}
      </p>
      {error && (
        <p
          role="alert"
          className="px-3 py-2 text-sm text-destructive md:col-span-2"
        >
          {error}
        </p>
      )}
      <InboxListPane
        data={query.data}
        isPending={query.isPending}
        isError={query.isError}
        refetch={() => query.refetch()}
        rows={rows}
        selectedId={item?.id}
        hasSelection={Boolean(item && selected)}
        pendingOnly={pendingOnly}
        unreadOnly={unreadOnly}
        kind={kind}
        skip={skip}
        onPendingChange={(pending) => {
          setPendingOnly(pending)
          setSelected(null)
          setSkip(0)
        }}
        onUnreadChange={(checked) => {
          setUnreadOnly(checked)
          setSelected(null)
          setSkip(0)
        }}
        onKindChange={(nextKind) => {
          setKind(nextKind)
          setSelected(null)
          setSkip(0)
        }}
        onPageChange={(nextSkip) => {
          setSkip(nextSkip)
          setSelected(null)
        }}
        onSelect={openItem}
      />
      <InboxDetailPane
        orgId={orgId}
        employeeId={employeeId}
        item={item}
        canMarkRead={Boolean(currentRow && !currentRow.read_at)}
        reading={reading}
        mobileVisible={Boolean(selected)}
        onBack={() => setSelected(null)}
        onMarkRead={markRead}
        onAnswerStart={() => item && setSelected({ item })}
        onAnswered={() =>
          item &&
          setSelected((selection) =>
            selection?.item.id === item.id
              ? { ...selection, answered: true }
              : selection,
          )
        }
      />
    </WorkspacePage>
  )
}
