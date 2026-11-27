import { deepEqual, equal } from "node:assert/strict"
import { test } from "node:test"
import { QueryObserver } from "@tanstack/react-query"
import type { CasePublic } from "../client"
import { loadPlanningCase } from "../components/Capacity/Plans"
import { createLocaleQueryClient } from "./localeQuerySync"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  }
}

function makePlanCase({
  id,
  snapshotId = `snap-${id}`,
  demandId = "demand-1",
  stale = false,
  summary,
  allowElastic = false,
}: {
  id: string
  snapshotId?: string
  demandId?: string
  stale?: boolean
  summary: string
  allowElastic?: boolean
}): CasePublic {
  return {
    id,
    demand_id: demandId,
    snapshot_id: snapshotId,
    snapshot_created_at: "2026-11-27T00:00:00Z",
    stale,
    notes: [],
    people: [],
    data: { rules: { allow_elastic: allowElastic } },
    options: [
      {
        id: `opt-${id}`,
        snapshot_id: snapshotId,
        kind: "direct",
        params: {},
        verdict: "feasible",
        findings: [],
        summary: {},
        created_at: "2026-11-27T00:00:00Z",
        kind_label: summary,
        verdict_label: summary,
      },
    ],
  }
}

test("refreshForLocaleChange cancels pending initial read queries so stale responses cannot overwrite new locale", async () => {
  let locale = "zh-CN"
  const first = deferred<{ summary: string }>()
  const second = deferred<{ summary: string }>()
  const seenLocales: string[] = []
  const { queryClient, refreshForLocaleChange } = createLocaleQueryClient(
    () => {},
  )

  const observer = new QueryObserver(queryClient, {
    queryKey: ["admin-overview", "org-1"],
    queryFn: async () => {
      seenLocales.push(locale)
      return locale === "zh-CN" ? first.promise : second.promise
    },
  })
  const unsubscribe = observer.subscribe(() => {})

  // First zh-CN request is in flight with no cached data yet.
  await Promise.resolve()
  deepEqual(seenLocales, ["zh-CN"])
  equal(queryClient.getQueryData(["admin-overview", "org-1"]), undefined)

  // Switch to en before the initial request resolves.
  locale = "en"
  refreshForLocaleChange()
  await Promise.resolve()
  deepEqual(seenLocales, ["zh-CN", "en"])

  // Resolve the new en request first, then let the delayed zh-CN request arrive later.
  second.resolve({ summary: "Not enabled" })
  await new Promise((r) => setTimeout(r, 10))
  deepEqual(queryClient.getQueryData(["admin-overview", "org-1"]), {
    summary: "Not enabled",
  })

  first.resolve({ summary: "尚未开启" })
  await new Promise((r) => setTimeout(r, 10))
  deepEqual(queryClient.getQueryData(["admin-overview", "org-1"]), {
    summary: "Not enabled",
  })

  unsubscribe()
  queryClient.clear()
})

test("refreshForLocaleChange waits for in-flight initial planning load instead of duplicating snapshot creation, and skips currentUser", async () => {
  let locale = "zh-CN"
  let createCalls = 0
  let getCalls = 0
  let userCalls = 0
  const storageKey = "planning-case:org-1:demand-1"
  const storage = memoryStorage()
  const createGate = deferred<CasePublic>()
  const { queryClient, refreshForLocaleChange } = createLocaleQueryClient(
    () => {},
  )

  const planObserver = new QueryObserver(queryClient, {
    queryKey: ["capacity", "org-1", "planning", "demand-1", ""],
    queryFn: ({ client, queryKey }) =>
      loadPlanningCase({
        demandId: "demand-1",
        hash: "",
        change: false,
        storageKey,
        storage,
        queryClient: client,
        queryKey,
        api: {
          getCase: async (caseId) => {
            getCalls += 1
            return makePlanCase({
              id: caseId,
              summary: locale === "en" ? "Regular Plan" : "常规方案",
            })
          },
          createCase: async () => {
            createCalls += 1
            const created = await createGate.promise
            storage.setItem(storageKey, created.id)
            return created
          },
        },
      }),
  })
  const userObserver = new QueryObserver(queryClient, {
    queryKey: ["currentUser"],
    queryFn: async () => {
      userCalls += 1
      return { preferred_locale: "zh-CN" }
    },
  })
  const unsubPlan = planObserver.subscribe(() => {})
  const unsubUser = userObserver.subscribe(() => {})

  await Promise.resolve()
  equal(createCalls, 1)
  equal(userCalls, 1)

  // Switch locale while initial POST createCase is still pending.
  locale = "en"
  refreshForLocaleChange()
  await Promise.resolve()
  equal(createCalls, 1)
  equal(getCalls, 0)
  equal(userCalls, 1)

  // Once createCase finishes and persists caseId, QueryCache.onSuccess triggers read-only GET in en.
  createGate.resolve(makePlanCase({ id: "case-1", summary: "常规方案" }))
  await new Promise((r) => setTimeout(r, 20))
  equal(createCalls, 1)
  equal(getCalls, 1)
  equal(userCalls, 1)
  equal(
    queryClient.getQueryData<CasePublic>([
      "capacity",
      "org-1",
      "planning",
      "demand-1",
      "",
    ])?.options[0]?.kind_label,
    "Regular Plan",
  )

  unsubPlan()
  unsubUser()
  queryClient.clear()
})

