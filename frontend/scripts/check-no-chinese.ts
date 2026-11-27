import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const HAN_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/
const IGNORE_MARKER_RE =
  /^i18n-ignore(?=$|[\s:：-])(?:\s*[:：-]?\s*([\s\S]*))?$/

type ExemptionIndex = {
  sameLine: Map<number, string>
  nextLine: Map<number, string>
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

function collectComments(sf: ts.SourceFile): ts.CommentRange[] {
  const seen = new Set<number>()
  const comments: ts.CommentRange[] = []
  const text = sf.text

  const addRanges = (ranges: ts.CommentRange[] | undefined) => {
    if (!ranges) return
    for (const range of ranges) {
      if (seen.has(range.pos)) continue
      seen.add(range.pos)
      comments.push(range)
    }
  }

  const walk = (node: ts.Node) => {
    addRanges(ts.getLeadingCommentRanges(text, node.getFullStart()))
    addRanges(ts.getTrailingCommentRanges(text, node.getEnd()))
    for (const child of node.getChildren(sf)) {
      walk(child)
    }
  }

  walk(sf)
  comments.sort((a, b) => a.pos - b.pos)
  return comments
}

function extractIgnoreReason(
  commentText: string,
  kind: ts.CommentKind,
): string | null {
  const body =
    kind === ts.SyntaxKind.SingleLineCommentTrivia
      ? commentText.slice(2).trim()
      : commentText.slice(2, -2).trim()
  const match = body.match(IGNORE_MARKER_RE)
  if (!match) return null
  return (match[1] ?? "").trim()
}

function isStandaloneComment(
  lines: string[],
  sf: ts.SourceFile,
  range: ts.CommentRange,
): boolean {
  const start = sf.getLineAndCharacterOfPosition(range.pos)
  const end = sf.getLineAndCharacterOfPosition(range.end)
  const before = (lines[start.line] ?? "").slice(0, start.character)
  const after = (lines[end.line] ?? "").slice(end.character)
  if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)) {
    return true
  }
  return (
    range.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
    /^[ \t]*\{[ \t]*$/.test(before) &&
    /^[ \t]*\}[ \t]*$/.test(after)
  )
}

function collectExemptions(
  sf: ts.SourceFile,
  lines: string[],
  rel: string,
  errors: string[],
): ExemptionIndex {
  const sameLine = new Map<number, string>()
  const nextLine = new Map<number, string>()

  for (const range of collectComments(sf)) {
    const commentText = sf.text.slice(range.pos, range.end)
    const reason = extractIgnoreReason(commentText, range.kind)
    if (reason === null) continue

    const start = sf.getLineAndCharacterOfPosition(range.pos)
    const end = sf.getLineAndCharacterOfPosition(range.end)
    if (!reason) {
      errors.push(`Missing reason for i18n-ignore in ${rel}:${start.line + 1}`)
    }

    for (let line = start.line; line <= end.line; line += 1) {
      if (!sameLine.has(line) || reason) sameLine.set(line, reason)
    }
    if (isStandaloneComment(lines, sf, range)) {
      const target = end.line + 1
      if (!nextLine.has(target) || reason) nextLine.set(target, reason)
    }
  }

  return { sameLine, nextLine }
}

function findExemption(
  exemptions: ExemptionIndex,
  startLine: number,
  endLine: number,
): { found: boolean; reason: string } {
  for (let i = startLine; i <= endLine; i += 1) {
    const reason = exemptions.sameLine.get(i)
    if (reason !== undefined) return { found: true, reason }
  }
  const prevReason = exemptions.nextLine.get(startLine)
  if (prevReason !== undefined) return { found: true, reason: prevReason }
  return { found: false, reason: "" }
}

function nodeText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    return node.text
  }
  if (ts.isJsxText(node)) {
    return node.text
  }
  return null
}

export function checkNoChinese(options?: { srcDir?: string }): {
  errors: string[]
  fileCount: number
  ignoreCount: number
} {
  const defaultSrcDir = path.resolve(import.meta.dirname, "../src")
  const srcDir = options?.srcDir ?? defaultSrcDir
  const errors: string[] = []
  let fileCount = 0
  let ignoreCount = 0

  if (!fs.existsSync(srcDir)) {
    return {
      errors: [`Source directory not found: ${srcDir}`],
      fileCount: 0,
      ignoreCount: 0,
    }
  }

  for (const filePath of collectSourceFiles(srcDir, srcDir)) {
    fileCount += 1
    const source = fs.readFileSync(filePath, "utf-8")
    const lines = source.split(/\r?\n/)
    const rel = path.relative(srcDir, filePath).split(path.sep).join("/")

    const sf = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const exemptions = collectExemptions(sf, lines, rel, errors)

    const visit = (node: ts.Node) => {
      const text = nodeText(node)
      if (text !== null && HAN_RE.test(text)) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        const end = sf.getLineAndCharacterOfPosition(node.getEnd())
        const exemption = findExemption(exemptions, start.line, end.line)
        if (exemption.found) {
          if (exemption.reason) ignoreCount += 1
        } else {
          const snippet = text.trim().replace(/\s+/g, " ").slice(0, 60)
          errors.push(
            `Hardcoded Chinese in ${rel}:${start.line + 1}:${start.character + 1}: ${JSON.stringify(snippet)}`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }

    visit(sf)
  }

  return { errors, fileCount, ignoreCount }
}

if (import.meta.main) {
  const { errors, fileCount, ignoreCount } = checkNoChinese()
  if (errors.length > 0) {
    console.error(`no-chinese check failed (${errors.length} issue(s)):`)
    for (const error of errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log(
    `no-chinese check passed (${fileCount} files scanned, ${ignoreCount} i18n-ignore exemptions).`,
  )
}
