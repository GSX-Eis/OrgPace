import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import { AxiosError } from "axios"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AdminAssistantService,
  type AdminSessionMessage,
  type AdminTurnInput,
  type AdminTurnResponse,
  type AdminUserMessage,
  type TableCard,
} from "@/client"
import {
  actorLabels,
  auditLabels,
  targetLabels,
} from "@/components/Admin/auditLabels"
import { TodayPanel } from "@/components/Admin/TodayPanel"
import { BotMessage } from "@/components/Bot/BotMessage"
import {
  beginAssistantRestart,
  getAssistantTurn,
  selectAssistantSession,
} from "@/components/Chat/assistantTurnStore"
import {
  ChatComposer,
  clearChatDraft,
  readChatDraft,
} from "@/components/Chat/ChatComposer"
import { ChatMessages } from "@/components/Chat/ChatMessages"
import { useSessionPanelSync } from "@/components/Chat/useSessionPanelSync"
import { useStreamingTurn } from "@/components/Chat/useStreamingTurn"
import { RosterPreview } from "@/components/Roster/RosterPreview"
import { SetupCard } from "@/components/Setup/SetupCards"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { useAdminAvailability } from "@/hooks/useAdminAvailability"
import {
  getCurrentConversation,
  rememberConversation,
  useCurrentConversation,
} from "@/hooks/useCurrentConversation"
import { useSetup } from "@/hooks/useSetup"
import { formatDate } from "@/i18n/format"
import { ChangeSetCard } from "./ChangeSetCard"
import { FileSummaryPreview } from "./FileSummaryPreview"
import { FileUploadCard } from "./FileUploadCard"
import { SecretInputCard } from "./SecretInputCard"

const ENUM_CELL_FIELDS = new Set([
  "status",
  "employment_status",
  "role",
  "platform",
  "kind",
  "trigger",
  "action",
  "actor_type",
  "target_type",
])

function formatCellText(
  value: unknown,
  labels: Record<string, string>,
  yesLabel: string,
  noLabel: string,
  separator: string,
  field = "",
): string {
  if (value == null) return "—"
  if (field === "allocation_percent" && typeof value === "number")
    return `${value}%`
  if (typeof value === "boolean") return value ? yesLabel : noLabel
  if (Array.isArray(value))
    return value
      .map((entry) =>
        formatCellText(entry, labels, yesLabel, noLabel, separator, field),
      )
      .join(separator)
  if (typeof value === "object") {
    for (const key of field === "roles"
      ? ["role"]
      : ["display_name", "name", "status"]) {
      const entry = Object.entries(value).find(([field]) => field === key)?.[1]
      if (entry != null)
        return formatCellText(entry, labels, yesLabel, noLabel, separator, key)
    }
    return Object.entries(value)
      .map(([key, entry]) =>
        formatCellText(entry, labels, yesLabel, noLabel, separator, key),
      )
      .join(separator)
  }
  return ENUM_CELL_FIELDS.has(field)
    ? (labels[String(value)] ??
        auditLabels[String(value)] ??
        actorLabels[String(value)] ??
        targetLabels[String(value)] ??
        String(value))
    : String(value)
}

