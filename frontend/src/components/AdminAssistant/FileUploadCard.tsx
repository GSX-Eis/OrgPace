import { useMutation } from "@tanstack/react-query"
import { useId, useRef } from "react"
import { useTranslation } from "react-i18next"
import {
  AdminAssistantService,
  type AdminTurnResponse,
  type FileUploadCard as Card,
} from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function FileUploadCard({
  orgId,
  sessionId,
  card,
  disabled,
  onUploaded,
  onUploading,
}: {
  orgId: string
  sessionId: string
  card: Card
  disabled: boolean
  onUploaded: (response: AdminTurnResponse) => void
  onUploading: (busy: boolean) => void
}) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const fileKinds = {
    work_csv: {
      title: t("adminAssistant.fileUpload.workCsvTitle"),
      form: t("adminAssistant.fileUpload.workCsvForm"),
      accept: ".csv,.xlsx",
      limit: 5,
      format: t("adminAssistant.fileUpload.workCsvFormat"),
    },
  } as const
  const kind = fileKinds[card.kind]
  const upload = useMutation({
    onMutate: () => onUploading(true),
    onSettled: () => onUploading(false),
    mutationFn: async () => {
      const file = input.current?.files?.[0]
      if (!file) throw new Error(t("adminAssistant.fileUpload.missingFile"))
      return (
        await AdminAssistantService.assistantUploadFile({
          query: { org_id: orgId },
          path: { session_id: sessionId },
          body: { kind: card.kind, file },
        })
      ).data
    },
    onSuccess: (response) => {
      if (input.current) input.current.value = ""
      onUploaded(response)
    },
  })
  return (
    <form
      aria-label={kind.form}
      className="space-y-3 rounded-xl border border-primary/25 bg-background p-4"
      onSubmit={(event) => {
        event.preventDefault()
        upload.mutate()
      }}
    >
      <label htmlFor={id} className="font-semibold">
        {t("adminAssistant.fileUpload.selectLabel", { title: kind.title })}
      </label>
      <p className="text-sm text-muted-foreground">
        {t("adminAssistant.fileUpload.hint", {
          format: kind.format,
          limit: kind.limit,
        })}
      </p>
      <Input
        id={id}
        ref={input}
        type="file"
        accept={kind.accept}
        required
        disabled={disabled || upload.isPending}
      />
      <Button disabled={disabled || upload.isPending}>
        {upload.isPending
          ? t("adminAssistant.fileUpload.uploading")
          : t("adminAssistant.fileUpload.submit")}
      </Button>
      <SetupError error={upload.error} />
    </form>
  )
}
