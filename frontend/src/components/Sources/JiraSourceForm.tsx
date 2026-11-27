import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  type JiraConfig,
  type JiraConnectionPublic,
  type JiraProject,
  SourcesService,
} from "@/client"
import { DraftField } from "@/components/AdminAssistant/DraftField"
import type { usePageDraft } from "@/components/AdminAssistant/usePageDraft"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatDate } from "@/i18n/format"
import { LastSyncStatus, useSourceRuns } from "./LastSyncStatus"

export function JiraSourceForm({
  orgId,
  connection,
  deployment,
  assistant,
}: {
  orgId: string
  connection: JiraConnectionPublic
  deployment: JiraConfig["deployment"]
  assistant: ReturnType<typeof usePageDraft>
}) {
  const { t } = useTranslation()
  const scheduleLabels = {
    off: t("sources.jira.schedules.off"),
    monthly: t("sources.jira.schedules.monthly"),
    quarterly: t("sources.jira.schedules.quarterly"),
    yearly: t("sources.jira.schedules.yearly"),
  }
  const client = useQueryClient()
  const start = new Date()
  const year = start.getFullYear() - 1
  const day = Math.min(
    start.getDate(),
    new Date(year, start.getMonth() + 1, 0).getDate(),
  )
  const previousConfig = connection.config
  const savedConfig =
    previousConfig?.deployment === deployment ? previousConfig : undefined
  const switchingDeployment =
    !!previousConfig && !savedConfig && !assistant.item
  const [manualConfig, setConfig] = useState<JiraConfig | null>(null)
  const config = assistant.values<JiraConfig>(
    manualConfig ??
      savedConfig ?? {
        deployment,
        base_url: "",
        auth_type: deployment === "cloud" ? "api_token" : "pat",
        username: "",
        start_date: switchingDeployment
          ? previousConfig.start_date
          : `${year}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        include_description:
          switchingDeployment && (previousConfig.include_description ?? false),
      },
  )
  const [schedule, setSchedule] =
    useState<JiraConnectionPublic["sync_schedule"]>()
  const [secret, setSecret] = useState("")
  const [confirmedSchedule, setConfirmedSchedule] =
    useState<JiraConnectionPublic["sync_schedule"]>()
  const hasSecret = !!savedConfig && connection.has_secret
  const [dirty, setDirty] = useState(false)
  const [projects, setProjects] = useState<JiraProject[]>([])
  const previousSchedule = connection.sync_schedule ?? "off"
  const displayedSchedule = assistant.values({
    sync_schedule:
      schedule ??
      (savedConfig || switchingDeployment ? previousSchedule : "off"),
  }).sync_schedule
  const switchConfirmed = confirmedSchedule === displayedSchedule
  const projectKeys = config.project_keys?.filter(Boolean) ?? []
  const runs = useSourceRuns(orgId, "jira")
  const latest = runs.data?.[0]
  const syncing = latest?.status === "queued" || latest?.status === "running"
  const save = useMutation({
    mutationFn: () =>
      SourcesService.putJira({
        path: { org_id: orgId },
        body: {
          ...config,
          project_keys: config.project_keys?.filter(Boolean),
          sync_schedule: displayedSchedule,
          secret: secret || undefined,
        },
      }),
    onSuccess: ({ data }) => {
      setConfig(null)
      setSchedule(undefined)
      setSecret("")
      setConfirmedSchedule(undefined)
      setDirty(false)
      client.setQueryData(["jira", orgId], data)
      test.reset()
    },
  })
  const test = useMutation({
    mutationFn: () => SourcesService.testJira({ path: { org_id: orgId } }),
    onSuccess: ({ data }) => setProjects(data.ok ? (data.projects ?? []) : []),
  })
  const sync = useMutation({
    mutationFn: () => SourcesService.startJiraSync({ path: { org_id: orgId } }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["source-runs", orgId] }),
        client.invalidateQueries({ queryKey: ["sync-runs", orgId] }),
      ]),
  })
  function change(patch: Partial<JiraConfig>) {
    if (
      patch.base_url !== undefined ||
      patch.username !== undefined ||
      patch.auth_type !== undefined
    )
      setProjects([])
    if (
      patch.base_url !== undefined ||
      patch.project_keys !== undefined ||
      patch.start_date !== undefined
    )
      setConfirmedSchedule(undefined)
    setConfig({ ...config, ...patch })
    setDirty(true)
    save.reset()
    test.reset()
  }
  const busy = save.isPending || test.isPending || sync.isPending
  const saveDisabled =
    busy ||
    syncing ||
    assistant.blocked ||
    (switchingDeployment && !switchConfirmed)
  const sep = t("sources.jira.joinSep")
  const switchScope =
    projectKeys.map((key) => key.toUpperCase()).join(sep) ||
    t("sources.jira.allProjects")
  const willSyncScope = projectKeys.length
    ? projectKeys
        .map((key) => {
          const project = projects.find((p) => p.key === key.toUpperCase())
          return project
            ? t("sources.jira.projectOption", {
                key: project.key,
                name: project.name,
              })
            : key.toUpperCase()
        })
        .join(sep)
    : t("sources.jira.allProjects")
  return (
    <section
      aria-label={t("sources.jira.sectionAriaLabel")}
      className="space-y-4"
    >
      {switchingDeployment && (
        <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-medium">{t("sources.jira.switchTitle")}</p>
          <p>{t("sources.jira.switchDesc")}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt>{t("sources.jira.prevDeployment")}</dt>
            <dd>
              {previousConfig.deployment === "cloud"
                ? t("sources.jira.cloudName")
                : t("sources.jira.dcName")}
            </dd>
            <dt>{t("sources.jira.prevSchedule")}</dt>
            <dd>{scheduleLabels[previousSchedule]}</dd>
            <dt>{t("sources.jira.prevProjects")}</dt>
            <dd className="wrap-anywhere">
              {previousConfig.project_keys?.join(sep) ||
                t("sources.jira.allProjects")}
            </dd>
            <dt>{t("sources.jira.prevStartDate")}</dt>
            <dd>{previousConfig.start_date ?? t("sources.jira.notSet")}</dd>
          </dl>
        </div>
      )}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (saveDisabled) return
          save.mutate()
        }}
      >
        <fieldset
          disabled={busy || syncing || assistant.blocked}
          className="min-w-0 space-y-4"
        >
          {assistant.changed("deployment") && (
            <DraftField changed>
              <p className="text-sm font-medium">
                {t("sources.jira.deploymentLabel", {
                  name:
                    config.deployment === "cloud"
                      ? t("sources.jira.cloudName")
                      : t("sources.jira.dcName"),
                })}
              </p>
            </DraftField>
          )}
          <DraftField changed={assistant.changed("base_url")}>
            <Label htmlFor="jira-url">{t("sources.jira.baseUrlLabel")}</Label>
            <Input
              id="jira-url"
              type="url"
              required
              maxLength={500}
              placeholder={t("sources.jira.baseUrlPlaceholder")}
              value={config.base_url}
              onChange={(e) => change({ base_url: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              {t("sources.jira.baseUrlHelp")}
            </p>
          </DraftField>
          {config.deployment === "data_center" && (
            <DraftField changed={assistant.changed("auth_type")}>
              <Label htmlFor="jira-auth">
                {t("sources.jira.authTypeLabel")}
              </Label>
              <select
                id="jira-auth"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={config.auth_type}
                onChange={(e) =>
                  change({
                    auth_type: e.target.value === "pat" ? "pat" : "basic",
                  })
                }
              >
                <option value="pat">{t("sources.jira.authPat")}</option>
                <option value="basic">{t("sources.jira.authBasic")}</option>
              </select>
            </DraftField>
          )}
          {config.auth_type !== "pat" && (
            <DraftField changed={assistant.changed("username")}>
              <Label htmlFor="jira-user">
                {config.deployment === "cloud"
                  ? t("sources.jira.accountEmailLabel")
                  : t("sources.jira.usernameLabel")}
              </Label>
              <Input
                id="jira-user"
                type={config.deployment === "cloud" ? "email" : "text"}
                required
                maxLength={255}
                value={config.username ?? ""}
                onChange={(e) => change({ username: e.target.value })}
              />
            </DraftField>
          )}
          <div className="space-y-2">
            <Label htmlFor="jira-secret">
              {config.auth_type === "basic"
                ? t("sources.jira.secretBasic")
                : config.auth_type === "pat"
                  ? t("sources.jira.secretPat")
                  : t("sources.jira.secretToken")}
            </Label>
            <Input
              id="jira-secret"
              type="password"
              autoComplete="new-password"
              required={!hasSecret}
              placeholder={
                hasSecret
                  ? t("sources.jira.secretSavedPlaceholder")
                  : t("sources.jira.secretEmptyPlaceholder")
              }
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value)
                setProjects([])
                setDirty(true)
                save.reset()
                test.reset()
              }}
            />
            <p className="text-xs text-muted-foreground">
              {switchingDeployment
                ? t("sources.jira.secretHelpSwitch")
                : t("sources.jira.secretHelpKeep")}
            </p>
            {config.deployment === "cloud" && (
              <p className="text-xs text-muted-foreground">
                {t("sources.jira.cloudTokenHelp")}
              </p>
            )}
          </div>
          <DraftField changed={assistant.changed("start_date")}>
            <Label htmlFor="jira-start">
              {t("sources.jira.startDateLabel")}
            </Label>
            <Input
              id="jira-start"
              type="date"
              required
              value={config.start_date ?? ""}
              onChange={(e) => change({ start_date: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              {t("sources.jira.startDateHelp")}
              {!switchingDeployment && t("sources.jira.startDateDefaultHelp")}
            </p>
          </DraftField>
          <DraftField changed={assistant.changed("project_keys")}>
            <Label htmlFor="jira-projects">
              {t("sources.jira.projectKeysLabel")}
            </Label>
            <Input
              id="jira-projects"
              value={(config.project_keys ?? []).join(",")}
              placeholder={t("sources.jira.projectKeysPlaceholder")}
              aria-describedby="jira-projects-help"
              onChange={(e) =>
                change({
                  project_keys: e.target.value
                    .split(/[,，]/)
                    .map((key) => key.trim()),
                })
              }
            />
            <p
              id="jira-projects-help"
              className="text-xs text-muted-foreground"
            >
              {t("sources.jira.projectKeysHelp")}
            </p>
            {projects.length > 0 && (
              <fieldset className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
                <legend className="px-1 text-sm">
                  {t("sources.jira.visibleProjectsLegend")}
                </legend>
                {projects.map((project) => (
                  <label
                    key={project.key}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={(config.project_keys ?? []).some(
                        (key) => key.toUpperCase() === project.key,
                      )}
                      onChange={(e) =>
                        change({
                          project_keys: e.target.checked
                            ? [
                                ...(config.project_keys ?? []).filter(Boolean),
                                project.key,
                              ]
                            : (config.project_keys ?? []).filter(
                                (key) => key.toUpperCase() !== project.key,
                              ),
                        })
                      }
                    />
                    {t("sources.jira.projectOption", {
                      key: project.key,
                      name: project.name,
                    })}
                  </label>
                ))}
              </fieldset>
            )}
          </DraftField>
          <DraftField changed={assistant.changed("sync_schedule")}>
            <Label htmlFor="jira-schedule">
              {t("sources.jira.syncScheduleLabel")}
            </Label>
            <select
              id="jira-schedule"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={displayedSchedule}
              onChange={(e) => {
                const value = e.target.value
                if (
                  value === "off" ||
                  value === "monthly" ||
                  value === "quarterly" ||
                  value === "yearly"
                ) {
                  setSchedule(value)
                  setConfirmedSchedule(undefined)
                  setDirty(true)
                  save.reset()
                }
              }}
            >
              {Object.entries(scheduleLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {t("sources.jira.syncScheduleHelp")}
            </p>
          </DraftField>
          <DraftField changed={assistant.changed("include_description")}>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={config.include_description}
                onChange={(e) =>
                  change({ include_description: e.target.checked })
                }
              />
              <span>
                {t("sources.jira.includeDescLabel")}
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t("sources.jira.includeDescHelp")}
                </span>
              </span>
            </label>
          </DraftField>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          {t("sources.jira.saveBeforeTestHint")}
        </p>
        <p className="text-sm font-medium">
          {t("sources.jira.willSyncPrefix", { scope: willSyncScope })}
        </p>
        {switchingDeployment && (
          <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              required
              checked={switchConfirmed}
              disabled={busy || syncing || assistant.blocked}
              onChange={(e) =>
                setConfirmedSchedule(
                  e.target.checked ? displayedSchedule : undefined,
                )
              }
            />
            <span className="wrap-anywhere">
              {t("sources.jira.switchConfirm", { scope: switchScope })}
            </span>
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saveDisabled}>
            {t("sources.jira.save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || dirty || !hasSecret || assistant.blocked}
            onClick={() => test.mutate()}
          >
            {t("sources.jira.testConnection")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              busy ||
              dirty ||
              !hasSecret ||
              syncing ||
              runs.isPending ||
              runs.isError ||
              assistant.blocked
            }
            onClick={() => sync.mutate()}
          >
            {t("sources.jira.syncNow")}
          </Button>
        </div>
      </form>
      <SetupError
        error={save.error ?? test.error ?? sync.error ?? runs.error}
      />
      {save.isSuccess && <p role="status">{t("sources.jira.saved")}</p>}
      {test.data && (
        <div role={test.data.data.ok ? "status" : "alert"} className="text-sm">
          <p>
            {test.data.data.message}
            {test.data.data.account_name &&
              t("sources.jira.accountNameSuffix", {
                name: test.data.data.account_name,
              })}
          </p>
          {!test.data.data.ok && <p>{t("sources.jira.testFallbackHint")}</p>}
        </div>
      )}
      {savedConfig && (
        <>
          <p className="text-sm text-muted-foreground">
            {t("sources.jira.nextSyncLabel")}
            {connection.next_sync_at
              ? formatDate(connection.next_sync_at, {
                  dateStyle: "short",
                  timeStyle: "medium",
                })
              : t("sources.jira.scheduleOff")}
          </p>
          <LastSyncStatus run={latest} />
        </>
      )}
    </section>
  )
}
