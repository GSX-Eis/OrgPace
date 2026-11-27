import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CapacityService, type DemandInput } from "@/client"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import { CapacityError } from "./AssignmentFields"
import {
  capabilityLevels,
  DemandWorkFields,
  demandWork,
  useDemandOptions,
} from "./DemandFields"
import { DemandTarget } from "./DemandsReference"
import { formatIsoDateRange } from "./shared"

export function DemandsCreate({
  orgId,
  back,
  created,
}: {
  orgId: string
  back: () => void
  created: (id: string) => void
}) {
  const { t } = useTranslation()
  const cache = useQueryClient()
  const [requestingId, setRequestingId] = useState("")
  const [capability, setCapability] = useState("")
  const [minimum, setMinimum] = useState("")
  const [preview, setPreview] = useState<DemandInput | null>(null)
  const previewHeading = useRef<HTMLHeadingElement>(null)
  const [needsDescription, setNeedsDescription] = useState(false)
  useEffect(() => {
    if (preview) previewHeading.current?.focus()
  }, [preview])
  const options = useDemandOptions(orgId)
  const submit = useMutation({
    mutationKey: ["capacity", orgId, "create", "outgoing"],
    mutationFn: (body: DemandInput) =>
      CapacityService.submitDemand({ path: { org_id: orgId }, body }),
    onSuccess: async ({ data }) => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["capacity", orgId] }),
        cache.invalidateQueries({ queryKey: ["inbox", orgId] }),
      ])
      created(data.id)
    },
  })
  if (options.isPending) return <ProfileLoading />
  if (options.isError) return <ProfileError retry={() => options.refetch()} />
  const { departments, capabilities, requesting } = options.data
  const selectedCapability = capabilities.find((c) => c.key === capability)
  const levels = capabilityLevels(selectedCapability?.level_rubric)
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (preview) {
          if (!submit.isPending) submit.mutate(preview)
          return
        }
        const data = new FormData(event.currentTarget)
        const work = demandWork(data)
        setNeedsDescription(!work.description)
        if (!work.description) return
        setPreview({
          requesting_department_id: String(data.get("requesting")),
          target_department_id: String(data.get("target")),
          capability_key: capability,
          minimum_level: minimum || null,
          ...work,
        })
      }}
    >
      <div hidden={!!preview} className="space-y-4">
        <DemandTarget
          orgId={orgId}
          departments={departments.filter((item) => item.id !== requestingId)}
        >
          <fieldset disabled={!!preview} className="grid gap-4 sm:grid-cols-2">
            {[
              {
                name: "requesting",
                label: t("capacity.demands.create.requestingDept"),
                change: setRequestingId,
                items: requesting.map((d) => ({ key: d.id, label: d.name })),
              },
              {
                name: "capability",
                label: t("capacity.demands.create.capability"),
                value: capability,
                change: (value: string) => {
                  setCapability(value)
                  setMinimum("")
                },
                items: capabilities.map((c) => ({ key: c.key, label: c.name })),
              },
              {
                name: "minimum",
                label: t("capacity.demands.create.minimumLevel"),
                value: minimum,
                change: setMinimum,
                items: levels.map((l) => ({
                  key: String(l.key),
                  label: String(l.label || l.key),
                })),
              },
            ].map(({ name, label, items, value, change }) => (
              <div key={name} className="space-y-2 text-sm font-medium">
                <label htmlFor={`demand-${name}`}>{label}</label>
                <select
                  id={`demand-${name}`}
                  name={name}
                  required={name !== "minimum"}
                  value={value}
                  onChange={
                    change ? (event) => change(event.target.value) : undefined
                  }
                  className="h-10 w-full rounded-md border bg-background px-3"
                >
                  <option value="">
                    {name === "minimum"
                      ? t("capacity.demands.create.unlimited")
                      : t("capacity.demands.create.selectPlaceholder")}
                  </option>
                  {items.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <DemandWorkFields />
            {needsDescription && (
              <p
                role="alert"
                className="text-sm text-destructive sm:col-span-2"
              >
                {t("capacity.demands.create.descriptionRequired")}
              </p>
            )}
          </fieldset>
        </DemandTarget>
        <Button type="submit" disabled={!requesting.length}>
          {t("capacity.demands.create.previewBtn")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={back}
          disabled={submit.isPending}
        >
          {t("capacity.common.cancel")}
        </Button>
      </div>
      {preview && (
        <section
          aria-label={t("capacity.demands.create.previewAria")}
          className="space-y-3 rounded-xl border p-5"
        >
          <h3 ref={previewHeading} tabIndex={-1} className="font-semibold">
            {t("capacity.demands.create.previewTitle")}
          </h3>
          <p>
            {
              departments.find((d) => d.id === preview.requesting_department_id)
                ?.name
            }{" "}
            →{" "}
            {
              departments.find((d) => d.id === preview.target_department_id)
                ?.name
            }
          </p>
          <p>
            {t("capacity.demands.create.minimumLevelLine", {
              name: selectedCapability?.name ?? "",
              level:
                levels
                  .find((l) => l.key === preview.minimum_level)
                  ?.label?.toString() || t("capacity.demands.create.unlimited"),
            })}
          </p>
          <p>{formatIsoDateRange(preview.window_start, preview.window_end)}</p>
          <p className="whitespace-pre-wrap break-words">
            {preview.description}
          </p>
          <div className="flex gap-3">
            <Button type="submit" disabled={submit.isPending}>
              {submit.isPending
                ? t("capacity.demands.create.submitting")
                : t("capacity.demands.create.submitBtn")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submit.isPending}
              onClick={() => {
                setPreview(null)
                submit.reset()
              }}
            >
              {t("capacity.demands.create.backToEdit")}
            </Button>
          </div>
          <CapacityError error={submit.error} />
        </section>
      )}
    </form>
  )
}
