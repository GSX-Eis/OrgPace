import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useRef } from "react"
import { useTranslation } from "react-i18next"
import { AdminAssistantService, type SecretInputCard as Card } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function SecretInputCard({
  orgId,
  card,
  disabled,
}: {
  orgId: string
  card: Card
  disabled: boolean
}) {
  const { t } = useTranslation()
  const titles: Record<string, string> = {
    app_id: t("adminAssistant.secretInput.appIdTitle"),
    app_secret: t("adminAssistant.secretInput.appSecretTitle"),
  }
  const input = useRef<HTMLInputElement>(null)
  const client = useQueryClient()
  const id = useId()
  const path = { org_id: orgId, id: card.change_set_id }
  const query = useQuery({
    queryKey: ["admin-change-set", orgId, card.change_set_id],
    queryFn: async () =>
      (await AdminAssistantService.assistantGetChangeSet({ path })).data,
  })
  const save = useMutation({
    mutationKey: ["admin-change-set-secret", orgId, card.change_set_id],
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["admin-change-set", orgId, card.change_set_id],
      }),
    mutationFn: async () => {
      const value = input.current?.value ?? ""
      if (input.current) input.current.value = ""
      try {
        await AdminAssistantService.assistantSaveChangeSetSecret({
          path: { ...path, field: card.field },
          body: { value },
        })
      } catch {
        throw new Error(t("adminAssistant.secretInput.submitError"))
      }
    },
  })
  return (
    <form
      aria-label={t("adminAssistant.secretInput.ariaLabel")}
      className="space-y-3 rounded-xl border border-primary/25 bg-background p-4"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <label htmlFor={id} className="font-semibold">
        {titles[card.field] ?? card.title}
      </label>
      <p className="text-sm text-muted-foreground">
        {t("adminAssistant.secretInput.description")}
      </p>
      <Input
        ref={input}
        id={id}
        type="password"
        autoComplete="new-password"
        required
        maxLength={10000}
        disabled={disabled || save.isPending || query.data?.status !== "draft"}
      />
      <Button
        disabled={disabled || save.isPending || query.data?.status !== "draft"}
      >
        {t("adminAssistant.secretInput.submit")}
      </Button>
      {save.isSuccess && (
        <p role="status">{t("adminAssistant.secretInput.saved")}</p>
      )}
      <SetupError error={save.error ?? query.error} />
    </form>
  )
}
