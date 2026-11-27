import { useMutation, useQueryClient } from "@tanstack/react-query"
import { isAxiosError } from "axios"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type DirectEditInput,
  type DirectEditResult,
  type ProfileItem,
  ProfilesService,
} from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { levelLabel, record } from "./fields"
import { characterCount, STATEMENT_MAX, textLimitMessage } from "./inputLimits"
import { ProfileVisibility } from "./ProfileVisibility"

export function DirectEditDialog({
  orgId,
  employeeId,
  item,
  revision,
  onClose,
}: {
  orgId: string
  employeeId: string
  item: ProfileItem
  revision: number | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  // Keep the version the editor opened with, even if the profile refetches.
  const [baseRevision] = useState(revision)
  const [statement, setStatement] = useState(item.claim?.statement ?? "")
  const [level, setLevel] = useState(item.claim?.level ?? "")
  const [retract, setRetract] = useState(false)
  const limitError =
    !retract && statement !== item.claim?.statement
      ? textLimitMessage(
          statement,
          STATEMENT_MAX,
          0,
          t("profile.common.capabilityStatement"),
        )
      : null
  const [preview, setPreview] = useState<DirectEditResult | null>(null)
  const path = { org_id: orgId, employee_id: employeeId }
  const body: DirectEditInput = {
    base_revision: baseRevision,
    items: [
      {
        capability_key: item.capability.key,
        op: retract ? "retract" : item.claim ? "modify" : "add",
        statement: retract
          ? t("profile.directEdit.retractStatement")
          : statement,
        level: retract ? null : level || null,
      },
    ],
  }
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["profile", orgId, employeeId] }),
      client.invalidateQueries({
        queryKey: ["profile-versions", orgId, employeeId],
      }),
      client.invalidateQueries({
        queryKey: ["change-requests", orgId, employeeId],
      }),
      client.invalidateQueries({ queryKey: ["inbox", orgId] }),
    ])
  const prepare = useMutation({
    mutationFn: async () =>
      (await ProfilesService.previewDirectEdit({ path, body })).data,
    onSuccess: setPreview,
  })
  const publish = useMutation({
    mutationFn: async () => ProfilesService.directEdit({ path, body }),
    onSuccess: async () => {
      await refresh()
      onClose()
    },
  })
  const busy = prepare.isPending || publish.isPending
  const error = prepare.error ?? publish.error
  const conflict = isAxiosError(error) && error.response?.status === 409
  const rubric = item.capability.level_rubric
  const levels =
    record(rubric) && Array.isArray(rubric.levels)
      ? rubric.levels
          .filter(record)
          .filter((entry) => typeof entry.key === "string")
      : []
  const invalidLevel =
    level !== "" && !levels.some((entry) => entry.key === level)
  const change = preview?.items[0]
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[90dvh] overflow-y-auto"
      >
        <DialogTitle>
          {t("profile.directEdit.title", { name: item.capability.name })}
        </DialogTitle>
        <DialogDescription>
          {t("profile.directEdit.description")}
        </DialogDescription>
        <ProfileVisibility />
        {conflict ? (
          <>
            <p role="alert">{t("profile.directEdit.conflict")}</p>
            <Button
              onClick={async () => {
                await refresh()
                onClose()
              }}
            >
              {t("profile.directEdit.refresh")}
            </Button>
          </>
        ) : (
          <>
            <SetupError error={error} />
            {change ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <section
                    aria-label={t("profile.directEdit.before")}
                    className="space-y-2 rounded-lg border p-4"
                  >
                    <h3 className="font-semibold">
                      {t("profile.directEdit.before")}
                    </h3>
                    <p>
                      {change.before?.statement ??
                        t("profile.directEdit.noRecord")}
                    </p>
                    <p>
                      {t("profile.directEdit.levelPrefix", {
                        level: change.before?.level
                          ? levelLabel(rubric, change.before.level)
                          : t("profile.directEdit.ungraded"),
                      })}
                    </p>
                  </section>
                  <section
                    aria-label={t("profile.directEdit.after")}
                    className="space-y-2 rounded-lg border p-4"
                  >
                    <h3 className="font-semibold">
                      {t("profile.directEdit.after")}
                    </h3>
                    <p>
                      {retract
                        ? t("profile.directEdit.retractLabel")
                        : change.after.statement}
                    </p>
                    <p>
                      {t("profile.directEdit.levelPrefix", {
                        level: change.after.level
                          ? levelLabel(rubric, change.after.level)
                          : t("profile.directEdit.ungraded"),
                      })}
                    </p>
                    <p>
                      {t("profile.directEdit.statusPrefix", {
                        status: retract
                          ? t("profile.directEdit.statusUnknown")
                          : t("profile.directEdit.statusConfirmed"),
                      })}
                    </p>
                  </section>
                </div>
                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setPreview(null)
                      publish.reset()
                    }}
                  >
                    {t("profile.directEdit.backToEdit")}
                  </Button>
                  <Button disabled={busy} onClick={() => publish.mutate()}>
                    {t("profile.directEdit.confirmPublish")}
                  </Button>
                </div>
              </>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  prepare.mutate()
                }}
              >
                <fieldset disabled={busy} className="space-y-4">
                  {item.claim && (
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={retract}
                        onChange={(event) => setRetract(event.target.checked)}
                      />
                      {t("profile.directEdit.retractCheckbox")}
                    </label>
                  )}
                  {!retract && (
                    <>
                      <label className="block space-y-1">
                        {t("profile.directEdit.statementLabel")}
                        <textarea
                          required
                          value={statement}
                          className="block min-h-24 w-full rounded-md border bg-background p-2"
                          onChange={(event) => setStatement(event.target.value)}
                        />
                      </label>
                      <p className="text-sm text-muted-foreground">
                        {t("profile.directEdit.charCount", {
                          count: characterCount(statement),
                          max: STATEMENT_MAX,
                        })}
                      </p>
                      {limitError && (
                        <p role="alert" className="text-sm text-destructive">
                          {limitError}
                        </p>
                      )}
                      <label className="block space-y-1">
                        {t("profile.directEdit.levelLabel")}
                        <select
                          value={level}
                          className="block w-full rounded-md border bg-background p-2"
                          onChange={(event) => setLevel(event.target.value)}
                        >
                          <option value="">
                            {t("profile.directEdit.ungraded")}
                          </option>
                          {invalidLevel && (
                            <option value={level}>
                              {t("profile.directEdit.invalidLevel")}
                            </option>
                          )}
                          {levels.map((entry) => (
                            <option
                              key={String(entry.key)}
                              value={String(entry.key)}
                            >
                              {String(entry.label ?? entry.key)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  <Button
                    type="submit"
                    disabled={
                      !!limitError ||
                      (!retract && (!statement.trim() || invalidLevel))
                    }
                  >
                    {t("profile.directEdit.previewButton")}
                  </Button>
                </fieldset>
              </form>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
