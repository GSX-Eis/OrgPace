import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AccessTokensService, ProfileImportService } from "@/client"
import { SectionCard } from "@/components/Common/WorkbenchPrimitives"
import { OrgState } from "@/components/Profile/OrgState"
import { ProfileError, ProfileLoading } from "@/components/Profile/QueryState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useOrg } from "@/hooks/useOrg"
import { formatDate } from "@/i18n/format"
import { handleError } from "@/utils"
import { AuthorizedClients } from "./AuthorizedClients"

export function AiConnections() {
  const { org, employeeId } = useOrg()
  if (!org) return <OrgState />
  return <Tokens key={org.id} orgId={org.id} hasEmployee={!!employeeId} />
}

function Tokens({
  orgId,
  hasEmployee,
}: {
  orgId: string
  hasEmployee: boolean
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [name, setName] = useState("")
  const [secret, setSecret] = useState("")
  const [message, setMessage] = useState("")
  const [configFeedback, setConfigFeedback] = useState("")
  const path = { org_id: orgId }
  const tokens = useQuery({
    queryKey: ["access-tokens", orgId],
    queryFn: async () =>
      (await AccessTokensService.readAccessTokens({ path })).data,
  })
  const setting = useQuery({
    queryKey: ["mcp-setting", orgId],
    queryFn: async () =>
      (await AccessTokensService.readMcpSetting({ path })).data,
  })
  const create = useMutation({
    mutationFn: async () => {
      const { data } = await AccessTokensService.createAccessToken({
        path,
        body: { name },
      })
      setSecret(data.token)
    },
    onSuccess: () => {
      setName("")
      setMessage("")
      client.invalidateQueries({ queryKey: ["access-tokens", orgId] })
    },
    onError: handleError.bind(setMessage),
  })
  const downloadSkill = useMutation({
    mutationFn: async () => {
      const { data } = await ProfileImportService.importDownloadImportFile({
        path: { name: "skill" },
        responseType: "blob",
      })
      if (!(data instanceof Blob))
        throw new Error(t("settings.ai.downloadFailed"))
      const url = URL.createObjectURL(data)
      const link = document.createElement("a")
      link.href = url
      link.download = "SKILL.md"
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    onError: handleError.bind(setMessage),
  })
  const revoke = useMutation({
    mutationFn: (id: string) =>
      AccessTokensService.revokeAccessToken({
        path: { ...path, token_id: id },
      }),
    onSuccess: () => {
      setSecret("")
      setMessage(t("settings.ai.tokenRevoked"))
      client.invalidateQueries({ queryKey: ["access-tokens", orgId] })
    },
    onError: handleError.bind(setMessage),
  })
  const config = JSON.stringify(
    {
      mcpServers: {
        employeeProfile: {
          url: `${window.location.origin}/mcp`,
          headers: {
            Authorization: `Bearer ${secret || t("settings.ai.tokenPlaceholder")}`,
          },
        },
      },
    },
    null,
    2,
  )
  async function copy(text: string, setFeedback = setMessage) {
    try {
      await navigator.clipboard.writeText(text)
      setFeedback(t("common.status.copied"))
    } catch {
      setFeedback(t("settings.ai.copyFailedSelect"))
    }
  }
  if (tokens.isPending || setting.isPending) return <ProfileLoading />
  if (tokens.isError || setting.isError)
    return (
      <ProfileError
        retry={() => {
          tokens.refetch()
          setting.refetch()
        }}
      />
    )
  return (
    <SectionCard className="divide-y overflow-hidden p-0 text-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-4 py-2.5">
        <h2 className="font-semibold">{t("settings.ai.title")}</h2>
        <Dialog
          onOpenChange={(open) => {
            if (open) setConfigFeedback("")
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="ml-auto">
              {t("settings.ai.viewMcpConfig")}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t("settings.ai.mcpDialogTitle")}</DialogTitle>
              <DialogDescription>
                {t("settings.ai.mcpDialogDesc")}
              </DialogDescription>
            </DialogHeader>
            <pre
              className="min-w-0 overflow-x-auto rounded-md bg-muted p-3 text-xs"
              data-testid="cursor-config"
            >
              {config}
            </pre>
            {window.location.protocol === "http:" && (
              <p className="text-sm text-muted-foreground">
                {t("settings.ai.httpWarning")}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-3">
              {configFeedback && (
                <p role="status" className="text-sm">
                  {configFeedback}
                </p>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => copy(config, setConfigFeedback)}
              >
                {t("settings.ai.copyConfig")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </header>
      {hasEmployee && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
          <p className="text-xs text-muted-foreground">
            {t("settings.ai.skillHint")}
          </p>
          <a
            href="/api/v1/profile-import/files/skill"
            className="ml-auto text-primary underline"
            onClick={(event) => {
              event.preventDefault()
              downloadSkill.mutate()
            }}
          >
            {t("settings.ai.downloadSkill")}
          </a>
        </div>
      )}
      {!setting.data.enabled && (
        <p className="bg-muted/30 px-4 py-2.5 text-muted-foreground">
          {t("settings.ai.orgDisabled")}
        </p>
      )}
      {!hasEmployee && (
        <p className="px-4 py-2.5 text-muted-foreground">
          {t("settings.ai.noEmployee")}
        </p>
      )}
      <AuthorizedClients orgId={orgId} />
      <section
        aria-label={t("settings.ai.personalTokenHeading")}
        className="space-y-2 px-4 py-2.5"
      >
        <h3 className="font-medium">{t("settings.ai.personalTokenHeading")}</h3>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>{t("settings.ai.bullet1")}</li>
          <li>{t("settings.ai.bullet2")}</li>
          <li>{t("settings.ai.bullet3")}</li>
          <li>
            {t("settings.ai.bullet4Lead")}
            <strong>{t("settings.ai.bullet4Strong")}</strong>
            {t("settings.ai.bullet4Tail")}
          </li>
          <li>{t("settings.ai.bullet5")}</li>
        </ul>
        <p className="text-muted-foreground">
          {t("settings.ai.tokenScopeNote")}
        </p>
      </section>
      <form
        className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
        onSubmit={(event) => {
          event.preventDefault()
          setSecret("")
          create.mutate()
        }}
      >
        <div>
          <label htmlFor="token-name" className="font-medium">
            {t("settings.ai.tokenNameLabel")}
          </label>
          <p id="token-hint" className="text-xs text-muted-foreground">
            {t("settings.ai.tokenNameHint")}
          </p>
        </div>
        <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
          <Input
            id="token-name"
            className="h-8 min-w-0 flex-1 sm:w-44"
            aria-describedby="token-hint"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            required
            placeholder={t("settings.ai.tokenNamePlaceholder")}
          />
          <Button
            size="sm"
            disabled={
              !setting.data.enabled ||
              !hasEmployee ||
              !name.trim() ||
              create.isPending
            }
          >
            {t("settings.ai.createToken")}
          </Button>
        </div>
      </form>
      {secret && (
        <section
          className="space-y-2 bg-muted/30 px-4 py-3"
          aria-label={t("settings.ai.newTokenAria")}
        >
          <h3 className="font-semibold">{t("settings.ai.newTokenTitle")}</h3>
          <code className="block break-all" data-testid="new-token">
            {secret}
          </code>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => copy(secret)}>
              {t("settings.ai.copyToken")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSecret("")}>
              {t("settings.ai.hideToken")}
            </Button>
          </div>
        </section>
      )}
      <section className="divide-y" aria-label={t("settings.ai.myTokensAria")}>
        {tokens.data.length === 0 && (
          <p className="px-4 py-2.5 text-muted-foreground">
            {t("settings.ai.noTokens")}
          </p>
        )}
        {tokens.data.map((token) => (
          <fieldset
            key={token.id}
            aria-label={token.name}
            className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="min-w-0 wrap-anywhere font-medium">
                  {token.name}
                </p>
                <code className="text-xs text-muted-foreground">
                  {token.prefix}…
                </code>
                <Badge variant="outline">
                  {token.revoked_at
                    ? t("settings.ai.statusRevoked")
                    : Date.parse(token.expires_at) <= Date.now()
                      ? t("settings.ai.statusExpired")
                      : t("settings.ai.statusActive")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.ai.tokenMeta", {
                  expiresAt: formatDate(token.expires_at),
                  lastUsed: token.last_used_at
                    ? formatDate(token.last_used_at, {
                        dateStyle: "short",
                        timeStyle: "medium",
                      })
                    : t("settings.ai.neverUsed"),
                })}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={!!token.revoked_at || revoke.isPending}
              onClick={() => revoke.mutate(token.id)}
            >
              {t("settings.ai.revoke")}
            </Button>
          </fieldset>
        ))}
      </section>
      {message && (
        <p role="status" className="px-4 py-2.5">
          {message}
        </p>
      )}
    </SectionCard>
  )
}
