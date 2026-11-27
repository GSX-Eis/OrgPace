import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ExternalIdentitiesService,
  type ExternalIdentityPublic,
  type IdentityLink,
} from "@/client"
import { ConfirmActionDialog } from "@/components/Admin/ConfirmActionDialog"
import { PageDraft } from "@/components/AdminAssistant/PageDraft"
import { usePageDraft } from "@/components/AdminAssistant/usePageDraft"
import { SetupError } from "@/components/Setup/SetupError"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatDate } from "@/i18n/format"
import { EmployeePicker } from "./EmployeePicker"
import { UnlinkDialog } from "./UnlinkDialog"

export function IdentityTable({
  orgId,
  inWizard = false,
  employeeId,
  initialSource,
}: {
  orgId: string
  inWizard?: boolean
  employeeId?: string
  initialSource?: string
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const linkDraft = usePageDraft(orgId, "link_identity")
  const unlinkDraft = usePageDraft(orgId, "unlink_identity")
  const drafts = [linkDraft, unlinkDraft].filter(
    (entry, index, all) =>
      entry.draft &&
      all.findIndex((other) => other.draft?.id === entry.draft?.id) === index,
  )
  const draftItems = drafts.flatMap((entry) => entry.draft?.items ?? [])
  const [status, setStatus] = useState<"unlinked" | "linked">(
    employeeId ? "linked" : "unlinked",
  )
  const [q, setQ] = useState("")
  const [identityId, setIdentityId] = useState("")
  const [source, setSource] = useState(
    initialSource ?? (employeeId ? "jira" : ""),
  )
  const [skip, setSkip] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [picker, setPicker] = useState<ExternalIdentityPublic | null>(null)
  const [unlinking, setUnlinking] = useState<ExternalIdentityPublic | null>(
    null,
  )
  const [message, setMessage] = useState("")
  const identities = useQuery({
    queryKey: ["identities", orgId, "summary", employeeId],
    enabled: !employeeId,
    queryFn: async () => {
      const first = (
        await ExternalIdentitiesService.identitiesGetIdentities({
          path: { org_id: orgId },
          query: {
            status: "all",
            limit: 200,
            source: employeeId ? "jira" : undefined,
          },
        })
      ).data
      const rows = [...first.data]
      for (let offset = 200; offset < first.count; offset += 200) {
        rows.push(
          ...(
            await ExternalIdentitiesService.identitiesGetIdentities({
              path: { org_id: orgId },
              query: {
                status: "all",
                skip: offset,
                limit: 200,
                source: employeeId ? "jira" : undefined,
              },
            })
          ).data.data,
        )
      }
      return rows
    },
  })
  const rows = identities.data ?? []
  const unlinked = rows.filter((row) => !row.employee)
  const linked = rows.filter(
    (row) => row.employee && (!employeeId || row.employee.id === employeeId),
  )
  const page = useQuery({
    queryKey: ["identities", orgId, status, source, q, skip, employeeId],
    queryFn: async () =>
      (
        await ExternalIdentitiesService.identitiesGetIdentities({
          path: { org_id: orgId },
          query: {
            status,
            source: source || undefined,
            q,
            skip,
            limit: 50,
            employee_id: status === "linked" ? employeeId : undefined,
          },
        })
      ).data,
  })
  const visible = page.data?.data ?? []
  const count = page.data?.count ?? 0
  const candidates = visible.filter(
    (row) => row.candidate && (!employeeId || row.candidate.id === employeeId),
  )
  const links = visible
    .filter(
      (row) =>
        selected.includes(row.id) &&
        row.candidate &&
        (!employeeId || row.candidate.id === employeeId),
    )
    .map((row) => ({
      identity_id: row.id,
      employee_id: row.candidate!.id,
    }))
  async function refresh() {
    setSelected([])
    setIdentityId("")
    setSkip(0)
    await client.invalidateQueries({ queryKey: ["identities", orgId] })
  }
  const link = useMutation({
    mutationFn: (links: IdentityLink[]) =>
      ExternalIdentitiesService.identitiesPostLinks({
        path: { org_id: orgId },
        body: { links },
      }),
    onSuccess: async ({ data }) => {
      setPicker(null)
      setMessage(
        t("sources.identities.table.linkedMessage", {
          linked: data.linked,
          evidence: data.counts.evidence_added,
        }),
      )
      await refresh()
    },
  })
  const unlink = useMutation({
    mutationFn: (identityId: string) =>
      ExternalIdentitiesService.identitiesPostUnlink({
        path: { org_id: orgId, identity_id: identityId },
      }),
    onSuccess: async ({ data }) => {
      setUnlinking(null)
      setMessage(
        t("sources.identities.table.unlinkedMessage", {
          evidence: data.evidence_retracted,
        }),
      )
      await refresh()
    },
  })
  const actionPending = link.isPending || unlink.isPending
  const pending = actionPending || linkDraft.blocked || unlinkDraft.blocked
  function resetSelection() {
    setSelected([])
    setSkip(0)
  }
  return (
    <div className="min-w-0 space-y-5">
      <SetupError error={linkDraft.error ?? unlinkDraft.error} />
      {drafts.map((entry) => (
        <PageDraft
          key={entry.draft!.id}
          orgId={orgId}
          draft={entry.draft}
          error={entry.error}
        />
      ))}
      <div className="space-y-1 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
        <p>{t("sources.identities.table.intro")}</p>
      </div>
      {message && (
        <p
          role="status"
          className="rounded-lg border border-primary/30 bg-primary/5 p-3"
        >
          {message}
        </p>
      )}
      <SetupError
        error={identities.error ?? page.error ?? (!picker ? link.error : null)}
      />
      {(identities.isError || page.isError) && (
        <Button
          onClick={() => {
            identities.refetch()
            page.refetch()
          }}
        >
          {t("sources.identities.table.retry")}
        </Button>
      )}
      {!employeeId && (
        <Tabs
          value={status}
          onValueChange={(value) => {
            setStatus(value === "linked" ? "linked" : "unlinked")
            resetSelection()
          }}
        >
          <TabsList aria-label={t("sources.identities.table.tabsAriaLabel")}>
            <TabsTrigger value="unlinked" disabled={actionPending}>
              {t("sources.identities.table.unlinkedTab", {
                count: unlinked.length,
              })}
            </TabsTrigger>
            <TabsTrigger value="linked" disabled={actionPending}>
              {t("sources.identities.table.linkedTab", {
                count: linked.length,
              })}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {employeeId && (
          <select
            aria-label={t("sources.identities.table.statusAriaLabel")}
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={status}
            disabled={actionPending}
            onChange={(event) => {
              setStatus(event.target.value === "linked" ? "linked" : "unlinked")
              resetSelection()
            }}
          >
            <option value="linked">
              {t("sources.identities.table.linkedOption")}
            </option>
            <option value="unlinked">
              {t("sources.identities.table.unlinkedOption")}
            </option>
          </select>
        )}
        <Input
          aria-label={t("sources.identities.table.searchAriaLabel")}
          placeholder={t("sources.identities.table.searchPlaceholder")}
          className="sm:max-w-xs"
          value={q}
          disabled={actionPending}
          onChange={(e) => {
            setQ(e.target.value)
            setIdentityId("")
            resetSelection()
          }}
        />
        {!employeeId && (
          <select
            aria-label={t("sources.identities.table.sourceFilterAriaLabel")}
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={source}
            disabled={actionPending}
            onChange={(e) => {
              setSource(e.target.value)
              resetSelection()
            }}
          >
            <option value="">{t("sources.identities.table.allSources")}</option>
            {[
              ...new Map(
                rows.map((row) => [row.source, row.source_label]),
              ).entries(),
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        )}
        {!employeeId && status === "unlinked" && (
          <Button
            disabled={pending || !links.length}
            onClick={() => link.mutate(links)}
          >
            {links.length
              ? t("sources.identities.table.confirmSelectedWithCount", {
                  count: links.length,
                })
              : t("sources.identities.table.confirmSelected")}
          </Button>
        )}
      </div>
      {(!employeeId && identities.isPending) || page.isPending ? (
        <p role="status">{t("sources.identities.table.loading")}</p>
      ) : employeeId && status === "unlinked" ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-2 text-sm" htmlFor="link-employee-identity">
            <span className="block">
              {t("sources.identities.table.linkLabel")}
            </span>
            <select
              id="link-employee-identity"
              className="h-10 max-w-full rounded-md border bg-background px-3"
              value={identityId}
              disabled={pending || page.isError}
              onChange={(event) => setIdentityId(event.target.value)}
            >
              <option value="">
                {t("sources.identities.table.selectUnlinkedPlaceholder")}
              </option>
              {visible.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.display_name ?? row.external_id} · {row.external_id}
                </option>
              ))}
            </select>
          </label>
          <ConfirmActionDialog
            title={t("sources.identities.table.linkToEmployee")}
            disabled={pending || !visible.some((row) => row.id === identityId)}
            description={t("sources.identities.table.linkConfirmDesc", {
              account:
                visible.find((row) => row.id === identityId)?.external_id ?? "",
            })}
            action={() =>
              ExternalIdentitiesService.identitiesPostLinks({
                path: { org_id: orgId },
                body: {
                  links: [{ identity_id: identityId, employee_id: employeeId }],
                },
              })
            }
            onSuccess={() => {
              refresh()
              setStatus("linked")
            }}
          />
          {!visible.length && (
            <p>{t("sources.identities.table.noMatchingAccounts")}</p>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {status === "unlinked" && (
                <TableHead>
                  <Checkbox
                    aria-label={t(
                      "sources.identities.table.selectAllCandidatesAria",
                    )}
                    disabled={pending || !candidates.length}
                    checked={
                      candidates.length > 0 &&
                      candidates.every((row) => selected.includes(row.id))
                    }
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked ? candidates.map((row) => row.id) : [],
                      )
                    }
                  />
                </TableHead>
              )}
              <TableHead>{t("sources.identities.table.colSource")}</TableHead>
              <TableHead>{t("sources.identities.table.colAccount")}</TableHead>
              {status === "unlinked" ? (
                <>
                  <TableHead>
                    {t("sources.identities.table.colDisplayName")}
                  </TableHead>
                  <TableHead>
                    {t("sources.identities.table.colEmail")}
                  </TableHead>
                  <TableHead>
                    {t("sources.identities.table.colRecordCount")}
                  </TableHead>
                  <TableHead>
                    {t("sources.identities.table.colCandidate")}
                  </TableHead>
                </>
              ) : (
                <>
                  <TableHead>
                    {t("sources.identities.table.colEmployee")}
                  </TableHead>
                  <TableHead>
                    {t("sources.identities.table.colLinkedAt")}
                  </TableHead>
                </>
              )}
              <TableHead>{t("sources.identities.table.colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow
                key={row.id}
                data-assistant-suggested={
                  draftItems.some((item) => item.args.identity_id === row.id) ||
                  undefined
                }
                className={
                  draftItems.some((item) => item.args.identity_id === row.id)
                    ? "bg-primary/10"
                    : undefined
                }
              >
                {status === "unlinked" && (
                  <TableCell>
                    <Checkbox
                      aria-label={t(
                        "sources.identities.table.selectAccountAria",
                        { account: row.external_id },
                      )}
                      disabled={
                        pending ||
                        !row.candidate ||
                        (!!employeeId && row.candidate.id !== employeeId)
                      }
                      checked={selected.includes(row.id)}
                      onCheckedChange={(checked) =>
                        setSelected(
                          checked
                            ? [...selected, row.id]
                            : selected.filter((id) => id !== row.id),
                        )
                      }
                    />
                  </TableCell>
                )}
                <TableCell>{row.source_label}</TableCell>
                <TableCell className="font-mono text-xs">
                  {row.external_id}
                  {draftItems
                    .filter((item) => item.args.identity_id === row.id)
                    .map((item, i) => (
                      <p
                        key={i}
                        className="mt-2 font-sans font-medium text-primary"
                      >
                        {t(
                          "sources.identities.table.assistantSuggestionPrefix",
                        )}
                        {item.function === "link_identity"
                          ? t("sources.identities.table.suggestionLink")
                          : t("sources.identities.table.suggestionUnlink")}
                      </p>
                    ))}
                </TableCell>
                {status === "unlinked" ? (
                  <>
                    <TableCell>
                      {row.display_name ??
                        t("sources.identities.table.notProvided")}
                    </TableCell>
                    <TableCell>
                      {row.email ?? t("sources.identities.table.notProvided")}
                    </TableCell>
                    <TableCell>{row.record_count}</TableCell>
                    <TableCell>
                      {row.candidate ? (
                        <div className="space-y-1">
                          <p className="font-medium">
                            {t("sources.identities.table.nameWithCode", {
                              name: row.candidate.display_name,
                              code:
                                row.candidate.employee_code ??
                                t("sources.identities.table.noEmployeeCode"),
                            })}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {row.candidate.department?.name ??
                              t("sources.identities.table.noDepartment")}
                          </p>
                          <Badge
                            variant={
                              row.candidate.reason === "email"
                                ? "secondary"
                                : "outline"
                            }
                          >
                            {row.candidate.reason === "email"
                              ? t("sources.identities.table.reasonEmail")
                              : t("sources.identities.table.reasonName")}
                          </Badge>
                        </div>
                      ) : (
                        t("sources.identities.table.noCandidate")
                      )}
                    </TableCell>
                  </>
                ) : (
                  <>
                    <TableCell>
                      {t("sources.identities.table.nameWithCode", {
                        name: row.employee?.display_name ?? "",
                        code:
                          row.employee?.employee_code ??
                          t("sources.identities.table.noEmployeeCode"),
                      })}
                      <p className="text-xs text-muted-foreground">
                        {row.employee?.department?.name ??
                          t("sources.identities.table.noDepartment")}
                      </p>
                    </TableCell>
                    <TableCell>
                      {row.linked_at
                        ? formatDate(row.linked_at, {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : t("sources.identities.table.notRecorded")}
                      {row.linked_by === "system_worker:email_match" && (
                        <p className="text-xs text-muted-foreground">
                          {t("sources.identities.table.autoLinkedByEmail")}
                        </p>
                      )}
                    </TableCell>
                  </>
                )}
                <TableCell>
                  <div className="flex gap-2">
                    {status === "unlinked" && employeeId ? (
                      <ConfirmActionDialog
                        disabled={pending}
                        title={t("sources.identities.table.linkToEmployee")}
                        description={t(
                          "sources.identities.table.linkConfirmDesc",
                          { account: row.external_id },
                        )}
                        action={() =>
                          ExternalIdentitiesService.identitiesPostLinks({
                            path: { org_id: orgId },
                            body: {
                              links: [
                                {
                                  identity_id: row.id,
                                  employee_id: employeeId,
                                },
                              ],
                            },
                          })
                        }
                        onSuccess={() => {
                          refresh()
                        }}
                      />
                    ) : status === "unlinked" ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending || !row.candidate}
                          onClick={() =>
                            link.mutate([
                              {
                                identity_id: row.id,
                                employee_id: row.candidate!.id,
                              },
                            ])
                          }
                        >
                          {t("sources.identities.table.confirmCandidate")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => {
                            link.reset()
                            setPicker(row)
                          }}
                        >
                          {t("sources.identities.table.selectEmployee")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          unlink.reset()
                          setUnlinking(row)
                        }}
                      >
                        {t("sources.identities.table.unlink")}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!visible.length && (
              <TableRow>
                <TableCell
                  colSpan={status === "unlinked" ? 8 : 5}
                  className="py-10 text-center text-muted-foreground"
                >
                  {t("sources.identities.table.noMatchingAccounts")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          disabled={actionPending || !skip}
          onClick={() => {
            setSkip(skip - 50)
            setSelected([])
          }}
        >
          {t("sources.identities.table.prevPage")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t("sources.identities.table.totalAccounts", { count })}
        </span>
        <Button
          variant="outline"
          disabled={actionPending || skip + 50 >= count}
          onClick={() => {
            setSkip(skip + 50)
            setSelected([])
          }}
        >
          {t("sources.identities.table.nextPage")}
        </Button>
      </div>
      {inWizard && identities.isSuccess && unlinked.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t("sources.identities.table.wizardRemaining", {
            count: unlinked.length,
          })}
        </p>
      )}
      {picker && (
        <EmployeePicker
          orgId={orgId}
          account={picker.external_id}
          pending={pending}
          error={link.error}
          onSelect={(employeeId) =>
            link.mutate([{ identity_id: picker.id, employee_id: employeeId }])
          }
          onClose={() => {
            setPicker(null)
            link.reset()
          }}
        />
      )}
      {unlinking && (
        <UnlinkDialog
          account={unlinking.external_id}
          pending={pending}
          error={unlink.error}
          onConfirm={() => unlink.mutate(unlinking.id)}
          onClose={() => setUnlinking(null)}
        />
      )}
    </div>
  )
}
