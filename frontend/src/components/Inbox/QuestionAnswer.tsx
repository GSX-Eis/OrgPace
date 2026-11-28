import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { EmployeeRequestsService } from "@/client"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import { handleError } from "@/utils"

export function QuestionAnswer({
  orgId,
  questionId,
  onAnswerStart,
  onAnswered,
}: {
  orgId: string
  questionId: string
  onAnswerStart: () => void
  onAnswered: () => void
}) {
  const { t } = useTranslation()
  const quickReplies = [
    t("inbox.question.quickReplies.solo"),
    t("inbox.question.quickReplies.support"),
    t("inbox.question.quickReplies.later"),
  ]
  const cache = useQueryClient()
  const [answer, setAnswer] = useState("")
  const input = useRef<HTMLTextAreaElement>(null)
  const [error, setError] = useState("")
  const query = useQuery({
    queryKey: ["question", orgId, questionId],
    queryFn: async () =>
      (
        await EmployeeRequestsService.readQuestion({
          path: { org_id: orgId, question_id: questionId },
        })
      ).data,
    retry: false,
  })
  const mutation = useMutation({
    mutationFn: async () =>
      (
        await EmployeeRequestsService.answerQuestion({
          path: { org_id: orgId, question_id: questionId },
          body: { answer: answer.trim() },
        })
      ).data,
    onSuccess: (data) => {
      cache.setQueryData(["question", orgId, questionId], data)
      onAnswered()
      cache.invalidateQueries({ queryKey: ["inbox", orgId] })
      cache.invalidateQueries({ queryKey: ["evidence", orgId] })
      setAnswer("")
      setError("")
    },
    onError: (err) => handleError.call(setError, err),
  })
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  if (query.data.status !== "open")
    return (
      <p role="status">
        {query.data.status === "answered"
          ? t("inbox.question.answered")
          : t("inbox.question.closed")}
      </p>
    )
  const inputId = `answer-${questionId}`
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!answer.trim() || mutation.isPending) return
        setError("")
        onAnswerStart()
        mutation.mutate()
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t("inbox.question.reason", { reason: query.data.reason })}
      </p>
      <fieldset className="flex min-w-0 flex-wrap gap-1.5">
        <legend className="sr-only">
          {t("inbox.question.quickRepliesAria")}
        </legend>
        {quickReplies.map((reply) => (
          <Button
            key={reply}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto max-w-full rounded-full py-1 whitespace-normal text-left text-xs shadow-none aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:bg-primary/10"
            aria-pressed={answer === reply}
            disabled={mutation.isPending}
            onClick={() => {
              setAnswer(reply)
              input.current?.focus()
            }}
          >
            {reply}
          </Button>
        ))}
      </fieldset>
      <label htmlFor={inputId} className="block text-sm font-medium">
        {t("inbox.question.answerLabel")}
      </label>
      <textarea
        id={inputId}
        ref={input}
        className="min-h-20 w-full rounded-md border bg-background p-2.5 text-sm"
        required
        maxLength={10000}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        disabled={mutation.isPending}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("inbox.question.restrictedHint")}
        </p>
        <Button
          size="sm"
          type="submit"
          disabled={!answer.trim() || mutation.isPending}
        >
          {mutation.isPending
            ? t("inbox.question.submitting")
            : t("inbox.question.submit")}
        </Button>
      </div>
    </form>
  )
}
