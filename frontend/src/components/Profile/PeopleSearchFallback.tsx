import { hashKey, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CapabilitiesService,
  OrgsService,
  PeopleSearchService,
  type peopleSearchSearchPeopleData,
} from "@/client"
import { timezoneLabel } from "@/components/Admin/OrganizationTimezoneSettings"
import { SetupError } from "@/components/Setup/SetupError"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { record } from "./fields"
import { LevelBadge } from "./LevelBadge"
import { labels } from "./labels"
import { StatusBadge } from "./StatusBadge"

type Filters = peopleSearchSearchPeopleData["query"]

const statuses = ["confirmed", "tentative", "disputed"] as const
const pageSize = 50

export function PeopleSearchFallback({
  orgId,
  timezone,
  initiallyOpen,
  isOrgAdmin,
  managedDepartmentIds,
}: {
  orgId: string
  timezone: string
  initiallyOpen: boolean
  isOrgAdmin: boolean
  managedDepartmentIds: string[]
}) {
  const { t } = useTranslation()
  const [filters, setFilters] = useState<Filters>({ capability_key: "" })
  const [query, setQuery] = useState<Filters>()
  const path = { org_id: orgId }
  const capabilities = useQuery({
    queryKey: ["capabilities", orgId],
    queryFn: async () =>
      (await CapabilitiesService.readCapabilities({ path })).data,
  })
  const departments = useQuery({
    queryKey: ["departments", orgId],
    queryFn: async () => (await OrgsService.readDepartments({ path })).data,
  })
  const results = useQuery({
    queryKey: [
      "people-search",
      orgId,
      isOrgAdmin ? "org_admin" : managedDepartmentIds,
      query,
    ],
    queryFn: async () =>
      (await PeopleSearchService.searchSearchPeople({ path, query: query! }))
        .data,
    enabled: !!query,
  })
  const rubric = capabilities.data?.data.find(
    (capability) => capability.key === filters.capability_key,
  )?.level_rubric
  const levels =
    record(rubric) && Array.isArray(rubric.levels)
      ? rubric.levels.filter(record)
      : []
  const departmentOptions = departments.data?.data.filter(
    ({ id }) => isOrgAdmin || managedDepartmentIds.includes(id),
  )
  const fields = [
    {
      key: "capability_key",
      label: t("people.findPeople.capabilityRequired"),
      options: capabilities.data?.data.map(({ key, name }) => ({
        key,
        label: name,
      })),
    },
    {
      key: "minimum_level",
      label: t("people.findPeople.minimumLevel"),
      options: levels.map(({ key, label }) => ({
        key: String(key),
        label: String(label || key),
      })),
    },
    {
      key: "department_id",
      label: t("people.findPeople.departmentWithChildren"),
      options: departmentOptions?.map(({ id, name }) => ({
        key: id,
        label: name,
      })),
    },
    {
      key: "statuses",
      label: t("people.findPeople.assessmentStatus"),
      options: statuses.map((key) => ({
        key,
        label: labels.assessment_status[key].label,
      })),
    },
  ] as const
  const timeZone = results.data?.timezone ?? timezone
  const skip = query?.skip ?? 0
  const error = capabilities.error || departments.error || results.error
  const headers = [
    t("people.findPeople.headers.name"),
    t("people.findPeople.headers.department"),
    t("people.findPeople.headers.capability"),
    t("people.findPeople.headers.level"),
    t("people.findPeople.headers.status"),
    t("people.findPeople.headers.statement"),
    t("people.findPeople.headers.evidenceCount"),
    t("people.findPeople.headers.latestEvidenceDate"),
  ]

  return (
    <details
      open={initiallyOpen}
      className="max-h-[60%] shrink-0 overflow-y-auto border-b bg-muted/20 px-4 py-3 md:px-6"
    >
      <summary className="cursor-pointer text-sm font-semibold">
        {t("people.findPeople.summary")}
      </summary>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("people.findPeople.fallbackNotice")}
      </p>
      <form
        aria-label={t("people.findPeople.formAria")}
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          const search = { ...filters, skip: 0, limit: pageSize }
          if (hashKey([search]) === hashKey([query])) void results.refetch()
          else setQuery(search)
        }}
      >
        {fields.map(({ key, label, options }) => (
          <div key={key} className="min-w-36 flex-1 space-y-1">
            <label
              htmlFor={`people-search-${key}`}
              className="text-xs font-medium"
            >
              {label}
            </label>
            <select
              id={`people-search-${key}`}
              className="block h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50"
              value={
                (key === "statuses" ? filters.statuses?.[0] : filters[key]) ??
                ""
              }
              required={key === "capability_key"}
              disabled={key === "minimum_level" && levels.length === 0}
              onChange={(event) => {
                const value = event.target.value
                if (key === "statuses") {
                  setFilters({
                    ...filters,
                    statuses: statuses.filter((status) => status === value),
                  })
                } else if (key === "capability_key") {
                  setFilters({
                    ...filters,
                    capability_key: value,
                    minimum_level: undefined,
                  })
                } else {
                  setFilters({
                    ...filters,
                    [key]: value || undefined,
                  })
                }
              }}
            >
              <option value="">
                {key === "capability_key"
                  ? t("people.findPeople.selectCapability")
                  : t("people.findPeople.any")}
              </option>
              {options?.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ))}
        <fieldset className="flex flex-wrap gap-3">
          <legend className="text-xs text-muted-foreground">
            {t("people.findPeople.orgTimezonePrefix", {
              timezone: timezoneLabel(timeZone),
            })}
          </legend>
          {(
            [
              ["evidence_from", t("people.findPeople.evidenceFrom")],
              ["evidence_to", t("people.findPeople.evidenceTo")],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="space-y-1">
              <label
                htmlFor={`people-search-${key}`}
                className="text-xs font-medium"
              >
                {label}
              </label>
              <Input
                id={`people-search-${key}`}
                type="date"
                value={filters[key] ?? ""}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    [key]: event.target.value || undefined,
                  })
                }
              />
            </div>
          ))}
        </fieldset>
        <Button
          type="submit"
          disabled={!filters.capability_key || results.isFetching}
        >
          {t("people.findPeople.search")}
        </Button>
      </form>
      {error && (
        <div className="mt-3 space-y-2">
          <SetupError error={error} />
          <Button
            variant="outline"
            onClick={() => {
              if (capabilities.isError) void capabilities.refetch()
              if (departments.isError) void departments.refetch()
              if (results.isError) void results.refetch()
            }}
          >
            {t("people.findPeople.retry")}
          </Button>
        </div>
      )}
      {results.isFetching && (
        <p role="status" className="mt-3 text-sm">
          {t("people.findPeople.searching")}
        </p>
      )}
      {results.data && (
        <section
          aria-label={t("people.findPeople.resultsAria")}
          className="mt-3 space-y-2"
        >
          <p role="status" className="text-sm text-muted-foreground">
            {t("people.findPeople.foundCount", { count: results.data.count })}
          </p>
          {results.data.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("people.findPeople.emptyHint")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {headers.map((label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.data.data.map((row) => (
                  <TableRow key={row.employee_id}>
                    <TableCell>
                      <Link
                        className="font-medium text-primary underline-offset-4 hover:underline"
                        to="/employees/$employeeId"
                        params={{ employeeId: row.employee_id }}
                      >
                        {row.display_name}
                      </Link>
                    </TableCell>
                    <TableCell>{row.department_name || "—"}</TableCell>
                    <TableCell>{row.capability_name}</TableCell>
                    <TableCell>
                      <LevelBadge
                        rubric={
                          capabilities.data?.data.find(
                            (capability) =>
                              capability.key === row.capability_key,
                          )?.level_rubric
                        }
                        level={row.level}
                        fallbackLabel={row.level_name}
                      />
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        kind="assessment_status"
                        value={row.status}
                      />
                    </TableCell>
                    <TableCell className="min-w-48 whitespace-normal">
                      {row.statement}
                    </TableCell>
                    <TableCell>{row.evidence_count}</TableCell>
                    <TableCell>{row.latest_evidence_date ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {query && results.data.count > pageSize && (
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={skip === 0}
                onClick={() => setQuery({ ...query, skip: skip - pageSize })}
              >
                {t("people.findPeople.prevPage")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={skip + pageSize >= results.data.count}
                onClick={() => setQuery({ ...query, skip: skip + pageSize })}
              >
                {t("people.findPeople.nextPage")}
              </Button>
            </div>
          )}
        </section>
      )}
    </details>
  )
}
