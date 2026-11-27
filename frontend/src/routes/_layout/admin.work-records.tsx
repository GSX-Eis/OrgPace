import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/_layout/admin/work-records")({
  beforeLoad: () => {
    throw redirect({
      to: "/admin/data-ai",
      search: { tab: "work-records" },
      replace: true,
    })
  },
})
