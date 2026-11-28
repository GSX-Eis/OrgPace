import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useLocation, useNavigate } from "@tanstack/react-router"
import { AxiosError } from "axios"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { type CasePublic, PlanningService } from "@/client"
import { ProfileLoading } from "@/components/Profile/QueryState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import i18n from "@/i18n"
import { isLocaleReadOnlyPlanningQuery } from "@/i18n/localeQuerySync"
import { OptionCard } from "./PlanOptionCard"
import {
  errorText,
  label,
  records,
  type SelectedPlanReply,
  verdictBadgeVariant,
} from "./PlansShared"
import { capacityKeys } from "./queries"
import { formatCapacityPercent, isCapacityAccessDenied } from "./shared"

export { countWeeks } from "./dateUtils"
export {
  isInDemandWindow,
  type SelectedPlanReply,
  summarizeFindings,
} from "./PlansShared"

type PlanningCaseApi = {
  getCase: (caseId: string) => Promise<CasePublic>
  createCase: (elastic: boolean) => Promise<CasePublic>
}

export async function loadPlanningCase({
  demandId,
  hash,
  change,
  storageKey,
  storage = localStorage,
  readOnly = false,
  queryClient,
  queryKey,
  api,
}: {
  demandId: string
  hash: string
  change: boolean
  storageKey: string
  storage?: Pick<Storage, "getItem" | "setItem">
  readOnly?: boolean
  queryClient?: QueryClient
  queryKey?: QueryKey
  api: PlanningCaseApi
}): Promise<CasePublic> {
  if (hash) {
    const caseId = new URLSearchParams(hash).get("case")
    if (!caseId) throw new Error(i18n.t("capacity.plans.invalidPlanLink"))
    const data = await api.getCase(caseId)
    if (data.demand_id !== demandId)
      throw new Error(i18n.t("capacity.plans.planDemandMismatch"))
    storage.setItem(storageKey, data.id)
    return data
  }
  const localeReadOnly =
    readOnly ||
    (queryClient !== undefined &&
      queryKey !== undefined &&
      isLocaleReadOnlyPlanningQuery(queryClient, queryKey))
  const caseId = storage.getItem(storageKey)
  if (caseId) {
    try {
      const data = await api.getCase(caseId)
      return !localeReadOnly && change && data.stale
        ? await api.createCase(false)
        : data
    } catch (error) {
      if (
        localeReadOnly ||
        !(error instanceof AxiosError) ||
        error.response?.status !== 404
      )
        throw error
    }
  }
  if (localeReadOnly) {
    throw new Error(i18n.t("capacity.plans.invalidPlanLink"))
  }
  return api.createCase(false)
}

