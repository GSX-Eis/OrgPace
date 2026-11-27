import { useMutation } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapacityService,
  type ExtensionDecisionInput,
  type ExtensionPublic,
} from "@/client"
import { Button } from "@/components/ui/button"
import {
  CapacityError,
  CommitmentFields,
  commitmentBody,
  NoteField,
  useCapacityRefresh,
} from "./AssignmentFields"

export function ExtensionReviews({
  orgId,
  requests,
}: {
  orgId: string
  requests: ExtensionPublic[]
}) {
  const { t } = useTranslation()
  return (
    <section
      aria-label={t("capacity.extensions.sectionAria")}
      className="divide-y divide-surface-border"
    >
      <h2 className="sr-only">{t("capacity.extensions.sectionAria")}</h2>
      {!requests.length && (
        <p className="p-3 text-sm text-muted-foreground">
          {t("capacity.extensions.empty")}
        </p>
      )}
      {requests.map((request) => (
        <ExtensionDecision key={request.id} orgId={orgId} request={request} />
      ))}
    </section>
  )
}

function ExtensionDecision({
  orgId,
  request,
}: {
  orgId: string
  request: ExtensionPublic
}) {
  const { t } = useTranslation()
  const refresh = useCapacityRefresh(orgId)
  const [approve, setApprove] = useState(true)
  const decide = useMutation({
    mutationFn: (body: ExtensionDecisionInput) =>
      CapacityService.decideExtensionRequest({
        path: { org_id: orgId, request_id: request.id },
        body,
      }),
    onSuccess: refresh,
  })
  const confirmerNames = (request.commitment_confirmer_names ?? []).join(
    t("capacity.common.listSeparator"),
  )
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm hover:bg-muted/60 [&::-webkit-details-marker]:hidden">
        <span className="rounded-full border border-surface-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {t("capacity.extensions.typeBadge")}
        </span>
        <span className="font-medium">
          {request.employee_name} · {request.capability_name}
        </span>
        <span className="text-xs text-muted-foreground">
          {request.current_due_date} → {request.requested_due_date}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-primary">
          {t("capacity.extensions.handle")}{" "}
          <ChevronDown
            aria-hidden="true"
            className="size-4 group-open:rotate-180"
          />
        </span>
      </summary>
      <form
        aria-label={t("capacity.extensions.formAria", {
          name: request.employee_name,
        })}
        className="space-y-3 border-surface-border border-t p-3"
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          decide.mutate({
            approve,
            note: String(data.get("note")).trim() || null,
            ...(approve ? commitmentBody(data) : {}),
          })
        }}
      >
        {request.on_behalf_of_name && (
          <p className="text-sm text-muted-foreground">
            {t("capacity.approvals.delegatedNote", {
              name: request.on_behalf_of_name,
            })}
          </p>
        )}
        <p className="text-sm">
          {t("capacity.extensions.summaryLine", {
            current: request.current_due_date,
            requested: request.requested_due_date,
            committed: request.committed_end_date ?? t("capacity.common.tbd"),
          })}
        </p>
        <p className="whitespace-pre-wrap break-words">{request.reason}</p>
        <fieldset disabled={decide.isPending} className="space-y-3">
          <label className="block space-y-2 text-sm">
            <span>{t("capacity.extensions.actionLabel")}</span>
            <select
              className="h-10 w-full rounded-md border bg-background px-3"
              value={approve ? "approve" : "return"}
              onChange={(event) => {
                setApprove(event.target.value === "approve")
                decide.reset()
              }}
            >
              <option value="approve">
                {t("capacity.extensions.approve")}
              </option>
              <option value="return">{t("capacity.extensions.return")}</option>
            </select>
          </label>
          {approve && !!request.commitment_confirmer_names?.length && (
            <p className="text-sm rounded-lg border p-3">
              {t("capacity.extensions.confirmerHint", {
                names: confirmerNames,
                committed: request.committed_end_date ?? "",
              })}
            </p>
          )}
          <NoteField
            label={
              approve
                ? t("capacity.extensions.noteLabel")
                : t("capacity.extensions.noteRequiredLabel")
            }
            name="note"
            required={!approve}
          />
          {approve && (
            <CommitmentFields
              dueDate={request.requested_due_date}
              committedEndDate={request.committed_end_date}
            />
          )}
          <Button type="submit">
            {approve
              ? t("capacity.extensions.approveBtn")
              : t("capacity.extensions.returnBtn")}
          </Button>
        </fieldset>
        <CapacityError error={decide.error} />
      </form>
    </details>
  )
}
