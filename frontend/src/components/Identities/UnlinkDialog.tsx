import { useTranslation } from "react-i18next"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"

export function UnlinkDialog({
  account,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  account: string
  pending: boolean
  error: Error | null
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogTitle>{t("sources.identities.unlinkDialog.title")}</DialogTitle>
        <DialogDescription>
          {t("sources.identities.unlinkDialog.description", { account })}
        </DialogDescription>
        <SetupError error={error} />
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {t("sources.identities.unlinkDialog.cancel")}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending
              ? t("sources.identities.unlinkDialog.unlinking")
              : t("sources.identities.unlinkDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
