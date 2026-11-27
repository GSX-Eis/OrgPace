import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { AxiosError } from "axios"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type AssignmentInput,
  type AssignmentUpdateInput,
  CapacityService,
  type DemandAssignment,
  type DemandPublic,
  type DepartedDemandAssignment,
  type FeedbackAssignment,
} from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"
import {
  AssignmentFeedback,
  useFeedbackAssignments,
} from "./AssignmentFeedback"
import {
  CapacityError,
  CommitmentFields,
  commitmentBody,
  DateField,
  useCapacityRefresh,
} from "./AssignmentFields"
import { AssignmentTracking, trackingLabel } from "./AssignmentTracking"
import {
  formatCapacityPercent,
  formatIsoDate,
  formatIsoDateRange,
  isCapacityAccessDenied,
} from "./shared"

const assignmentStatusKeys = {
  active: "capacity.assignments.statuses.active",
  done: "capacity.assignments.statuses.done",
  cancelled: "capacity.assignments.statuses.cancelled",
} as const

export function assignmentStatusLabel(
  status: keyof typeof assignmentStatusKeys,
) {
  return i18n.t(assignmentStatusKeys[status])
}

export function DemandAssignments({
  orgId,
  demand,
  canProposeChange,
}: {
  orgId: string
  demand: DemandPublic
  canProposeChange: boolean
}) {
  const { t } = useTranslation()
  const id = useId()
  const [employeeId, setEmployeeId] = useState("")
  const refresh = useCapacityRefresh(orgId)
  const { managedDepartmentIds } = useOrg()
  const path = { org_id: orgId, demand_id: demand.id }
  const feedback = useFeedbackAssignments(orgId, demand.id)
  const query = useQuery({
    queryKey: ["capacity", orgId, "assignments", demand.id],
    queryFn: async () =>
      (await CapacityService.listDemandAssignments({ path })).data,
  })
  const basis = useQuery({
    queryKey: ["capacity", orgId, "demand-basis", demand.id],
    queryFn: async () => (await CapacityService.getDemandBasis({ path })).data,
  })
  const create = useMutation({
    mutationFn: (body: AssignmentInput) =>
      CapacityService.createAssignment({ path, body }),
    onSuccess: refresh,
    onError: (error) => {
      if (
        error instanceof AxiosError &&
        error.response?.status === 409 &&
        error.response.data?.detail?.code === "employee_departed"
      ) {
        setEmployeeId("")
        void basis.refetch()
      }
    },
  })
  if (
    isCapacityAccessDenied(basis.error) ||
    isCapacityAccessDenied(query.error)
  )
    return (
      <section
        aria-label={t("capacity.assignments.sectionAria")}
        className="space-y-4 rounded-xl border p-5"
      >
        <h3 className="text-lg font-semibold">
          {t("capacity.assignments.sectionTitle")}
        </h3>
        <p role="status">{t("capacity.demandDetail.noPermission")}</p>
      </section>
    )
  return (
    <SectionCard
      id="demand-assignments"
      aria-label={t("capacity.assignments.sectionAria")}
      className="scroll-mt-16 space-y-3"
    >
      <h3 className="text-lg font-semibold">
        {t("capacity.assignments.sectionTitle")}
      </h3>
      {basis.data &&
        (!basis.data.data.length && !basis.data.others.length ? (
          <p>{t("capacity.assignments.noActiveEmployees")}</p>
        ) : demand.headcount != null && basis.data.count < demand.headcount ? (
          <p>
            {t("capacity.assignments.headcountShortage", {
              count: basis.data.count,
              headcount: demand.headcount,
            })}
          </p>
        ) : null)}
      {demand.proposal?.status !== "committed" &&
        demand.proposal?.kind !== "change" && (
          <form
            aria-label={t("capacity.assignments.addFormAria")}
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              create.mutate({
                employee_id: String(data.get("employee_id")),
                allocation_percent: Number(data.get("allocation_percent")),
                start_date: String(data.get("start_date")),
                outside_basis: data.has("outside_basis"),
                due_date: String(data.get("due_date")),
              })
            }}
          >
            <fieldset
              disabled={
                create.isPending || !basis.isSuccess || !query.isSuccess
              }
              className="grid gap-3 sm:grid-cols-3"
            >
              <label className="space-y-2 text-sm">
                <span>{t("capacity.assignments.selectEmployee")}</span>
                <select
                  name="employee_id"
                  required
                  className="h-10 w-full rounded-md border bg-background px-3"
                  value={employeeId}
                  onChange={(event) => setEmployeeId(event.target.value)}
                >
                  <option value="" disabled>
                    {t("capacity.assignments.selectPlaceholder")}
                  </option>
                  {[
                    {
                      label: t("capacity.assignments.qualifiedGroup"),
                      people: basis.data?.data,
                    },
                    {
                      label: t("capacity.assignments.otherDeptGroup"),
                      people: basis.data?.others,
                    },
                  ].map(({ label, people }) => (
                    <optgroup key={label} label={label}>
                      {people
                        ?.filter(
                          (person) =>
                            !query.data?.data.some(
                              (row) =>
                                "employee_id" in row &&
                                row.employee_id === person.employee_id &&
                                row.status === "active",
                            ),
                        )
                        .map((person) => (
                          <option
                            key={person.employee_id}
                            value={person.employee_id}
                          >
                            {person.display_name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label htmlFor={`${id}-percent`} className="space-y-2 text-sm">
                <span>{t("capacity.assignments.allocationPercent")}</span>
                <Input
                  id={`${id}-percent`}
                  type="number"
                  name="allocation_percent"
                  min={10}
                  max={100}
                  step={1}
                  required
                  defaultValue={demand.allocation_percent ?? undefined}
                />
              </label>
              <DateField
                label={t("capacity.assignments.startDate")}
                name="start_date"
                min={demand.committed_start_date ?? undefined}
              />
              <DateField
                label={t("capacity.assignments.dueDate")}
                name="due_date"
                max={demand.committed_end_date ?? undefined}
              />
              {basis.data?.others.some(
                (person) => person.employee_id === employeeId,
              ) && (
                <label
                  htmlFor={`${id}-outside`}
                  key={employeeId}
                  className="flex items-center gap-2 text-sm sm:col-span-3"
                >
                  <Input
                    id={`${id}-outside`}
                    type="checkbox"
                    name="outside_basis"
                    required
                    className="size-4"
                  />
                  {t("capacity.assignments.outsideBasisCheck")}
                </label>
              )}
              <Button type="submit">
                {t("capacity.assignments.confirmAssignBtn")}
              </Button>
            </fieldset>
            <CapacityError error={create.error} />
          </form>
        )}
      {basis.isError && <ProfileError retry={() => basis.refetch()} />}
      {query.isPending ? (
        <ProfileLoading />
      ) : query.isError ? (
        <ProfileError retry={() => query.refetch()} />
      ) : (
        <>
          {!query.data.count && (
            <p className="text-muted-foreground">
              {t("capacity.assignments.empty")}
            </p>
          )}
          {query.data.data.map((row, index) =>
            !("id" in row) ? (
              <article
                key={`borrow-${index}`}
                className="space-y-2 rounded-lg border p-3"
              >
                <h4 className="font-medium">
                  {t("capacity.assignments.borrowHeading", {
                    count: row.headcount,
                  })}
                </h4>
                <p className="text-sm">
                  {t("capacity.assignments.borrowMeta", {
                    percent: formatCapacityPercent(row.allocation_percent),
                    range: row.start_date
                      ? formatIsoDateRange(row.start_date, row.due_date)
                      : formatIsoDate(row.due_date),
                    status: t(assignmentStatusKeys[row.status]),
                  })}
                </p>
                {row.status === "active" && (
                  <p className="text-sm">
                    {trackingLabel(row.tracking_state ?? "no_tasks")}
                  </p>
                )}
              </article>
            ) : (
              <AssignmentRow
                key={`${row.id}:${row.start_date}:${row.due_date}`}
                orgId={orgId}
                row={row}
                feedback={feedback.data?.find((item) => item.id === row.id)}
                committedEndDate={demand.committed_end_date ?? null}
                committedStartDate={demand.committed_start_date ?? null}
                canProposeChange={canProposeChange}
                canEdit={managedDepartmentIds.includes(
                  demand.target_department_id,
                )}
              />
            ),
          )}
        </>
      )}
      <CapacityError error={feedback.error} />
    </SectionCard>
  )
}

function AssignmentRow({
  orgId,
  row,
  feedback,
  committedEndDate,
  committedStartDate,
  canEdit,
  canProposeChange,
}: {
  orgId: string
  row: DemandAssignment | DepartedDemandAssignment
  feedback?: FeedbackAssignment
  committedEndDate: string | null
  committedStartDate: string | null
  canEdit: boolean
  canProposeChange: boolean
}) {
  const { t } = useTranslation()
  const committed = "proposal_line_id" in row && !!row.proposal_line_id
  const refresh = useCapacityRefresh(orgId)
  const [dueDate, setDueDate] = useState(row.due_date)
  const update = useMutation({
    mutationFn: (body: AssignmentUpdateInput) =>
      CapacityService.updateAssignment({
        path: { org_id: orgId, assignment_id: row.id },
        body,
      }),
    onSuccess: refresh,
  })
  return (
    <article
      aria-label={row.employee_name}
      className="space-y-3 rounded-lg border p-4"
    >
      <h4 className="font-medium">
        {row.employee_name} ·{" "}
        {"status" in row
          ? t(assignmentStatusKeys[row.status])
          : t("capacity.assignments.statuses.active")}
      </h4>
      <p className="text-sm">
        {t("capacity.assignments.rowMeta", {
          percent: formatCapacityPercent(row.allocation_percent),
          start: row.start_date
            ? t("capacity.assignments.startLabel", { date: row.start_date })
            : t("capacity.assignments.startUnconfirmed"),
          due: formatIsoDate(row.due_date),
        })}
      </p>
      {canEdit &&
        "status" in row &&
        row.status === "active" &&
        !row.employee_departed && (
          <AssignmentTracking orgId={orgId} assignmentId={row.id} />
        )}
      {canEdit && (!("status" in row) || row.status === "active") && (
        <>
          <div className="flex flex-wrap gap-2">
            {"status" in row && (
              <Button
                variant="outline"
                disabled={update.isPending}
                onClick={() => update.mutate({ status: "done" })}
              >
                {t("capacity.assignments.markDoneBtn")}
              </Button>
            )}
            {(!committed || row.employee_departed) && (
              <Button
                variant="outline"
                disabled={update.isPending}
                onClick={() => update.mutate({ status: "cancelled" })}
              >
                {t("capacity.assignments.cancelAssignBtn")}
              </Button>
            )}
            {committed && canProposeChange && (
              <Button asChild variant="outline">
                <Link
                  to="/capacity"
                  search={{ tab: "incoming", demand: row.demand_id, plans: 1 }}
                  resetScroll={false}
                  onClick={() =>
                    document.getElementById("capacity-plans")?.scrollIntoView()
                  }
                >
                  {t("capacity.assignments.proposeStartChangeBtn")}
                </Link>
              </Button>
            )}
          </div>
          {"status" in row && !committed && (
            <form
              aria-label={t("capacity.assignments.editStartAria")}
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                update.mutate({
                  start_date: String(
                    new FormData(event.currentTarget).get("start_date"),
                  ),
                })
              }}
            >
              <fieldset disabled={update.isPending} className="space-y-3">
                <DateField
                  label={t("capacity.assignments.newStartDate")}
                  name="start_date"
                  defaultValue={row.start_date ?? ""}
                  min={committedStartDate ?? undefined}
                  max={row.due_date}
                />
                <Button type="submit">
                  {t("capacity.assignments.saveStartDateBtn")}
                </Button>
              </fieldset>
            </form>
          )}
          {"status" in row && (
            <form
              aria-label={t("capacity.assignments.editDueAria")}
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                update.mutate({
                  due_date: dueDate,
                  ...commitmentBody(new FormData(event.currentTarget)),
                })
              }}
            >
              <fieldset disabled={update.isPending} className="space-y-3">
                <DateField
                  label={t("capacity.assignments.newDueDate")}
                  min={committed ? row.due_date : (row.start_date ?? undefined)}
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                />
                <CommitmentFields
                  dueDate={dueDate}
                  committedEndDate={committedEndDate}
                />
                <Button type="submit">
                  {t("capacity.assignments.saveDueDateBtn")}
                </Button>
              </fieldset>
            </form>
          )}
        </>
      )}
      <CapacityError error={update.error} />
      {feedback && <AssignmentFeedback orgId={orgId} assignment={feedback} />}
    </article>
  )
}
