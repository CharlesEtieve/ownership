import * as core from '@actions/core'
import type { Config } from '../config.js'
import type { Rank } from '../comment/state.js'
import { buildDiff, type DiffDigest } from '../diff/budget.js'
import { filterFiles, type FilterResult } from '../diff/filter.js'
import { statusOf, type GitHubApi, type StatusState } from '../github.js'
import type { LlmClient } from '../llm/provider.js'

export interface Deps {
  gh: GitHubApi
  config: Config
  /** Creates the model client lazily, so skipped runs never need an API key. */
  llm: () => LlmClient
  nonce: () => string
}

export type OutcomeKind =
  'skipped' | 'quiz-posted' | 'quiz-refreshed' | 'quiz-updated' | 'unchanged' | 'evaluated'

export interface Outcome {
  kind: OutcomeKind
  /** Markdown for the job summary. */
  summary: string
  rank?: Rank | undefined
}

export interface LoadedDiff {
  filtered: FilterResult
  digest: DiffDigest
}

export async function loadDiff(gh: GitHubApi, number: number, config: Config): Promise<LoadedDiff> {
  const files = await gh.listFiles(number)
  const filtered = filterFiles(files, config.excludePaths)
  const digest = buildDiff(filtered.kept, config.maxDiffChars)
  // Sizes only: the diff itself never goes to the logs.
  core.info(
    `Diff: ${files.length} files, ${filtered.kept.length} kept, ${filtered.excluded.length} excluded, ` +
      `${digest.changedLines} changed lines, ${digest.text.length} characters sent to the model ` +
      `(${digest.truncatedFiles.length} truncated, ${digest.omittedFiles.length} omitted).`
  )
  return { filtered, digest }
}

export function skipped(reason: string): Outcome {
  core.info(`Skipping: ${reason}`)
  return { kind: 'skipped', summary: `### ⚓ OwnerShip\n\nNothing to do: ${reason}\n` }
}

/** Sets the optional commit status. A read-only token (fork PRs) only produces a warning. */
export async function reportStatus(
  deps: Deps,
  sha: string,
  state: StatusState,
  description: string,
  targetUrl?: string
): Promise<void> {
  if (!deps.config.failOnUnanswered) return
  try {
    await deps.gh.setStatus(sha, state, description, targetUrl)
  } catch (error) {
    if (statusOf(error) !== 403 && statusOf(error) !== 404) throw error
    core.warning(
      'Could not set the OwnerShip commit status: the token lacks "statuses: write" ' +
        '(add it to the workflow permissions; fork PRs only get a read-only token).'
    )
  }
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