test("refreshForLocaleChange on idle cached replan page stays read-only even when backend reports stale, preserving snapshot_id", async () => {
  let locale = "zh-CN"
  let serverStale = false
  let createCalls = 0
  const readLog: Array<{ caseId: string; locale: string }> = []
  const storageKey = "planning-case:org-1:demand-1"
  const storage = memoryStorage({ [storageKey]: "case-1" })
  const key = ["capacity", "org-1", "planning", "demand-1", ""] as const
  const { queryClient, refreshForLocaleChange } = createLocaleQueryClient(
    () => {},
  )

  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    queryFn: ({ client, queryKey }) =>
      loadPlanningCase({
        demandId: "demand-1",
        hash: "",
        change: true,
        storageKey,
        storage,
        queryClient: client,
        queryKey,
        api: {
          getCase: async (caseId) => {
            readLog.push({ caseId, locale })
            return makePlanCase({
              id: caseId,
              snapshotId: `snap-${caseId}`,
              stale: serverStale,
              summary: locale === "en" ? "Opened Plan" : "已打开方案",
            })
          },
          createCase: async () => {
            createCalls += 1
            const created = makePlanCase({
              id: "case-recreated",
              snapshotId: "snap-recreated",
              stale: false,
              summary: locale === "en" ? "New Snapshot" : "新建快照",
            })
            storage.setItem(storageKey, created.id)
            return created
          },
        },
      }),
  })
  const unsubscribe = observer.subscribe(() => {})
  await new Promise((r) => setTimeout(r, 15))
  equal(createCalls, 0)
  deepEqual(readLog, [{ caseId: "case-1", locale: "zh-CN" }])

  // Background inputs change so backend now marks snap-case-1 stale, while query is idle.
  serverStale = true
  locale = "en"
  refreshForLocaleChange()
  await new Promise((r) => setTimeout(r, 20))

  // Language switch must only GET in en, keep original snapshot_id, and surface stale=true.
  equal(createCalls, 0)
  deepEqual(readLog, [
    { caseId: "case-1", locale: "zh-CN" },
    { caseId: "case-1", locale: "en" },
  ])
  const afterSwitch = queryClient.getQueryData<CasePublic>(key)
  equal(afterSwitch?.id, "case-1")
  equal(afterSwitch?.snapshot_id, "snap-case-1")
  equal(afterSwitch?.stale, true)
  equal(afterSwitch?.options[0]?.kind_label, "Opened Plan")

  // Normal business invalidation afterwards (not a locale switch) can still recreate when stale.
  await queryClient.invalidateQueries({ queryKey: key, exact: true })
  await new Promise((r) => setTimeout(r, 20))
  equal(createCalls, 1)
  equal(
    queryClient.getQueryData<CasePublic>(key)?.snapshot_id,
    "snap-recreated",
  )

  unsubscribe()
  queryClient.clear()
})

