import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AxiosError } from "axios"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CapacityService, type WeekLoad, type WorkloadPublic } from "@/client"
import { HelpTip } from "@/components/Common/WorkbenchPrimitives"
import { Badge } from "@/components/ui/badge"
import i18n, { getLocale } from "@/i18n"
import { formatDate, formatDateRange, formatPercent } from "@/i18n/format"
import { cn } from "@/lib/utils"
import { capacityKeys } from "./queries"

export { addWeeks } from "./dateUtils"

export function isCapacityAccessDenied(error: unknown) {
  return (
    error instanceof AxiosError &&
    [403, 404].includes(error.response?.status ?? 0)
  )
}

export function useCapacitySettings(orgId?: string) {
  return useQuery({
    queryKey: capacityKeys.settings(orgId),
    queryFn: async () =>
      (await CapacityService.getCapacitySettings({ path: { org_id: orgId! } }))
        .data,
    enabled: !!orgId,
    refetchOnWindowFocus: true,
  })
}

function isCapacityDisabled(error: unknown, orgId: string) {
  const detail =
    error instanceof AxiosError ? error.response?.data?.detail : undefined
  return (
    error instanceof AxiosError &&
    error.response?.status === 404 &&
    (detail === "规划与负荷功能未开启" || // i18n-ignore: 匹配后端返回的中文功能未开启错误
      detail === "Planning and workload features are not enabled" ||
      detail === "Planning and capacity features are not enabled") &&
    !!error.config?.url &&
    new URL(error.config.url, window.location.origin).pathname.startsWith(
      `/api/v1/orgs/${orgId}/capacity/`,
    )
  )
}

export function useCapacityDisabled(orgId?: string) {
  const client = useQueryClient()
  const [disabledOrgId, setDisabledOrgId] = useState<string>()
  useEffect(() => {
    setDisabledOrgId(undefined)
    if (!orgId) return
    const handleError = (error: unknown) => {
      if (!isCapacityDisabled(error, orgId)) return
      setDisabledOrgId(orgId)
      client.invalidateQueries({ queryKey: capacityKeys.settings(orgId) })
    }
    const unsubscribeQueries = client.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "success" &&
        event.query.queryKey[0] === "capacity-settings" &&
        event.query.queryKey[1] === orgId
      )
        setDisabledOrgId(undefined)
      if (
        event.type === "updated" &&
        (event.action.type === "error" || event.action.type === "failed")
      )
        handleError(event.action.error)
    })
    const unsubscribeMutations = client
      .getMutationCache()
      .subscribe((event) => {
        if (event.type === "updated" && event.action.type === "error")
          handleError(event.action.error)
      })
    return () => {
      unsubscribeQueries()
      unsubscribeMutations()
    }
  }, [client, orgId])
  return !!orgId && disabledOrgId === orgId
}

const bandKeys = {
  unconfirmed: "capacity.bands.unconfirmed",
  available: "capacity.bands.available",
  full: "capacity.bands.full",
  overloaded: "capacity.bands.overloaded",
} as const

export function formatCapacityPercent(value: number) {
  return formatPercent(value / 100, { maximumFractionDigits: 2 })
}

export function formatIsoDate(date: string) {
  return getLocale() === "zh-CN" ? date : formatDate(date)
}

export function formatIsoDateRange(start: string, end: string) {
  return getLocale() === "zh-CN"
    ? `${start} 至 ${end}` // i18n-ignore: zh-CN 专用 ISO 日期区间连接词（NERE-1438）
    : formatDateRange(start, end)
}

export function formatDateOptional(value: string | null | undefined) {
  if (!value) return "—"
  return getLocale() === "zh-CN" ? value.slice(0, 10) : formatDate(value)
}

export function WorkloadBand({ band }: Pick<WorkloadPublic, "band">) {
  const { t } = useTranslation()
  return (
    <Badge variant={band === "overloaded" ? "destructive" : "secondary"}>
      {t(bandKeys[band])}
    </Badge>
  )
}

export const unavailableStripes =
  "bg-[repeating-linear-gradient(135deg,transparent_0_5px,var(--border)_5px_7px)]"

