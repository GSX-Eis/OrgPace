import { deepEqual, equal, ok, throws } from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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

test("shards include nested files and every Playwright test suffix", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "playwright-shard-"))
  try {
    const regular = [
      "regular.spec.ts",
      "reviews/approval.spec.ts",
      "another.test.ts",
      "reviews/annual/deep.spec.ts",
      "uppercase.SPEC.ts",
    ]
    for (const ext of ["js", "mjs", "mts", "cjs", "cts", "jsx", "tsx"]) {
      regular.push(`reviews/case.spec.${ext}`, `case.test.${ext}`)
    }
    mkdirSync(path.join(dir, "reviews", "annual"), { recursive: true })
    mkdirSync(path.join(dir, "node_modules"))
    writeFileSync(
      path.join(dir, "node_modules/vendor.spec.ts"),
      'test("dependency", () => {})',
    )
    for (const file of regular)
      writeFileSync(path.join(dir, file), 'test("ordinary", () => {})')
    for (const ext of ["ts", "js", "mjs", "mts", "cjs", "cts", "jsx", "tsx"])
      writeFileSync(
        path.join(dir, `auth.setup.${ext}`),
        'test("setup", () => {})',
      )
    writeFileSync(
      path.join(dir, "only-jira.spec.ts"),
      'test("jira @real-jira", () => {})',
    )
    writeFileSync(
      path.join(dir, "only-mcp.test.ts"),
      'test("mcp @external-mcp", () => {})',
    )
    const specs = listEligibleSpecs(dir)
    const union = [1, 2, 3]
      .flatMap((s) => selectPlaywrightShard(s, 3, specs))
      .sort()
    deepEqual(union, regular.map((f) => `tests/${f}`).sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("selectPlaywrightShard partitions specs deterministically and evenly", () => {
  const frontend = path.resolve(import.meta.dirname, "..")
  const listing = execFileSync(
    "bunx",
    [
      "playwright",
      "test",
      "--list",
      "--project=chromium",
      "--grep-invert",
      "@external-mcp|@real-jira",
      "--reporter=list",
    ],
    {
      cwd: frontend,
      encoding: "utf8",
      env: {
        ...process.env,
        FIRST_SUPERUSER: "admin@example.com",
        FIRST_SUPERUSER_PASSWORD: "listing-only",
        NO_COLOR: "1",
      },
    },
  )
  const expected = [
    ...new Set(
      [...listing.matchAll(/^\s*\[chromium\] › (.+?):\d+:\d+ ›/gm)].map(
        (m) => `tests/${m[1].split(path.sep).join("/")}`,
      ),
    ),
  ].sort()
  ok(expected.length > 0)
  const shards = [1, 2, 3].map((s) => selectPlaywrightShard(s, 3))
  const shardsAgain = [1, 2, 3].map((s) => selectPlaywrightShard(s, 3))
  deepEqual(shards, shardsAgain)
  const union = shards.flat().sort()
  deepEqual(union, expected)
  equal(new Set(union).size, expected.length)
  for (const f of ["reviews", "ai-connections", "oauth-consent"])
    ok(union.includes(`tests/${f}.spec.ts`))
  const w = new Map(listEligibleSpecs().map((x) => [x.file, x.w]))
  const loads = shards.map((fs) => fs.reduce((a, f) => a + (w.get(f) ?? 0), 0))
  ok(Math.max(...loads) / Math.min(...loads) <= 1.05)
  throws(() => selectPlaywrightShard(0, 3))
  throws(() => selectPlaywrightShard(4, 3))
  throws(() => selectPlaywrightShard(1, 0))
})
