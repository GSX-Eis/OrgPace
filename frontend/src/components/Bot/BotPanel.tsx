import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { AxiosError } from "axios"
import { LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type AttachmentPublic,
  BotService,
  EmployeeRequestsService,
  type SessionMessage,
  type TurnInput,
  type TurnResponse,
  type UserMessage,
} from "@/client"
import { invalidateCapacityAll } from "@/components/Capacity/queries"
import {
  getAssistantTurn,
  selectAssistantSession,
} from "@/components/Chat/assistantTurnStore"
import { ChatComposer, readChatDraft } from "@/components/Chat/ChatComposer"
import { ChatMessages } from "@/components/Chat/ChatMessages"
import { useSessionPanelSync } from "@/components/Chat/useSessionPanelSync"
import { useStreamingTurn } from "@/components/Chat/useStreamingTurn"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import type { AssistantMode } from "@/hooks/useAssistantWorkspace"
import {
  getCurrentConversation,
  rememberConversation,
} from "@/hooks/useCurrentConversation"
import { useOrg } from "@/hooks/useOrg"
import { type BotAction, BotMessage } from "./BotMessage"
import { foldedStatusCards, requestCardHistory } from "./requestCards"

type BotEntry = Pick<SessionMessage, "role" | "payload"> &
  Partial<Pick<SessionMessage, "created_at">>

const messageKey = (storageKey: string, sessionId: string) =>
  ["bot-session-messages", storageKey, sessionId] as const

