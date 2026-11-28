import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type Ref, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { type OrgChartDepartment, OrgsService } from "@/client"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

export function DepartmentActions({
  actionsRef,
  orgId,
  department,
  departments,
  onMovedParent,
}: {
  actionsRef: Ref<HTMLFieldSetElement>
  orgId: string
  department: OrgChartDepartment
  departments: OrgChartDepartment[]
  onMovedParent?: (parentId: string) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [action, setAction] = useState<"rename" | "move" | "delete" | null>(
    null,
  )
  const actionLabels = {
    rename: t("people.orgChart.actions.rename"),
    move: t("people.orgChart.actions.move"),
    delete: t("people.orgChart.actions.delete"),
  } as const
  const [name, setName] = useState(department.name)
  const [parent, setParent] = useState(department.parent_department_id ?? "")
  const parentOptions = useMemo(() => {
    if (action !== "move") return []
    const byId = new Map(departments.map((item) => [item.id, item]))
    const blocked = new Set([department.id])
    let changed = true
    while (changed) {
      changed = false
      for (const item of departments)
        if (
          item.parent_department_id &&
          blocked.has(item.parent_department_id) &&
          !blocked.has(item.id)
        ) {
          blocked.add(item.id)
          changed = true
        }
    }
    const pathLabel = (item: OrgChartDepartment): string => {
      const names = [item.name]
      const seen = new Set([item.id])
      let ancestor = byId.get(item.parent_department_id ?? "")
      while (ancestor && !seen.has(ancestor.id)) {
        seen.add(ancestor.id)
        names.unshift(ancestor.name)
        ancestor = byId.get(ancestor.parent_department_id ?? "")
      }
      return names.join(" / ")
    }
    return departments
      .filter((item) => !blocked.has(item.id))
      .map((item) => ({ id: item.id, label: pathLabel(item) }))
  }, [action, department.id, departments])
  const save = useMutation({
    mutationFn: async () => {
      const path = { org_id: orgId, id: department.id }
      if (action === "delete") return OrgsService.deleteDepartment({ path })
      return OrgsService.updateDepartment({
        path,
        body:
          action === "rename"
            ? { name }
            : { parent_department_id: parent || null },
      })
    },
    onSuccess: () => {
      if (action === "move" && parent) onMovedParent?.(parent)
      client.invalidateQueries({ queryKey: ["org-chart", orgId] })
      client.invalidateQueries({ queryKey: ["departments", orgId] })
      client.invalidateQueries({ queryKey: ["department-capabilities", orgId] })
      client.invalidateQueries({ queryKey: ["profile", orgId] })
      setAction(null)
    },
  })
  return (
    <>
      <fieldset
        ref={actionsRef}
        className="flex flex-wrap gap-1 border-surface-border border-t pt-2"
        aria-label={t("people.orgChart.deptActionsAria", {
          name: department.name,
        })}
      >
        {(["rename", "move", "delete"] as const).map((key) => {
          const label = actionLabels[key]
          return (
            <Button
              key={key}
              variant="ghost"
              size="sm"
              aria-label={t("people.orgChart.actionButtonAria", {
                action: label,
                name: department.name,
              })}
              onClick={() => {
                save.reset()
                setName(department.name)
                setParent(department.parent_department_id ?? "")
                setAction(key)
              }}
            >
              {label}
            </Button>
          )
        })}
      </fieldset>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !save.isPending) setAction(null)
        }}
      >
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              save.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {action &&
                  t("people.orgChart.actionDialogTitle", {
                    action: actionLabels[action],
                    name: department.name,
                  })}
              </DialogTitle>
              <DialogDescription>
                {action === "delete"
                  ? t("people.orgChart.deleteDesc")
                  : action === "move"
                    ? t("people.orgChart.moveDesc")
                    : t("people.orgChart.renameDesc")}
              </DialogDescription>
            </DialogHeader>
            {action === "rename" && (
              <label
                className="block space-y-2"
                htmlFor={`department-name-${department.id}`}
              >
                <span>{t("people.orgChart.deptNameLabel")}</span>
                <Input
                  id={`department-name-${department.id}`}
                  value={name}
                  maxLength={100}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            {action === "move" && (
              <label className="block space-y-2">
                <span>{t("people.orgChart.parentDeptLabel")}</span>
                <select
                  className="w-full rounded-md border bg-background p-2"
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                >
                  <option value="">{t("people.orgChart.topLevelDept")}</option>
                  {parentOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <SetupError error={save.error} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={save.isPending}
                onClick={() => setAction(null)}
              >
                {t("people.orgChart.cancel")}
              </Button>
              <Button
                type="submit"
                variant={action === "delete" ? "destructive" : "default"}
                disabled={
                  save.isPending || (action === "rename" && !name.trim())
                }
              >
                {save.isPending
                  ? t("people.orgChart.saving")
                  : action === "delete"
                    ? t("people.orgChart.confirmDelete")
                    : t("people.orgChart.confirmSave")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
