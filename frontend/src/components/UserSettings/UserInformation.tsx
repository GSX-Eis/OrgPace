import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { EmployeeRequestsService } from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError } from "@/components/Profile/QueryState"
import useAuth from "@/hooks/useAuth"
import { useOrg } from "@/hooks/useOrg"

const UserInformation = () => {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { org, employeeId } = useOrg()
  const reports = useQuery({
    queryKey: ["my-direct-reports", org?.id, employeeId],
    queryFn: async () =>
      (
        await EmployeeRequestsService.readMyDirectReports({
          path: { org_id: org!.id },
        })
      ).data,
    enabled: !!org && !!employeeId,
  })
  return (
    <SectionCard
      aria-label={t("settings.userInfo.title")}
      className="divide-y overflow-hidden p-0"
    >
      <header className="bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-semibold">
          {t("settings.userInfo.title")}
        </h2>
      </header>
      <dl className="divide-y">
        {[
          [
            t("settings.userInfo.nameLabel"),
            t("settings.userInfo.nameDesc"),
            user?.full_name,
          ],
          [
            t("settings.userInfo.emailLabel"),
            t("settings.userInfo.emailDesc"),
            user?.email,
          ],
        ].map(([label, description, value]) => (
          <div
            key={label}
            className="grid gap-1 px-4 py-2.5 text-sm sm:grid-cols-2 sm:items-center sm:gap-3"
          >
            <dt className="font-medium">
              <span>{label}</span>
              <span className="block text-xs font-normal text-muted-foreground">
                {description}
              </span>
            </dt>
            <dd className="min-w-0 wrap-anywhere sm:text-right">
              {value || t("settings.userInfo.notSet")}
            </dd>
          </div>
        ))}
      </dl>
      {reports.isError && <ProfileError retry={() => reports.refetch()} />}
      {reports.data
        ?.filter((report) => !report.is_reviewer)
        .map((report) => {
          const reviewers = report.reviewers
            .map((reviewer) =>
              t("settings.userInfo.directReportReviewerItem", {
                name: reviewer.name,
                role: reviewer.role,
              }),
            )
            .join(t("settings.userInfo.directReportReviewerJoin"))
          return (
            <p
              key={report.employee_code ?? report.employee_name}
              className="px-4 py-2.5 text-sm text-muted-foreground"
            >
              {t("settings.userInfo.directReportPrefix", {
                name: report.employee_name,
              })}
              {report.employee_code &&
                t("settings.userInfo.directReportCode", {
                  code: report.employee_code,
                })}
              {t("settings.userInfo.directReportMid")}
              {report.reviewers.length
                ? t("settings.userInfo.directReportReviewers", { reviewers })
                : t("settings.userInfo.directReportNoReviewers")}
              {t("settings.userInfo.directReportHint")}
            </p>
          )
        })}
    </SectionCard>
  )
}

export default UserInformation
