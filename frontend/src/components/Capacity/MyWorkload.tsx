import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarOff, SlidersHorizontal } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useTranslation } from "react-i18next"
import { CapacityService } from "@/client"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { SideDrawer } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Button } from "@/components/ui/button"
import { useOrg } from "@/hooks/useOrg"
import { MyAssignments } from "./MyAssignments"
import { MyWorkloadOverview } from "./MyWorkloadOverview"
import {
  MyWorkloadAdjustForm,
  MyWorkloadRequestHistory,
} from "./MyWorkloadRequests"
import { capacityKeys, invalidateWorkloadMutation } from "./queries"
import { WorkloadHelp } from "./shared"
import { Unavailability } from "./UnavailabilityPanel"

export function MyWorkload({
  orgId,
  actions,
}: {
  orgId: string
  actions: ReactNode
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const { roles } = useOrg()
  const isAdmin = roles.includes("org_admin")
  const [adjusting, setAdjusting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [leaveNotice, setLeaveNotice] = useState<string[] | null>(null)
  const [percent, setPercent] = useState("")
  const [reason, setReason] = useState("")
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const query = useQuery({
    queryKey: capacityKeys.workloadMe(orgId),
    queryFn: async () =>
      (await CapacityService.getMyWorkload({ path: { org_id: orgId } })).data,
  })
  const submit = useMutation({
    mutationFn: () => {
      const startWeek = start || query.data!.weeks[0].week_start
      const endWeek = end || startWeek
      return CapacityService.requestWorkloadChange({
        path: { org_id: orgId },
        body: {
          requested_percent: Number(percent),
          reason: reason.trim(),
          start_week: startWeek,
          end_week: endWeek,
        },
      })
    },
    onSuccess: () => {
      void invalidateWorkloadMutation(client, orgId)
      setPercent("")
      setReason("")
      setStart("")
      setEnd("")
      setAdjusting(false)
    },
  })
  if (query.isPending) return <ProfileLoading />
  if (query.isError) return <ProfileError retry={() => query.refetch()} />
  const pending = query.data.requests.some(
    (request) => request.status === "pending",
  )
  const sep = t("capacity.common.listSeparator")
  const reviewerNames = query.data.reviewer_names.join(sep)
  const submittedNames = submit.data?.data.reviewer_names?.join(sep)
  return (
    <div className="space-y-3">
      <p aria-hidden="true" className="text-lg font-semibold sm:hidden">
        {t("capacity.workload.myTitle")}
      </p>
      <TopbarActions>
        {actions}
        <WorkloadHelp />
        {!isAdmin && (
          <SideDrawer
            title={t("capacity.workload.leaveDrawerTitle")}
            open={leaving}
            onOpenChange={setLeaving}
            trigger={
              <Button
                size="sm"
                variant="outline"
                className="max-sm:size-8 max-sm:p-0"
              >
                <CalendarOff aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">
                  {t("capacity.workload.leaveBtn")}
                </span>
              </Button>
            }
          >
            <Unavailability
              orgId={orgId}
              employeeId={query.data.employee_id}
              startWeek={query.data.weeks[0].week_start}
              canWrite
              showNote
              idPrefix="leave"
              submitLabel={t("capacity.workload.leaveSubmit")}
              onRegistered={(overWeeks) => {
                setLeaveNotice(overWeeks)
                setLeaving(false)
              }}
            />
          </SideDrawer>
        )}
        <SideDrawer
          title={t("capacity.workload.adjustTitle")}
          open={adjusting}
          onOpenChange={setAdjusting}
          trigger={
            <Button
              size="sm"
              className="max-sm:size-8 max-sm:p-0"
              disabled={submit.isPending}
            >
              <SlidersHorizontal aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">
                {t("capacity.workload.adjustBtn")}
              </span>
            </Button>
          }
        >
          <MyWorkloadAdjustForm
            firstWeekStart={query.data.weeks[0].week_start}
            reviewerNames={reviewerNames}
            pending={pending}
            isPending={submit.isPending}
            error={submit.error}
            start={start}
            end={end}
            percent={percent}
            reason={reason}
            onStartChange={setStart}
            onEndChange={setEnd}
            onPercentChange={setPercent}
            onReasonChange={setReason}
            onSubmit={() => submit.mutate()}
          />
        </SideDrawer>
      </TopbarActions>
      {leaveNotice !== null && (
        <p
          role="status"
          className="rounded-md border bg-surface px-3 py-2 text-sm"
        >
          {t("capacity.workload.leaveRegisteredNotice")}
          {leaveNotice.length > 0 &&
            t("capacity.workload.leaveOverWeeksNotice", {
              weeks: leaveNotice.join(sep),
            })}
        </p>
      )}
      <MyWorkloadOverview
        orgId={orgId}
        workload={query.data}
        isAdmin={isAdmin}
        onLeaveRegistered={(overWeeks) => setLeaveNotice(overWeeks)}
      />
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,68fr)_minmax(0,32fr)]">
        <MyAssignments orgId={orgId} />
        <MyWorkloadRequestHistory
          requests={query.data.requests}
          reviewerNames={reviewerNames}
          pending={pending}
          submitSuccess={submit.isSuccess}
          submittedNames={submittedNames}
        />
      </div>
    </div>
  )
}
