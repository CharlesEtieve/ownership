import { createHash } from 'node:crypto'
import { countChangedLines, type FileCategory, type KeptFile } from './filter.js'

/** What the model gets to see of the PR, plus the facts we keep about it. */
export interface DiffDigest {
  /** Diff text sent to the model: a file overview followed by patches, within the character budget. */
  text: string
  changedLines: number
  /** Fingerprint of the whole filtered diff, used to detect meaningful pushes. */
  hash: string
  /** Source files touched by the PR (capped), used to detect new areas of change. */
  sourceFiles: string[]
  includedFiles: string[]
  truncatedFiles: string[]
  omittedFiles: string[]
}

const CATEGORY_RANK: Record<FileCategory, number> = { source: 0, test: 1, config: 2, docs: 3 }
const MAX_LISTED_FILES = 150
const MAX_TRACKED_SOURCE_FILES = 100
/** One file may not eat more than this share of the budget, so several files get a chance. */
const SINGLE_FILE_SHARE = 0.4
const FOOTER_RESERVE = 600

/**
 * Builds the diff the model will read. Source code comes first, then tests, config and docs; within a
 * category the biggest changes come first. Patches are cut at hunk boundaries when possible, and every
 * cut is announced in the text so the model never mistakes a partial diff for a complete one.
 */
export function buildDiff(files: readonly KeptFile[], maxChars: number): DiffDigest {
  const ordered = [...files].sort(
    (a, b) =>
      CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
      b.changes - a.changes ||
      a.filename.localeCompare(b.filename)
  )
  const changedLines = countChangedLines(ordered)

  const header = renderOverview(ordered, changedLines)
  let remaining = Math.max(0, maxChars - header.length - FOOTER_RESERVE)
  const perFileCap = Math.max(1_500, Math.floor(maxChars * SINGLE_FILE_SHARE))

  const sections: string[] = []
  const includedFiles: string[] = []
  const truncatedFiles: string[] = []
  const omittedFiles: string[] = []

  for (const file of ordered) {
    if (file.status === 'removed' || !file.patch) continue
    const sectionHeader = `\n=== ${file.filename} (${file.status}) ===\n`
    const allowance = Math.min(remaining - sectionHeader.length, perFileCap)
    if (allowance < 200) {
      omittedFiles.push(file.filename)
      continue
    }
    const { body, truncated } = truncatePatch(file.patch, allowance)
    sections.push(sectionHeader + body)
    remaining -= sectionHeader.length + body.length
    includedFiles.push(file.filename)
    if (truncated) truncatedFiles.push(file.filename)
  }

  return {
    text: header + sections.join('\n') + renderFooter(truncatedFiles, omittedFiles),
    changedLines,
    hash: fingerprint(ordered),
    sourceFiles: ordered
      .filter(file => file.category === 'source')
      .map(file => file.filename)
      .sort()
      .slice(0, MAX_TRACKED_SOURCE_FILES),
    includedFiles,
    truncatedFiles,
    omittedFiles
  }
}

function renderOverview(files: readonly KeptFile[], changedLines: number): string {
  const lines = [`Changed files (${files.length} files, ${changedLines} lines changed):`]
  for (const file of files.slice(0, MAX_LISTED_FILES)) {
    const renamed = file.previous_filename ? ` (renamed from ${file.previous_filename})` : ''
    let note = ''
    if (file.status === 'removed') note = ' [deleted, contents not shown]'
    else if (!file.patch && file.status !== 'renamed') note = ' [diff not available]'
    lines.push(
      `- ${file.filename}${renamed}: ${file.category}, ${file.status}, +${file.additions} -${file.deletions}${note}`
    )
  }
  if (files.length > MAX_LISTED_FILES) {
    lines.push(`- ... and ${files.length - MAX_LISTED_FILES} more files`)
  }
  return lines.join('\n') + '\n'
}

function renderFooter(truncated: readonly string[], omitted: readonly string[]): string {
  const notes: string[] = []
  if (truncated.length > 0)
    notes.push(`Truncated to fit the size limit: ${summarizeList(truncated)}.`)
  if (omitted.length > 0) notes.push(`Not shown to fit the size limit: ${summarizeList(omitted)}.`)
  return notes.length > 0 ? `\n\n[${notes.join(' ')}]\n` : '\n'
}

function summarizeList(names: readonly string[]): string {
  const shown = names.slice(0, 15).join(', ')
  return names.length > 15 ? `${shown} and ${names.length - 15} more` : shown
}

/**
 * Keeps whole hunks while they fit; if even the first hunk is too big, keeps its first lines.
 * The returned body never exceeds `limit` characters.
 */
export function truncatePatch(patch: string, limit: number): { body: string; truncated: boolean } {
  if (patch.length <= limit) return { body: patch, truncated: false }

  const hunks = splitHunks(patch)
  const marker = (count: number): string => `\n... [${count} more hunk(s) truncated]`
  const kept: string[] = []
  let size = 0
  for (const hunk of hunks) {
    const extra = (kept.length > 0 ? 1 : 0) + hunk.length
    if (size + extra + marker(hunks.length).length > limit) break
    kept.push(hunk)
    size += extra
  }
  if (kept.length > 0) {
    return { body: kept.join('\n') + marker(hunks.length - kept.length), truncated: true }
  }

  const cutMarker = '\n... [truncated]'
  const lines = patch.split('\n')
  const out: string[] = []
  let length = 0
  for (const line of lines) {
    if (length + line.length + 1 + cutMarker.length > limit) break
    out.push(line)
    length += line.length + 1
  }
  return { body: out.join('\n') + cutMarker, truncated: true }
}

function splitHunks(patch: string): string[] {
  const hunks: string[] = []
  let current: string[] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') && current.length > 0) {
      hunks.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) hunks.push(current.join('\n'))
  return hunks
}

function fingerprint(files: readonly KeptFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.filename.localeCompare(b.filename))) {
    hash.update(`${file.filename}\0${file.status}\0${file.patch ?? ''}\0`)
  }
  return `sha256:${hash.digest('hex').slice(0, 32)}`
}
