import { useTranslation } from "react-i18next"
import type {
  DemandOutcome,
  DemandPublic,
  DemandStatus,
  ProposalSchedule,
  SchedulePhase,
} from "@/client"
import i18n from "@/i18n"
import { formatDate } from "@/i18n/format"
import { formatIsoDateRange } from "./shared"

export type DemandStatusKey =
  | "accepted"
  | "withdrawn"
  | "rejected"
  | "pendingAlternative"
  | "pendingTarget"

export function latestDemandReply(demand: DemandPublic) {
  return [...(demand.events ?? [])]
    .reverse()
    .find((event) => event.kind === "replied")
}

export function demandStatusKey(
  status: DemandStatus,
  outcome?: DemandOutcome | null,
  schedule?: ProposalSchedule | null,
  now = Date.now(),
): DemandStatusKey {
  if (status === "accepted") return "accepted"
  if (status === "withdrawn") return "withdrawn"
  if (status === "replied" && outcome === "not_now") return "rejected"
  if (
    status === "replied" &&
    schedule?.status === "pending" &&
    schedule.hold_expires_at &&
    Date.parse(schedule.hold_expires_at) > now
  )
    return "pendingAlternative"
  return "pendingTarget"
}

export function demandStatusLabel(
  status: DemandStatus,
  outcome?: DemandOutcome | null,
  schedule?: ProposalSchedule | null,
  now = Date.now(),
) {
  return i18n.t(
    `capacity.demands.status.${demandStatusKey(status, outcome, schedule, now)}`,
  )
}

export function SchedulePhases({ phases }: { phases?: SchedulePhase[] }) {
  const { t } = useTranslation()
  if (!phases?.length) return null
  return (
    <ul
      aria-label={t("capacity.demands.schedule.phasesAria")}
      className="space-y-1"
    >
      {phases.map(({ start_date, end_date }, index) => (
        <li key={`${start_date}:${end_date}`}>
          {t("capacity.demands.schedule.phaseItem", {
            index: index + 1,
            range: formatIsoDateRange(start_date, end_date),
          })}
        </li>
      ))}
    </ul>
  )
}

export function holdDeadline(value: string) {
  return formatDate(value, {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

export function DemandScheduleSummary({
  demand,
  status,
}: {
  demand: Pick<
    DemandPublic,
    | "status"
    | "proposal_schedule"
    | "window_start"
    | "window_end"
    | "committed_start_date"
    | "committed_end_date"
  >
  status: string
}) {
  const { t } = useTranslation()
  const schedule = demand.proposal_schedule
  const pending = status === t("capacity.demands.status.pendingAlternative")
  const visible = schedule?.status === "committed" || pending ? schedule : null
  const start =
    visible?.start_date ??
    (demand.status === "accepted" ? demand.committed_start_date : null) ??
    demand.window_start
  const end =
    visible?.end_date ??
    (demand.status === "accepted" ? demand.committed_end_date : null) ??
    demand.window_end
  return (
    <>
      <p>{formatIsoDateRange(start, end)}</p>
      <SchedulePhases phases={visible?.schedule_phases} />
      {pending && schedule?.hold_expires_at && (
        <p>
          {t("capacity.demands.schedule.holdUntil", {
            deadline: holdDeadline(schedule.hold_expires_at),
          })}
        </p>
      )}
    </>
  )
}