export const forecastSurface =
  "border-dashed border-sky-500/50 bg-[repeating-linear-gradient(135deg,rgba(14,165,233,0.08)_0_6px,transparent_6px_12px)]"

export function hasForecast(week: WeekLoad) {
  return (
    week.status !== "confirmed" &&
    week.forecast_other_percent !== null &&
    week.forecast_other_percent !== undefined
  )
}

export function forecastOccupiedPercent(week: WeekLoad) {
  return (week.forecast_other_percent ?? 0) + week.platform_percent
}

export function regularCapPercent(week: WeekLoad, defaultCap = 70) {
  return Math.min(week.capacity_percent, defaultCap)
}

export function forecastSourceLabel(source: WeekLoad["forecast_source"]) {
  return i18n.t(
    source === "manager_override"
      ? "capacity.gantt.managerOverride"
      : "capacity.gantt.forecastBaseline",
  )
}

export const loadColors = {
  unconfirmed: {
    surface: "border-dashed bg-muted/50",
    badge: "border-border bg-muted text-muted-foreground",
    bar: "bg-muted-foreground",
  },
  available: {
    surface: "border-teal-600/25 bg-teal-500/5",
    badge: "border-teal-600/30 bg-teal-500/10 text-teal-800 dark:text-teal-300",
    bar: "bg-teal-600 dark:bg-teal-400",
  },
  full: {
    surface: "border-amber-600/30 bg-amber-500/10",
    badge:
      "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    bar: "bg-amber-500",
  },
  overloaded: {
    surface: "border-red-600/30 bg-red-500/10",
    badge: "border-red-600/30 bg-red-500/10 text-red-700 dark:text-red-300",
    bar: "bg-red-500",
  },
}

export function occupiedPercent(week: WeekLoad) {
  return (week.other_percent ?? 0) + week.platform_percent
}

export function weekBand(week: WeekLoad): WorkloadPublic["band"] {
  if (week.status !== "confirmed") return "unconfirmed"
  const total = occupiedPercent(week)
  if (total > week.capacity_percent) return "overloaded"
  return total < Math.floor(week.capacity_percent * 0.8) ? "available" : "full"
}

export function loadBandLabel(band: WorkloadPublic["band"]) {
  return i18n.t(bandKeys[band])
}

export function UtilizationBadge({
  band,
  percent,
  capacity,
}: {
  band: WorkloadPublic["band"]
  percent: number | null
  capacity?: number
}) {
  const { t } = useTranslation()
  const confirmed = band !== "unconfirmed" && percent !== null
  const label = confirmed ? formatCapacityPercent(percent) : t(bandKeys[band])
  const showCapacity = confirmed && capacity !== undefined
  const bandLabel = t(bandKeys[band])
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 tabular-nums", loadColors[band].badge)}
      title={
        showCapacity
          ? t("capacity.utilization.titleWithCapacity", {
              band: bandLabel,
              label,
              capacity,
            })
          : bandLabel
      }
    >
      {showCapacity ? `${label} / ${formatCapacityPercent(capacity)}` : label}
    </Badge>
  )
}

export function workloadNotice() {
  return i18n.t("capacity.workload.notice")
}

export function WorkloadHelp() {
  const { t } = useTranslation()
  return (
    <HelpTip
      label={t("capacity.workload.helpLabel")}
      content={
        <div className="space-y-2">
          <p>{t("capacity.workload.notice")}</p>
          <p>{t("capacity.workload.helpBarNote")}</p>
        </div>
      }
    />
  )
}

export function weekLabel(start: string) {
  const date =
    getLocale() === "en"
      ? formatDate(start, { month: "numeric", day: "numeric" })
      : start.slice(5).replace("-", "/")
  return i18n.t("capacity.workload.weekLabel", { date })
}

export function weekLoadLabel(week: WeekLoad) {
  if (week.status === "unconfirmed")
    return i18n.t("capacity.workload.statusUnconfirmed")
  if (week.status === "stale") return i18n.t("capacity.workload.statusStale")
  return `${formatCapacityPercent(occupiedPercent(week))} / ${formatCapacityPercent(week.capacity_percent)}`
}
