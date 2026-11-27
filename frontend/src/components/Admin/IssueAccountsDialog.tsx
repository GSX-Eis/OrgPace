import { useQuery } from "@tanstack/react-query"
import { AxiosError } from "axios"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import { AccountsService } from "@/client"
import { DataTable } from "@/components/Common/DataTable"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { handleError } from "@/utils"
import { type AccountStatus, accountLabels } from "./labels"

export type IssuableEmployee = {
  id: string
  employee_code: string | null
  display_name: string
  status: AccountStatus
}
type Props = {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  orgId: string
  employees?: IssuableEmployee[]
  onIssued: (count: number) => void
}
const conflictSchema = z.array(
  z.object({
    employee_code: z.string().nullable(),
    display_name: z.string(),
    reason: z.string(),
  }),
)

export function IssueAccountsDialog({
  orgId,
  employees,
  onIssued,
  open: controlledOpen,
  onOpenChange,
}: Props) {
  const { t } = useTranslation()
  const [internalOpen, setOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const [busy, setBusy] = useState(false)
  const [issued, setIssued] = useState<number | null>(null)
  const regenerateId = useId()
  const selected = employees?.length ? employees : undefined
  const [regenerate, setRegenerate] = useState(false)
  const [error, setError] = useState("")
  const [conflicts, setConflicts] = useState<z.infer<typeof conflictSchema>>([])
  const needsRegeneration =
    selected?.some((e) => e.status === "pending_first_login") ?? false
  function close(value: boolean) {
    if (busy) return
    setOpen(value)
    onOpenChange?.(value)
    if (!value) {
      if (issued !== null) onIssued(issued)
      setIssued(null)
      setRegenerate(false)
      setError("")
      setConflicts([])
    }
  }
  const count = useQuery({
    queryKey: ["accounts", orgId, "unissued-count"],
    queryFn: async () =>
      (
        await AccountsService.readAccounts({
          path: { org_id: orgId },
          query: { status: "none", employment_status: "active", limit: 1 },
        })
      ).data.count,
    enabled: open && !selected,
  })
  async function issue() {
    setBusy(true)
    setError("")
    setConflicts([])
    try {
      const response = await AccountsService.issueAccounts({
        path: { org_id: orgId },
        body: {
          employee_ids: selected?.map((e) => e.id),
          regenerate_pending: regenerate,
        },
        responseType: "blob",
      })
      let filename = t("admin.issueAccounts.fallbackFilename")
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(
        response.headers["content-disposition"] ?? "",
      )?.[1]
      if (encoded) {
        try {
          filename = decodeURIComponent(encoded)
        } catch {
          /* Use the fallback for malformed headers. */
        }
      }
      const url = URL.createObjectURL(response.data)
      try {
        const link = document.createElement("a")
        link.href = url
        link.download = filename
        link.click()
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      setIssued(Number(response.headers["x-issued-count"]))
    } catch (err) {
      if (err instanceof AxiosError && err.response) {
        if (err.response.data instanceof Blob) {
          try {
            err.response.data = JSON.parse(await err.response.data.text())
          } catch {
            /* Fall back to the common error message. */
          }
        }
        const detail: unknown = err.response.data?.detail
        const parsed = conflictSchema.safeParse(detail)
        if (err.response.status === 409 && parsed.success)
          setConflicts(parsed.data)
        else if (typeof detail === "string") setError(detail)
        else handleError.call(setError, err)
      } else
        handleError.call(setError, err instanceof Error ? err : new Error())
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      {controlledOpen === undefined && (
        <Button onClick={() => setOpen(true)}>
          {selected
            ? t("admin.issueAccounts.triggerWithCount", {
                count: selected.length,
              })
            : t("admin.issueAccounts.trigger")}
        </Button>
      )}
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!busy}
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault()
        }}
        onInteractOutside={(e) => {
          if (busy) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("admin.issueAccounts.title")}</DialogTitle>
          <DialogDescription>
            {t("admin.issueAccounts.description")}
          </DialogDescription>
        </DialogHeader>
        {issued !== null ? (
          <div
            role="status"
            className="space-y-4 rounded-lg border bg-muted/30 p-4"
          >
            <p className="font-semibold">
              {t("admin.issueAccounts.issuedCount", { count: issued })}
            </p>
            <p>{t("admin.issueAccounts.issuedHint")}</p>
          </div>
        ) : (
          <>
            {selected ? (
              <DataTable
                data={selected}
                columns={[
                  {
                    accessorKey: "employee_code",
                    header: t("admin.issueAccounts.colCode"),
                  },
                  {
                    accessorKey: "display_name",
                    header: t("admin.issueAccounts.colName"),
                  },
                  {
                    accessorKey: "status",
                    header: t("admin.issueAccounts.colStatus"),
                    cell: ({ row }) => accountLabels[row.original.status],
                  },
                ]}
              />
            ) : count.isError ? (
              <div role="alert">
                {t("admin.issueAccounts.rangeError")}
                <Button variant="outline" onClick={() => count.refetch()}>
                  {t("admin.common.retry")}
                </Button>
              </div>
            ) : (
              <p>
                {count.isPending
                  ? t("admin.issueAccounts.counting")
                  : t("admin.issueAccounts.countSummary", {
                      count: count.data,
                    })}
              </p>
            )}
            {!selected && count.data === 0 && (
              <p>{t("admin.issueAccounts.allIssued")}</p>
            )}
            {needsRegeneration && (
              <>
                <label
                  htmlFor={regenerateId}
                  className="flex items-start gap-3"
                >
                  <Checkbox
                    id={regenerateId}
                    checked={regenerate}
                    onCheckedChange={(value) => setRegenerate(value === true)}
                    disabled={busy}
                  />
                  <span>{t("admin.issueAccounts.regenerateLabel")}</span>
                </label>
                {!regenerate && (
                  <p className="text-sm text-muted-foreground">
                    {t("admin.issueAccounts.regenerateHint")}
                  </p>
                )}
              </>
            )}
            {conflicts.length > 0 && (
              <div role="alert">
                <p>{t("admin.issueAccounts.conflictNotice")}</p>
                <DataTable
                  data={conflicts}
                  columns={[
                    {
                      accessorKey: "employee_code",
                      header: t("admin.issueAccounts.colCode"),
                    },
                    {
                      accessorKey: "display_name",
                      header: t("admin.issueAccounts.colName"),
                    },
                    {
                      accessorKey: "reason",
                      header: t("admin.issueAccounts.colReason"),
                    },
                  ]}
                />
              </div>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <Button
              disabled={
                busy ||
                (needsRegeneration && !regenerate) ||
                (!selected && (!count.data || count.isError))
              }
              onClick={issue}
            >
              {busy
                ? t("admin.issueAccounts.generating")
                : t("admin.issueAccounts.confirmGenerate")}
            </Button>
          </>
        )}
        <Button variant="outline" disabled={busy} onClick={() => close(false)}>
          {issued === null ? t("admin.common.cancel") : t("admin.common.close")}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
