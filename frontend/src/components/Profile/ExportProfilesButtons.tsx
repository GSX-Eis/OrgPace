import { useMutation } from "@tanstack/react-query"
import { Download } from "lucide-react"
import { useTranslation } from "react-i18next"
import { PeopleSearchService } from "@/client"
import { TopbarActions } from "@/components/Common/TopbarSlot"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function ExportProfilesButtons({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const download = useMutation({
    mutationFn: async (format: "csv" | "json") => {
      const { data } = await PeopleSearchService.searchExportProfiles({
        path: { org_id: orgId },
        query: { format },
        responseType: "blob",
      })
      if (!(data instanceof Blob)) throw new Error(t("profile.export.failed"))
      const url = URL.createObjectURL(data)
      const link = document.createElement("a")
      link.href = url
      link.download = `${t("profile.export.filename")}.${format}`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
  })
  return (
    <>
      <TopbarActions>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label={t("profile.export.button")}
              disabled={download.isPending}
            >
              <Download aria-hidden="true" />
              <span className="hidden sm:inline">
                {t("profile.export.button")}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-60">
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
              {t("profile.export.menuDesc")}
            </DropdownMenuLabel>
            {(["csv", "json"] as const).map((format) => (
              <DropdownMenuItem
                key={format}
                onSelect={() => download.mutate(format)}
              >
                {t("profile.export.menuItem", { format: format.toUpperCase() })}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </TopbarActions>
      <SetupError error={download.error} />
    </>
  )
}
