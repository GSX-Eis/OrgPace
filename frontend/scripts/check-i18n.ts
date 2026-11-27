import fs from "node:fs"
import path from "node:path"

const LOCALES = ["zh-CN", "en"] as const
const PLACEHOLDER_RE = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g
const CALL_RE = /(?:^|[^\w$.])(?:i18n\.)?t\(\s*(["'])([a-zA-Z0-9_.-]+)\1/g

function flatten(
  value: unknown,
  prefix = "",
  out: Map<string, string> = new Map(),
): Map<string, string> {
  if (typeof value === "string") {
    out.set(prefix, value)
    return out
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      const next = prefix ? `${prefix}.${k}` : k
      flatten(v, next, out)
    }
    return out
  }
  throw new Error(
    `Invalid locale value at key "${prefix}": expected string or object`,
  )
}

function extractPlaceholders(text: string): Set<string> {
  const result = new Set<string>()
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    result.add(match[1])
  }
  return result
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}

function collectSourceFiles(
  dir: string,
  root: string,
  files: string[] = [],
): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    const rel = path.relative(root, fullPath).split(path.sep).join("/")
    if (entry.isDirectory()) {
      if (rel === "client" || rel.startsWith("i18n/locales")) continue
      collectSourceFiles(fullPath, root, files)
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (rel === "routeTree.gen.ts" || /\.test\.(ts|tsx)$/.test(entry.name)) {
      continue
    }
    files.push(fullPath)
  }
  return files
}

export function checkI18n(options?: { localesDir?: string; srcDir?: string }): {
  errors: string[]
  keyCount: number
} {
  const defaultSrcDir = path.resolve(import.meta.dirname, "../src")
  const srcDir = options?.srcDir ?? defaultSrcDir
  const localesDir = options?.localesDir ?? path.join(srcDir, "i18n", "locales")
  const errors: string[] = []

  const filesByLocale = new Map<string, string[]>()
  for (const locale of LOCALES) {
    const dir = path.join(localesDir, locale)
    if (!fs.existsSync(dir)) {
      errors.push(`Missing locale directory: ${dir}`)
      filesByLocale.set(locale, [])
      continue
    }
    const jsonFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
    filesByLocale.set(locale, jsonFiles)
  }

  const zhFiles = filesByLocale.get("zh-CN") ?? []
  const enFiles = filesByLocale.get("en") ?? []
  const zhFileSet = new Set(zhFiles)
  const enFileSet = new Set(enFiles)

  for (const f of zhFiles) {
    if (!enFileSet.has(f)) errors.push(`Missing en locale file: ${f}`)
  }
  for (const f of enFiles) {
    if (!zhFileSet.has(f))
      errors.push(`Extra en locale file without zh-CN: ${f}`)
  }

  const allKeys = new Set<string>()
  for (const file of zhFiles) {
    if (!enFileSet.has(file)) continue
    const ns = file.slice(0, -".json".length)
    let zhFlat: Map<string, string>
    let enFlat: Map<string, string>
    try {
      zhFlat = flatten(
        JSON.parse(
          fs.readFileSync(path.join(localesDir, "zh-CN", file), "utf-8"),
        ),
        ns,
      )
      enFlat = flatten(
        JSON.parse(fs.readFileSync(path.join(localesDir, "en", file), "utf-8")),
        ns,
      )
    } catch (error) {
      errors.push(
        `Failed to parse locale file ${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }

    for (const [key, zhValue] of zhFlat) {
      allKeys.add(key)
      const enValue = enFlat.get(key)
      if (enValue === undefined) {
        errors.push(`Missing key in en/${file}: ${key}`)
        continue
      }
      const zhPlaceholders = extractPlaceholders(zhValue)
      const enPlaceholders = extractPlaceholders(enValue)
      if (!sameSet(zhPlaceholders, enPlaceholders)) {
        errors.push(
          `Placeholder mismatch for ${key}: zh=[${[...zhPlaceholders].sort().join(", ")}], en=[${[...enPlaceholders].sort().join(", ")}]`,
        )
      }
    }
    for (const key of enFlat.keys()) {
      if (!zhFlat.has(key)) {
        errors.push(`Extra key in en/${file} without zh-CN: ${key}`)
      }
    }
  }

  if (fs.existsSync(srcDir)) {
    for (const filePath of collectSourceFiles(srcDir, srcDir)) {
      const source = fs.readFileSync(filePath, "utf-8")
      const rel = path.relative(srcDir, filePath).split(path.sep).join("/")
      for (const match of source.matchAll(CALL_RE)) {
        const key = match[2]
        if (!allKeys.has(key)) {
          errors.push(`Missing translation key referenced in ${rel}: ${key}`)
        }
      }
    }
  }

  return { errors, keyCount: allKeys.size }
}

if (import.meta.main) {
  const { errors, keyCount } = checkI18n()
  if (errors.length > 0) {
    console.error(`i18n check failed (${errors.length} issue(s)):`)
    for (const error of errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log(`i18n check passed (${keyCount} keys verified).`)
}
