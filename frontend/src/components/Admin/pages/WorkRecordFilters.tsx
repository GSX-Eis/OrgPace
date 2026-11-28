import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useSearch } from "@tanstack/react-router"
import { ChevronDown } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AccountsService,
  OrgsService,
  SourcesService,
  type SyncRunPublic,
  type WorkRecordsPublic,
} from "@/client"
import { departmentOptions } from "@/components/Admin/departments"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { formatTime } from "./WorkRecordResults"

interface FilterOption {
  id: string
  label: string
}

function SearchableFilterPicker({
  id,
  ariaLabel,
  title,
  allLabel,
  searchLabel,
  searchPlaceholder,
  value,
  selectedLabel,
  search,
  onSearchChange,
  items,
  totalCount,
  isPending,
  isError,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRetry,
  onSelect,
  triggerClassName,
}: {
  id: string
  ariaLabel: string
  title: string
  allLabel: string
  searchLabel: string
  searchPlaceholder: string
  value: string
  selectedLabel: string | null
  search: string
  onSearchChange: (value: string) => void
  items: FilterOption[]
  totalCount: number | undefined
  isPending: boolean
  isError: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
  onRetry: () => void
  onSelect: (id: string, label: string | null) => void
  triggerClassName: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        id={id}
        type="button"
        variant="outline"
        size="sm"
        aria-label={ariaLabel}
        className={`h-8 justify-between font-normal ${triggerClassName}`}
        onClick={() => setOpen(true)}
      >
        <span className="truncate">
          {value === "all"
            ? allLabel
            : (selectedLabel ??
              t("sources.workRecords.pickerSelectedFallback"))}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 opacity-50"
        />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("sources.workRecords.pickerDialogDesc")}
          </DialogDescription>
          <Input
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          <div className="max-h-72 space-y-1 overflow-y-auto">
            <Button
              type="button"
              variant={value === "all" ? "secondary" : "ghost"}
              size="sm"
              className="h-auto w-full justify-start whitespace-normal text-left"
              onClick={() => {
                onSelect("all", null)
                setOpen(false)
              }}
            >
              {allLabel}
            </Button>
            {isPending && (
              <p role="status" className="py-2 text-sm text-muted-foreground">
                {t("sources.workRecords.pickerLoading")}
              </p>
            )}
            {isError && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetry}
              >
                {t("sources.workRecords.pickerRetry")}
              </Button>
            )}
            {items.map((item) => (
              <Button
                key={item.id}
                type="button"
                variant={value === item.id ? "secondary" : "ghost"}
                size="sm"
                className="h-auto w-full justify-start whitespace-normal text-left"
                onClick={() => {
                  onSelect(item.id, item.label)
                  setOpen(false)
                }}
              >
                {item.label}
              </Button>
            ))}
            {!isPending && !isError && items.length === 0 && (
              <p className="py-2 text-sm text-muted-foreground">
                {t("sources.workRecords.pickerEmpty")}
              </p>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {t("sources.workRecords.pickerTotal", {
                count: totalCount ?? items.length,
              })}
            </span>
            {hasNextPage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isFetchingNextPage}
                onClick={onLoadMore}
              >
                {isFetchingNextPage
                  ? t("sources.workRecords.pickerLoadingMore")
                  : t("sources.workRecords.pickerLoadMore")}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function useWorkRecordFilters(orgId: string) {
  const { t } = useTranslation()
  const search = useSearch({ from: "/_layout/admin/data-ai" })
  const [source, setSource] = useState(search.source ?? "all")
  const [employeeId, setEmployeeId] = useState("all")
  const [selectedEmployeeLabel, setSelectedEmployeeLabel] = useState<
    string | null
  >(null)
  const [employeeSearch, setEmployeeSearch] = useState("")
  const [departmentId, setDepartmentId] = useState("all")
  const [syncRunId, setSyncRunId] = useState(search.sync_run_id ?? "all")
  const [selectedSyncRunLabel, setSelectedSyncRunLabel] = useState<
    string | null
  >(null)
  const [syncRunSearch, setSyncRunSearch] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 })

  useEffect(() => {
    setSource(search.source ?? "all")
    setSyncRunId(search.sync_run_id ?? "all")
    setSelectedSyncRunLabel(null)
    setPagination((old) => ({ ...old, pageIndex: 0 }))
  }, [search.source, search.sync_run_id])

  const resetPage = () => setPagination((old) => ({ ...old, pageIndex: 0 }))

  const departments = useQuery({
    queryKey: ["departments", orgId],
    queryFn: async () =>
      (await OrgsService.readDepartments({ path: { org_id: orgId } })).data,
  })
  const employees = useInfiniteQuery({
    queryKey: ["accounts", orgId, "work-record-filter", employeeSearch],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (
        await AccountsService.readAccounts({
          path: { org_id: orgId },
          query: {
            q: employeeSearch.trim() || undefined,
            skip: pageParam,
            limit: 50,
          },
        })
      ).data,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.data.length, 0)
      return loaded < lastPage.count ? loaded : undefined
    },
  })
  const syncRuns = useInfiniteQuery({
    queryKey: ["sync-runs", orgId, "work-record-filter", syncRunSearch],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (
        await SourcesService.listSyncRuns({
          path: { org_id: orgId },
          query: {
            q: syncRunSearch.trim() || undefined,
            skip: pageParam,
            limit: 50,
          },
        })
      ).data,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.data.length, 0)
      return loaded < lastPage.count ? loaded : undefined
    },
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: departmentOptions uses the current locale internally.
  const deptList = useMemo(
    () => departmentOptions(departments.data?.data ?? []),
    [departments.data, t],
  )
  const employeeItems = useMemo(
    () =>
      (employees.data?.pages ?? []).flatMap((page) =>
        page.data.map((emp) => ({
          id: emp.id,
          label: emp.employee_code
            ? t("sources.workRecords.employeeOptionWithCode", {
                name: emp.display_name,
                code: emp.employee_code,
              })
            : emp.display_name,
        })),
      ),
    [employees.data, t],
  )
  const syncRunItems = useMemo(() => {
    const formatSyncRunLabel = (run: SyncRunPublic) =>
      `${run.kind === "jira" ? t("sources.workRecords.syncRunJira") : t("sources.workRecords.syncRunCsv", { filename: run.filename ?? t("sources.workRecords.syncRunCsvDefault") })} · ${formatTime(run.created_at)}`

    return (syncRuns.data?.pages ?? []).flatMap((page) =>
      page.data.map((run) => ({
        id: run.id,
        label: formatSyncRunLabel(run),
      })),
    )
  }, [syncRuns.data, t])
  const resolvedSyncRunLabel =
    selectedSyncRunLabel ??
    syncRunItems.find((item) => item.id === syncRunId)?.label ??
    null
  const hasFilter =
    source !== "all" ||
    employeeId !== "all" ||
    departmentId !== "all" ||
    syncRunId !== "all" ||
    Boolean(dateFrom) ||
    Boolean(dateTo)

  return {
    source,
    setSource,
    employeeId,
    setEmployeeId,
    selectedEmployeeLabel,
    setSelectedEmployeeLabel,
    employeeSearch,
    setEmployeeSearch,
    departmentId,
    setDepartmentId,
    syncRunId,
    setSyncRunId,
    resolvedSyncRunLabel,
    setSelectedSyncRunLabel,
    syncRunSearch,
    setSyncRunSearch,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    pagination,
    setPagination,
    resetPage,
    deptList,
    employeeItems,
    syncRunItems,
    employees,
    syncRuns,
    hasFilter,
  }
}

