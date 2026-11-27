import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useBlocker } from "@tanstack/react-router"
import { isAxiosError } from "axios"
import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type ChangeRequestPublic,
  EmployeeRequestsService,
  type ItemInput,
  type ProfileItem,
  type RequestPreview,
} from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatDate } from "@/i18n/format"
import { levelLabel, record } from "./fields"
import {
  characterCount,
  EXPLANATION_MAX,
  ITEMS_MAX,
  STATEMENT_MAX,
  textLimitMessage,
} from "./inputLimits"
import { ProfileVisibility } from "./ProfileVisibility"
import { RequestReviewers } from "./RequestReviewers"
import {
  activeEvidence,
  cloneWithdrawnItems,
  requestItemInput,
} from "./withdrawnRequest"

export type EditorSelection = {
  request?: ChangeRequestPublic
  cloneFrom?: ChangeRequestPublic
  item?: ProfileItem
  retract?: boolean
  preview?: boolean
  capabilityKey?: string
  objection?: boolean
}

export function ChangeRequestEditor({
  orgId,
  selection,
  profileItems,
  onClose,
  onEvidence,
}: {
  orgId: string
  selection: EditorSelection
  profileItems: ProfileItem[]
  onClose: () => void
  onEvidence?: (id: string) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const path = { org_id: orgId }
  const [requestId, setRequestId] = useState(
    selection.cloneFrom ? undefined : selection.request?.id,
  )
  const source = selection.cloneFrom ?? selection.request
  const [items, setItems] = useState<ItemInput[]>(() =>
    selection.cloneFrom
      ? cloneWithdrawnItems(selection.cloneFrom, profileItems)
      : selection.request
        ? (selection.request.items ?? []).map(requestItemInput)
        : selection.item
          ? [
              {
                op: selection.retract
                  ? "retract"
                  : selection.item.claim
                    ? "modify"
                    : "add",
                capability_key: selection.item.capability.key,
                statement: selection.item.claim?.statement ?? "",
                level: selection.retract ? null : selection.item.claim?.level,
                evidence_ids: activeEvidence(
                  selection.item.claim?.evidence,
                ).map((e) => e.evidence_id),
              },
            ]
          : [],
  )
  const [skippedCount] = useState(() =>
    selection.cloneFrom ? (source?.items?.length ?? 0) - items.length : 0,
  )
  const [pickedTitles, setPickedTitles] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<RequestPreview | null>(null)
  const [savedItems, setSavedItems] = useState(() => JSON.stringify(items))
  const [confirmClose, setConfirmClose] = useState(false)
  const limitErrors = items
    .flatMap((item, index) => [
      item.op !== "retract" &&
      item.op !== "attach_evidence" &&
      item.statement !==
        profileItems.find((p) => p.capability.key === item.capability_key)
          ?.claim?.statement
        ? textLimitMessage(
            item.statement,
            STATEMENT_MAX,
            index,
            t("profile.common.capabilityStatement"),
          )
        : null,
      ...[item.owner_statement, item.objection, item.uncertainty].map((text) =>
        textLimitMessage(text ?? "", EXPLANATION_MAX, index),
      ),
    ])
    .filter(Boolean)
  if (items.length > ITEMS_MAX)
    limitErrors.push(
      t("profile.request.editor.maxItems", {
        max: ITEMS_MAX,
        count: items.length,
      }),
    )
  const dirty = JSON.stringify(items) !== savedItems
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: dirty,
    withResolver: true,
  })
  const finishClose = () => {
    if (blocker.status === "blocked") blocker.proceed()
    onClose()
  }
  const [showPreview, setShowPreview] = useState(!!selection.preview)
  const [notice, setNotice] = useState("")
  const [stale, setStale] = useState(false)
  const [evidenceSkip, setEvidenceSkip] = useState(0)
  const activeField = useRef<HTMLTextAreaElement>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const formId = useId()
  const dictionary = useQuery({
    queryKey: ["my-capabilities", orgId],
    queryFn: async () =>
      (await EmployeeRequestsService.readMyCapabilities({ path })).data,
  })
  const evidence = useQuery({
    queryKey: ["my-evidence", orgId, evidenceSkip],
    queryFn: async () =>
      (
        await EmployeeRequestsService.readMyEvidence({
          path,
          query: { skip: evidenceSkip, limit: 100 },
        })
      ).data,
  })
  useEffect(() => {
    if (dictionary.isSuccess && evidence.isSuccess) activeField.current?.focus()
  }, [dictionary.isSuccess, evidence.isSuccess])
  const initialPreview = useQuery({
    queryKey: ["request-preview", orgId, requestId],
    queryFn: async () =>
      (
        await EmployeeRequestsService.previewRequest({
          path: { ...path, request_id: requestId! },
        })
      ).data,
    enabled: !!selection.preview && !!requestId,
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
  const displayedPreview = preview ?? (showPreview ? initialPreview.data : null)
  const evidenceTitles = new Map(
    [
      ...profileItems.flatMap((item) => item.claim?.evidence ?? []),
      ...(source?.items ?? []).flatMap((item) => item.evidence ?? []),
      ...(displayedPreview?.items ?? []).flatMap(({ before, after }) => [
        ...(before?.evidence ?? []),
        ...(after.evidence ?? []),
      ]),
    ].map((entry) => [entry.evidence_id, entry.title]),
  )
  for (const entry of evidence.data?.data ?? []) {
    evidenceTitles.set(entry.id, entry.title)
  }
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["change-requests", orgId] }),
      client.invalidateQueries({ queryKey: ["profile", orgId] }),
      client.invalidateQueries({ queryKey: ["profile-versions", orgId] }),
      client.invalidateQueries({ queryKey: ["inbox", orgId] }),
      client.invalidateQueries({ queryKey: ["reviews", orgId] }),
      client.invalidateQueries({ queryKey: ["employees", orgId] }),
      client.invalidateQueries({ queryKey: ["employee", orgId] }),
      client.invalidateQueries({ queryKey: ["coverage", orgId] }),
      client.invalidateQueries({ queryKey: ["capability-stats", orgId] }),
    ])
  const save = useMutation({
    mutationFn: async (andPreview: boolean) => {
      const result = requestId
        ? await EmployeeRequestsService.updateItems({
            path: { ...path, request_id: requestId },
            body: { items },
          })
        : await EmployeeRequestsService.createDraft({
            path,
            body: { items, withdrawn_request_id: selection.cloneFrom?.id },
          })
      setRequestId(result.data.id)
      setSavedItems(JSON.stringify(items))
      await refresh()
      if (andPreview) {
        const resultPreview = await EmployeeRequestsService.previewRequest({
          path: { ...path, request_id: result.data.id },
        })
        setPreview(resultPreview.data)
        setShowPreview(true)
      } else setNotice(t("profile.request.editor.draftSaved"))
      setStale(false)
    },
  })
  const submit = useMutation({
    mutationFn: async () => {
      if (!displayedPreview) return
      try {
        await EmployeeRequestsService.submitRequest({
          path: { ...path, request_id: displayedPreview.request_id },
          body: {
            revision: displayedPreview.revision,
            base_revision: displayedPreview.base_revision,
            policy_version: displayedPreview.policy_version,
          },
        })
        await refresh()
        onClose()
      } catch (error) {
        if (isAxiosError(error) && error.response?.status === 409) {
          const detail = error.response.data?.detail
          if (
            record(detail) &&
            (detail.code === "stale_initial_draft" ||
              detail.code === "approval_policy_changed")
          ) {
            const refreshed =
              detail.code === "approval_policy_changed"
                ? (detail.preview as RequestPreview | undefined)
                : undefined
            const latest =
              refreshed ??
              (
                await EmployeeRequestsService.previewRequest({
                  path: { ...path, request_id: displayedPreview.request_id },
                })
              ).data
            setPreview(latest)
            setShowPreview(true)
            setStale(false)
            setNotice(String(detail.message))
            await refresh()
            return
          }
          setStale(true)
          setNotice(t("profile.request.editor.staleNotice"))
          setPreview(null)
          setShowPreview(false)
          await refresh()
        }
        throw error
      }
    },
  })
  const reloadPreview = useMutation({
    mutationFn: async () => {
      const result = await EmployeeRequestsService.previewRequest({
        path: { ...path, request_id: requestId! },
      })
      setPreview(result.data)
      const reloadedItems = result.data.items.map(({ after }) =>
        requestItemInput(after),
      )
      setItems(reloadedItems)
      setSavedItems(JSON.stringify(reloadedItems))
      setShowPreview(true)
      setStale(false)
      setNotice("")
      submit.reset()
    },
  })
  const update = (index: number, changes: Partial<ItemInput>) => {
    setItems(
      items.map((item, i) => (i === index ? { ...item, ...changes } : item)),
    )
    setStale(false)
    setNotice("")
  }
  const error =
    save.error ??
    submit.error ??
    reloadPreview.error ??
    dictionary.error ??
    evidence.error ??
    initialPreview.error
  const busy = save.isPending || submit.isPending || reloadPreview.isPending
  const formDisabled = busy || !dictionary.data || !evidence.data
  const detail = isAxiosError(error) ? error.response?.data?.detail : null
  const itemErrors = Array.isArray(detail)
    ? detail.filter(record).filter((item) => typeof item.message === "string")
    : []
  const leaving = confirmClose || blocker.status === "blocked"
  let description = t("profile.request.editor.descDefault")
  if (showPreview) {
    if (!displayedPreview) {
      description = t("profile.request.editor.descCheckingPolicy")
    } else if (displayedPreview.partial_auto_publish) {
      description = t("profile.request.editor.descPartialAuto")
    } else if (displayedPreview.requires_manager !== false) {
      description = t("profile.request.editor.descRequiresManager")
    } else if (
      displayedPreview.items.some(({ after }) => after.op === "retract")
    ) {
      description = t("profile.request.editor.descAutoRetract")
    } else {
      description = t("profile.request.editor.descAutoPublish")
    }
  }
  const hasFeedback = !!(notice || error)
  useEffect(() => {
    if (hasFeedback || leaving || showPreview)
      scrollArea.current?.scrollTo({ top: 0 })
  }, [hasFeedback, leaving, showPreview])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          if (dirty) setConfirmClose(true)
          else onClose()
        }
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] min-w-0 flex-col overflow-hidden sm:max-w-3xl"
        showCloseButton={!busy}
      >
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle>
            {showPreview
              ? t("profile.request.editor.titlePreview")
              : t("profile.request.editor.titleEdit")}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div
          ref={scrollArea}
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto wrap-anywhere"
        >
          <ProfileVisibility />
          {itemErrors.length ? (
            <div role="alert" className="text-sm text-destructive">
              {itemErrors.map((item, index) => (
                <p key={`${item.index}-${index}`}>
                  {t("profile.request.editor.itemError", {
                    index: Number(item.index) + 1,
                    message: String(item.message),
                  })}
                </p>
              ))}
            </div>
          ) : (
            <SetupError error={error} />
          )}
          {limitErrors.map((message, index) => (
            <p
              key={`${index}-${message}`}
              role="alert"
              className="text-sm text-destructive"
            >
              {message}
            </p>
          ))}
          {notice && <p role="status">{notice}</p>}
          {skippedCount > 0 && (
            <p className="text-sm text-muted-foreground">
              {t("profile.request.editor.skippedCount", {
                count: skippedCount,
              })}
            </p>
          )}
          {leaving ? (
            <section
              className="space-y-3"
              aria-label={t("profile.request.editor.unsavedAria")}
            >
              <p>{t("profile.request.editor.unsavedPrompt")}</p>
              <div className="flex flex-wrap gap-3">
                <Button
                  disabled={
                    busy ||
                    limitErrors.length > 0 ||
                    !items.length ||
                    items.some((item) => !item.statement.trim())
                  }
                  onClick={() => save.mutate(false, { onSuccess: finishClose })}
                >
                  {t("profile.request.editor.saveDraft")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={finishClose}
                >
                  {t("profile.request.editor.discard")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setConfirmClose(false)
                    blocker.reset?.()
                  }}
                >
                  {t("profile.request.editor.continueEditing")}
                </Button>
              </div>
            </section>
          ) : stale ? (
            <Button disabled={busy} onClick={() => reloadPreview.mutate()}>
              {t("profile.request.editor.reloadLatest")}
            </Button>
          ) : showPreview ? (
            <>
              {!displayedPreview && (
                <p role="status">
                  {t("profile.request.editor.loadingPreview")}
                </p>
              )}
              {displayedPreview && (
                <RequestReviewers
                  reviewers={displayedPreview.reviewers}
                  requiresManager={displayedPreview.requires_manager}
                  partialAutoPublish={displayedPreview.partial_auto_publish}
                  preview
                />
              )}
              {displayedPreview?.items.map(
                ({
                  before,
                  after,
                  warning,
                  current_changed_at,
                  submission_notice,
                }) => (
                  <section
                    key={after.id}
                    className="space-y-3 rounded-lg border p-4"
                  >
                    <h3 className="font-semibold">{after.capability.name}</h3>
                    <p>{submission_notice}</p>
                    {current_changed_at && (
                      <p
                        role="status"
                        className="text-sm text-muted-foreground"
                      >
                        {t("profile.request.editor.currentChangedAt", {
                          time: formatDate(current_changed_at, {
                            year: "numeric",
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                            timeZone: "Asia/Shanghai",
                            hour12: false,
                          }),
                        })}
                      </p>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="text-sm text-muted-foreground">
                          {t("profile.request.editor.previewBefore")}
                        </p>
                        <p>
                          {before?.statement ??
                            t("profile.request.compactNoRecord")}
                        </p>
                        <p>
                          {t("profile.request.levelColon")}
                          {before?.level
                            ? levelLabel(
                                after.capability.level_rubric,
                                before.level,
                              )
                            : t("profile.request.ungraded")}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">
                          {t("profile.request.editor.previewAfter")}
                        </p>
                        <p>
                          {after.op === "attach_evidence"
                            ? t("profile.request.editor.attachKeepOriginal")
                            : after.op === "retract"
                              ? t("profile.request.editor.retractItem")
                              : after.after?.statement}
                        </p>
                        <p>
                          {t("profile.request.levelColon")}
                          {after.after?.level
                            ? levelLabel(
                                after.capability.level_rubric,
                                after.after.level,
                              )
                            : t("profile.request.ungraded")}
                        </p>
                      </div>
                    </div>
                    {after.owner_statement && (
                      <p>
                        {t("profile.request.editor.ownerNote", {
                          text: after.owner_statement,
                        })}
                      </p>
                    )}
                    {after.uncertainty && (
                      <p>
                        {t("profile.request.editor.uncertaintyNote", {
                          text: after.uncertainty,
                        })}
                      </p>
                    )}
                    {after.objection && (
                      <p>
                        {t("profile.request.editor.objectionNote", {
                          text: after.objection,
                        })}
                      </p>
                    )}
                    <div className="text-sm">
                      <p>{t("profile.request.editor.relatedEvidence")}</p>
                      {after.evidence?.length ? (
                        <ul className="space-y-1">
                          {after.evidence.map((entry) => (
                            <li key={entry.evidence_id}>
                              {onEvidence ? (
                                <Button
                                  type="button"
                                  variant="link"
                                  className="h-auto min-h-8 max-w-full justify-start px-0 text-left whitespace-normal"
                                  onClick={() => onEvidence(entry.evidence_id)}
                                >
                                  {entry.title}
                                </Button>
                              ) : (
                                entry.title
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>{t("profile.request.editor.none")}</p>
                      )}
                    </div>
                    {warning && (
                      <p role="alert">
                        {t("profile.request.editor.reselectLevelWarning", {
                          warning,
                        })}
                      </p>
                    )}
                  </section>
                ),
              )}
            </>
          ) : (
            <form
              id={formId}
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault()
                save.mutate(true)
              }}
            >
              <fieldset disabled={formDisabled} className="min-w-0 space-y-5">
                {items.map((item, index) => {
                  const capability = dictionary.data?.data.find(
                    (c) => c.key === item.capability_key,
                  )
                  const rubric = capability?.level_rubric
                  const levels =
                    record(rubric) && Array.isArray(rubric.levels)
                      ? rubric.levels
                          .filter(record)
                          .filter((l) => typeof l.key === "string")
                      : []
                  const invalidLevel =
                    item.level && !levels.some((l) => l.key === item.level)
                  return (
                    <fieldset
                      key={item.capability_key}
                      className="min-w-0 space-y-3 rounded-lg border bg-muted/10 p-4"
                    >
                      <legend className="px-1 font-semibold">
                        {capability?.name ??
                          t("profile.request.editor.capabilityRetired")}
                      </legend>
                      {item.op === "attach_evidence" ? (
                        <p>{t("profile.request.editor.attachKeepOriginal")}</p>
                      ) : item.op === "retract" ? (
                        <p>{t("profile.request.editor.retractItem")}</p>
                      ) : (
                        <>
                          <label className="block space-y-1">
                            {t("profile.request.editor.statementLabel")}
                            <textarea
                              ref={
                                item.capability_key ===
                                  selection.capabilityKey &&
                                !selection.objection
                                  ? activeField
                                  : undefined
                              }
                              required
                              aria-label={t(
                                "profile.request.editor.statementLabel",
                              )}
                              value={item.statement}
                              className="block min-h-24 w-full rounded-md border bg-background p-2"
                              onChange={(e) =>
                                update(index, { statement: e.target.value })
                              }
                            />
                          </label>
                          <p className="text-sm text-muted-foreground">
                            {t("profile.request.editor.charCount", {
                              count: characterCount(item.statement),
                              max: STATEMENT_MAX,
                            })}
                          </p>
                          <label className="block space-y-1">
                            {t("profile.request.editor.levelLabel")}
                            <select
                              value={item.level ?? ""}
                              className="block w-full rounded-md border bg-background p-2"
                              onChange={(e) =>
                                update(index, { level: e.target.value || null })
                              }
                            >
                              <option value="">
                                {t("profile.request.ungraded")}
                              </option>
                              {invalidLevel && (
                                <option value={item.level!}>
                                  {t(
                                    "profile.request.editor.reselectLevelOption",
                                  )}
                                </option>
                              )}
                              {levels.map((level) => (
                                <option
                                  key={String(level.key)}
                                  value={String(level.key)}
                                >
                                  {String(level.label ?? level.key)}
                                </option>
                              ))}
                            </select>
                          </label>
                        </>
                      )}
                      <label className="block space-y-1">
                        {t("profile.request.editor.ownerNoteLabel")}
                        <textarea
                          value={item.owner_statement ?? ""}
                          className="block min-h-20 w-full rounded-md border bg-background p-2"
                          onChange={(e) =>
                            update(index, {
                              owner_statement: e.target.value || null,
                            })
                          }
                        />
                      </label>
                      <p className="text-sm text-muted-foreground">
                        {t("profile.request.editor.charCount", {
                          count: characterCount(item.owner_statement ?? ""),
                          max: EXPLANATION_MAX,
                        })}
                      </p>
                      {(source?.origin === "initial_sync" ||
                        source?.origin === "import" ||
                        source?.items?.some(
                          (original) =>
                            original.capability.key === item.capability_key &&
                            original.objection,
                        ) ||
                        item.objection) && (
                        <label className="block space-y-1">
                          {t("profile.request.editor.objectionLabel")}
                          <textarea
                            ref={
                              item.capability_key === selection.capabilityKey &&
                              selection.objection
                                ? activeField
                                : undefined
                            }
                            value={item.objection ?? ""}
                            aria-label={t(
                              "profile.request.editor.objectionLabel",
                            )}
                            className="block min-h-20 w-full rounded-md border bg-background p-2"
                            onChange={(e) =>
                              update(index, {
                                objection: e.target.value || null,
                              })
                            }
                          />
                          <span className="text-sm text-muted-foreground">
                            {t("profile.request.editor.charCount", {
                              count: characterCount(item.objection ?? ""),
                              max: EXPLANATION_MAX,
                            })}
                          </span>
                        </label>
                      )}
                      {!!item.evidence_ids?.length && (
                        <ul
                          aria-label={t(
                            "profile.request.editor.selectedEvidenceAria",
                          )}
                          className="space-y-2"
                        >
                          {item.evidence_ids.map((id) => (
                            <li
                              key={id}
                              className="flex flex-wrap items-center gap-x-2 text-sm"
                            >
                              <span className="min-w-0">
                                {evidenceTitles.get(id) ??
                                  pickedTitles[id] ??
                                  t(
                                    "profile.request.editor.evidenceRefFallback",
                                  )}
                              </span>
                              {onEvidence && (
                                <Button
                                  type="button"
                                  variant="link"
                                  size="sm"
                                  onClick={() => onEvidence(id)}
                                >
                                  {t("profile.request.editor.view")}
                                </Button>
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  update(index, {
                                    evidence_ids: item.evidence_ids?.filter(
                                      (selected) => selected !== id,
                                    ),
                                  })
                                }
                              >
                                {t("profile.request.editor.remove")}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <details>
                        <summary className="cursor-pointer">
                          {t("profile.request.editor.selectEvidenceSummary", {
                            count: item.evidence_ids?.length ?? 0,
                          })}
                        </summary>
                        <div className="max-h-48 space-y-2 overflow-y-auto py-3">
                          {evidence.data?.data.map((entry) => (
                            <label
                              key={entry.id}
                              className="flex items-start gap-2 text-sm"
                            >
                              <input
                                type="checkbox"
                                checked={
                                  item.evidence_ids?.includes(entry.id) ?? false
                                }
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setPickedTitles((titles) => ({
                                      ...titles,
                                      [entry.id]: entry.title,
                                    }))
                                  }
                                  update(index, {
                                    evidence_ids: e.target.checked
                                      ? [...(item.evidence_ids ?? []), entry.id]
                                      : item.evidence_ids?.filter(
                                          (id) => id !== entry.id,
                                        ),
                                  })
                                }}
                              />
                              {entry.title}
                            </label>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            disabled={!evidenceSkip}
                            onClick={() => setEvidenceSkip(evidenceSkip - 100)}
                          >
                            {t("profile.request.editor.prevEvidence")}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={
                              evidenceSkip + 100 >= (evidence.data?.count ?? 0)
                            }
                            onClick={() => setEvidenceSkip(evidenceSkip + 100)}
                          >
                            {t("profile.request.editor.nextEvidence")}
                          </Button>
                        </div>
                      </details>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          setItems(items.filter((_, i) => i !== index))
                        }
                      >
                        {t("profile.request.editor.removeChange")}
                      </Button>
                    </fieldset>
                  )
                })}
                <label className="block space-y-1">
                  {t("profile.request.editor.addCapabilityLabel")}
                  <select
                    disabled={items.length >= ITEMS_MAX}
                    value=""
                    className="block w-full rounded-md border bg-background p-2"
                    onChange={(e) => {
                      if (e.target.value)
                        setItems([
                          ...items,
                          {
                            capability_key: e.target.value,
                            op: "add",
                            statement: "",
                            evidence_ids: [],
                          },
                        ])
                    }}
                  >
                    <option value="">
                      {t("profile.request.editor.selectFromDictionary")}
                    </option>
                    {dictionary.data?.data
                      .filter(
                        (c) =>
                          !items.some((i) => i.capability_key === c.key) &&
                          !profileItems.some(
                            (i) => i.capability.key === c.key && i.claim,
                          ),
                      )
                      .map((c) => (
                        <option key={c.id} value={c.key}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
                <p className="text-sm text-muted-foreground">
                  {t("profile.request.editor.visibilityHint")}
                </p>
              </fieldset>
            </form>
          )}
        </div>
        {!leaving && !stale && (
          <div className="flex shrink-0 flex-wrap gap-3 border-t pt-4">
            {showPreview ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    scrollArea.current?.scrollTo({ top: 0 })
                    setShowPreview(false)
                    submit.reset()
                  }}
                >
                  {t("profile.request.editor.backToEdit")}
                </Button>
                <Button
                  disabled={
                    busy ||
                    !displayedPreview?.items.length ||
                    limitErrors.length > 0 ||
                    displayedPreview.items.some((i) => i.warning)
                  }
                  onClick={() => submit.mutate()}
                >
                  {t("profile.request.editor.confirmSubmit")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={formDisabled || limitErrors.length > 0}
                  onClick={() => save.mutate(false)}
                >
                  {t("profile.request.editor.saveDraft")}
                </Button>
                <Button
                  type="submit"
                  form={formId}
                  disabled={
                    formDisabled ||
                    limitErrors.length > 0 ||
                    !items.length ||
                    items.some(
                      (i) =>
                        i.level &&
                        !dictionary.data?.data.find(
                          (c) => c.key === i.capability_key,
                        ),
                    )
                  }
                >
                  {t("profile.request.editor.previewAndSubmit")}
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
