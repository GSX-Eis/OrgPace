import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tests",
)
const DECL = /\b(?:test(?:\.(?:only|fixme|fail))?|isolated)\s*\(\s*/g
const LIT = /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/
const TAG = /@(?:external-mcp|real-jira)\b/

export const isTagOnlySpec = (src) => {
  let n = 0
  for (const m of src.matchAll(DECL)) {
    n += 1
    const lit = src.slice(m.index + m[0].length).match(LIT)?.[1]
    if (!lit || (lit[0] === "`" && lit.includes("${")) || !TAG.test(lit))
      return false
  }
  return n > 0
}

export const estimateSpecWeight = (src) =>
  src.split("\n").length +
  (src.match(/\b(?:test|isolated)\s*\(/g) ?? []).length * 80 +
  (/setup\/initialize|createSourcesOrg/.test(src) ? 150 : 0) +
  (/modelUrl|createServer/.test(src) ? 150 : 0)

function listTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return entry.name === "node_modules"
        ? []
        : listTestFiles(path.join(dir, entry.name)).map((file) =>
            path.posix.join(entry.name, file),
          )
    }
    const suffix = entry.name.match(/\.(?:spec|test)(\.[cm]?[jt]sx?)$/i)
    return entry.isFile() && suffix && suffix[1] === suffix[1].toLowerCase()
      ? [entry.name]
      : []
  })
}

export const listEligibleSpecs = (dir = DIR) =>
  listTestFiles(dir)
    .sort()
    .flatMap((f) => {
      const s = readFileSync(path.join(dir, f), "utf8")
      return isTagOnlySpec(s)
        ? []
        : [{ file: `tests/${f}`, w: estimateSpecWeight(s) }]
    })

export function selectPlaywrightShard(
  shard,
  total,
  specs = listEligibleSpecs(),
) {
  if (!Number.isInteger(total) || total < 1)
    throw new Error(`Invalid total: ${total}`)
  if (!Number.isInteger(shard) || shard < 1 || shard > total)
    throw new Error(`Invalid shard ${shard}/${total}`)
  const out = Array.from({ length: total }, () => ({ w: 0, files: [] }))
  for (const x of [...specs].sort(
    (a, b) => b.w - a.w || a.file.localeCompare(b.file),
  )) {
    const i = out.reduce((b, c, k) => (c.w < out[b].w ? k : b), 0)
    out[i].w += x.w
    out[i].files.push(x.file)
  }
  return out[shard - 1].files.sort()
}

export function toPlaywrightFilePattern(file, root = path.dirname(DIR)) {
  // Playwright treats positional file arguments as regexes on absolute paths.
  const absolute = path.resolve(root, file).split(path.sep).join("/")
  return `/^${absolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$/`
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  for (const f of selectPlaywrightShard(
    Number(process.argv[2]),
    Number(process.argv[3]),
  ))
    console.log(
      process.argv[4] === "--patterns" ? toPlaywrightFilePattern(f) : f,
    )
