import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TESTS_DIR = path.resolve(HERE, "../tests")
const TEST_RE = /\b(?:test|isolated)\s*\(\s*("[^"]*"|'[^']*'|`[^`]*`)/g
const TAG_RE = /@(?:external-mcp|real-jira)\b/

export const isTagOnlySpec = (source) => {
  const m = [...source.matchAll(TEST_RE)]
  return m.length > 0 && m.every(([, t]) => TAG_RE.test(t) && !t.includes("${"))
}

export const estimateSpecWeight = (source) =>
  source.split("\n").length +
  (source.match(/\b(?:test|isolated)\s*\(/g) ?? []).length * 80 +
  (/setup\/initialize|createSourcesOrg/.test(source) ? 150 : 0) +
  (/modelUrl|createServer/.test(source) ? 150 : 0)

export function listEligibleSpecs(testsDir = TESTS_DIR) {
  return readdirSync(testsDir)
    .filter((n) => n.endsWith(".spec.ts"))
    .sort()
    .flatMap((n) => {
      const src = readFileSync(path.join(testsDir, n), "utf8")
      return isTagOnlySpec(src)
        ? []
        : [{ file: `tests/${n}`, w: estimateSpecWeight(src) }]
    })
}

export function selectPlaywrightShard(
  shard,
  total,
  specs = listEligibleSpecs(),
) {
  if (!Number.isInteger(total) || total < 1)
    throw new Error(`Invalid total: ${total}`)
  if (!Number.isInteger(shard) || shard < 1 || shard > total)
    throw new Error(`Invalid shard ${shard}/${total}`)
  const buckets = Array.from({ length: total }, () => ({ w: 0, files: [] }))
  for (const item of [...specs].sort(
    (a, b) => b.w - a.w || a.file.localeCompare(b.file),
  )) {
    const idx = buckets.reduce((b, c, i) => (c.w < buckets[b].w ? i : b), 0)
    buckets[idx].w += item.w
    buckets[idx].files.push(item.file)
  }
  return buckets[shard - 1].files.sort()
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  for (const f of selectPlaywrightShard(
    Number(process.argv[2]),
    Number(process.argv[3]),
  ))
    console.log(f)
}
