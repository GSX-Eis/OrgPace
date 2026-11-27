import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChangeRequestsService, type SubmissionVia } from "@/client"
import { Badge } from "@/components/ui/badge"
import i18n, { getLocale } from "@/i18n"
import { formatDate } from "@/i18n/format"
import { ProfileError, ProfileLoading } from "./QueryState"

export const viaLabels: Record<string, string> = {
  get web() {
    return i18n.t("profile.request.via.web")
  },
  get mcp() {
    return i18n.t("profile.request.via.mcp")
  },
  get import() {
    return i18n.t("profile.request.via.import")
  },
  get bot() {
    return i18n.t("profile.request.via.bot")
  },
  get admin_handover() {
    return i18n.t("profile.request.via.admin_handover")
  },
  get im() {
    return i18n.t("profile.request.via.im")
  },
  get policy() {
    return i18n.t("profile.request.via.policy")
  },
  get sync() {
    return i18n.t("profile.request.via.sync")
  },
}

const enChannelNames = new Map<string, string>([
  ["飞书", "Feishu"], // i18n-ignore: 映射后端存储的中文 IM 渠道名
  ["企业微信", "WeCom"], // i18n-ignore: 映射后端存储的中文 IM 渠道名
  ["Telegram", "Telegram"],
])

export function requestClientName(name: string, via?: string | null) {
  if (getLocale() === "en") {
    if (name === "画像页") return "Profile Page" // i18n-ignore: 映射历史中文客户端来源名
    if (name === "管理助手") return "Admin Assistant" // i18n-ignore: 映射历史中文客户端来源名
    if (name === "网页") return "Web" // i18n-ignore: 映射历史中文客户端来源名
    if (via === "bot" || via === "im") {
      const match = name.match(/^(?:内置机器人|内置助手)(?:（(.+?)）)?$/)
      if (match) {
        const channel = match[1]
          ? (enChannelNames.get(match[1]) ?? match[1])
          : ""
        return channel
          ? `Built-in Assistant (${channel})`
          : "Built-in Assistant"
      }
    }
    return name
  }
  return via === "bot" || via === "im"
    ? name.replace(/^内置机器人(?=（|$)/, "内置助手") // i18n-ignore: 归一化历史中文客户端来源名
    : name
}

export function RequestSourceBadge({
  via,
  clientName,
}: {
  via?: SubmissionVia | null
  clientName?: string | null
}) {
  const { t } = useTranslation()
  if (!via) return null
  return (
    <div>
      <Badge
        variant="outline"
        className="max-w-full wrap-anywhere whitespace-normal"
      >
        {via === "mcp" ? t("profile.request.mcpExternalBadge") : viaLabels[via]}
        {clientName && ` · ${requestClientName(clientName, via)}`}
      </Badge>
    </div>
  )
}

export const decisionLabels = {
  get approved() {
    return i18n.t("profile.request.decisionLabels.approved")
  },
  get changes_requested() {
    return i18n.t("profile.request.decisionLabels.changes_requested")
  },
  get rejected() {
    return i18n.t("profile.request.decisionLabels.rejected")
  },
}

export function RequestTimeline({
  orgId,
  employeeId,
  requestId,
}: {
  orgId: string
  employeeId: string
  requestId: string
}) {
  const { t } = useTranslation()
  const actions: Record<string, string> = {
    created: t("profile.request.timelineActions.created"),
    submitted: t("profile.request.timelineActions.submitted"),
    decided: t("profile.request.timelineActions.decided"),
    published: t("profile.request.timelineActions.published"),
    withdrawn: t("profile.request.timelineActions.withdrawn"),
    returned: t("profile.request.timelineActions.returned"),
  }
  const [open, setOpen] = useState(false)
  const query = useQuery({
    enabled: open,
    queryKey: ["request-timeline", orgId, requestId],
    queryFn: async () =>
      (
        await ChangeRequestsService.readRequestTimeline({
          path: {
            org_id: orgId,
            employee_id: employeeId,
            request_id: requestId,
          },
        })
      ).data,
  })
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer py-2 text-primary">
        {t("profile.request.timelineTitle")}
      </summary>
      {query.isPending ? (
        <ProfileLoading />
      ) : query.isError ? (
        <ProfileError retry={() => query.refetch()} />
      ) : (
        <ol
          aria-label={t("profile.request.timelineTitle")}
          className="ml-2 space-y-4 border-l pl-5 text-sm"
        >
          {query.data.map((event, index) => (
            <li key={`${event.action}-${index}`} className="space-y-1">
              <p>
                {actions[event.action] ??
                  t("profile.request.timelineActions.default")}
                {event.version && ` · r${event.version}`}
                {event.reviewer && ` · ${event.reviewer}`}
                {event.via &&
                  ` · ${viaLabels[event.via] ?? t("profile.request.via.other")}`}
                {event.client_name &&
                  ` · ${requestClientName(event.client_name, event.via)}`}
              </p>
              <time className="text-xs text-muted-foreground">
                {formatDate(event.at, {
                  year: "numeric",
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                })}
              </time>
              {event.request_id && (
                <a
                  className="block text-primary underline"
                  href={`#request-${event.request_id}`}
                >
                  {t("profile.request.viewResubmitDraft")}
                </a>
              )}
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}