export function BotConversation({
  orgId,
  employeeId,
  storageKey,
  selectedSession,
  restart,
  mode,
  prompt,
}: {
  orgId: string
  employeeId: string
  storageKey: string
  selectedSession?: string
  restart?: number
  mode?: AssistantMode
  prompt?: string
}) {
  const { t } = useTranslation()
  const { managedDepartmentIds } = useOrg()
  const description = managedDepartmentIds.length
    ? t("bot.scopeTeam")
    : t("bot.scopeSelf")
  const client = useQueryClient()
  const navigate = useNavigate()
  const [sessionId, setSessionId] = useState("")
  const [text, setText] = useState(prompt ?? "")
  const [expired, setExpired] = useState(false)
  const replacementSession = useRef("")
  const [conflict, setConflict] = useState<
    "preview" | "withdraw" | "review" | "profile_edit" | null
  >(null)
  const initialization = useRef(0)
  const query = { org_id: orgId }
  const history = useQuery<BotEntry[]>({
    queryKey: messageKey(storageKey, sessionId),
    enabled: false,
  })
  const setMessages = (
    update: BotEntry[] | ((previous: BotEntry[]) => BotEntry[]),
  ) =>
    client.setQueryData<BotEntry[]>(
      messageKey(storageKey, sessionId),
      (previous = []) =>
        typeof update === "function" ? update(previous) : update,
    )
  const dictionary = useQuery({
    queryKey: ["my-capabilities", orgId],
    queryFn: async () =>
      (await EmployeeRequestsService.readMyCapabilities({ path: query })).data,
  })
  const initialize = useMutation({
    onMutate: () => ++initialization.current,
    mutationFn: async (selection?: string) => {
      let expired = false
      let id = selection ?? getCurrentConversation(storageKey)
      if (id) {
        try {
          const key = messageKey(storageKey, id)
          if (getAssistantTurn(storageKey, id)?.status !== "streaming") {
            const session = id
            await client.fetchQuery({
              queryKey: key,
              queryFn: async ({ signal }) =>
                (
                  await BotService.listMessages({
                    query,
                    path: { session_id: session },
                    signal,
                  })
                ).data,
            })
          }
          return { id, expired }
        } catch (error) {
          if (!(error instanceof AxiosError) || error.response?.status !== 404)
            throw error
          expired = true
        }
      }
      id = (await BotService.createSession({ query })).data.session_id
      return { id, expired }
    },
    onSuccess: (data, requested, startedAt) => {
      if (initialization.current !== startedAt) return
      preserveText.current = false
      if (requested || getCurrentConversation(storageKey) !== data.id)
        rememberConversation(storageKey, data.id)
      else selectAssistantSession(storageKey, data.id)
      if (data.expired) replacementSession.current = data.id
      setExpired(data.expired || replacementSession.current === data.id)
      if (data.expired)
        navigate({
          to: "/assistant",
          search: (previous) => ({ ...previous, session: data.id }),
          replace: true,
        })
      if (data.expired)
        client.invalidateQueries({
          queryKey: ["conversation-history", orgId, false],
        })
      setConflict(null)
      send.reset()
      setSessionId(data.id)
      setText((current) => current || readChatDraft(`${storageKey}:${data.id}`))
    },
  })
  const refreshProfileQueries = () => {
    void client.invalidateQueries({
      queryKey: ["conversation-history", orgId],
    })
    void client.invalidateQueries({
      queryKey: ["change-requests", orgId],
      refetchType: "all",
    })
    void client.invalidateQueries({
      queryKey: ["profile", orgId],
      refetchType: "all",
    })
    void client.invalidateQueries({
      queryKey: ["profile-versions", orgId],
      refetchType: "all",
    })
    void client.invalidateQueries({ queryKey: ["inbox", orgId] })
    void client.invalidateQueries({ queryKey: ["reviews", orgId] })
    void client.invalidateQueries({ queryKey: ["employees", orgId] })
    void client.invalidateQueries({ queryKey: ["employee", orgId] })
    void client.invalidateQueries({ queryKey: ["coverage", orgId] })
    void client.invalidateQueries({ queryKey: ["capability-stats", orgId] })
  }
  const stream = useStreamingTurn<TurnInput, TurnResponse>({
    storageKey,
    sessionId,
    url: (id) => `/api/v1/bot/sessions/${id}/turns?org_id=${orgId}`,
    onComplete: (id, user, response, created_at) => {
      client.setQueryData<BotEntry[]>(
        messageKey(storageKey, id),
        (previous = []) => [
          ...previous,
          user,
          { role: "assistant", payload: response, created_at },
        ],
      )
      refreshProfileQueries()
      void invalidateCapacityAll(client, orgId)
    },
  })
  const sendTurn = useMutation({
    onMutate: () => initialization.current,
    mutationFn: (payload: UserMessage) =>
      stream.run(
        { text: payload.text, attachment_ids: payload.attachment_ids },
        payload,
      ),
    onSuccess: (_result, _input, startedAt) => {
      if (initialization.current === startedAt) setConflict(null)
    },
    onError: (error, _input, startedAt) => {
      if (error instanceof AxiosError && error.response?.status === 409) {
        refreshProfileQueries()
        if (initialization.current === startedAt) setConflict("preview")
      } else if (initialization.current === startedAt) {
        setConflict(null)
      }
    },
  })
  const send = useMutation({
    onMutate: () => initialization.current,
    mutationFn: async (input: BotAction) => ({
      response: (
        await BotService.act({
          query,
          path: { session_id: sessionId },
          body: input,
        })
      ).data,
      created_at: new Date().toISOString(),
    }),
    onSuccess: (result, input, startedAt) => {
      refreshProfileQueries()
      if (
        input.action === "confirm_project_draft" ||
        input.action === "confirm_capacity"
      )
        void invalidateCapacityAll(client, orgId)
      if (initialization.current !== startedAt) return
      if (input.action === "confirm_review") {
        const resultText =
          result.response.messages[0]?.type === "text"
            ? result.response.messages[0].text
            : t("bot.reviewSavedFallback")
        setMessages((previous) =>
          previous.map((entry) =>
            "messages" in entry.payload
              ? {
                  ...entry,
                  payload: {
                    ...entry.payload,
                    messages: entry.payload.messages.map((item) =>
                      item.type === "review_card" &&
                      item.card_id === input.card_id
                        ? {
                            ...item,
                            actions: [],
                            status: "confirmed" as const,
                            result: resultText,
                          }
                        : item,
                    ),
                  },
                }
              : entry,
          ),
        )
      } else if (input.action === "confirm_profile_edit") {
        const resultText =
          result.response.messages[0]?.type === "text"
            ? result.response.messages[0].text
            : t("bot.profilePublishedFallback")
        setMessages((previous) =>
          previous.map((entry) =>
            "messages" in entry.payload
              ? {
                  ...entry,
                  payload: {
                    ...entry.payload,
                    messages: entry.payload.messages.map((item) =>
                      item.type === "profile_edit_card" &&
                      item.card_id === input.card_id
                        ? {
                            ...item,
                            actions: [],
                            status: "confirmed" as const,
                            result: resultText,
                          }
                        : item,
                    ),
                  },
                }
              : entry,
          ),
        )
      } else {
        setMessages((previous) => [
          ...previous,
          {
            role: "assistant",
            payload: result.response,
            created_at: result.created_at,
          },
        ])
      }
      setConflict(null)
    },
    onError: async (error, input, startedAt) => {
      if (error instanceof AxiosError && error.response?.status === 409)
        refreshProfileQueries()
      if (initialization.current !== startedAt) return
      if (!(error instanceof AxiosError) || error.response?.status !== 409) {
        setConflict(null)
        return
      }
      const action = input.action
      setConflict(
        action === "withdraw"
          ? "withdraw"
          : action === "confirm_review" || action === "continue_review"
            ? "review"
            : action === "confirm_profile_edit" ||
                action === "continue_profile_edit"
              ? "profile_edit"
              : "preview",
      )
      const refreshed = await BotService.listMessages({
        query,
        path: { session_id: sessionId },
      }).catch(() => null)
      if (refreshed && initialization.current === startedAt)
        setMessages(refreshed.data)
    },
  })
  const busy = initialize.isPending || send.isPending || stream.isPending
  const messages = stream.pendingUserMessage
    ? [...(history.data ?? []), stream.pendingUserMessage]
    : (history.data ?? [])
  const { bottom, preserveText } = useSessionPanelSync({
    storageKey,
    mode,
    selectedSession,
    replaceOnStorageSync: true,
    scroll: {
      messageCount: messages.length,
      streamText: stream.text,
      tools: stream.tools,
    },
  })
  useEffect(() => {
    if (restart) replacementSession.current = ""
    setSessionId("")
    if (!preserveText.current) setText(prompt ?? "")
    initialize.mutate(selectedSession)
    return () => {
      initialization.current++
    }
  }, [initialize.mutate, selectedSession, restart, prompt, preserveText])
  async function sendText(value: string, attachments: AttachmentPublic[] = []) {
    setText("")
    const result = await sendTurn.mutateAsync({
      text: value,
      attachments,
      attachment_ids: attachments.map((item) => item.id),
    })
    return !!result
  }
  const cards = messages.flatMap(({ payload }) =>
    "messages" in payload ? payload.messages : [],
  )
  const requestHistory = requestCardHistory(cards)
  const foldedCards = foldedStatusCards(cards)
  const confirmedCardResults = new Set(
    cards.flatMap((card) =>
      (card.type === "review_card" || card.type === "profile_edit_card") &&
      card.status === "confirmed" &&
      card.result
        ? [card.result]
        : [],
    ),
  )
  const visibleMessages = messages.flatMap((entry) => {
    if (!("messages" in entry.payload)) return [entry]
    const turnMessages = entry.payload.messages
    const filtered = turnMessages.filter(
      (item) =>
        !(item.type === "status_card" && foldedCards.has(item)) &&
        !(
          item.type === "text" &&
          turnMessages.length === 1 &&
          confirmedCardResults.has(item.text)
        ),
    )
    return filtered.length
      ? [{ ...entry, payload: { ...entry.payload, messages: filtered } }]
      : []
  })
  const latestProjectDraft = cards
    .reverse()
    .find((message) => message.type === "project_draft_card")
  return (
    <>
      <div
        className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 text-sm"
        role="log"
        aria-label={t("bot.logAria")}
        aria-busy={busy}
      >
        {messages.length === 0 && (
          <p className="mx-auto max-w-3xl text-muted-foreground leading-relaxed">
            {t("bot.introMain")}
            {managedDepartmentIds.length > 0 && t("bot.introTeam")}
            <br />
            {description}
            {t("bot.introBeforeLink")}
            <Link
              className="underline"
              to="/employees/$employeeId"
              params={{ employeeId }}
            >
              {t("bot.introMyProfileLink")}
            </Link>
            {t("bot.introAfterLink")}
          </p>
        )}
        <ChatMessages
          messages={visibleMessages}
          onDownload={async (id) =>
            (
              await BotService.downloadAttachment({
                query,
                path: {
                  session_id: stream.sessionId ?? sessionId,
                  attachment_id: id,
                },
              })
            ).data
          }
          text={stream.text}
          tools={stream.tools}
          stopped={stream.stopped}
          renderMessage={(entry, index) => (
            <div key={index} className="space-y-4 break-words">
              {"messages" in entry.payload
                ? entry.payload.messages.map((message, i) => (
                    <BotMessage
                      dictionary={dictionary.data}
                      key={i}
                      message={message}
                      laterRequest={
                        message.type === "preview_card" ||
                        message.type === "status_card"
                          ? requestHistory.get(message)
                          : undefined
                      }
                      disabled={
                        busy ||
                        (message.type === "project_draft_card" &&
                          message !== latestProjectDraft)
                      }
                      onAction={(action) => send.mutate(action)}
                    />
                  ))
                : entry.payload.text}
            </div>
          )}
        />
        {(busy ||
          initialize.error ||
          (!conflict && (send.error || stream.error)) ||
          expired ||
          initialize.isError ||
          conflict) && (
          <div className="mx-auto w-full max-w-3xl space-y-4">
            {busy && (
              <p
                role="status"
                className="flex items-center gap-2 text-muted-foreground"
              >
                <LoaderCircle
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
                {initialize.isPending
                  ? t("bot.loadingConversation")
                  : t("bot.thinking")}
              </p>
            )}
            <SetupError
              error={
                initialize.error ??
                (conflict ? null : (send.error ?? stream.error))
              }
            />
            {expired && <p role="status">{t("bot.sessionExpired")}</p>}
            {initialize.isError && (
              <Button variant="outline" onClick={() => initialize.mutate()}>
                {t("bot.retry")}
              </Button>
            )}
            {conflict === "preview" && (
              <div role="alert" className="space-y-2">
                <p>{t("bot.conflictPreview")}</p>
                <Button
                  disabled={busy}
                  onClick={() => sendText(t("bot.conflictPreviewPrompt"))}
                >
                  {t("bot.repreview")}
                </Button>
              </div>
            )}
            {conflict === "review" && (
              <div role="alert" className="space-y-2">
                <p>{t("bot.conflictReview")}</p>
                <Button
                  disabled={busy}
                  onClick={() => sendText(t("bot.conflictReviewPrompt"))}
                >
                  {t("bot.reviewAgain")}
                </Button>
              </div>
            )}
            {conflict === "profile_edit" && (
              <div role="alert" className="space-y-2">
                <p>{t("bot.conflictProfileEdit")}</p>
                <Button
                  disabled={busy}
                  onClick={() => sendText(t("bot.conflictProfileEditPrompt"))}
                >
                  {t("bot.reviewAgain")}
                </Button>
              </div>
            )}
            {conflict === "withdraw" && (
              <p role="alert">{t("bot.conflictWithdraw")}</p>
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>
      <ChatComposer
        key={sessionId}
        draftKey={sessionId ? `${storageKey}:${sessionId}` : undefined}
        id="bot-input"
        label={t("bot.inputLabel")}
        placeholder={t("bot.inputPlaceholder")}
        text={text}
        onChange={setText}
        onSend={(attachments) =>
          sendText(text.trim() || t("bot.attachmentPrompt"), attachments)
        }
        onUpload={async (file) =>
          (
            await BotService.uploadAttachment({
              query,
              path: { session_id: sessionId },
              body: { file },
            })
          ).data
        }
        busy={stream.isPending}
        disabled={busy || !sessionId}
        onStop={stream.stop}
      />
      <p className="mx-auto w-[calc(100%-2rem)] max-w-3xl pb-4 text-xs text-muted-foreground">
        {t("bot.selfReportNotice")}
      </p>
    </>
  )
}
