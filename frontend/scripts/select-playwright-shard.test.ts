import { deepEqual, equal, ok, throws } from "node:assert/strict"
import { readdirSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import * as shardMod from "./select-playwright-shard.mjs"

const { isTagOnlySpec, listEligibleSpecs, selectPlaywrightShard } = shardMod

test("isTagOnlySpec excludes pure tags and keeps mixed or dynamic", () => {
  const cases: [string, boolean][] = [
    ['test("a, b @real-jira", async () => {})', true],
    ['test("oauth @external-mcp", async () => {})', true],
    ['test("a", () => {})\ntest("b @external-mcp", () => {})', false],
    ['test("x @external-mcp", () => {}); test(title, () => {})', false],
    ['test("x @external-mcp", () => {}); test.only("ok", () => {})', false],
    [`test(\`case\${"$"}{tag}\`, () => {})`, false],
    ["helper()", false],
  ]
  for (const [src, exp] of cases) equal(isTagOnlySpec(src), exp)
})

test("selectPlaywrightShard partitions specs deterministically and evenly", () => {
  const dir = path.resolve(import.meta.dirname, "../tests")
  const all = readdirSync(dir)
    .filter((n) => n.endsWith(".spec.ts"))
    .sort()
  const tagOnly = new Set(["m2-real-jira.spec.ts", "sources-real-jira.spec.ts"])
  const expected = all.filter((f) => !tagOnly.has(f)).map((f) => `tests/${f}`)
  const shards = [1, 2, 3].map((s) => selectPlaywrightShard(s, 3))
  deepEqual(
    shards,
    [1, 2, 3].map((s) => selectPlaywrightShard(s, 3)),
  )
  const union = shards.flat().sort()
  deepEqual(union, expected)
  equal(new Set(union).size, expected.length)
  for (const f of ["reviews", "ai-connections", "oauth-consent"])
    ok(union.includes(`tests/${f}.spec.ts`))
  const w = new Map(listEligibleSpecs(dir).map((x) => [x.file, x.w]))
  const loads = shards.map((fs) => fs.reduce((a, f) => a + (w.get(f) ?? 0), 0))
  ok(Math.max(...loads) / Math.min(...loads) <= 1.05)
  for (const [s, t] of [
    [0, 3],
    [4, 3],
    [1, 0],
  ])
    throws(() => selectPlaywrightShard(s, t))
})
