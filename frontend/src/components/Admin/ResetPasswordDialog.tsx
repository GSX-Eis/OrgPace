import { useMutation } from "@tanstack/react-query"
import { useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { AccountsService } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

export function ResetPasswordDialog({
  orgId,
  userId,
  name,
  open,
  onClose,
}: {
  orgId: string
  userId: string
  name: string
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [copyMessage, setCopyMessage] = useState("")
  const passwordId = useId()
  const password = useRef<HTMLInputElement>(null)
  const mutation = useMutation({
    mutationFn: async () =>
      (
        await AccountsService.resetPassword({
          path: { org_id: orgId, user_id: userId },
        })
      ).data,
    gcTime: 0,
  })
  function changeOpen(value: boolean) {
    if (mutation.isPending) return
    if (!value) {
      mutation.reset()
      setCopyMessage("")
      onClose()
    }
  }
  async function copy() {
    if (!mutation.data) return
    try {
      await navigator.clipboard.writeText(mutation.data.initial_password)
      setCopyMessage(t("admin.common.copied"))
      return
    } catch {
      /* HTTP deployments use the legacy fallback. */
    }
    password.current?.select()
    try {
      if (document.execCommand("copy")) {
        setCopyMessage(t("admin.common.copied"))
        return
      }
    } catch {
      /* Keep the password selected for manual copying. */
    }
    setCopyMessage(t("admin.common.copyManual"))
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent showCloseButton={!mutation.isPending}>
        <DialogHeader>
          <DialogTitle>{t("admin.resetPassword.title", { name })}</DialogTitle>
          <DialogDescription>
            {mutation.data
              ? t("admin.resetPassword.descAfter")
              : t("admin.resetPassword.descBefore")}
          </DialogDescription>
        </DialogHeader>
        {mutation.data ? (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
            <p>
              {t("admin.resetPassword.username", {
                username: mutation.data.username,
              })}
            </p>
            <p>
              {t("admin.resetPassword.displayName", {
                name: mutation.data.display_name ?? name,
              })}
            </p>
            <label className="block" htmlFor={passwordId}>
              {t("admin.resetPassword.newPassword")}
              <Input
                id={passwordId}
                ref={password}
                aria-label={t("admin.resetPassword.newPassword")}
                readOnly
                value={mutation.data.initial_password}
              />
            </label>
            <Button variant="outline" onClick={copy}>
              {t("admin.common.copy")}
            </Button>
            <p role="status">{copyMessage}</p>
          </div>
        ) : (
          <>
            <SetupError error={mutation.error} />
            <Button
              disabled={mutation.isPending}
              onClick={() => {
                mutation.mutate()
              }}
            >
              {mutation.isPending
                ? t("admin.resetPassword.resetting")
                : t("admin.resetPassword.confirmReset")}
            </Button>
          </>
        )}
        <Button
          variant="outline"
          disabled={mutation.isPending}
          onClick={() => changeOpen(false)}
        >
          {mutation.data ? t("admin.common.close") : t("admin.common.cancel")}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
