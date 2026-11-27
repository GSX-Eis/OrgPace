import { createFileRoute, redirect } from "@tanstack/react-router"
import { tabSearch } from "@/components/Admin/AdminTabs"

export const Route = createFileRoute("/_layout/admin/connections")({
  validateSearch: tabSearch,
  beforeLoad: () => {
    throw redirect({
      to: "/admin/data-ai",
      search: { tab: "im" },
      replace: true,
    })
  },
})
