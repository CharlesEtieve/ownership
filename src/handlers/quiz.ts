import * as core from '@actions/core'
import { createHash } from 'node:crypto'
import { modelLabel, requiresApiKey } from '../config.js'
import { messagesFor } from '../comment/i18n.js'
import { renderQuizComment, sanitize } from '../comment/render.js'
import { OPTION_LETTERS, type QuizQuestion, type QuizState } from '../comment/state.js'
import type { DiffDigest } from '../diff/budget.js'
import { findQuizComment, isBotAccount } from '../github.js'
import { quizRequest } from '../llm/prompts.js'
import { completeJson } from '../llm/provider.js'
import { validateQuiz } from '../llm/schemas.js'
import { loadDiff, plural, reportStatus, skipped, type Deps, type Outcome } from './shared.js'

/** Subset of the `pull_request` webhook payload used here. */
export interface PullRequestEvent {
  action?: string
  pull_request?: {
    number: number
    title: string
    body?: string | null
    draft?: boolean
    user: { login: string; type: string }
    head: { sha: string; repo: { full_name: string } | null }
    base: { repo: { full_name: string } }
  }
}

const HANDLED_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review'])
/** A pending quiz is regenerated when the changed-line count moves by more than this share. */
const SIGNIFICANT_CHANGE_RATIO = 0.3

export async function handlePullRequest(event: PullRequestEvent, deps: Deps): Promise<Outcome> {
  const pr = event.pull_request
  if (!pr) return skipped('the event has no pull request.')
  if (!event.action || !HANDLED_ACTIONS.has(event.action)) {
    return skipped(`pull request action "${event.action ?? 'unknown'}" is not handled.`)
  }
  if (pr.draft)
    return skipped('the pull request is a draft; the quiz comes when it is ready for review.')
  if (isBotAccount(pr.user)) {
    await reportStatus(deps, pr.head.sha, 'success', 'Skipped: opened by a bot')
    return skipped(`the author (${pr.user.login}) is a bot.`)
  }

  const { config, gh } = deps
  const isFork = pr.head.repo?.full_name !== pr.base.repo.full_name
  if (isFork && !config.apiKey && requiresApiKey(config.provider)) {
    core.notice(
      'This pull request comes from a fork. GitHub does not share repository secrets with workflows ' +
        'triggered by forks, so OwnerShip cannot reach the model and skips this PR. This is expected.'
    )
    return skipped(
      'pull request from a fork: secrets are not available (expected GitHub behaviour).'
    )
  }

  const { digest, filtered } = await loadDiff(gh, pr.number, config)
  const existing = findQuizComment(await gh.listComments(pr.number))
  const messages = messagesFor(config.language)

  if (!existing) {
    if (digest.changedLines < config.minChangedLines) {
      await reportStatus(deps, pr.head.sha, 'success', 'No quiz needed for a change this small')
      return skipped(
        `only ${plural(digest.changedLines, 'changed line')} after filtering ` +
          `(min-changed-lines: ${config.minChangedLines}).`
      )
    }
    const questions = await generateQuestions(deps, pr.title, pr.body ?? '', digest)
    const state: QuizState = {
      v: 1,
      quizSha: pr.head.sha,
      headSha: pr.head.sha,
      diffHash: digest.hash,
      changedLines: digest.changedLines,
      sourceFiles: digest.sourceFiles,
      format: config.format,
      questions,
      status: 'pending',
      attempts: 0,
      refreshes: 0
    }
    const comment = await gh.createComment(
      pr.number,
      renderQuizComment({
        state,
        author: pr.user.login,
        messages,
        modelLabel: modelLabel(config),
        maxAttempts: config.maxAttempts
      })
    )
    await reportStatus(
      deps,
      pr.head.sha,
      'pending',
      'Waiting for the author to answer the quiz',
      comment.html_url
    )
    core.info(`Quiz posted: ${comment.html_url}`)
    return {
      kind: 'quiz-posted',
      summary: quizSummary(
        'Quiz posted',
        pr.number,
        questions,
        digest,
        filtered.excluded.length,
        comment.html_url
      )
    }
  }

  const { comment, state } = existing
  if (state.headSha === pr.head.sha) {
    return {
      kind: 'unchanged',
      summary: `### ⚓ OwnerShip\n\nThe quiz is already up to date for \`${pr.head.sha.slice(0, 7)}\`.\n`
    }
  }

  const rerender = (next: QuizState): string =>
    renderQuizComment({
      state: next,
      author: pr.user.login,
      messages,
      modelLabel: modelLabel(config),
      maxAttempts: config.maxAttempts
    })

  // Answered quizzes are never regenerated: the badge has been earned.
  if (state.status === 'evaluated') {
    const next = { ...state, headSha: pr.head.sha }
    await gh.updateComment(comment.id, rerender(next))
    await reportStatus(deps, pr.head.sha, 'success', 'Quiz answered', comment.html_url)
    return {
      kind: 'quiz-updated',
      summary: '### ⚓ OwnerShip\n\nThe quiz was already answered; new commits do not change it.\n'
    }
  }

  let next: QuizState
  let kind: Outcome['kind']
  if (digest.hash === state.diffHash) {
    // Same filtered diff (for example a rebase): the questions still match exactly.
    next = { ...state, quizSha: pr.head.sha, headSha: pr.head.sha }
    kind = 'quiz-updated'
  } else if (isSignificantChange(state, digest) && digest.changedLines >= config.minChangedLines) {
    const questions = await generateQuestions(deps, pr.title, pr.body ?? '', digest)
    next = {
      ...state,
      quizSha: pr.head.sha,
      headSha: pr.head.sha,
      diffHash: digest.hash,
      changedLines: digest.changedLines,
      sourceFiles: digest.sourceFiles,
      format: config.format,
      questions,
      refreshes: state.refreshes + 1
    }
    kind = 'quiz-refreshed'
  } else {
    next = { ...state, headSha: pr.head.sha }
    kind = 'quiz-updated'
  }

  await gh.updateComment(comment.id, rerender(next))
  await reportStatus(
    deps,
    pr.head.sha,
    'pending',
    'Waiting for the author to answer the quiz',
    comment.html_url
  )
  return {
    kind,
    summary:
      kind === 'quiz-refreshed'
        ? quizSummary(
            'Quiz refreshed after significant changes',
            pr.number,
            next.questions,
            digest,
            filtered.excluded.length,
            comment.html_url
          )
        : '### ⚓ OwnerShip\n\nNew commits, but no significant change: the questions stay the same.\n'
  }
}

