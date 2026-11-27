import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { isAxiosError } from "axios"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ChangeRequestsService,
  type ProfileItem,
  ProfilesService,
  type RequestStatus,
} from "@/client"
import { tabSearch } from "@/components/Admin/AdminTabs"
import { WorkspacePage } from "@/components/Common/WorkbenchPrimitives"
import { AutoDraftSetting } from "@/components/Profile/AutoDraftSetting"
import { CapabilityList } from "@/components/Profile/CapabilityList"
import {
  ChangeRequestCard,
  type FocusedRequest,
} from "@/components/Profile/ChangeRequestCard"
import {
  ChangeRequestEditor,
  type EditorSelection,
} from "@/components/Profile/ChangeRequestEditor"
import { DirectEditDialog } from "@/components/Profile/DirectEditDialog"
import { EmployeeDetailTabs } from "@/components/Profile/EmployeeDetailTabs"
import { EvidenceList } from "@/components/Profile/EvidenceList"
import { EvidenceSheet } from "@/components/Profile/EvidenceSheet"
import { levelLabel } from "@/components/Profile/fields"
import { initialStatusReason } from "@/components/Profile/initialStatus"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { reviewerRoleLabel } from "@/components/Profile/RequestReviewers"
import { VersionHistory } from "@/components/Profile/VersionHistory"
import { cloneWithdrawnItems } from "@/components/Profile/withdrawnRequest"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { useOrg } from "@/hooks/useOrg"
import i18n from "@/i18n"

export const Route = createFileRoute("/_layout/employees/$employeeId")({
  component: EmployeePage,
  validateSearch: tabSearch,
  head: () => ({ meta: [{ title: i18n.t("people.detail.pageTitle") }] }),
})

function EmployeePage() {
  const { org } = useOrg()
  const { employeeId } = Route.useParams()
  return <EmployeeDetails key={`${org?.id}:${employeeId}`} />
}