function ReadTable({ table }: { table: TableCard }) {
  const { t } = useTranslation()
  const labels: Record<string, string> = {
    id: t("adminAssistant.labels.id"),
    employee_code: t("adminAssistant.labels.employee_code"),
    display_name: t("adminAssistant.labels.display_name"),
    title: t("adminAssistant.labels.title"),
    work_email: t("adminAssistant.labels.work_email"),
    employment_status: t("adminAssistant.labels.employment_status"),
    department: t("adminAssistant.labels.department"),
    department_name: t("adminAssistant.labels.department_name"),
    requesting_department_name: t(
      "adminAssistant.labels.requesting_department_name",
    ),
    capability_name: t("adminAssistant.labels.capability_name"),
    headcount: t("adminAssistant.labels.headcount"),
    allocation_percent: t("adminAssistant.labels.allocation_percent"),
    window_start: t("adminAssistant.labels.window_start"),
    window_end: t("adminAssistant.labels.window_end"),
    statement: t("adminAssistant.labels.statement"),
    level_name: t("adminAssistant.labels.level_name"),
    evidence_count: t("adminAssistant.labels.evidence_count"),
    latest_evidence_at: t("adminAssistant.labels.latest_evidence_at"),
    latest_evidence_date: t("adminAssistant.labels.latest_evidence_date"),
    published_by: t("adminAssistant.labels.published_by"),
    published_at: t("adminAssistant.labels.published_at"),
    account: t("adminAssistant.labels.account"),
    roles: t("adminAssistant.labels.roles"),
    username: t("adminAssistant.labels.username"),
    role: t("adminAssistant.labels.role"),
    department_id: t("adminAssistant.labels.department_id"),
    user_id: t("adminAssistant.labels.user_id"),
    kind: t("adminAssistant.labels.kind"),
    status: t("adminAssistant.labels.status"),
    trigger: t("adminAssistant.labels.trigger"),
    attempts: t("adminAssistant.labels.attempts"),
    counts: t("adminAssistant.labels.counts"),
    error: t("adminAssistant.labels.error"),
    filename: t("adminAssistant.labels.filename"),
    created_at: t("adminAssistant.labels.created_at"),
    started_at: t("adminAssistant.labels.started_at"),
    finished_at: t("adminAssistant.labels.finished_at"),
    updated_at: t("adminAssistant.labels.updated_at"),
    platform: t("adminAssistant.labels.platform"),
    enabled: t("adminAssistant.labels.enabled"),
    email_auto_bind: t("adminAssistant.labels.email_auto_bind"),
    has_credentials: t("adminAssistant.labels.has_credentials"),
    summary: t("adminAssistant.labels.summary"),
    action: t("adminAssistant.labels.action"),
    actor_id: t("adminAssistant.labels.actor_id"),
    actor_type: t("adminAssistant.labels.actor_type"),
    target_id: t("adminAssistant.labels.target_id"),
    target_type: t("adminAssistant.labels.target_type"),
    details: t("adminAssistant.labels.details"),
    open: t("adminAssistant.labels.open"),
    upheld: t("adminAssistant.labels.upheld"),
    confirmed: t("adminAssistant.labels.confirmed"),
    tentative: t("adminAssistant.labels.tentative"),
    disputed: t("adminAssistant.labels.disputed"),
    reopened: t("adminAssistant.labels.reopened"),
    submitted: t("adminAssistant.labels.submitted"),
    replied: t("adminAssistant.labels.replied"),
    accepted: t("adminAssistant.labels.accepted"),
    withdrawn: t("adminAssistant.labels.withdrawn"),
    preview: t("adminAssistant.labels.preview"),
    applied: t("adminAssistant.labels.applied"),
    active: t("adminAssistant.labels.active"),
    inactive: t("adminAssistant.labels.inactive"),
    none: t("adminAssistant.labels.none"),
    pending_first_login: t("adminAssistant.labels.pending_first_login"),
    disabled: t("adminAssistant.labels.disabled"),
    org_admin: t("adminAssistant.labels.org_admin"),
    dept_manager: t("adminAssistant.labels.dept_manager"),
    employee: t("adminAssistant.labels.employee"),
    queued: t("adminAssistant.labels.queued"),
    running: t("adminAssistant.labels.running"),
    succeeded: t("adminAssistant.labels.succeeded"),
    failed: t("adminAssistant.labels.failed"),
    manual: t("adminAssistant.labels.manual"),
    retry: t("adminAssistant.labels.retry"),
    schedule: t("adminAssistant.labels.schedule"),
    feishu: t("adminAssistant.labels.feishu"),
    jira: t("adminAssistant.labels.jira"),
    csv: t("adminAssistant.labels.csv"),
  }
  const yesLabel = t("adminAssistant.booleanYes")
  const noLabel = t("adminAssistant.booleanNo")
  const separator = t("adminAssistant.listSeparator")
  const { columns } = table
  const personId = columns.includes("capability_name")
    ? columns.indexOf("employee_id")
    : -1
  const projectId =
    table.page === "/capacity" && columns.includes("requesting_department_name")
      ? columns.indexOf("id")
      : -1
  const demandIdIndex =
    table.page === "/capacity" && columns.includes("capability_name")
      ? columns.indexOf("id")
      : -1
  const canReplyIndex = columns.indexOf("can_reply")
  const shown = columns
    .map((column, index) => ({ column, index }))
    .filter(
      ({ column, index }) =>
        index !== personId &&
        index !== projectId &&
        index !== demandIdIndex &&
        !(demandIdIndex >= 0 && index === canReplyIndex) &&
        !(personId >= 0 && ["capability_key", "level"].includes(column)),
    )

  return (
    <div className="overflow-x-auto rounded-xl border p-3">
      <p>
        {table.title}
        {table.queried_at && (
          <span className="ml-2 text-xs text-muted-foreground">
            {t("adminAssistant.queriedAt", {
              time: formatDate(table.queried_at, {
                hour: "2-digit",
                minute: "2-digit",
              }),
            })}
          </span>
        )}
        {t("adminAssistant.tableTotal", { total: table.total })}
      </p>
      <table className="w-max min-w-full text-left text-sm">
        <thead>
          <tr>
            {shown.map(({ column }) => (
              <th key={column} className="whitespace-nowrap p-2">
                {projectId >= 0 && column === "title"
                  ? t("adminAssistant.projectNameColumn")
                  : (labels[column] ?? t("adminAssistant.infoColumn"))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {shown.map(({ column, index }) => {
                const text = formatCellText(
                  row[index],
                  labels,
                  yesLabel,
                  noLabel,
                  separator,
                  column,
                )
                const employeeId = row[personId]
                const project = row[projectId]
                const demandId = row[demandIdIndex]
                return (
                  <td
                    key={column}
                    className="min-w-[8em] max-w-64 break-words p-2"
                  >
                    {column === "display_name" &&
                    typeof employeeId === "string" ? (
                      <Link
                        to="/employees/$employeeId"
                        params={{ employeeId }}
                        className="underline"
                      >
                        {text}
                      </Link>
                    ) : column === "title" && typeof project === "string" ? (
                      <Link
                        to="/capacity"
                        search={{ tab: "projects", project }}
                        className="underline"
                      >
                        {text}
                      </Link>
                    ) : column === "capability_name" &&
                      typeof demandId === "string" ? (
                      <Link
                        to="/capacity"
                        search={{
                          tab:
                            row[canReplyIndex] === true
                              ? "incoming"
                              : "outgoing",
                          demand: demandId,
                        }}
                        className="underline"
                      >
                        {text}
                      </Link>
                    ) : (
                      text
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <Link
        to={table.page}
        search={projectId >= 0 ? { tab: "projects" } : undefined}
        className="underline"
      >
        {t("adminAssistant.openPage")}
      </Link>
    </div>
  )
}

function displayInput(
  body: AdminUserMessage,
  hiddenText: string,
): AdminUserMessage {
  return /(?<![A-Za-z0-9])sk-\S+|(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/.test(
    body.text,
  )
    ? { ...body, text: hiddenText }
    : body
}

export function AdminAssistantPanel({
  orgId,
  storageKey,
  sessionId: selectedSession,
  navigationKey,
  restart,
  prefill,
}: {
  orgId: string
  storageKey: string
  sessionId?: string
  navigationKey?: string
  restart?: number
  prefill?: { text: string }
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const navigate = useNavigate()
  const router = useRouter()
  const setup = useSetup()
  const availability = useAdminAvailability()
  const available = availability.data?.available === true
  const [uploading, setUploading] = useState(false)
  const remembered = useCurrentConversation(storageKey)
  const sessionId = selectedSession ?? (remembered || undefined)
  const creatingSession = useRef<{
    navigationKey?: string
    promise: Promise<string>
  } | null>(null)
  const [text, setText] = useState(prefill?.text ?? "")
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const query = { org_id: orgId }
  const messageKey = ["admin-assistant-messages", orgId, sessionId]
  const activeTurn = getAssistantTurn(storageKey, sessionId)
  const history = useQuery({
    queryKey: messageKey,
    enabled:
      !!sessionId &&
      (activeTurn?.status !== "streaming" ||
        client.getQueryData(messageKey) !== undefined),
    staleTime: activeTurn?.status === "streaming" ? Infinity : 0,
    retry: false,
    queryFn: async ({ signal }) =>
      (
        await AdminAssistantService.assistantListMessages({
          query,
          path: { session_id: sessionId! },
          signal,
        })
      ).data,
  })
  const messages = history.data ?? []
  const setupIntro =
    messages.some(
      (entry) =>
        "messages" in entry.payload &&
        entry.payload.messages.some((card) => card.type === "setup_checklist"),
    ) && !messages.some((entry) => entry.role === "user")
  const expired =
    history.error instanceof AxiosError &&
    history.error.response?.status === 404
  useEffect(() => {
    if (expired) {
      if (
        selectedSession &&
        localStorage.getItem(storageKey) === selectedSession
      )
        rememberConversation(storageKey, "")
      client.invalidateQueries({
        queryKey: ["conversation-history", orgId, true],
      })
    }
  }, [expired, storageKey, selectedSession, orgId, client])
  const ensureSession = async (signal?: AbortSignal) => {
    if (!expired && sessionId) return sessionId
    if (
      !creatingSession.current ||
      creatingSession.current.navigationKey !== navigationKey
    ) {
      const promise = AdminAssistantService.assistantCreateSession({
        query,
        signal,
      })
        .then(({ data }) => data.session_id)
        .catch((error) => {
          if (creatingSession.current?.promise === promise)
            creatingSession.current = null
          throw error
        })
      creatingSession.current = { navigationKey, promise }
    }
    return creatingSession.current.promise
  }
  const stream = useStreamingTurn<AdminTurnInput, AdminTurnResponse>({
    storageKey,
    sessionId: expired ? undefined : sessionId,
    url: (id) => `/api/v1/admin-assistant/sessions/${id}/turns?org_id=${orgId}`,
    resolveSession: ensureSession,
    onComplete: (id, user, response, created_at) => {
      client.setQueryData<
        (Pick<AdminSessionMessage, "role" | "payload"> & {
          created_at?: string
        })[]
      >(["admin-assistant-messages", orgId, id], (previous = []) => [
        ...previous,
        ...(response.messages.some(
          (message) =>
            message.type === "text" &&
            (message.text === "请用安全输入框填写" || // i18n-ignore: 兼容后端返回的安全输入框固定提示文案
              message.text === "Please enter it using the secure input box"),
        )
          ? []
          : [
              {
                ...user,
                payload: { ...user.payload, page: "/admin/assistant" as const },
              },
            ]),
        { role: "assistant", payload: response, created_at },
      ])
      void client.invalidateQueries({
        predicate: (query) =>
          !["admin-assistant-messages", "chat-attachment"].includes(
            String(query.queryKey[0]),
          ),
      })
    },
  })
  const send = useMutation({
    onMutate: () => navigationKey,
    mutationFn: (body: AdminUserMessage) =>
      stream.run(
        {
          text: body.text,
          page: body.page,
          attachment_ids: body.attachment_ids,
        },
        displayInput(body, t("adminAssistant.secretHidden")),
      ),
    onSuccess: (id, _body, startedAt) => {
      if (
        id &&
        getAssistantTurn(storageKey, id)?.status === "completed" &&
        mounted.current &&
        router.state.location.state.__TSR_key === startedAt
      ) {
        navigate({
          to: "/assistant",
          search: { mode: "admin", session: id },
          replace: true,
        })
      }
    },
  })
  const pendingMessage = stream.pendingUserMessage
  const busy =
    (!!sessionId && history.isFetching) ||
    (history.isError && !expired) ||
    stream.isPending ||
    uploading
  const uploaded = (response: AdminTurnResponse) => {
    client.setQueryData(messageKey, [
      ...messages,
      { role: "assistant", payload: response },
    ])
    client.invalidateQueries()
  }
  const { bottom, preserveText } = useSessionPanelSync({
    storageKey,
    mode: "admin",
    selectedSession,
    syncEmptyStorage: true,
    onStorageSync: () => {
      creatingSession.current = null
    },
    scroll: {
      enabled: !setupIntro || !!pendingMessage,
      messageCount: messages.length,
      streamText: stream.text,
      tools: stream.tools,
      busy,
    },
  })
  useLayoutEffect(() => {
    if (selectedSession) {
      rememberConversation(storageKey, selectedSession)
    } else if (restart && beginAssistantRestart(storageKey, restart)) {
      rememberConversation(storageKey, "")
      clearChatDraft(`${storageKey}:new`)
      creatingSession.current = null
      setText(prefill?.text ?? "")
    } else {
      // Keep this tab's selection if another tab changes the saved ID while away.
      selectAssistantSession(
        storageKey,
        getCurrentConversation(storageKey) ?? "",
      )
    }
  }, [restart, selectedSession, storageKey, prefill])
  useEffect(() => {
    if (!preserveText.current)
      setText(
        prefill?.text ||
          readChatDraft(
            `${storageKey}:${selectedSession ?? (getCurrentConversation(storageKey) || "new")}`,
          ),
      )
    preserveText.current = false
    creatingSession.current = null
  }, [selectedSession, storageKey, prefill, preserveText])
  const content = (
    <>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-6 text-sm [&>*]:mx-auto [&>*]:max-w-3xl [&>*+*]:mt-4"
        role="log"
        aria-label={t("adminAssistant.logAria")}
        aria-busy={busy}
      >
        {!available && (
          <p role="status" className="rounded-lg border bg-muted/40 p-4">
            {availability.data?.reason || t("adminAssistant.checkingStatus")}
            {(availability.data?.reason?.includes("模型") || // i18n-ignore: 匹配后端返回的中文模型不可用原因
              availability.data?.reason?.toLowerCase().includes("model")) && (
              <span className="mt-2 block">
                {t("adminAssistant.modelUnavailable")}
                <Link
                  to="/admin/data-ai"
                  search={{ tab: "model" }}
                  className="underline"
                >
                  {t("adminAssistant.configureModel")}
                </Link>
              </span>
            )}
          </p>
        )}
        <SetupError error={availability.error} />
        {!sessionId && !messages.length && !pendingMessage && (
          <>
            <div className="space-y-8 py-6">
              <div className="space-y-3 text-center">
                <h2 className="text-2xl font-semibold">
                  {t("adminAssistant.heroTitle")}
                </h2>
                <p className="text-muted-foreground">
                  {t("adminAssistant.heroSubtitle")}
                </p>
              </div>
              <section
                className="space-y-3"
                aria-label={t("adminAssistant.quickActionsAria")}
              >
                <h2 className="font-semibold">
                  {t("adminAssistant.quickActionsTitle")}
                </h2>
                <div className="flex flex-wrap gap-2">
                  {[
                    t("adminAssistant.quickActions.syncDrafting"),
                    t("adminAssistant.quickActions.reminderSchedule"),
                    t("adminAssistant.quickActions.employeesAccounts"),
                    t("adminAssistant.quickActions.inactiveEmployees"),
                    t("adminAssistant.quickActions.feishuConnection"),
                    t("adminAssistant.quickActions.troubleshootSync"),
                  ].map((example) => (
                    <Button
                      type="button"
                      variant="outline"
                      key={example}
                      className="h-auto rounded-full px-3 py-2 text-xs font-normal"
                      onClick={() => setText(example)}
                    >
                      {example}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("adminAssistant.confirmNotice")}
                </p>
              </section>
            </div>

            <TodayPanel orgId={orgId} onPrompt={setText} />
          </>
        )}
        <ChatMessages
          onDownload={async (id) =>
            (
              await AdminAssistantService.assistantDownloadAttachment({
                query,
                path: {
                  session_id: stream.sessionId ?? sessionId!,
                  attachment_id: id,
                },
              })
            ).data
          }
          messages={pendingMessage ? [...messages, pendingMessage] : messages}
          text={stream.text}
          tools={stream.tools}
          stopped={stream.stopped}
          renderMessage={(entry, index) => (
            <div key={`${sessionId}:${index}`} className="space-y-4">
              {"messages" in entry.payload
                ? entry.payload.messages.map((message, i) =>
                    message.type === "setup_checklist" ||
                    message.type === "setup_form" ? (
                      <SetupCard
                        key={i}
                        orgId={orgId}
                        showCompanyEditor={
                          message.type === "setup_checklist" &&
                          "messages" in entry.payload &&
                          !entry.payload.messages.some(
                            (card) =>
                              card.type === "setup_form" &&
                              card.step === "org_profile",
                          )
                        }
                        step={
                          message.type === "setup_form"
                            ? message.step
                            : undefined
                        }
                      />
                    ) : message.type === "link" ? (
                      <Link
                        key={i}
                        to={message.page}
                        className="block rounded-xl border p-4 underline"
                      >
                        {message.title}
                      </Link>
                    ) : message.type === "file_upload" ? (
                      <FileUploadCard
                        key={i}
                        orgId={orgId}
                        sessionId={sessionId!}
                        card={message}
                        disabled={busy}
                        onUploaded={uploaded}
                        onUploading={setUploading}
                      />
                    ) : message.type === "file_preview" ? (
                      <div
                        key={i}
                        className="rounded-xl border bg-background p-4"
                      >
                        {"counts" in message.preview ? (
                          <FileSummaryPreview preview={message.preview} />
                        ) : (
                          <RosterPreview preview={message.preview} />
                        )}
                      </div>
                    ) : message.type === "admin_change_set" ? (
                      <ChangeSetCard
                        key={i}
                        orgId={orgId}
                        changeSet={message.change_set}
                        disabled={busy}
                      />
                    ) : message.type === "secret_input" ? (
                      <SecretInputCard
                        key={i}
                        orgId={orgId}
                        card={message}
                        disabled={busy}
                      />
                    ) : message.type === "table" ? (
                      <ReadTable key={i} table={message} />
                    ) : (
                      <BotMessage
                        key={i}
                        message={message}
                        disabled={busy}
                        onAction={() => {}}
                      />
                    ),
                  )
                : entry.payload.text}
            </div>
          )}
        />
        {setupIntro &&
          !pendingMessage &&
          available &&
          setup.data?.steps
            .filter((step) => step.required)
            .every((step) => step.status === "completed") && (
            <Button
              disabled={busy}
              onClick={() => {
                const body = {
                  text: t("adminAssistant.continueSetupPrompt"),
                  page: "/admin/assistant" as const,
                }
                send.mutate(body)
              }}
            >
              {t("adminAssistant.continueSetupButton")}
            </Button>
          )}
        <div ref={bottom} />
        {(busy ||
          (!expired && history.error) ||
          stream.error ||
          expired ||
          history.isError) && (
          <div className="mx-auto w-full max-w-3xl space-y-4">
            {busy && <p role="status">{t("adminAssistant.thinking")}</p>}
            <SetupError
              error={(!expired ? history.error : null) ?? stream.error}
            />
            {expired && (
              <p role="status">{t("adminAssistant.sessionExpired")}</p>
            )}
            {history.isError && (
              <Button onClick={() => history.refetch()}>
                {t("adminAssistant.retry")}
              </Button>
            )}
          </div>
        )}
      </div>
      <ChatComposer
        key={navigationKey}
        draftKey={`${storageKey}:${sessionId ?? "new"}`}
        id="admin-assistant-input"
        label={t("adminAssistant.inputLabel")}
        placeholder={t("adminAssistant.inputPlaceholder")}
        text={text}
        onChange={setText}
        onUpload={async (file) => {
          const id = await ensureSession()
          return (
            await AdminAssistantService.assistantUploadAttachment({
              query,
              path: { session_id: id },
              body: { file },
            })
          ).data
        }}
        onSend={async (attachments) => {
          const body = {
            text: text.trim() || t("adminAssistant.attachmentPrompt"),
            page: "/admin/assistant" as const,
            attachments,
            attachment_ids: attachments.map((item) => item.id),
          }
          setText("")
          return !!(await send.mutateAsync(body))
        }}
        busy={stream.isPending}
        disabled={busy || !available}
        onStop={stream.stop}
      />
    </>
  )
  return <div className="flex h-full min-h-0 flex-col">{content}</div>
}
