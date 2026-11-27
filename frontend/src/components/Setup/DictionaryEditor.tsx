import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapabilitiesService,
  type CapabilityProposalPublic,
  type DictionaryDefinition,
  type DictionaryPreview,
} from "@/client"
import { ConfirmActionDialog } from "@/components/Admin/ConfirmActionDialog"
import { DraftField } from "@/components/AdminAssistant/DraftField"
import type { usePageDraft } from "@/components/AdminAssistant/usePageDraft"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getLocale } from "@/i18n"
import { formatDate } from "@/i18n/format"
import { DictionaryPreviewPanel } from "./DictionaryPreviewPanel"
import { SetupError } from "./SetupError"

type Props = {
  orgId: string
  onClose: () => void
  onSaved: () => void
  suggestion?: ReturnType<typeof usePageDraft>
}

export function DictionaryEditor(props: Props) {
  const { t } = useTranslation()
  const current = useQuery({
    queryKey: ["dictionary-editor", props.orgId],
    queryFn: async () =>
      (
        await CapabilitiesService.readDictionaryEditor({
          path: { org_id: props.orgId },
        })
      ).data,
    refetchOnWindowFocus: false,
    gcTime: 0,
  })
  if (current.isPending) return <p role="status">{t("setup.editor.loading")}</p>
  if (current.isError) return <SetupError error={current.error} />
  return <Editor {...props} initial={current.data} />
}

