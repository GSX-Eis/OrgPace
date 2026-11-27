import { useMutation } from "@tanstack/react-query"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { CapabilitiesService, type CapabilityPublic } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useOrg } from "@/hooks/useOrg"

type PickerCapability = Pick<CapabilityPublic, "key" | "name" | "category"> & {
  profileStatus?: "unfilled" | "recorded"
}

export function CapabilityPicker({
  capabilities,
  onSelect,
  onClose,
}: {
  capabilities: PickerCapability[]
  onSelect: (key: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [search, setSearch] = useState("")
  const nameId = useId()
  const { org, employeeId } = useOrg()
  const [suggesting, setSuggesting] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [reason, setReason] = useState("")
  const suggest = useMutation({
    mutationFn: () =>
      CapabilitiesService.suggestNewCapability({
        path: { org_id: org!.id },
        body: { name, description, reason },
      }),
  })
  const groups = new Map<string, typeof capabilities>()
  for (const capability of capabilities) {
    if (
      !`${capability.name} ${capability.category ?? ""}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase())
    )
      continue
    const category = capability.category ?? t("profile.picker.otherCategory")
    groups.set(category, [...(groups.get(category) ?? []), capability])
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>{t("profile.picker.title")}</DialogTitle>
        <Input
          aria-label={t("profile.picker.searchAria")}
          placeholder={t("profile.picker.searchPlaceholder")}
          value={search}
          disabled={suggest.isPending}
          onChange={(event) => {
            setSearch(event.target.value)
            setSuggesting(false)
            suggest.reset()
          }}
        />
        <div className="max-h-80 space-y-4 overflow-y-auto">
          {Array.from(groups, ([category, entries]) => (
            <section key={category} aria-label={category} className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">
                {category}
              </h3>
              {entries.map(({ key, name, profileStatus }) =>
                profileStatus ? (
                  <div
                    key={key}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0 break-words">
                      <p className="text-sm font-medium">{name}</p>
                      <p className="text-xs text-muted-foreground">
                        {profileStatus === "unfilled"
                          ? t("profile.picker.inProfileUnfilled")
                          : t("profile.picker.inProfile")}
                      </p>
                    </div>
                    {profileStatus === "unfilled" && (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={t("profile.picker.fillAria", { name })}
                        onClick={() => onSelect(key)}
                      >
                        {t("profile.picker.fill")}
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    key={key}
                    variant="outline"
                    className="h-auto w-full justify-start whitespace-normal text-left"
                    onClick={() => onSelect(key)}
                  >
                    {name}
                  </Button>
                ),
              )}
            </section>
          ))}
          {!groups.size && !search.trim() && (
            <p className="text-sm text-muted-foreground">
              {t("profile.picker.noneAvailable")}
            </p>
          )}
          {!groups.size && !!search.trim() && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground break-words">
                {t("profile.picker.notFound", { term: search.trim() })}
              </p>
              {suggest.isSuccess ? (
                <p role="status">{suggest.data.data.message}</p>
              ) : suggesting ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    suggest.mutate()
                  }}
                >
                  <fieldset disabled={suggest.isPending} className="space-y-3">
                    <label htmlFor={nameId} className="block space-y-1 text-sm">
                      <span>{t("profile.picker.nameLabel")}</span>
                      <Input
                        id={nameId}
                        required
                        maxLength={40}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>{t("profile.picker.descLabel")}</span>
                      <textarea
                        required
                        maxLength={300}
                        value={description}
                        className="min-h-20 w-full rounded-md border p-2"
                        onChange={(event) => setDescription(event.target.value)}
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>{t("profile.picker.reasonLabel")}</span>
                      <textarea
                        required
                        maxLength={300}
                        value={reason}
                        className="min-h-20 w-full rounded-md border p-2"
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </label>
                    <SetupError error={suggest.error} />
                    <Button
                      type="submit"
                      disabled={
                        !name.trim() || !description.trim() || !reason.trim()
                      }
                    >
                      {suggest.isPending
                        ? t("profile.picker.submitting")
                        : t("profile.picker.submit")}
                    </Button>
                  </fieldset>
                </form>
              ) : employeeId && org ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setName(search.trim().slice(0, 40))
                    setSuggesting(true)
                  }}
                >
                  {t("profile.picker.suggestButton")}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
