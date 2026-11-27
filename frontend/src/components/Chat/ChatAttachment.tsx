import { useQuery } from "@tanstack/react-query"
import { AxiosError } from "axios"
import { FileText } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { AttachmentPublic } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { formatNumber } from "@/i18n/format"

export function ChatAttachment({
  attachment,
  onDownload,
}: {
  attachment: AttachmentPublic
  onDownload: (id: string) => Promise<Blob>
}) {
  const { t } = useTranslation()
  const [requested, setRequested] = useState(false)
  const [cleaned, setCleaned] = useState(false)
  const [url, setUrl] = useState("")
  const image = attachment.kind === "image"
  const download = useQuery({
    queryKey: ["chat-attachment", attachment.id],
    queryFn: async () => {
      try {
        return await onDownload(attachment.id)
      } catch (error) {
        if (error instanceof AxiosError && error.response?.status === 404)
          setCleaned(true)
        throw error
      }
    },
    enabled: !cleaned && (image || requested),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  })
  useEffect(() => {
    if (!download.data) return
    const objectUrl = URL.createObjectURL(download.data)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [download.data])
  useEffect(() => {
    if (!requested || !url || image) return
    const link = document.createElement("a")
    link.href = url
    link.download = attachment.filename
    link.click()
    setRequested(false)
  }, [url, requested, image, attachment.filename])
  return (
    <section
      className="my-2 w-fit max-w-full space-y-2 rounded-xl border bg-background p-2.5 text-sm"
      aria-label={t("common.chat.attachmentAria", {
        filename: attachment.filename,
      })}
    >
      <p className="flex items-center gap-2 break-all">
        <FileText
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        {attachment.filename}
      </p>
      <p className="text-xs text-muted-foreground">
        {attachmentSizeLabel(attachment.size)}
      </p>
      {attachment.notice && <p>{attachment.notice}</p>}
      {cleaned ? (
        <p role="status">{t("common.chat.attachmentCleaned")}</p>
      ) : (
        <>
          {image && url ? (
            <a href={url} target="_blank" rel="noopener noreferrer">
              <img
                src={url}
                alt={attachment.filename}
                className="max-h-40 w-auto max-w-[min(240px,100%)] rounded-lg object-contain"
              />
            </a>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={download.isFetching}
              onClick={() => {
                if (download.isError) download.refetch()
                setRequested(true)
              }}
            >
              {download.isFetching
                ? t("common.chat.attachmentReading")
                : t("common.chat.attachmentDownload")}
            </Button>
          )}
          <SetupError error={download.error} />
        </>
      )}
    </section>
  )
}

export function attachmentSizeLabel(bytes: number) {
  const kb = bytes / 1024
  if (kb < 1) return "<1 KB"
  if (kb < 1024) return `${formatNumber(kb, { maximumFractionDigits: 1 })} KB`
  const mb = kb / 1024
  return `${formatNumber(mb, { maximumFractionDigits: 1 })} MB`
}
