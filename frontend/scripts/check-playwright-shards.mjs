import { deepEqual } from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  listEligibleSpecs,
  selectPlaywrightShard,
  toPlaywrightFilePattern,
} from "./select-playwright-shard.mjs"

const frontend = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)

function collect(config, filters = []) {
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
      "--config",
      config,
      ...filters,
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
  return [
    ...new Set(
      [...listing.matchAll(/^\s*\[chromium\] › (.+?):\d+:\d+ ›/gm)].map(
        (m) => `tests/${m[1].split(path.sep).join("/")}`,
      ),
    ),
  ].sort()
}

function verify(root, config, specs, label) {
  const expected = collect(config)
  const shards = [1, 2, 3].map((s) => selectPlaywrightShard(s, 3, specs))
  const collected = shards.map((files, index) => {
    const patterns = files.map((file) => toPlaywrightFilePattern(file, root))
    if (root === frontend) {
      const cli = execFileSync(
        "bun",
        [
          "scripts/select-playwright-shard.mjs",
          String(index + 1),
          "3",
          "--patterns",
        ],
        { cwd: frontend, encoding: "utf8" },
      )
      const args = cli.trimEnd().split("\n")
      deepEqual(args, patterns)
      return collect(config, args)
    }
    return collect(config, patterns)
  })
  console.log(
    `${label}: ${collected.map((files) => files.length).join("/")} files; expected ${expected.length}`,
  )
  if (label === "fixture")
    collected.forEach((files, index) => {
      console.log(`  shard ${index + 1}: ${files.join(", ")}`)
    })
  deepEqual(collected, shards)
  deepEqual(collected.flat().sort(), expected)
  return expected
}

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "playwright-shard-")))
try {
  const config = path.join(root, "playwright.config.mjs")
  writeFileSync(
    config,
    'export default { testDir: "./tests", projects: [{ name: "chromium" }] }',
  )
  const regular = [
    "reviews/[team]/approval.test.ts",
    "reviews/plain.spec.ts",
    "reviews/plain.spec.tsx",
    "uppercase.SPEC.ts",
  ]
  mkdirSync(path.join(root, "tests/reviews/[team]"), { recursive: true })
  const playwright = createRequire(import.meta.url).resolve("@playwright/test")
  for (const file of [...regular, "reviews/upper.test.TS"])
    writeFileSync(
      path.join(root, "tests", file),
      `import { test } from ${JSON.stringify(playwright)}; test("ordinary", () => {})`,
    )
  deepEqual(
    verify(
      root,
      config,
      listEligibleSpecs(path.join(root, "tests")),
      "fixture",
    ),
    regular.map((file) => `tests/${file}`).sort(),
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

verify(
  frontend,
  path.join(frontend, "playwright.config.ts"),
  listEligibleSpecs(),
  "repository",
)