test("refreshForLocaleChange waits for in-flight cached stale replan creation without replaying POST, then reads same snapshot_id in new locale", async () => {
  let locale = "zh-CN"
  let createCalls = 0
  const readLog: Array<{ caseId: string; locale: string }> = []
  const storageKey = "planning-case:org-1:demand-1"
  const storage = memoryStorage({ [storageKey]: "case-old" })
  const createGate = deferred<CasePublic>()
  const key = ["capacity", "org-1", "planning", "demand-1", ""] as const
  const { queryClient, refreshForLocaleChange } = createLocaleQueryClient(
    () => {},
  )

  // Pre-fill cached snapshot (non-undefined data), matching cached replan state.
  queryClient.setQueryData(
    key,
    makePlanCase({ id: "case-old", stale: true, summary: "旧快照" }),
  )

  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    queryFn: ({ client, queryKey }) =>
      loadPlanningCase({
        demandId: "demand-1",
        hash: "",
        change: true,
        storageKey,
        storage,
        queryClient: client,
        queryKey,
        api: {
          getCase: async (caseId) => {
            readLog.push({ caseId, locale })
            if (caseId === "case-old") {
              return makePlanCase({
                id: "case-old",
                stale: true,
                summary: "过期旧快照",
              })
            }
            return makePlanCase({
              id: caseId,
              snapshotId: "snap-case-new",
              stale: false,
              summary: locale === "en" ? "Replanned Option" : "改排新方案",
            })
          },
          createCase: async () => {
            createCalls += 1
            const created = await createGate.promise
            storage.setItem(storageKey, created.id)
            return created
          },
        },
      }),
  })

  // Subscribing with default staleTime=0 triggers a cached refetch that reads the stale snapshot and starts createCase(false).
  const unsubscribe = observer.subscribe(() => {})
  await new Promise((r) => setTimeout(r, 10))
  equal(createCalls, 1)
  deepEqual(readLog, [{ caseId: "case-old", locale: "zh-CN" }])

  // Switch language while POST createCase is still pending and cache already holds prior data.
  locale = "en"
  refreshForLocaleChange()
  await new Promise((r) => setTimeout(r, 10))
  equal(createCalls, 1)
  deepEqual(readLog, [{ caseId: "case-old", locale: "zh-CN" }])

  // Complete the original POST; onSuccess refreshes via read-only GET in the new locale without another POST.
  createGate.resolve(makePlanCase({ id: "case-new", summary: "改排新方案" }))
  await new Promise((r) => setTimeout(r, 20))

  equal(createCalls, 1)
  deepEqual(readLog, [
    { caseId: "case-old", locale: "zh-CN" },
    { caseId: "case-new", locale: "en" },
  ])
  equal(storage.getItem(storageKey), "case-new")
  const finalCase = queryClient.getQueryData<CasePublic>(key)
  equal(finalCase?.id, "case-new")
  equal(finalCase?.snapshot_id, "snap-case-new")
  equal(finalCase?.stale, false)
  equal(finalCase?.options[0]?.kind_label, "Replanned Option")

  unsubscribe()
  queryClient.clear()
})

test("explicit elastic recalculation creates a new snapshot and subsequent locale switch only reads it", async () => {
  let locale = "zh-CN"
  let createCalls = 0
  const createdElasticFlags: boolean[] = []
  const readLog: Array<{ caseId: string; locale: string }> = []
  const storageKey = "planning-case:org-1:demand-1"
  const storage = memoryStorage({ [storageKey]: "case-1" })
  const key = ["capacity", "org-1", "planning", "demand-1", ""] as const
  const { queryClient, refreshForLocaleChange } = createLocaleQueryClient(
    () => {},
  )

  const api = {
    getCase: async (caseId: string) => {
      readLog.push({ caseId, locale })
      return makePlanCase({
        id: caseId,
        allowElastic: caseId === "case-elastic",
        summary: locale === "en" ? "Elastic Plan" : "弹性方案",
      })
    },
    createCase: async (elastic: boolean) => {
      createCalls += 1
      createdElasticFlags.push(elastic)
      const created = makePlanCase({
        id: elastic ? "case-elastic" : "case-regular",
        allowElastic: elastic,
        summary: "弹性方案",
      })
      storage.setItem(storageKey, created.id)
      return created
    },
  }

  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    queryFn: ({ client, queryKey }) =>
      loadPlanningCase({
        demandId: "demand-1",
        hash: "",
        change: true,
        storageKey,
        storage,
        queryClient: client,
        queryKey,
        api,
      }),
  })
  const unsubscribe = observer.subscribe(() => {})
  await new Promise((r) => setTimeout(r, 10))
  equal(createCalls, 0)
  deepEqual(readLog, [{ caseId: "case-1", locale: "zh-CN" }])

  // Simulate explicit resimulate mutation (allowElastic = true) updating cache + refetching.
  const elasticCase = await api.createCase(true)
  queryClient.setQueryData(key, elasticCase)
  await queryClient.invalidateQueries({ queryKey: key, exact: true })
  await new Promise((r) => setTimeout(r, 10))
  equal(createCalls, 1)
  deepEqual(createdElasticFlags, [true])

  // Switching locale afterwards only reads the newly simulated elastic snapshot.
  locale = "en"
  refreshForLocaleChange()
  await new Promise((r) => setTimeout(r, 10))
  equal(createCalls, 1)
  deepEqual(readLog, [
    { caseId: "case-1", locale: "zh-CN" },
    { caseId: "case-elastic", locale: "zh-CN" },
    { caseId: "case-elastic", locale: "en" },
  ])
  equal(
    queryClient.getQueryData<CasePublic>(key)?.options[0]?.kind_label,
    "Elastic Plan",
  )

  unsubscribe()
  queryClient.clear()
})
