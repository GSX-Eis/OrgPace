import { deepEqual, equal, ok, throws } from "node:assert/strict"
import { readdirSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import {
  isTagOnlySpec,
  listEligibleSpecs,
  selectPlaywrightShard,
} from "./select-playwright-shard.mjs"

test("isTagOnlySpec excludes pure @real-jira/@external-mcp and keeps mixed", () => {
  equal(isTagOnlySpec('test("syncs @real-jira", async () => {})'), true)
  equal(isTagOnlySpec('test("oauth @external-mcp", async () => {})'), true)
  equal(
    isTagOnlySpec('test("a", () => {})\ntest("b @external-mcp", () => {})'),
    false,
  )
  equal(isTagOnlySpec(`test(\`case\${"$"}{tag}\`, () => {})`), false)
})

test("selectPlaywrightShard partitions eligible specs deterministically and evenly", () => {
  const dir = path.resolve(import.meta.dirname, "../tests")
  const all = readdirSync(dir)
    .filter((n) => n.endsWith(".spec.ts"))
    .map((n) => `tests/${n}`)
    .sort()
  const eligible = listEligibleSpecs(dir)
  const shards = [1, 2, 3].map((s) => selectPlaywrightShard(s, 3, eligible))
  deepEqual(
    shards,
    [1, 2, 3].map((s) => selectPlaywrightShard(s, 3, eligible)),
  )
  const union = shards.flat().sort()
  deepEqual(union, eligible.map((x) => x.file).sort())
  equal(new Set(union).size, eligible.length)
  for (const f of [
    "tests/m2-real-jira.spec.ts",
    "tests/sources-real-jira.spec.ts",
  ])
    ok(all.includes(f) && !union.includes(f))
  for (const f of [
    "tests/reviews.spec.ts",
    "tests/ai-connections.spec.ts",
    "tests/oauth-consent.spec.ts",
  ])
    ok(union.includes(f))
  const w = new Map(eligible.map((x) => [x.file, x.w]))
  const loads = shards.map((fs) => fs.reduce((a, f) => a + (w.get(f) ?? 0), 0))
  ok(Math.max(...loads) / Math.min(...loads) <= 1.05)
  throws(() => selectPlaywrightShard(0, 3))
  throws(() => selectPlaywrightShard(4, 3))
  throws(() => selectPlaywrightShard(1, 0))
})
