import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useBlocker } from "@tanstack/react-router"
import { isAxiosError } from "axios"
import { useEffect, useId, useMemo, useRef, useState } from "react"
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
import { ChangeRequestPreview } from "./ChangeRequestPreview"
import { record } from "./fields"
import {
  EXPLANATION_MAX,
  ITEMS_MAX,
  STATEMENT_MAX,
  textLimitMessage,
} from "./inputLimits"
import { ProfileVisibility } from "./ProfileVisibility"
import { RequestEditorFooter } from "./RequestEditorFooter"
import { RequestItemEditor } from "./RequestItemEditor"
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
  const limitErrors = useMemo(() => {
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
        ...[item.owner_statement, item.objection, item.uncertainty].map(
          (text) => textLimitMessage(text ?? "", EXPLANATION_MAX, index),
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
    return limitErrors
  }, [items, profileItems, t])
  const serializedItems = useMemo(() => JSON.stringify(items), [items])
  const dirty = serializedItems !== savedItems
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
  const evidenceTitles = useMemo(() => {
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
    return evidenceTitles
  }, [profileItems, source?.items, displayedPreview, evidence.data])
  const capabilitiesByKey = useMemo(
    () => new Map(dictionary.data?.data.map((c) => [c.key, c])),
    [dictionary.data],
  )
  const availableCapabilities = useMemo(
    () =>
      dictionary.data?.data.filter(
        (c) =>
          !items.some((i) => i.capability_key === c.key) &&
          !profileItems.some((i) => i.capability.key === c.key && i.claim),
      ),
    [dictionary.data, items, profileItems],
  )
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
      setSavedItems(serializedItems)
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
            <ChangeRequestPreview
              displayedPreview={displayedPreview}
              onEvidence={onEvidence}
            />
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
                {items.map((item, index) => (
                  <RequestItemEditor
                    key={item.capability_key}
                    item={item}
                    capability={capabilitiesByKey.get(item.capability_key)}
                    source={source}
                    activeField={
                      item.capability_key === selection.capabilityKey
                        ? activeField
                        : undefined
                    }
                    objectionFocus={selection.objection}
                    update={(changes) => update(index, changes)}
                    onRemove={() =>
                      setItems(items.filter((_, i) => i !== index))
                    }
                    evidencePicker={{
                      evidence: evidence.data,
                      evidenceTitles,
                      pickedTitles,
                      evidenceSkip,
                      setEvidenceSkip,
                      onPickTitle: (id, title) =>
                        setPickedTitles((titles) => ({
                          ...titles,
                          [id]: title,
                        })),
                      onEvidence,
                    }}
                  />
                ))}
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
                    {availableCapabilities?.map((c) => (
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
          <RequestEditorFooter
            showPreview={showPreview}
            busy={busy}
            canSubmit={
              !!displayedPreview?.items.length &&
              !limitErrors.length &&
              !displayedPreview.items.some((i) => i.warning)
            }
            canSave={!formDisabled && !limitErrors.length}
            canPreview={
              !formDisabled &&
              !limitErrors.length &&
              !!items.length &&
              !items.some(
                (i) => i.level && !capabilitiesByKey.has(i.capability_key),
              )
            }
            formId={formId}
            onBack={() => {
              scrollArea.current?.scrollTo({ top: 0 })
              setShowPreview(false)
              submit.reset()
            }}
            onSubmit={() => submit.mutate()}
            onSave={() => save.mutate(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
