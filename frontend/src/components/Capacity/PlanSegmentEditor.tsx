import { useMutation } from "@tanstack/react-query"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { type AssigneeInput, type CasePublic, PlanningService } from "@/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createBlankSegment, errorText, records } from "./PlansShared"

export function SegmentEditor({
  plan,
  orgId,
  initial,
  onCancel,
  onSaved,
}: {
  plan: CasePublic
  orgId: string
  initial: AssigneeInput[]
  onCancel: () => void
  onSaved: (optionId: string) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const id = useId()
  const [segments, setSegments] = useState(initial)
  const save = useMutation({
    mutationFn: async () =>
      (
        await PlanningService.createOption({
          path: { org_id: orgId, case_id: plan.id },
          body: { assignees: segments },
        })
      ).data,
    onSuccess: (created) => onSaved(created.id),
  })
  const demand = records([plan.data.demand])[0]
  const update = (index: number, changes: Partial<AssigneeInput>) =>
    setSegments((previous) =>
      previous.map((segment, i) =>
        i === index ? { ...segment, ...changes } : segment,
      ),
    )
  return (
    <form
      className="space-y-3"
      aria-label={t("capacity.plans.editorAria")}
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <fieldset className="space-y-3" disabled={save.isPending}>
        {segments.map((segment, index) => (
          <div
            key={index}
            className="grid gap-2 rounded-lg bg-muted/30 p-3 sm:grid-cols-2"
          >
            <label>
              <span>{t("capacity.plans.employeeLabel")}</span>
              <select
                className="block h-9 w-full rounded-md border bg-background px-3"
                required
                value={segment.employee_id}
                onChange={(event) =>
                  update(index, { employee_id: event.target.value })
                }
              >
                <option value="">{t("capacity.plans.selectEmployee")}</option>
                {plan.people.map((person) => (
                  <option key={person.employee_id} value={person.employee_id}>
                    {person.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${id}-percent-${index}`}>
              {t("capacity.plans.allocationLabel")}
              <Input
                id={`${id}-percent-${index}`}
                type="number"
                min={10}
                max={100}
                required
                value={segment.allocation_percent}
                onChange={(event) =>
                  update(index, {
                    allocation_percent: Number(event.target.value),
                  })
                }
              />
            </label>
            <label htmlFor={`${id}-start-${index}`}>
              {t("capacity.plans.startDate")}
              <Input
                id={`${id}-start-${index}`}
                type="date"
                required
                value={segment.start_date}
                onChange={(event) =>
                  update(index, { start_date: event.target.value })
                }
              />
            </label>
            <label htmlFor={`${id}-end-${index}`}>
              {t("capacity.plans.endDate")}
              <Input
                id={`${id}-end-${index}`}
                type="date"
                required
                value={segment.end_date}
                min={segment.start_date}
                onChange={(event) =>
                  update(index, { end_date: event.target.value })
                }
              />
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setSegments((previous) =>
                  previous.filter((_, i) => i !== index),
                )
              }
            >
              {t("capacity.plans.removeSegment")}
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setSegments((previous) => [
                ...previous,
                createBlankSegment(demand),
              ])
            }
          >
            {t("capacity.plans.addSegment")}
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("capacity.common.cancel")}
            </Button>
            <Button type="submit" disabled={!segments.length}>
              {t("capacity.plans.simulateAdjusted")}
            </Button>
          </div>
        </div>
      </fieldset>
      {save.error && <p role="alert">{errorText(save.error)}</p>}
    </form>
  )
}