function EmployeeDetails() {
  const { t } = useTranslation()
  const {
    org,
    roles,
    employeeId: ownEmployeeId,
    managedDepartmentIds,
  } = useOrg()
  const isAdmin = roles.includes("org_admin")
  const orgId = org?.id
  const { employeeId } = Route.useParams()
  const { tab: detailTab } = Route.useSearch()
  const navigate = Route.useNavigate()
  const queryClient = useQueryClient()
  const evidenceLoading =
    useIsFetching({ queryKey: ["evidence", orgId, employeeId] }) > 0
  const visitedHistory = useRef(false)
  const [focusedRequest, setFocusedRequest] = useState<FocusedRequest | null>(
    null,
  )
  const focusRequest = (id: string) =>
    setFocusedRequest((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }))
  const [evidenceId, setEvidenceId] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditorSelection | null>(null)
  const [choosing, setChoosing] = useState<ProfileItem | null>(null)
  const [directEditing, setDirectEditing] = useState<ProfileItem | null>(null)
  const requests = useQuery({
    queryKey: ["change-requests", org?.id, employeeId],
    queryFn: async () =>
      (
        await ChangeRequestsService.readChangeRequests({
          path: { org_id: org!.id, employee_id: employeeId },
          query: { status: "all" },
        })
      ).data,
    enabled: !!org,
    retry: false,
  })
  const query = useQuery({
    queryKey: ["profile", org?.id, employeeId],
    queryFn: async () =>
      (
        await ProfilesService.readProfile({
          path: { org_id: org!.id, employee_id: employeeId },
        })
      ).data,
    enabled: !!org,
    retry: false,
  })
  useEffect(() => {
    if (detailTab !== "versions") {
      visitedHistory.current = false
      return
    }
    if (
      !isAdmin ||
      !query.isSuccess ||
      evidenceLoading ||
      visitedHistory.current
    )
      return

    // Wait for the tabs and drawer to commit before checking the evidence layout.
    const focusTimer = window.setTimeout(() => {
      if (queryClient.isFetching({ queryKey: ["evidence", orgId, employeeId] }))
        return
      const history = document.getElementById("version-history")
      if (!history) return
      visitedHistory.current = true
      history.focus({ preventScroll: true })
      history.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      })
    }, 0)
    return () => window.clearTimeout(focusTimer)
  }, [
    detailTab,
    employeeId,
    evidenceLoading,
    isAdmin,
    orgId,
    query.isSuccess,
    queryClient,
  ])

  if (!org) return <OrgState />
  if (query.isPending) return <ProfileLoading />
  if (query.isError) {
    if (!(isAxiosError(query.error) && query.error.response?.status === 404))
      return <ProfileError retry={() => query.refetch()} />
    return (
      <div role="alert">
        {t("people.detail.notFound")}
        <Button variant="outline" onClick={() => query.refetch()}>
          {t("people.detail.retry")}
        </Button>
      </div>
    )
  }
  const active = query.data.employee.employment_status === "active"
  const canEditOwn = active && ownEmployeeId === employeeId
  const canDirectEdit =
    ownEmployeeId !== employeeId &&
    active &&
    (isAdmin ||
      managedDepartmentIds.includes(query.data.employee.department?.id ?? ""))
  const isOwner = ownEmployeeId === employeeId
  const initialRequest = requests.data?.data.find(
    (request) => request.origin === "initial_sync",
  )
  const pendingSupplement = requests.data?.data.find(
    (request) =>
      request.status === "pending_review" && request.origin !== "initial_sync",
  )
  const pendingRequest =
    initialRequest?.status === "pending_review"
      ? initialRequest
      : pendingSupplement
  const reviewerNames = (pendingRequest?.reviewers ?? [])
    .map((reviewer) =>
      t("people.detail.reviewerItem", {
        name: reviewer.name,
        role: reviewerRoleLabel(reviewer.role, t),
      }),
    )
    .join(t("people.detail.reviewerSeparator"))
  const hasDraft = requests.data?.data.some(
    (request) => request.status === "draft",
  )
  const canStartAnotherRequest = !pendingRequest && !hasDraft
  const canCloneInitial =
    canEditOwn &&
    canStartAnotherRequest &&
    initialRequest?.status === "withdrawn" &&
    cloneWithdrawnItems(initialRequest, query.data.items).length > 0
  const initialMessages: Partial<Record<RequestStatus, string>> = {
    withdrawn: isOwner
      ? t("people.detail.initialWithdrawnOwner")
      : t("people.detail.initialWithdrawnOther"),
    pending_review: t("people.detail.initialPendingReview"),
    changes_requested: isOwner
      ? t("people.detail.initialRejectedOwner")
      : t("people.detail.initialRejectedOther"),
    rejected: isOwner
      ? t("people.detail.initialRejectedOwner")
      : t("people.detail.initialRejectedOther"),
  }
  const initialStatus = initialRequest?.status
  const initialReason =
    (initialStatus && initialMessages[initialStatus]) ??
    initialStatusReason(
      query.data.employee.progress?.initial_profile_status === "owner_reviewed"
        ? undefined
        : query.data.employee.progress?.initial_profile_status,
      isOwner,
    )
  return (
    <WorkspacePage>
      <EmployeeDetailTabs
        employee={query.data.employee}
        tab={detailTab}
        onTabChange={(tab) => navigate({ search: { tab } })}
        evidence={
          <>
            <section
              aria-label={t("people.detail.evidenceSection")}
              className="space-y-4"
            >
              <h2 className="text-lg font-semibold">
                {t("people.detail.evidenceSection")}
              </h2>
              <EvidenceList
                orgId={org.id}
                employeeId={employeeId}
                onSelect={setEvidenceId}
              />
            </section>
            <section
              id="version-history"
              aria-label={t("people.detail.versionHistorySection")}
              tabIndex={-1}
              className="scroll-mt-14 space-y-4 border-t pt-6"
            >
              <h2 className="text-lg font-semibold">
                {t("people.detail.versionHistorySection")}
              </h2>
              <VersionHistory
                orgId={org.id}
                employeeId={employeeId}
                onEvidence={setEvidenceId}
                onRequest={(id) => {
                  focusRequest(id)
                  navigate({ search: { tab: "capabilities" } })
                }}
              />
            </section>
          </>
        }
      >
        {isAdmin && canEditOwn && <AutoDraftSetting orgId={org.id} />}
        {requests.isPending ? (
          <ProfileLoading />
        ) : requests.isError ? (
          <ProfileError retry={() => requests.refetch()} />
        ) : (
          <ChangeRequestCard
            requests={requests.data.data}
            focusedRequest={focusedRequest}
            compact={!isAdmin}
            profileItems={query.data.items}
            employeeId={employeeId}
            isOwner={canEditOwn}
            onEvidence={setEvidenceId}
            orgId={org.id}
            onEdit={setEditing}
          />
        )}
        {!query.data.latest_published &&
          !query.data.items.some((item) => item.claim) && (
            <section
              aria-label={t("people.detail.summarySection")}
              className="space-y-1.5 rounded-lg border border-surface-border bg-surface p-3 text-sm"
            >
              <h2 className="font-semibold">
                {ownEmployeeId === employeeId
                  ? t("people.detail.emptyOwn")
                  : t("people.detail.emptyOther")}
              </h2>
              <p>{initialReason}</p>
              {isOwner && pendingRequest && (
                <p className="wrap-anywhere">
                  {initialStatus === "pending_review"
                    ? reviewerNames
                      ? t("people.detail.reviewersInitial", {
                          names: reviewerNames,
                        })
                      : t("people.detail.reviewersInitialFallback")
                    : reviewerNames
                      ? t("people.detail.reviewersSupplement", {
                          names: reviewerNames,
                        })
                      : t("people.detail.reviewersSupplementFallback")}
                </p>
              )}
              {canEditOwn &&
                !pendingRequest &&
                initialStatus === "withdrawn" &&
                hasDraft && <p>{t("people.detail.hasDraftHint")}</p>}
              {canEditOwn &&
              (initialStatus !== "withdrawn" || canStartAnotherRequest) ? (
                <p>
                  {canCloneInitial && t("people.detail.cloneHintPrefix")}
                  {t("people.detail.addViaTopbarPrefix")}
                  <Link
                    to="/assistant"
                    search={{ mode: "personal" }}
                    className="text-primary underline"
                  >
                    {t("people.detail.assistantLink")}
                  </Link>
                  {t("people.detail.addViaAssistantSuffix")}
                </p>
              ) : !isOwner && active && !initialStatus ? (
                <p>{t("people.detail.otherEmptyHint")}</p>
              ) : null}
              {canCloneInitial && (
                <Button
                  variant="outline"
                  className="h-auto min-h-9 max-w-full whitespace-normal"
                  onClick={() => setEditing({ cloneFrom: initialRequest })}
                >
                  {t("people.detail.cloneFromInitial")}
                </Button>
              )}
              <p>{t("people.detail.complianceNotice")}</p>
            </section>
          )}
        {!query.data.schema_version && (
          <p role="status" className="mb-6 text-muted-foreground">
            {t("people.detail.noDictionary")}
          </p>
        )}
        <CapabilityList
          items={query.data.items}
          compact={!isAdmin}
          departmentConfigured={
            query.data.department_capabilities_configured ?? false
          }
          canConfigureDepartment={roles.includes("org_admin")}
          onEvidence={setEvidenceId}
          onViewRequest={focusRequest}
          onViewVersions={
            isAdmin
              ? () =>
                  navigate({
                    search: { tab: "versions" },
                    resetScroll: false,
                  })
              : undefined
          }
          directEdit={canDirectEdit}
          appeals={
            canEditOwn && requests.data
              ? { orgId: org.id, requests: requests.data.data }
              : undefined
          }
          onEdit={
            canEditOwn
              ? (item, retract) =>
                  retract ? setEditing({ item, retract }) : setChoosing(item)
              : canDirectEdit
                ? setDirectEditing
                : undefined
          }
          pendingCapabilityIds={
            new Set(
              requests.data?.data
                .filter((request) =>
                  ["draft", "pending_owner", "pending_review"].includes(
                    request.status,
                  ),
                )
                .flatMap((request) =>
                  (request.items ?? []).map((item) => item.capability.id),
                ),
            )
          }
        />
      </EmployeeDetailTabs>
      {editing && canEditOwn && (
        <ChangeRequestEditor
          orgId={org.id}
          selection={editing}
          profileItems={query.data.items}
          onClose={() => setEditing(null)}
          onEvidence={setEvidenceId}
        />
      )}
      {choosing && canEditOwn && (
        <Dialog open onOpenChange={(open) => !open && setChoosing(null)}>
          <DialogContent>
            <DialogTitle>
              {t("people.detail.editDialogTitle", {
                name: choosing.capability.name,
              })}
            </DialogTitle>
            <DialogDescription>
              {t("people.detail.editDialogDesc")}
            </DialogDescription>
            <Button
              onClick={() => {
                setEditing({ item: choosing })
                setChoosing(null)
              }}
            >
              {t("people.detail.manualEdit")}
            </Button>
            <Button variant="outline" asChild>
              <Link
                to="/assistant"
                search={{
                  prompt: t("people.detail.assistantEditPrompt", {
                    name: choosing.capability.name,
                    level: choosing.claim?.level
                      ? levelLabel(
                          choosing.capability.level_rubric,
                          choosing.claim.level,
                        )
                      : t("people.detail.assistantEditUnfilled"),
                  }),
                }}
              >
                {t("people.detail.useAssistant")}
              </Link>
            </Button>
          </DialogContent>
        </Dialog>
      )}
      {directEditing && canDirectEdit && (
        <DirectEditDialog
          orgId={org.id}
          employeeId={employeeId}
          item={directEditing}
          revision={query.data.latest_published?.revision ?? null}
          onClose={() => setDirectEditing(null)}
        />
      )}
      {evidenceId && (
        <EvidenceSheet
          orgId={org.id}
          evidenceId={evidenceId}
          onClose={() => setEvidenceId(null)}
        />
      )}
    </WorkspacePage>
  )
}