function Editor({
  orgId,
  onClose,
  onSaved,
  initial,
  suggestion,
}: Props & { initial: DictionaryPreview }) {
  const { t } = useTranslation()
  const locale = getLocale()
  const [error, setError] = useState<Error | null>(null)
  const client = useQueryClient()
  const proposals = useQuery({
    queryKey: ["capability-proposals", orgId],
    queryFn: async () =>
      (
        await CapabilitiesService.readCapabilityProposals({
          path: { org_id: orgId },
        })
      ).data,
  })
  const [dismissed, setDismissed] = useState("")
  const prefix = useId()
  const nextId = useRef(initial.definitions.length)
  const [baseVersion] = useState(initial.expected_version)
  const [rows, setRows] = useState(() =>
    [...initial.definitions]
      .sort((a, b) => a.category.localeCompare(b.category, locale))
      .map((definition, index) => ({
        id: index,
        locked: true,
        hideKey: false,
        definition,
      })),
  )
  const [preview, setPreview] = useState<DictionaryPreview | null>(null)
  const previewPanel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (preview) {
      previewPanel.current?.focus({ preventScroll: true })
      previewPanel.current?.scrollIntoView({ block: "nearest" })
    }
  }, [preview])
  const [redraft, setRedraft] = useState(false)
  const body = {
    definitions: rows.map((r) => r.definition),
    expected_version: baseVersion,
    redraft,
  }
  const check = useMutation({
    mutationFn: () =>
      CapabilitiesService.previewDictionaryEditor({
        path: { org_id: orgId },
        body,
      }),
    onMutate: () => {
      setError(null)
      setPreview(null)
    },
    onSuccess: ({ data }) => setPreview(data),
    onError: setError,
  })
  const save = useMutation({
    mutationFn: () =>
      CapabilitiesService.updateDictionary({ path: { org_id: orgId }, body }),
    onMutate: () => setError(null),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["dictionary-editor", orgId] })
      onSaved()
    },
    onError: setError,
  })
  const busy = check.isPending || save.isPending || !!suggestion?.blocked
  const proposed = suggestion?.item
    ? suggestion.values(initial).definitions
    : null
  const baseline = { ...initial, ...suggestion?.item?.before }.definitions
  const visibleRows = proposed
    ? [
        ...proposed.map((definition, id) => ({
          id,
          locked: true,
          hideKey: false,
          definition,
          removed: false,
        })),
        ...baseline
          .filter((d) => !proposed.some((next) => next.key === d.key))
          .map((definition, index) => ({
            id: proposed.length + index,
            locked: true,
            hideKey: false,
            definition,
            removed: true,
          })),
      ]
    : rows.map((row) => ({ ...row, removed: false }))
  function update(id: number, change: Partial<DictionaryDefinition>) {
    setPreview(null)
    setRows((values) =>
      values.map((row) =>
        row.id === id
          ? { ...row, definition: { ...row.definition, ...change } }
          : row,
      ),
    )
  }
  function add(proposal?: CapabilityProposalPublic) {
    const used = new Set(
      [...initial.definitions, ...body.definitions].map((d) => d.key),
    )
    let sequence = 1
    while (used.has(`capability_${sequence}`)) sequence++
    setRows([
      ...rows,
      {
        id: nextId.current++,
        locked: false,
        hideKey: !!proposal,
        definition: {
          key: `capability_${sequence}`,
          name: proposal?.name ?? "",
          category: proposal?.category ?? t("setup.browser.uncategorized"),
          description: proposal?.description ?? "",
          level_rubric: {
            levels: proposal
              ? [
                  ...new Map(
                    initial.definitions
                      .flatMap((definition) => definition.level_rubric.levels)
                      .map((level) => [level.key, level]),
                  ).values(),
                ]
              : [
                  {
                    key: "basic",
                    label: t("setup.editor.basicLevelDefault"),
                    description: "",
                  },
                ],
          },
        },
      },
    ])
    setPreview(null)
  }
  return (
    <section
      aria-label={t("setup.editor.sectionAriaLabel")}
      className="space-y-6 rounded-xl border p-4 sm:p-6"
    >
      <header>
        <h3 className="text-xl font-semibold">{t("setup.editor.heading")}</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("setup.editor.subtitle", { version: baseVersion })}
        </p>
      </header>
      <SetupError error={proposals.error} />
      {dismissed && (
        <p role="status">
          {t("setup.editor.dismissedNotice", { name: dismissed })}
        </p>
      )}
      {!!proposals.data?.data.length && (
        <section
          aria-label={t("setup.editor.proposalsHeading")}
          className="space-y-3 rounded-lg border p-4"
        >
          <h3 className="font-semibold">
            {t("setup.editor.proposalsHeading")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("setup.editor.proposalsDescription")}
          </p>
          {proposals.data.data.map((proposal) => (
            <article
              key={proposal.id}
              aria-label={t("setup.editor.proposalAriaLabel", {
                name: proposal.name,
              })}
              className="space-y-2 border-t pt-3"
            >
              <h4 className="font-medium">
                {proposal.name} ·{" "}
                {proposal.category || t("setup.browser.uncategorized")}
              </h4>
              <p>{proposal.description}</p>
              <p>
                {t("setup.editor.proposalReason", { reason: proposal.reason })}
              </p>
              <p className="text-sm font-medium">
                {proposal.proposed_by_employee_name
                  ? t("setup.editor.proposalByEmployee", {
                      name: proposal.proposed_by_employee_name,
                    })
                  : t("setup.editor.proposalByDraft", {
                      count: proposal.evidence_count,
                    })}
              </p>
              <p className="text-sm">
                {t("setup.editor.proposalMeta", {
                  evidenceCount: proposal.evidence_count,
                  employeeCount: proposal.employee_count,
                  updatedAt: formatDate(proposal.updated_at, {
                    dateStyle: "short",
                    timeStyle: "medium",
                    timeZone: "Asia/Shanghai",
                  }),
                })}
              </p>
              <ul className="list-disc pl-5 text-sm">
                {proposal.evidence_withdrawn && (
                  <li>{t("setup.editor.evidenceWithdrawn")}</li>
                )}
                {proposal.evidence_titles.map((title, i) => (
                  <li key={i}>{title}</li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button
                  disabled={
                    busy ||
                    rows.length >= 1000 ||
                    rows.some((r) => r.definition.name === proposal.name)
                  }
                  onClick={() => add(proposal)}
                >
                  {t("setup.editor.acceptProposal")}
                </Button>
                <ConfirmActionDialog
                  title={t("setup.editor.dismissTitle")}
                  description={t("setup.editor.dismissDescription", {
                    name: proposal.name,
                  })}
                  disabled={busy}
                  action={() =>
                    CapabilitiesService.dismissCapabilityProposal({
                      path: { org_id: orgId, id: proposal.id },
                    })
                  }
                  onSuccess={() => {
                    setDismissed(proposal.name)
                    client.invalidateQueries({
                      queryKey: ["capability-proposals", orgId],
                    })
                    client.invalidateQueries({
                      queryKey: ["admin-overview", orgId],
                    })
                  }}
                />
              </div>
            </article>
          ))}
        </section>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (suggestion?.blocked) return
          check.mutate()
        }}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-6">
          {visibleRows.map(
            ({ id, locked, hideKey, definition: d, removed }, rowIndex) => (
              <div key={id} className="space-y-4">
                {(rowIndex === 0 ||
                  visibleRows[rowIndex - 1].definition.category !==
                    d.category) && (
                  <h4 className="border-l-2 border-primary pl-3 font-semibold">
                    {d.category || t("setup.browser.uncategorized")}
                  </h4>
                )}
                <DraftField
                  changed={
                    !!proposed &&
                    (removed ||
                      JSON.stringify(
                        baseline.find((entry) => entry.key === d.key),
                      ) !== JSON.stringify(d))
                  }
                  label={
                    removed
                      ? t("setup.editor.draftRemove")
                      : baseline.some((entry) => entry.key === d.key)
                        ? t("setup.editor.draftModify")
                        : t("setup.editor.draftAdd")
                  }
                >
                  <article
                    aria-label={d.name || t("setup.editor.newCapabilityAria")}
                    className="min-w-0 space-y-4 rounded-lg border bg-muted/10 p-4"
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      {(
                        [
                          ["name", t("setup.editor.fields.name"), 200],
                          ["key", t("setup.editor.fields.key"), 100],
                          ["category", t("setup.editor.fields.category"), 200],
                          [
                            "description",
                            t("setup.editor.fields.description"),
                            4000,
                          ],
                        ] as const
                      )
                        .filter(([field]) => field !== "key" || !hideKey)
                        .map(([field, label, maxLength]) => (
                          <label
                            key={field}
                            htmlFor={`${prefix}-${id}-${field}`}
                            className="space-y-2 text-sm"
                          >
                            {label}
                            <Input
                              id={`${prefix}-${id}-${field}`}
                              required={field === "name" || field === "key"}
                              maxLength={maxLength}
                              disabled={locked && field === "key"}
                              value={d[field]}
                              onChange={(e) =>
                                update(id, { [field]: e.target.value })
                              }
                              onBlur={
                                field === "category"
                                  ? () =>
                                      setRows((values) =>
                                        [...values].sort((a, b) =>
                                          a.definition.category.localeCompare(
                                            b.definition.category,
                                            getLocale(),
                                          ),
                                        ),
                                      )
                                  : undefined
                              }
                            />
                          </label>
                        ))}
                    </div>
                    <fieldset className="min-w-0 space-y-3">
                      <legend className="mb-2 text-sm font-medium">
                        {t("setup.editor.levelsLegend")}
                      </legend>
                      {d.level_rubric.levels.map((level, index) => (
                        <div
                          key={index}
                          className="grid min-w-0 gap-3 rounded-md border p-3 sm:grid-cols-2"
                        >
                          {(
                            [
                              ["key", t("setup.editor.levelFields.key"), 100],
                              [
                                "label",
                                t("setup.editor.levelFields.label"),
                                200,
                              ],
                              [
                                "description",
                                t("setup.editor.levelFields.description"),
                                4000,
                              ],
                            ] as const
                          ).map(([field, label, maxLength]) => (
                            <label
                              key={field}
                              htmlFor={`${prefix}-${id}-${index}-${field}`}
                              className="space-y-2 text-sm"
                            >
                              {label}
                              <Input
                                id={`${prefix}-${id}-${index}-${field}`}
                                required
                                maxLength={maxLength}
                                value={level[field]}
                                onChange={(e) =>
                                  update(id, {
                                    level_rubric: {
                                      levels: d.level_rubric.levels.map(
                                        (l, i) =>
                                          i === index
                                            ? {
                                                ...l,
                                                [field]: e.target.value,
                                              }
                                            : l,
                                      ),
                                    },
                                  })
                                }
                              />
                            </label>
                          ))}
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={d.level_rubric.levels.length === 1}
                            onClick={() =>
                              update(id, {
                                level_rubric: {
                                  levels: d.level_rubric.levels.filter(
                                    (_, i) => i !== index,
                                  ),
                                },
                              })
                            }
                          >
                            {t("setup.editor.removeLevel")}
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        disabled={d.level_rubric.levels.length >= 20}
                        onClick={() =>
                          update(id, {
                            level_rubric: {
                              levels: [
                                ...d.level_rubric.levels,
                                { key: "", label: "", description: "" },
                              ],
                            },
                          })
                        }
                      >
                        {t("setup.editor.addLevel")}
                      </Button>
                    </fieldset>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setRows(rows.filter((r) => r.id !== id))
                        setPreview(null)
                      }}
                    >
                      {t("setup.editor.removeCapability")}
                    </Button>
                  </article>
                </DraftField>
              </div>
            ),
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={rows.length >= 1000}
              onClick={() => add()}
            >
              {t("setup.editor.addCapability")}
            </Button>
            <Button type="submit" disabled={!rows.length}>
              {t("setup.editor.previewChanges")}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("setup.editor.cancelEdit")}
            </Button>
          </div>
        </fieldset>
      </form>
      <SetupError error={error} />
      {preview && !suggestion?.draft && (
        <section
          ref={previewPanel}
          tabIndex={-1}
          aria-label={t("setup.editor.previewReadyAria")}
        >
          <DictionaryPreviewPanel
            preview={preview}
            busy={busy}
            redraft={redraft}
            onRedraft={setRedraft}
            onSave={() => save.mutate()}
          />
        </section>
      )}
    </section>
  )
}
