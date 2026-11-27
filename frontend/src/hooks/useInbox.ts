import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { EmployeeRequestsService, type InboxKind } from "@/client"
import { useOrg } from "./useOrg"

export function useInbox({
  skip = 0,
  pendingOnly = false,
  unreadOnly = false,
  kind,
}: {
  skip?: number
  pendingOnly?: boolean
  unreadOnly?: boolean
  kind?: InboxKind
} = {}) {
  const { org, employeeId } = useOrg()
  const { i18n } = useTranslation()
  return useQuery({
    queryKey: [
      "inbox",
      org?.id,
      employeeId,
      i18n.language,
      skip,
      pendingOnly,
      unreadOnly,
      kind,
    ],
    queryFn: async () =>
      (
        await EmployeeRequestsService.readInbox({
          path: { org_id: org!.id },
          query: {
            skip,
            limit: 20,
            pending_only: pendingOnly || undefined,
            unread_only: unreadOnly || undefined,
            kind,
          },
        })
      ).data,
    enabled: !!org,
    retry: false,
    refetchInterval: 30000,
  })
}
