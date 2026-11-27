import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { ModelSettingService, type ModelSettingUpdateWritable } from "@/client"
import { DraftField } from "@/components/AdminAssistant/DraftField"
import { PageDraft } from "@/components/AdminAssistant/PageDraft"
import { usePageDraft } from "@/components/AdminAssistant/usePageDraft"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ChatGptConnect } from "./ChatGptConnect"

const providerKeys = [
  "openai",
  "anthropic",
  "deepseek",
  "qwen",
  "moonshotai",
  "moonshotai-cn",
  "kimi-coding",
  "openrouter",
] as const
const qwenUrls = [
  ["https://dashscope.aliyuncs.com/compatible-mode/v1", "cn"],
  ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "sg"],
  ["https://dashscope-us.aliyuncs.com/compatible-mode/v1", "us"],
] as const

export function ModelSettingForm({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const path = { org_id: orgId }
  const [changes, setChanges] = useState<ModelSettingUpdateWritable | null>(
    null,
  )
  const [apiKey, setApiKey] = useState("")
  const [clearKey, setClearKey] = useState(false)
  const settings = useQuery({
    queryKey: ["model-setting", orgId],
    queryFn: async () =>
      (await ModelSettingService.settingGetModelSetting({ path })).data,
  })
  const save = useMutation({
    mutationFn: (body: ModelSettingUpdateWritable) =>
      ModelSettingService.settingPutModelSetting({ path, body }),
    onSuccess: ({ data }) => {
      client.setQueryData(["model-setting", orgId], data)
      client.invalidateQueries({ queryKey: ["setup", orgId] })
      setChanges(null)
      setApiKey("")
      setClearKey(false)
    },
  })
  const test = useMutation({
    mutationFn: () => ModelSettingService.settingTestModelSetting({ path }),
  })
  const resetManual = useCallback(() => {
    setChanges(null)
    setApiKey("")
    setClearKey(false)
  }, [])
  const pageDraft = usePageDraft(orgId, "update_model_setting", resetManual)
  if (settings.isPending)
    return <p role="status">{t("admin.modelForm.loading")}</p>
  if (settings.isError)
    return (
      <>
        <SetupError error={settings.error} />
        <Button onClick={() => settings.refetch()}>
          {t("admin.common.retry")}
        </Button>
      </>
    )
  const saved = settings.data
  const current: ModelSettingUpdateWritable = pageDraft.values(
    changes ?? {
      enabled: saved.enabled ?? false,
      kind: saved.kind as ModelSettingUpdateWritable["kind"],
      provider: saved.provider,
      model: saved.model,
      base_url: saved.base_url,
      reasoning_effort: saved.reasoning_effort,
    },
  )
  const chatgpt = current.kind === "chatgpt_subscription"
  const changedDestination =
    saved.has_api_key &&
    !chatgpt &&
    (current.kind !== saved.kind ||
      current.provider !== saved.provider ||
      (current.base_url ?? "").replace(/\/$/, "") !==
        (saved.base_url ?? "").replace(/\/$/, ""))
  function change(values: Partial<ModelSettingUpdateWritable>) {
    setChanges({ ...current, ...values })
    save.reset()
    test.reset()
  }
  const selectClass = "h-9 w-full min-w-0 rounded-md border bg-background px-2"
  return (
    <>
      <PageDraft
        orgId={orgId}
        draft={pageDraft.draft}
        error={pageDraft.error}
      />
      <form
        className="max-w-2xl min-w-0 space-y-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate({
            ...current,
            api_key: chatgpt ? null : clearKey ? "" : apiKey || null,
          })
        }}
      >
        <fieldset
          className="min-w-0 space-y-3"
          disabled={pageDraft.blocked || save.isPending}
        >
          <DraftField changed={pageDraft.changed("enabled")}>
            <label className="flex gap-3 items-center">
              <input
                type="checkbox"
                checked={current.enabled}
                onChange={(e) => change({ enabled: e.target.checked })}
              />
              {t("admin.modelForm.enabledLabel")}
            </label>
          </DraftField>
          <p className="text-sm text-muted-foreground">
            {t("admin.modelForm.enabledHint")}
          </p>
          {saved.kind &&
            saved.kind !== "chatgpt_subscription" &&
            !saved.provider && (
              <p role="status">{t("admin.modelForm.reselectProviderNotice")}</p>
            )}
          <DraftField changed={pageDraft.changed("kind")}>
            <label className="block space-y-1">
              <span>{t("admin.modelForm.kindLabel")}</span>
              <select
                className={selectClass}
                value={current.kind ?? ""}
                required={current.enabled}
                onChange={(e) => {
                  const kind = e.target
                    .value as ModelSettingUpdateWritable["kind"]
                  change({
                    kind,
                    provider:
                      kind === "local"
                        ? "ollama"
                        : kind === "openai_compatible"
                          ? "openai-compatible"
                          : null,
                    model:
                      kind === "chatgpt_subscription"
                        ? "chatgpt/gpt-6.1-sol"
                        : "",
                    base_url: null,
                    reasoning_effort:
                      kind === "chatgpt_subscription" ? "high" : null,
                  })
                  setApiKey("")
                  setClearKey(false)
                }}
              >
                <option value="">{t("admin.modelForm.kindPlaceholder")}</option>
                <option value="cloud_api">
                  {t("admin.modelForm.kinds.cloud_api")}
                </option>
                <option value="local">
                  {t("admin.modelForm.kinds.local")}
                </option>
                <option value="openai_compatible">
                  {t("admin.modelForm.kinds.openai_compatible")}
                </option>
                <option value="chatgpt_subscription">
                  {t("admin.modelForm.kinds.chatgpt_subscription")}
                </option>
              </select>
            </label>
          </DraftField>
          <p className="text-sm text-muted-foreground">
            {t("admin.modelForm.billingHint")}
          </p>
          {current.kind && (
            <>
              <DraftField changed={pageDraft.changed("model")}>
                <label htmlFor="model-name" className="block space-y-1">
                  <span>{t("admin.modelForm.modelNameLabel")}</span>
                  <Input
                    id="model-name"
                    required={current.enabled}
                    value={current.model ?? ""}
                    placeholder={
                      chatgpt
                        ? "chatgpt/gpt-6.1-sol"
                        : t("admin.modelForm.modelNamePlaceholder")
                    }
                    onChange={(e) => change({ model: e.target.value })}
                  />
                </label>
              </DraftField>
              <p className="text-sm text-muted-foreground">
                {t("admin.modelForm.testHint")}
              </p>
              {chatgpt && (
                <p className="text-sm text-muted-foreground">
                  {t("admin.modelForm.chatgptPrefixHint")}
                </p>
              )}
              <details className="space-y-2 rounded-md border border-surface-border p-3">
                <summary className="cursor-pointer font-medium">
                  {t("admin.modelForm.reasoningSummary")}
                </summary>
                <DraftField changed={pageDraft.changed("reasoning_effort")}>
                  <label className="block space-y-1">
                    <span>{t("admin.modelForm.reasoningLabel")}</span>
                    <select
                      className={selectClass}
                      value={current.reasoning_effort ?? "off"}
                      onChange={(e) =>
                        change({
                          reasoning_effort: e.target
                            .value as ModelSettingUpdateWritable["reasoning_effort"],
                        })
                      }
                    >
                      {(
                        [
                          "off",
                          "minimal",
                          "low",
                          "medium",
                          "high",
                          "xhigh",
                        ] as const
                      ).map((v) => (
                        <option key={v} value={v}>
                          {t(`admin.modelForm.reasoningOptions.${v}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </DraftField>
                <p className="text-sm text-muted-foreground">
                  {t("admin.modelForm.reasoningHint")}
                </p>
              </details>
              {!chatgpt && (
                <>
                  {current.kind === "cloud_api" && (
                    <>
                      <DraftField changed={pageDraft.changed("provider")}>
                        <label className="block space-y-1">
                          <span>{t("admin.modelForm.providerLabel")}</span>
                          <select
                            aria-label={t("admin.modelForm.providerLabel")}
                            className={selectClass}
                            required={current.enabled}
                            value={current.provider ?? ""}
                            onChange={(e) => {
                              const provider = e.target
                                .value as ModelSettingUpdateWritable["provider"]
                              change({
                                provider,
                                base_url:
                                  provider === "qwen" ? qwenUrls[0][0] : null,
                              })
                              setApiKey("")
                            }}
                          >
                            <option value="">
                              {t("admin.modelForm.providerPlaceholder")}
                            </option>
                            {providerKeys.map((value) => (
                              <option key={value} value={value}>
                                {t(`admin.modelForm.providers.${value}`)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </DraftField>
                      <p className="text-sm text-muted-foreground">
                        {t("admin.modelForm.providerKeyHint")}
                      </p>
                      <p className="text-sm">
                        {t("admin.modelForm.claudeNote")}
                      </p>
                      {current.provider === "qwen" && (
                        <DraftField changed={pageDraft.changed("base_url")}>
                          <label className="block space-y-1">
                            <span>{t("admin.modelForm.qwenRegionLabel")}</span>
                            <select
                              className={selectClass}
                              value={current.base_url ?? qwenUrls[0][0]}
                              onChange={(e) =>
                                change({ base_url: e.target.value })
                              }
                            >
                              {qwenUrls.map(([url, regionKey]) => (
                                <option key={url} value={url}>
                                  {t(
                                    `admin.modelForm.qwenRegions.${regionKey}`,
                                  )}
                                </option>
                              ))}
                            </select>
                          </label>
                        </DraftField>
                      )}
                    </>
                  )}
                  {current.kind !== "cloud_api" && (
                    <DraftField changed={pageDraft.changed("base_url")}>
                      <label htmlFor="model-url" className="block space-y-1">
                        <span>
                          base URL
                          {current.kind === "openai_compatible"
                            ? t("admin.modelForm.baseUrlHintOpenai")
                            : t("admin.modelForm.baseUrlHintLocal")}
                        </span>
                        <Input
                          id="model-url"
                          type="url"
                          required={current.enabled}
                          value={current.base_url ?? ""}
                          onChange={(e) =>
                            change({ base_url: e.target.value || null })
                          }
                        />
                      </label>
                    </DraftField>
                  )}
                  {current.kind !== "cloud_api" && (
                    <p className="text-sm text-muted-foreground">
                      {t("admin.modelForm.baseUrlHelp")}
                    </p>
                  )}
                  <label htmlFor="model-key" className="block space-y-1">
                    <span>
                      {t("admin.modelForm.apiKeyLabel")}
                      {current.kind !== "cloud_api" &&
                        t("admin.modelForm.optionalSuffix")}
                    </span>
                    <Input
                      id="model-key"
                      type="password"
                      autoComplete="new-password"
                      required={
                        !clearKey &&
                        (changedDestination ||
                          (current.enabled &&
                            current.kind === "cloud_api" &&
                            !saved.has_api_key))
                      }
                      value={apiKey}
                      placeholder={
                        saved.has_api_key && !clearKey
                          ? t("admin.modelForm.apiKeySavedPlaceholder")
                          : t("admin.modelForm.apiKeyEmptyPlaceholder")
                      }
                      onChange={(e) => {
                        setApiKey(e.target.value)
                        save.reset()
                      }}
                    />
                  </label>
                  <p className="text-sm text-muted-foreground">
                    {t("admin.modelForm.apiKeyHelp")}
                  </p>
                  {changedDestination && (
                    <p role="status">{t("admin.modelForm.reenterKeyNotice")}</p>
                  )}
                  {saved.has_api_key && (
                    <div className="space-y-2">
                      <label className="flex gap-2">
                        <input
                          type="checkbox"
                          checked={clearKey}
                          onChange={(e) => setClearKey(e.target.checked)}
                        />
                        {t("admin.modelForm.clearKeyLabel")}
                      </label>
                      <p className="text-sm text-muted-foreground">
                        {t("admin.modelForm.clearKeyHelp")}
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <p className="text-sm text-muted-foreground">
            {t("admin.modelForm.privacyNote")}
          </p>
          <SetupError error={save.error ?? test.error} />
          {save.isSuccess && <p role="status">{t("admin.modelForm.saved")}</p>}
          {test.data && (
            <p role={test.data.data.ok ? "status" : "alert"}>
              {test.data.data.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={save.isPending}>
              {t("admin.common.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                save.isPending ||
                test.isPending ||
                !!changes ||
                !!apiKey ||
                clearKey ||
                !saved.enabled
              }
              onClick={() => test.mutate()}
            >
              {t("admin.modelForm.testConnection")}
            </Button>
          </div>
        </fieldset>
        {chatgpt && <ChatGptConnect orgId={orgId} />}
      </form>
    </>
  )
}