export function Plans({
  orgId,
  demandId,
  change = false,
  onReply,
}: {
  orgId: string
  demandId: string
  change?: boolean
  onReply?: (reply: SelectedPlanReply) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const navigate = useNavigate()
  const hash = useLocation({ select: (location) => location.hash })
  const key = capacityKeys.planning(orgId, demandId, hash)
  const storageKey = `planning-case:${orgId}:${demandId}`
  const [allowElastic, setAllowElastic] = useState(false)
  const [activeOptionId, setActiveOptionId] = useState<string | null>(null)
  const create = async (elastic = false) => {
    const { data } = await PlanningService.createCase({
      path: { org_id: orgId, demand_id: demandId },
      body: { allow_elastic: elastic },
    })
    localStorage.setItem(storageKey, data.id)
    return data
  }
  const current = useQuery({
    queryKey: key,
    queryFn: ({ client: queryClient, queryKey }) =>
      loadPlanningCase({
        demandId,
        hash,
        change,
        storageKey,
        queryClient,
        queryKey,
        api: {
          getCase: async (caseId) =>
            (
              await PlanningService.getCase({
                path: { org_id: orgId, case_id: caseId },
              })
            ).data,
          createCase: create,
        },
      }),
  })
  const simulation = useMutation({
    mutationFn: (elastic: boolean) => create(elastic),
    onSuccess: async (data) => {
      const nextHash = hash ? `case=${data.id}` : ""
      client.setQueryData(
        capacityKeys.planning(orgId, demandId, nextHash),
        data,
      )
      if (hash !== nextHash) {
        await navigate({ search: true, hash: nextHash, replace: true })
      } else {
        await current.refetch()
      }
    },
  })
  const plan = current.data
  const visibleOptions = (plan?.options ?? []).filter(
    (option) => option.kind !== "borrow",
  )
  const rules = records([plan?.data.rules])[0]
  const snapshotId = plan?.snapshot_id
  const snapshotAllowElastic = rules?.allow_elastic === true
  const regularCapPercent =
    typeof rules?.default_allocation_cap_percent === "number"
      ? rules.default_allocation_cap_percent
      : 100
  useEffect(() => {
    if (snapshotId) setAllowElastic(snapshotAllowElastic)
  }, [snapshotId, snapshotAllowElastic])
  const selectedOptionId = hash ? new URLSearchParams(hash).get("option") : null
  const hasMatchedOption =
    !!selectedOptionId &&
    visibleOptions.some((item) => item.id === selectedOptionId)
  useEffect(() => {
    if (hasMatchedOption && selectedOptionId) {
      setActiveOptionId(selectedOptionId)
    }
  }, [hasMatchedOption, selectedOptionId])
  const activeOption =
    visibleOptions.find((option) => option.id === activeOptionId) ??
    visibleOptions[0]
  useEffect(() => {
    if (!hasMatchedOption || !selectedOptionId) return
    document
      .getElementById(`plan-option-${selectedOptionId}`)
      ?.scrollIntoView({ block: "center" })
  }, [hasMatchedOption, selectedOptionId])
  const error = simulation.error ?? current.error
  if (isCapacityAccessDenied(error))
    return <p role="alert">{t("capacity.plans.noPermission")}</p>
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">{t("capacity.plans.title")}</h3>
      {current.isPending && <ProfileLoading />}
      {error && <p role="alert">{errorText(error)}</p>}
      {error && (!plan || current.error) && (
        <Button
          variant="outline"
          onClick={() => simulation.mutate(allowElastic)}
          disabled={simulation.isPending || current.isFetching}
        >
          {t("capacity.plans.resimulate")}
        </Button>
      )}
      {plan && !current.error && (
        <>
          {plan.stale && <p role="alert">{t("capacity.plans.staleAlert")}</p>}
          {selectedOptionId && !hasMatchedOption && (
            <p role="status">{t("capacity.plans.missingHashOption")}</p>
          )}
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-surface-border bg-muted/20 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              {snapshotAllowElastic
                ? t("capacity.plans.modeElastic", {
                    cap: formatCapacityPercent(regularCapPercent),
                  })
                : t("capacity.plans.modeRegular", {
                    cap: formatCapacityPercent(regularCapPercent),
                  })}
            </span>
            <label className="inline-flex cursor-pointer items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={allowElastic}
                onChange={(event) => setAllowElastic(event.target.checked)}
                disabled={simulation.isPending || current.isFetching}
              />
              <span>{t("capacity.plans.allowElastic")}</span>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => simulation.mutate(allowElastic)}
              disabled={simulation.isPending || current.isFetching}
            >
              {t("capacity.plans.resimulate")}
            </Button>
          </div>
          {!visibleOptions.length ? (
            <p className="rounded-md border border-dashed border-surface-border p-4 text-sm text-muted-foreground">
              {t("capacity.plans.empty")}
            </p>
          ) : (
            <>
              {visibleOptions.length > 1 && (
                <div
                  role="tablist"
                  aria-label={t("capacity.plans.optionsTabAria")}
                  className="flex flex-wrap gap-2"
                >
                  {visibleOptions.map((option) => {
                    const isActive = option.id === activeOption?.id
                    const optionElastic =
                      typeof option.summary.elastic_used_percent === "number"
                        ? option.summary.elastic_used_percent
                        : 0
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => setActiveOptionId(option.id)}
                        className={`inline-flex cursor-pointer flex-wrap items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors sm:text-sm ${
                          isActive
                            ? "border-primary bg-primary/10 font-medium text-foreground ring-1 ring-primary/30"
                            : "border-surface-border bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                        }`}
                      >
                        <span>{option.kind_label}</span>
                        <Badge
                          variant={verdictBadgeVariant(option.verdict)}
                          className="px-1.5 py-0 text-[11px]"
                        >
                          {option.verdict_label}
                        </Badge>
                        <span>
                          {t("capacity.plans.finishPrefix", {
                            date: label(option.summary.finish_date),
                          })}
                        </span>
                        {option.summary.uses_elastic === true && (
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                            {t("capacity.plans.elasticUsedBadge", {
                              percent: formatCapacityPercent(optionElastic),
                            })}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
              {activeOption && (
                <OptionCard
                  key={activeOption.id}
                  option={activeOption}
                  plan={plan}
                  orgId={orgId}
                  selected={activeOption.id === selectedOptionId}
                  onRevised={async (createdOptionId) => {
                    if (createdOptionId) setActiveOptionId(createdOptionId)
                    await current.refetch()
                  }}
                  onReply={onReply}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
