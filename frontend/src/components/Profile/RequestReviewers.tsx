import { useTranslation } from "react-i18next"
import type { RequestReviewer } from "@/client"

const reviewerRoleKeys: Record<string, string> = {
  直属上级: "profile.request.reviewers.roles.directManager",
  部门经理: "profile.request.reviewers.roles.departmentManager",
  代理审批: "profile.request.reviewers.roles.delegatedApprover",
  企业管理员: "profile.request.reviewers.roles.orgAdmin",
}

/** Map backend Chinese reviewer role enum values to localized UI labels. */
export function reviewerRoleLabel(
  role: string,
  translate: (key: string) => string,
) {
  return reviewerRoleKeys[role] ? translate(reviewerRoleKeys[role]) : role
}

export function RequestReviewers({
  reviewers = [],
  preview = false,
  requiresManager = true,
  partialAutoPublish = false,
}: {
  reviewers?: RequestReviewer[]
  preview?: boolean
  requiresManager?: boolean
  partialAutoPublish?: boolean
}) {
  const { t } = useTranslation()
  if (preview && !requiresManager) return null
  const names = reviewers
    .map((r) =>
      t("profile.request.reviewers.item", {
        name: r.name,
        role: reviewerRoleLabel(r.role, t),
      }),
    )
    .join(t("profile.request.summaryListSeparator"))
  const prefix =
    preview && partialAutoPublish
      ? t("profile.request.reviewers.partialPrefix")
      : ""
  return (
    <p>
      {names
        ? preview
          ? t("profile.request.reviewers.preview", { prefix, names })
          : t("profile.request.reviewers.pending", { prefix, names })
        : t("profile.request.reviewers.none", { prefix })}
    </p>
  )
}
