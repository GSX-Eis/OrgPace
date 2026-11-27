import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CapabilitiesService, OrgsService } from "@/client"
import { CapabilityPicker } from "@/components/Profile/CapabilityPicker"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"

export function DepartmentCapabilities({
  orgId,
  departmentId,
  canEdit,
}: {
  orgId: string
  departmentId: string
  canEdit: boolean
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [draft, setDraft] = useState<string[] | null>(null)
  const [picking, setPicking] = useState(false)
  const [saved, setSaved] = useState(false)
  const queryKey = ["department-capabilities", orgId, departmentId]
  const path = { org_id: orgId, id: departmentId }
  const query = useQuery({
    queryKey,
    queryFn: async () =>
      (await OrgsService.readDepartmentCapabilities({ path })).data,
  })
  const dictionary = useQuery({
    queryKey: ["capabilities", orgId],
    queryFn: async () =>
      (await CapabilitiesService.readCapabilities({ path: { org_id: orgId } }))
        .data,
    enabled: canEdit && picking,
  })
  const save = useMutation({
    mutationFn: async () =>
      (
        await OrgsService.updateDepartmentCapabilities({
          path,
          body: { capability_keys: draft ?? query.data!.capability_keys },
        })
      ).data,
    onSuccess: (data) => {
      client.setQueryData(queryKey, data)
      client.invalidateQueries({ queryKey: ["department-capabilities", orgId] })
      client.invalidateQueries({ queryKey: ["profile", orgId] })
      setDraft(null)
      setSaved(true)
    },
  })
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  const own = draft ?? query.data.capability_keys
  const inherited = query.data.inherited_capability_keys
  const name = (key: string) =>
    query.data.capabilities.find((item) => item.key === key)?.name ??
    dictionary.data?.data.find((item) => item.key === key)?.name ??
    key
  return (
    <section
      aria-label={t("people.orgChart.capabilities.ariaLabel")}
      className="space-y-3 border-surface-border border-t pt-3"
    >
      <div>
        <h2 className="font-semibold">
          {t("people.orgChart.capabilities.title")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("people.orgChart.capabilities.description")}
        </p>
      </div>
      <div className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {t("people.orgChart.capabilities.inheritedTitle")}
          </h3>
          {inherited.map((key) => (
            <p key={key} className="text-sm wrap-anywhere">
              {t("people.orgChart.capabilities.inheritedFromParent", {
                name: name(key),
              })}
            </p>
          ))}
          {!inherited.length && (
            <p className="text-sm text-muted-foreground">
              {t("people.orgChart.capabilities.noInherited")}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {t("people.orgChart.capabilities.ownTitle")}
          </h3>
          {own.map((key) => (
            <div
              key={key}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="min-w-0 wrap-anywhere">{name(key)}</span>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("people.orgChart.capabilities.removeAria", {
                    name: name(key),
                  })}
                  disabled={save.isPending}
                  onClick={() => {
                    setDraft(own.filter((item) => item !== key))
                    setSaved(false)
                  }}
                >
                  {t("people.orgChart.capabilities.remove")}
                </Button>
              )}
            </div>
          ))}
          {!own.length && (
            <p className="text-sm text-muted-foreground">
              {t("people.orgChart.capabilities.noOwn")}
            </p>
          )}
        </div>
      </div>
      <SetupError error={save.error} />
      {saved && (
        <p role="status" className="text-sm wrap-anywhere">
          {t("people.orgChart.capabilities.saved")}
        </p>
      )}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={save.isPending}
            onClick={() => setPicking(true)}
          >
            {t("people.orgChart.capabilities.addCapability")}
          </Button>
          <Button
            size="sm"
            disabled={draft === null || save.isPending}
            onClick={() => save.mutate()}
          >
            {t("people.orgChart.capabilities.save")}
          </Button>
        </div>
      )}
      {picking &&
        (dictionary.isPending ? (
          <ProfileLoading />
        ) : dictionary.isError ? (
          <ProfileError retry={() => dictionary.refetch()} />
        ) : (
          <CapabilityPicker
            capabilities={dictionary.data.data.filter(
              (item) => !own.includes(item.key),
            )}
            onClose={() => setPicking(false)}
            onSelect={(key) => {
              setDraft([...own, key])
              setSaved(false)
              setPicking(false)
            }}
          />
        ))}
    </section>
  )
}