/**
 * A push is significant when it touches source files the quiz did not know about, or when the
 * amount of changed lines moves by more than 30%. Small fixups keep the questions stable.
 */
export function isSignificantChange(state: QuizState, digest: DiffDigest): boolean {
  const known = new Set(state.sourceFiles)
  if (digest.sourceFiles.some(file => !known.has(file))) return true
  const delta = Math.abs(digest.changedLines - state.changedLines)
  return delta / Math.max(state.changedLines, 1) > SIGNIFICANT_CHANGE_RATIO
}

async function generateQuestions(
  deps: Deps,
  title: string,
  description: string,
  digest: DiffDigest
): Promise<QuizQuestion[]> {
  const { config } = deps
  const request = quizRequest({
    title,
    description,
    diff: digest.text,
    count: config.questions,
    format: config.format,
    language: config.language,
    nonce: deps.nonce()
  })
  const quiz = await completeJson(
    deps.llm(),
    request,
    data => validateQuiz(data, config.questions, config.format),
    'quiz'
  )
  return quiz.questions.map((question, index) => ({
    id: index + 1,
    text: question.question,
    focus: question.focus,
    // Keep only paths that are really part of the PR.
    files: question.files.filter(
      file => digest.includedFiles.includes(file) || digest.sourceFiles.includes(file)
    ),
    ...(question.options && question.answer
      ? { options: placeAnswer(question.question, question.options, question.answer) }
      : {})
  }))
}

/**
 * Models tend to put the right option in the same few positions. This moves it to a position derived
 * from the question text (stable, so tests and re-renders agree), keeping the other options in order.
 */
export function placeAnswer(
  question: string,
  options: readonly string[],
  answer: string
): string[] {
  const index = OPTION_LETTERS.indexOf(answer as (typeof OPTION_LETTERS)[number])
  const right = options[index]
  if (right === undefined) return [...options]
  const others = options.filter((_, i) => i !== index)
  const position = (createHash('sha256').update(question).digest()[0] as number) % options.length
  return [...others.slice(0, position), right, ...others.slice(position)]
}

function quizSummary(
  title: string,
  number: number,
  questions: readonly QuizQuestion[],
  digest: DiffDigest,
  excluded: number,
  url: string
): string {
  const lines = [
    `### ⚓ OwnerShip: ${title}`,
    '',
    `[Quiz on #${number}](${url}) · ${plural(questions.length, 'question')} · ` +
      `${plural(digest.changedLines, 'changed line')} considered · ${plural(excluded, 'file')} filtered out · ` +
      `${digest.text.length.toLocaleString('en-US')} characters sent to the model` +
      (digest.truncatedFiles.length + digest.omittedFiles.length > 0
        ? ` (${plural(digest.truncatedFiles.length, 'file')} truncated, ${digest.omittedFiles.length} omitted)`
        : ''),
    '',
    ...questions.map(question => `${question.id}. ${sanitize(question.text).replace(/\n/g, ' ')}`),
    ''
  ]
  return lines.join('\n')
}
