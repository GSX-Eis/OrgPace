import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AdminAssistantService,
  type ChangeSetApplied,
  type ChangeSetPublic,
  type DictionaryChanges,
} from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"

function DictionaryDiff({ changes }: { changes: DictionaryChanges }) {
  const { t } = useTranslation()
  const listSeparator = t("adminAssistant.listSeparator")
  const groupLabels = {
    added: t("adminAssistant.changeSet.dictionaryDiff.added"),
    modified: t("adminAssistant.changeSet.dictionaryDiff.modified"),
    removed: t("adminAssistant.changeSet.dictionaryDiff.removed"),
  } as const
  return (
    <section
      className="space-y-3 text-sm"
      aria-label={t("adminAssistant.changeSet.dictionaryDiff.ariaLabel")}
    >
      {(
        [
          ["added", changes.added],
          ["modified", changes.modified],
          ["removed", changes.removed],
        ] as const
      )
        .filter(
          ([kind, definitions]) =>
            kind !== "removed" || Boolean(definitions?.length),
        )
        .map(([kind, definitions]) => (
          <div key={kind}>
            <p className="font-semibold">
              {t("adminAssistant.changeSet.dictionaryDiff.groupHeading", {
                label: groupLabels[kind],
                count: definitions?.length ?? 0,
              })}
            </p>
            <ul className="space-y-2">
              {definitions?.map((definition) => (
                <li key={definition.key} className="rounded-lg bg-muted/40 p-3">
                  <p className="font-medium">{definition.name}</p>
                  <p>
                    {t("adminAssistant.changeSet.dictionaryDiff.category", {
                      category:
                        definition.category ||
                        t(
                          "adminAssistant.changeSet.dictionaryDiff.uncategorized",
                        ),
                    })}
                  </p>
                  <p>
                    {t("adminAssistant.changeSet.dictionaryDiff.levels", {
                      levels: definition.level_rubric.levels
                        .map((level) => level.label)
                        .join(listSeparator),
                    })}
                  </p>
                  {kind === "modified" && (
                    <p>
                      {t(
                        "adminAssistant.changeSet.dictionaryDiff.changedFields",
                        {
                          fields:
                            definition.changed_fields?.join(listSeparator) ??
                            "",
                        },
                      )}
                    </p>
                  )}
                  <details>
                    <summary className="cursor-pointer">
                      {t(
                        "adminAssistant.changeSet.dictionaryDiff.viewDescription",
                      )}
                    </summary>
                    <p className="whitespace-pre-wrap">
                      {definition.description ||
                        t(
                          "adminAssistant.changeSet.dictionaryDiff.noDescription",
                        )}
                    </p>
                    {definition.level_rubric.levels.map((level) => (
                      <p key={level.key}>
                        {t(
                          "adminAssistant.changeSet.dictionaryDiff.levelDesc",
                          {
                            label: level.label,
                            description: level.description,
                          },
                        )}
                      </p>
                    ))}
                  </details>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  )
}

export function ChangeSetCard({
  orgId,
  changeSet,
  disabled,
  inline = false,
}: {
  orgId: string
  changeSet: ChangeSetPublic
  disabled: boolean
  inline?: boolean
}) {
  const { t } = useTranslation()
  const labels: Record<string, string> = {
    platform: t("adminAssistant.changeSet.fields.platform"),
    email_auto_bind: t("adminAssistant.changeSet.fields.email_auto_bind"),
    allowed_clients: t("adminAssistant.changeSet.fields.allowed_clients"),
    enabled: t("adminAssistant.changeSet.fields.enabled"),
    kind: t("adminAssistant.changeSet.fields.kind"),
    provider: t("adminAssistant.changeSet.fields.provider"),
    model: t("adminAssistant.changeSet.fields.model"),
    reasoning_effort: t("adminAssistant.changeSet.fields.reasoning_effort"),
    question_guide: t("adminAssistant.changeSet.fields.question_guide"),
    retention_days: t("adminAssistant.changeSet.fields.retention_days"),
    reminder_schedule: t("adminAssistant.changeSet.fields.reminder_schedule"),
    stale_after_months: t("adminAssistant.changeSet.fields.stale_after_months"),
    require_manager: t("adminAssistant.changeSet.fields.require_manager"),
    category_overrides: t("adminAssistant.changeSet.fields.category_overrides"),
    no_approval: t("adminAssistant.changeSet.fields.no_approval"),
    no_approval_category_overrides: t(
      "adminAssistant.changeSet.fields.no_approval_category_overrides",
    ),
    owner_review_days: t("adminAssistant.changeSet.fields.owner_review_days"),
    deployment: t("adminAssistant.changeSet.fields.deployment"),
    base_url: t("adminAssistant.changeSet.fields.base_url"),
    auth_type: t("adminAssistant.changeSet.fields.auth_type"),
    username: t("adminAssistant.changeSet.fields.username"),
    start_date: t("adminAssistant.changeSet.fields.start_date"),
    project_keys: t("adminAssistant.changeSet.fields.project_keys"),
    include_description: t(
      "adminAssistant.changeSet.fields.include_description",
    ),
    sync_schedule: t("adminAssistant.changeSet.fields.sync_schedule"),
    identity_id: t("adminAssistant.changeSet.fields.identity_id"),
    employee_id: t("adminAssistant.changeSet.fields.employee_id"),
    run_id: t("adminAssistant.changeSet.fields.run_id"),
  }
  const values: Record<string, string> = {
    feishu: t("adminAssistant.changeSet.values.feishu"),
    cloud_api: t("adminAssistant.changeSet.values.cloud_api"),
    local: t("adminAssistant.changeSet.values.local"),
    openai_compatible: t("adminAssistant.changeSet.values.openai_compatible"),
    chatgpt_subscription: t(
      "adminAssistant.changeSet.values.chatgpt_subscription",
    ),
    "openai-compatible": t("adminAssistant.changeSet.values.openai-compatible"),
    ollama: t("adminAssistant.changeSet.values.ollama"),
    openai: t("adminAssistant.changeSet.values.openai"),
    anthropic: t("adminAssistant.changeSet.values.anthropic"),
    deepseek: t("adminAssistant.changeSet.values.deepseek"),
    qwen: t("adminAssistant.changeSet.values.qwen"),
    moonshotai: t("adminAssistant.changeSet.values.moonshotai"),
    "moonshotai-cn": t("adminAssistant.changeSet.values.moonshotai-cn"),
    "kimi-coding": t("adminAssistant.changeSet.values.kimi-coding"),
    openrouter: t("adminAssistant.changeSet.values.openrouter"),
    quarterly: t("adminAssistant.changeSet.values.quarterly"),
    yearly: t("adminAssistant.changeSet.values.yearly"),
    off: t("adminAssistant.changeSet.values.off"),
    monthly: t("adminAssistant.changeSet.values.monthly"),
    cloud: t("adminAssistant.changeSet.values.cloud"),
    data_center: t("adminAssistant.changeSet.values.data_center"),
    api_token: t("adminAssistant.changeSet.values.api_token"),
    pat: t("adminAssistant.changeSet.values.pat"),
    basic: t("adminAssistant.changeSet.values.basic"),
    true: t("adminAssistant.changeSet.values.true"),
    false: t("adminAssistant.changeSet.values.false"),
  }
  const effortLabels: Record<string, string> = {
    off: t("adminAssistant.changeSet.reasoningEffort.off"),
    minimal: t("adminAssistant.changeSet.reasoningEffort.minimal"),
    low: t("adminAssistant.changeSet.reasoningEffort.low"),
    medium: t("adminAssistant.changeSet.reasoningEffort.medium"),
    high: t("adminAssistant.changeSet.reasoningEffort.high"),
    xhigh: t("adminAssistant.changeSet.reasoningEffort.xhigh"),
  }
  const display = (value: unknown, field: string): string => {
    if (field === "enabled")
      return value
        ? t("adminAssistant.changeSet.enabledOn")
        : t("adminAssistant.changeSet.enabledOff")
    if (field === "reasoning_effort")
      return effortLabels[String(value)] ?? effortLabels.off
    if (field === "allowed_clients" && Array.isArray(value))
      return (
        value.join(t("adminAssistant.listSeparator")) ||
        t("adminAssistant.changeSet.allowAllClients")
      )
    if (field === "sync_schedule" && value === "off")
      return t("adminAssistant.changeSet.syncOff")
    if (field === "include_description")
      return value
        ? t("adminAssistant.changeSet.syncDescriptionOn")
        : t("adminAssistant.changeSet.syncDescriptionOff")
    if (field === "no_approval")
      return value
        ? t("adminAssistant.changeSet.toggleOn")
        : t("adminAssistant.changeSet.toggleOff")
    if (
      field === "no_approval_category_overrides" &&
      value &&
      typeof value === "object"
    )
      return (
        Object.entries(value)
          .map(([category, enabled]) =>
            t("adminAssistant.changeSet.categoryNoApproval", {
              category,
              status: enabled
                ? t("adminAssistant.changeSet.noApprovalOn")
                : t("adminAssistant.changeSet.noApprovalOff"),
            }),
          )
          .join(t("adminAssistant.changeSet.overrideSeparator")) ||
        t("adminAssistant.changeSet.followGlobalRule")
      )
    if (field === "category_overrides" && value && typeof value === "object")
      return (
        Object.entries(value)
          .map(([category, required]) =>
            t("adminAssistant.changeSet.categoryRequireManager", {
              category,
              status: required
                ? t("adminAssistant.changeSet.managerRequired")
                : t("adminAssistant.changeSet.managerNotRequired"),
            }),
          )
          .join(t("adminAssistant.changeSet.overrideSeparator")) ||
        t("adminAssistant.changeSet.followGlobalRule")
      )
    if (typeof value === "object") return JSON.stringify(value)
    return values[String(value)] ?? String(value)
  }
  const statuses = {
    draft: t("adminAssistant.changeSet.statuses.draft"),
    applied: t("adminAssistant.changeSet.statuses.applied"),
    discarded: t("adminAssistant.changeSet.statuses.discarded"),
    stale: t("adminAssistant.changeSet.statuses.stale"),
    undone: t("adminAssistant.changeSet.statuses.undone"),
  }
  const [, copy] = useCopyToClipboard()
  const client = useQueryClient()
  const [oneTime, setOneTime] = useState<
    NonNullable<ChangeSetApplied["one_time"]>
  >([])
  const [reverse, setReverse] = useState<ChangeSetPublic | null>(null)
  const path = { org_id: orgId, id: changeSet.id }
  const key = ["admin-change-set", orgId, changeSet.id]
  const query = useQuery({
    queryKey: key,
    initialData: changeSet,
    queryFn: async () =>
      (await AdminAssistantService.assistantGetChangeSet({ path })).data,
  })
  const current = query.data
  const confirmAgain =
    current.status === "draft" && Boolean(current.confirmed_once_at)
  const action = useMutation({
    mutationFn: async (kind: "apply" | "discard" | "undo") => {
      if (kind === "apply") {
        const { one_time, ...data } = (
          await AdminAssistantService.assistantApplyChangeSet({
            path,
            body: { revision: current.revision },
          })
        ).data
        setOneTime(one_time ?? [])
        return data
      }
      if (kind === "discard")
        return (await AdminAssistantService.assistantDiscardChangeSet({ path }))
          .data
      return (await AdminAssistantService.assistantUndoChangeSet({ path })).data
    },
    onSuccess: (data) => {
      client.setQueryData(["admin-change-set", orgId, data.id], data)
      if (data.id !== changeSet.id && data.status === "draft") setReverse(data)
    },
    onSettled: () => client.invalidateQueries(),
  })
  const savedAt = Math.max(
    0,
    ...useMutationState({
      filters: {
        mutationKey: ["admin-change-set-secret", orgId, changeSet.id],
        status: "success",
      },
      select: (mutation) => mutation.state.submittedAt,
    }),
  )
  useEffect(() => {
    if (savedAt > 0) action.reset()
  }, [savedAt, action.reset])
  const test = useMutation({
    onMutate: () => action.reset(),
    mutationFn: async (item: number) =>
      (
        await AdminAssistantService.assistantTestChangeSet({
          path,
          body: { item },
        })
      ).data,
    onSuccess: () => client.invalidateQueries(),
  })
  const busy =
    disabled ||
    action.isPending ||
    test.isPending ||
    query.isFetching ||
    query.isError
  return (
    <section
      aria-label={
        inline
          ? t("adminAssistant.changeSet.pageDraftAria")
          : t("adminAssistant.changeSet.cardAria")
      }
      className="space-y-4 rounded-xl border border-primary/25 bg-background p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-3 border-b pb-3">
        <h3 className="font-semibold">
          {current.undo_of_id
            ? t("adminAssistant.changeSet.undoConfirmTitle")
            : t("adminAssistant.changeSet.applyConfirmTitle")}
        </h3>
        <span role="status" className="text-xs text-muted-foreground">
          {confirmAgain
            ? t("adminAssistant.changeSet.reconfirmStatus")
            : statuses[current.status]}
        </span>
      </div>
      {current.items.map((item, i) =>
        item.function === "set_department_capabilities" &&
        item.impact?.text === "" ? null : (
          <div key={i} className="space-y-2">
            <p className="text-sm font-medium">{item.title}</p>
            {item.function === "dismiss_capability_proposal" && (
              <p className="text-sm">
                {item.before?.status === "dismissed"
                  ? t("adminAssistant.changeSet.restoreProposal")
                  : t("adminAssistant.changeSet.dismissProposal")}
                {t("adminAssistant.changeSet.proposalBracketed", {
                  name: String(
                    item.before?.name ??
                      t(
                        "adminAssistant.changeSet.capabilitySuggestionFallback",
                      ),
                  ),
                })}
              </p>
            )}
            {item.impact?.dictionary && (
              <DictionaryDiff changes={item.impact.dictionary} />
            )}
            {item.undoable &&
              !item.impact?.dictionary &&
              (item.function !== "set_department_capabilities" ||
                !item.impact) &&
              item.function !== "dismiss_capability_proposal" &&
              Object.keys(item.after)
                .filter(
                  (field) =>
                    JSON.stringify(item.before?.[field]) !==
                    JSON.stringify(item.after[field]),
                )
                .map((field) => (
                  <div
                    key={field}
                    className="rounded-lg bg-muted/40 p-3 text-sm"
                  >
                    <p className="mb-2 text-muted-foreground">
                      {labels[field] ??
                        t("adminAssistant.changeSet.settingItemFallback")}
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      {(
                        [
                          {
                            kind: "before",
                            title: t("adminAssistant.changeSet.before"),
                            value: item.before?.[field],
                          },
                          {
                            kind: "after",
                            title: t("adminAssistant.changeSet.after"),
                            value: item.after[field],
                          },
                        ] as const
                      ).map(({ kind, title, value }) => (
                        <div key={kind}>
                          <p className="text-xs text-muted-foreground">
                            {title}
                          </p>
                          <p
                            className={
                              kind === "after"
                                ? "font-semibold text-primary"
                                : ""
                            }
                          >
                            {value == null
                              ? t("adminAssistant.changeSet.unset")
                              : `${display(value, field)}${field === "stale_after_months" ? t("adminAssistant.changeSet.monthsSuffix") : ""}`}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            {item.impact && (
              <p className="text-xs text-muted-foreground">
                {item.function !== "set_department_capabilities" &&
                  t("adminAssistant.changeSet.impactCount", {
                    count: item.impact.count,
                  })}
                {item.impact.text}
              </p>
            )}
            {current.status === "draft" && item.testable && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => test.mutate(i)}
                >
                  {test.isPending && test.variables === i
                    ? t("adminAssistant.changeSet.testingConnection")
                    : t("adminAssistant.changeSet.testConnection")}
                </Button>
                {test.data && test.variables === i && (
                  <p
                    role={test.data.ok ? "status" : "alert"}
                    className="text-sm"
                  >
                    {test.data.ok
                      ? t("adminAssistant.changeSet.testSuccess")
                      : t("adminAssistant.changeSet.testFailed", {
                          message: test.data.message,
                        })}
                  </p>
                )}
              </div>
            )}
          </div>
        ),
      )}
      {confirmAgain && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <p className="font-semibold">
            {t("adminAssistant.changeSet.reconfirmPrompt")}
          </p>
          {current.items
            .filter((item) => item.risk === "high")
            .map((item, i) => (
              <p key={i}>
                {t("adminAssistant.changeSet.impactCount", {
                  count: item.impact?.count ?? 0,
                })}
                {item.impact?.text ??
                  t("adminAssistant.changeSet.reconfirmFallbackText")}
              </p>
            ))}
        </div>
      )}
      {oneTime.map((output, i) => (
        <div key={i} className="space-y-2 rounded-lg border p-3 text-sm">
          <p>{t("adminAssistant.changeSet.oneTimeNotice")}</p>
          {output.type === "initial_password" ? (
            <>
              <p>
                {output.display_name} · {output.username}
              </p>
              <label className="block">
                {t("adminAssistant.changeSet.initialPasswordLabel")}
                <input
                  aria-label={t(
                    "adminAssistant.changeSet.initialPasswordLabel",
                  )}
                  readOnly
                  value={output.initial_password}
                  className="ml-2 rounded border p-2"
                />
              </label>
              <Button
                variant="outline"
                onClick={() => copy(output.initial_password)}
              >
                {t("adminAssistant.changeSet.copyPassword")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                const bytes = Uint8Array.from(
                  atob(output.content_base64),
                  (c) => c.charCodeAt(0),
                )
                const url = URL.createObjectURL(
                  new Blob([bytes], {
                    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                  }),
                )
                const link = document.createElement("a")
                link.href = url
                link.download = output.filename
                link.click()
                URL.revokeObjectURL(url)
              }}
            >
              {t("adminAssistant.changeSet.downloadAccounts")}
            </Button>
          )}
        </div>
      ))}
      <SetupError
        error={
          (test.submittedAt > action.submittedAt
            ? (test.error ?? action.error)
            : (action.error ?? test.error)) ?? query.error
        }
      />
      {current.status === "draft" && (
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => action.mutate("apply")}>
            {confirmAgain
              ? t("adminAssistant.changeSet.reconfirmButton")
              : t("adminAssistant.changeSet.applyButton")}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => action.mutate("discard")}
          >
            {t("adminAssistant.changeSet.discardButton")}
          </Button>
        </div>
      )}
      {current.status === "applied" &&
        current.items.every(
          (item) => item.before !== null && item.undoable,
        ) && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => action.mutate("undo")}
          >
            {t("adminAssistant.changeSet.undoButton")}
          </Button>
        )}
      {reverse && (
        <ChangeSetCard orgId={orgId} changeSet={reverse} disabled={disabled} />
      )}
    </section>
  )
}