export function WorkRecordFilters({
  filters,
  records,
}: {
  filters: ReturnType<typeof useWorkRecordFilters>
  records?: WorkRecordsPublic
}) {
  const { t } = useTranslation()
  const {
    source,
    setSource,
    employeeId,
    setEmployeeId,
    selectedEmployeeLabel,
    setSelectedEmployeeLabel,
    employeeSearch,
    setEmployeeSearch,
    departmentId,
    setDepartmentId,
    syncRunId,
    setSyncRunId,
    resolvedSyncRunLabel,
    setSelectedSyncRunLabel,
    syncRunSearch,
    setSyncRunSearch,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    resetPage,
    deptList,
    employeeItems,
    syncRunItems,
    employees,
    syncRuns,
    hasFilter,
  } = filters
  const csvSources = useMemo(
    () => (records?.sources ?? []).filter((item) => item.value !== "jira"),
    [records?.sources],
  )
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-surface-border bg-surface px-3 py-2.5 text-sm">
      <div className="space-y-1">
        <Label htmlFor="wr-source" className="text-xs text-muted-foreground">
          {t("sources.workRecords.filterSourceLabel")}
        </Label>
        <Select
          value={source}
          onValueChange={(value) => {
            setSource(value)
            resetPage()
          }}
        >
          <SelectTrigger
            id="wr-source"
            aria-label={t("sources.workRecords.filterSourceAria")}
            size="sm"
            className="w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t("sources.workRecords.allSources")}
            </SelectItem>
            <SelectItem value="jira">Jira</SelectItem>
            <SelectItem value="csv">
              {t("sources.workRecords.allCsv")}
            </SelectItem>
            {csvSources.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t("sources.workRecords.csvOption", { label: option.label })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="wr-employee" className="text-xs text-muted-foreground">
          {t("sources.workRecords.filterEmployeeLabel")}
        </Label>
        <SearchableFilterPicker
          id="wr-employee"
          ariaLabel={t("sources.workRecords.filterEmployeeAria")}
          title={t("sources.workRecords.filterEmployeeTitle")}
          allLabel={t("sources.workRecords.allEmployees")}
          searchLabel={t("sources.workRecords.filterEmployeeSearchLabel")}
          searchPlaceholder={t(
            "sources.workRecords.filterEmployeeSearchPlaceholder",
          )}
          value={employeeId}
          selectedLabel={selectedEmployeeLabel}
          search={employeeSearch}
          onSearchChange={setEmployeeSearch}
          items={employeeItems}
          totalCount={employees.data?.pages[0]?.count}
          isPending={employees.isPending}
          isError={employees.isError}
          hasNextPage={Boolean(employees.hasNextPage)}
          isFetchingNextPage={employees.isFetchingNextPage}
          onLoadMore={() => employees.fetchNextPage()}
          onRetry={() => employees.refetch()}
          onSelect={(value, label) => {
            setEmployeeId(value)
            setSelectedEmployeeLabel(label)
            resetPage()
          }}
          triggerClassName="w-44"
        />
      </div>

      <div className="space-y-1">
        <Label
          htmlFor="wr-department"
          className="text-xs text-muted-foreground"
        >
          {t("sources.workRecords.filterDepartmentLabel")}
        </Label>
        <Select
          value={departmentId}
          onValueChange={(value) => {
            setDepartmentId(value)
            resetPage()
          }}
        >
          <SelectTrigger
            id="wr-department"
            aria-label={t("sources.workRecords.filterDepartmentAria")}
            size="sm"
            className="w-44"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t("sources.workRecords.allDepartments")}
            </SelectItem>
            {deptList.map((dept) => (
              <SelectItem key={dept.id} value={dept.id}>
                {dept.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="wr-batch" className="text-xs text-muted-foreground">
          {t("sources.workRecords.filterBatchLabel")}
        </Label>
        <SearchableFilterPicker
          id="wr-batch"
          ariaLabel={t("sources.workRecords.filterBatchAria")}
          title={t("sources.workRecords.filterBatchTitle")}
          allLabel={t("sources.workRecords.allBatches")}
          searchLabel={t("sources.workRecords.filterBatchSearchLabel")}
          searchPlaceholder={t(
            "sources.workRecords.filterBatchSearchPlaceholder",
          )}
          value={syncRunId}
          selectedLabel={resolvedSyncRunLabel}
          search={syncRunSearch}
          onSearchChange={setSyncRunSearch}
          items={syncRunItems}
          totalCount={syncRuns.data?.pages[0]?.count}
          isPending={syncRuns.isPending}
          isError={syncRuns.isError}
          hasNextPage={Boolean(syncRuns.hasNextPage)}
          isFetchingNextPage={syncRuns.isFetchingNextPage}
          onLoadMore={() => syncRuns.fetchNextPage()}
          onRetry={() => syncRuns.refetch()}
          onSelect={(value, label) => {
            setSyncRunId(value)
            setSelectedSyncRunLabel(label)
            resetPage()
          }}
          triggerClassName="w-56"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="wr-from" className="text-xs text-muted-foreground">
          {t("sources.workRecords.filterFromLabel")}
        </Label>
        <Input
          id="wr-from"
          aria-label={t("sources.workRecords.filterFromLabel")}
          type="date"
          value={dateFrom}
          onChange={(event) => {
            setDateFrom(event.target.value)
            resetPage()
          }}
          className="h-8 w-36 text-xs"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="wr-to" className="text-xs text-muted-foreground">
          {t("sources.workRecords.filterToLabel")}
        </Label>
        <Input
          id="wr-to"
          aria-label={t("sources.workRecords.filterToLabel")}
          type="date"
          value={dateTo}
          onChange={(event) => {
            setDateTo(event.target.value)
            resetPage()
          }}
          className="h-8 w-36 text-xs"
        />
      </div>

      {hasFilter && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs"
          onClick={() => {
            setSource("all")
            setEmployeeId("all")
            setSelectedEmployeeLabel(null)
            setDepartmentId("all")
            setSyncRunId("all")
            setSelectedSyncRunLabel(null)
            setDateFrom("")
            setDateTo("")
            resetPage()
          }}
        >
          {t("sources.workRecords.resetFilters")}
        </Button>
      )}

      <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {t("sources.workRecords.totalCount", {
          count: records?.count ?? "—",
        })}
      </span>
    </div>
  )
}
