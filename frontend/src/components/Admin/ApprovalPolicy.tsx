import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { ApprovalPolicyService, type PolicyInput } from "@/client"
import { ChangeHistory } from "@/components/Admin/ChangeHistory"
import { localeRecord } from "@/components/Admin/labels"
import { RulesLayout } from "@/components/Admin/RulesLayout"
import { DraftField } from "@/components/AdminAssistant/DraftField"
import { PageDraft } from "@/components/AdminAssistant/PageDraft"
import { usePageDraft } from "@/components/AdminAssistant/usePageDraft"
import { HelpTip, SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatDate } from "@/i18n/format"

const fieldLabels: Record<string, string> = localeRecord(
  {
    require_manager: "",
    category_overrides: "",
    no_approval_category_overrides: "",
    owner_review_days: "",
  },
  "admin.approvalPolicy.fields",
)

export function ApprovalPolicy({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [changes, setChanges] = useState<PolicyInput | null>(null)
  const suggestion = usePageDraft(
    orgId,
    "update_approval_policy",
    useCallback(() => setChanges(null), []),
  )
  const policy = useQuery({
    queryKey: ["approval-policy", orgId],
    queryFn: async () =>
      (
        await ApprovalPolicyService.policyGetApprovalPolicy({
          path: { org_id: orgId },
        })
      ).data,
  })
  const save = useMutation({
    mutationFn: (body: PolicyInput) =>
      ApprovalPolicyService.policyPutApprovalPolicy({
        path: { org_id: orgId },
        body,
      }),
    onSuccess: ({ data }) => {
      client.setQueryData(["approval-policy", orgId], data)
      client.invalidateQueries({ queryKey: ["handover", orgId] })
      setChanges(null)
    },
  })
  if (policy.isPending) return <ProfileLoading />
  if (policy.isError) return <ProfileError retry={() => policy.refetch()} />
  const published = policy.data.current
  const current = suggestion.values(changes ?? published)
  const exceptionCount = policy.data.categories.filter(
    (category) =>
      published.category_overrides?.[category] !== undefined ||
      published.no_approval_category_overrides?.[category] === true,
  ).length
  const categoryValue = (category: string) => {
    const noApprovalOverride =
      current.no_approval_category_overrides?.[category]
    const managerOverride = current.category_overrides?.[category]
    if (noApprovalOverride === true) return "no_approval"
    if (managerOverride !== undefined)
      return managerOverride ? "required" : "optional"
    return "inherit"
  }
  return (
    <RulesLayout
      summary={[
        [
          t("admin.approvalPolicy.summary.defaultPolicy"),
          published.require_manager
            ? t("admin.approvalPolicy.summary.managerReview")
            : t("admin.approvalPolicy.summary.employeeConfirmTentative"),
        ],
        [
          t("admin.approvalPolicy.summary.exceptions"),
          t("admin.approvalPolicy.summary.exceptionsCount", {
            count: exceptionCount,
          }),
        ],
        [
          t("admin.approvalPolicy.summary.ownerReviewDays"),
          t("admin.approvalPolicy.summary.daysCount", {
            days: published.owner_review_days,
          }),
        ],
        [
          t("admin.approvalPolicy.summary.currentVersion"),
          published.version
            ? t("admin.approvalPolicy.summary.versionNumber", {
                version: published.version,
              })
            : t("admin.approvalPolicy.summary.defaultRules"),
        ],
      ]}
      history={
        <>
          <ChangeHistory targetType="approval_policy" variant="compact" />
          {policy.data.history.length > 0 && (
            <SectionCard
              aria-label={t("admin.approvalPolicy.historyAriaLabel")}
              className="p-3"
            >
              <details>
                <summary className="cursor-pointer text-sm font-semibold">
                  {t("admin.approvalPolicy.historySummary")}
                </summary>
                <ol className="mt-2 divide-y text-xs wrap-anywhere">
                  {policy.data.history.map((version) => (
                    <li key={version.version} className="space-y-1 py-2">
                      <p className="font-medium">
                        {t("admin.approvalPolicy.versionMeta", {
                          version: version.version,
                          author: version.created_by_name,
                        })}
                      </p>
                      <p className="text-muted-foreground">
                        {version.created_at &&
                          formatDate(version.created_at, {
                            dateStyle: "short",
                            timeStyle: "medium",
                          })}{" "}
                        ·{" "}
                        {(version.changed_fields ?? [])
                          .map((field) => fieldLabels[field] ?? field)
                          .join(t("admin.approvalPolicy.fieldJoin")) ||
                          t("admin.approvalPolicy.saveCurrentRules")}
                      </p>
                      <p>
                        {t("admin.approvalPolicy.historyOrgLine", {
                          required: version.require_manager
                            ? t("admin.approvalPolicy.requiredYes")
                            : t("admin.approvalPolicy.requiredNo"),
                          days: version.owner_review_days,
                        })}
                      </p>
                      {Object.entries(version.category_overrides ?? {}).map(
                        ([category, required]) => (
                          <p key={category}>
                            {t("admin.approvalPolicy.historyCategoryLine", {
                              category,
                              required: required
                                ? t("admin.approvalPolicy.requiredYes")
                                : t("admin.approvalPolicy.requiredNo"),
                            })}
                          </p>
                        ),
                      )}
                      {Object.entries(
                        version.no_approval_category_overrides ?? {},
                      ).map(([category, enabled]) => (
                        <p key={`no-approval-${category}`}>
                          {enabled
                            ? t(
                                "admin.approvalPolicy.historyNoApprovalEnabled",
                                { category },
                              )
                            : t(
                                "admin.approvalPolicy.historyNoApprovalDisabled",
                                { category },
                              )}
                        </p>
                      ))}
                    </li>
                  ))}
                </ol>
              </details>
            </SectionCard>
          )}
        </>
      }
    >
      <PageDraft
        orgId={orgId}
        draft={suggestion.draft}
        error={suggestion.error}
      />
      <form
        aria-label={t("admin.approvalPolicy.formAriaLabel")}
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (suggestion.blocked) return
          save.mutate({
            require_manager: current.require_manager,
            category_overrides: current.category_overrides,
            no_approval_category_overrides:
              current.no_approval_category_overrides ?? {},
            owner_review_days: current.owner_review_days,
          })
        }}
      >
        <fieldset
          disabled={save.isPending || suggestion.blocked}
          className="min-w-0 space-y-3"
        >
          <SectionCard className="space-y-3 p-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">
                {t("admin.approvalPolicy.defaultSectionTitle")}
              </h2>
              <HelpTip
                label={t("admin.approvalPolicy.defaultTipLabel")}
                content={t("admin.approvalPolicy.defaultTipContent")}
              />
            </div>
            <DraftField changed={suggestion.changed("require_manager")}>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={current.require_manager}
                  onChange={(event) =>
                    setChanges({
                      ...current,
                      require_manager: event.target.checked,
                    })
                  }
                />
                {t("admin.approvalPolicy.requireManagerLabel")}
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("admin.approvalPolicy.requireManagerHint")}
              </p>
            </DraftField>
            <DraftField changed={suggestion.changed("owner_review_days")}>
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="owner-review-days">
                  {t("admin.approvalPolicy.ownerReviewDaysLabel")}
                </Label>
                <HelpTip
                  label={t("admin.approvalPolicy.ownerReviewDaysTipLabel")}
                  content={t("admin.approvalPolicy.ownerReviewDaysTipContent")}
                />
                <Input
                  id="owner-review-days"
                  className="h-8 w-24"
                  type="number"
                  min={1}
                  max={90}
                  step={1}
                  required
                  value={current.owner_review_days}
                  onChange={(event) =>
                    setChanges({
                      ...current,
                      owner_review_days: Number(event.target.value),
                    })
                  }
                />
              </div>
            </DraftField>
          </SectionCard>
          <SectionCard className="space-y-3 p-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">
                {t("admin.approvalPolicy.categorySectionTitle")}
              </h2>
              <HelpTip
                label={t("admin.approvalPolicy.categoryTipLabel")}
                content={t("admin.approvalPolicy.categoryTipContent")}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("admin.approvalPolicy.categoryDescription")}
            </p>
            <DraftField
              changed={
                suggestion.changed("category_overrides") ||
                suggestion.changed("no_approval_category_overrides")
              }
            >
              {policy.data.categories.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("admin.approvalPolicy.noCategories")}
                </p>
              )}
              <div className="space-y-2">
                {policy.data.categories.map((category, index) => (
                  <div
                    key={category}
                    className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1.6fr)] items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
                  >
                    <Label
                      htmlFor={`policy-category-${index}`}
                      className="wrap-anywhere"
                    >
                      {category}
                    </Label>
                    <span aria-hidden="true" className="text-sm text-primary">
                      →
                    </span>
                    <Select
                      disabled={save.isPending || suggestion.blocked}
                      value={categoryValue(category)}
                      onValueChange={(value) => {
                        const overrides = { ...current.category_overrides }
                        const noApprovalOverrides = {
                          ...(current.no_approval_category_overrides ?? {}),
                        }
                        if (value === "inherit") {
                          delete overrides[category]
                          delete noApprovalOverrides[category]
                        } else if (value === "no_approval") {
                          delete overrides[category]
                          noApprovalOverrides[category] = true
                        } else {
                          overrides[category] = value === "required"
                          delete noApprovalOverrides[category]
                        }
                        setChanges({
                          ...current,
                          category_overrides: overrides,
                          no_approval_category_overrides: noApprovalOverrides,
                        })
                      }}
                    >
                      <SelectTrigger
                        id={`policy-category-${index}`}
                        size="sm"
                        className="w-full min-w-0 bg-surface"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">
                          {t("admin.approvalPolicy.selectInherit")}
                        </SelectItem>
                        <SelectItem value="required">
                          {t("admin.approvalPolicy.selectRequired")}
                        </SelectItem>
                        <SelectItem value="optional">
                          {t("admin.approvalPolicy.selectOptional")}
                        </SelectItem>
                        <SelectItem value="no_approval">
                          {t("admin.approvalPolicy.selectNoApproval")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </DraftField>
          </SectionCard>
          <SetupError error={save.error} />
          <Button
            size="sm"
            type="submit"
            disabled={suggestion.blocked || !changes}
          >
            {save.isPending
              ? t("admin.common.saving")
              : t("admin.approvalPolicy.saveButton")}
          </Button>
        </fieldset>
        {save.isSuccess && !changes && (
          <p role="status">{t("admin.approvalPolicy.saved")}</p>
        )}
      </form>
    </RulesLayout>
  )
}
