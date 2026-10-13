import * as core from '@actions/core'
import { DEAD_RECKONING_LABEL, isBetter, RANK_LABELS, rankFor } from '../badges.js'
import { modelLabel } from '../config.js'
import { isOwnershipCommand, parseAnswers } from '../comment/answers.js'
import { messagesFor } from '../comment/i18n.js'
import {
  rankName,
  renderAnswerTemplate,
  renderDebrief,
  renderQuizComment,
  sanitize
} from '../comment/render.js'
import { RANKS, type QuizResult, type QuizState } from '../comment/state.js'
import { findQuizComment, isBotAccount } from '../github.js'
import { evaluationRequest } from '../llm/prompts.js'
import { completeJson } from '../llm/provider.js'
import { validateEvaluation, type Evaluation } from '../llm/schemas.js'
import { loadDiff, reportStatus, skipped, type Deps, type Outcome } from './shared.js'

/** Subset of the `issue_comment` webhook payload used here. */
export interface IssueCommentEvent {
  action?: string
  issue?: {
    number: number
    user: { login: string; type: string }
    pull_request?: unknown
  }
  comment?: {
    id: number
    body?: string
    html_url: string
    user: { login: string; type: string }
  }
}

export async function handleIssueComment(event: IssueCommentEvent, deps: Deps): Promise<Outcome> {
  const { issue, comment } = event
  if (event.action !== 'created' || !issue || !comment) return skipped('not a new comment.')
  if (!issue.pull_request) return skipped('the comment is on an issue, not a pull request.')
  if (!isOwnershipCommand(comment.body))
    return skipped('the comment does not start with /ownership.')
  if (isBotAccount(comment.user)) return skipped('the comment was written by a bot.')
  if (comment.user.login !== issue.user.login) {
    return skipped(
      `only the pull request author (@${issue.user.login}) is quizzed; ` +
        `the /ownership comment from @${comment.user.login} is ignored.`
    )
  }

  const { gh, config } = deps
  const existing = findQuizComment(await gh.listComments(issue.number))
  if (!existing) return skipped('there is no OwnerShip quiz on this pull request.')

  const messages = messagesFor(config.language)
  const { state } = existing
  const bestRankName = state.result ? rankName(state.result.rank) : RANK_LABELS.deckhand.name

  if (state.attempts >= config.maxAttempts) {
    await gh.createComment(issue.number, messages.outOfAttempts(config.maxAttempts, bestRankName))
    return skipped(`all ${config.maxAttempts} attempts were already used.`)
  }

  const parsed = parseAnswers(
    comment.body ?? '',
    state.questions.map(q => q.id)
  )
  if (parsed.empty) {
    await gh.createComment(
      issue.number,
      `${messages.emptyAnswers}\n\n${renderAnswerTemplate(state, messages)}\n`
    )
    return skipped('the /ownership comment contains no answers.')
  }

  await gh.addReaction(comment.id, 'eyes').catch(error => {
    core.debug(`Could not add a reaction: ${String(error)}`)
  })

  const pr = await gh.getPullRequest(issue.number)
  const { digest } = await loadDiff(gh, issue.number, config)
  const request = evaluationRequest({
    title: pr.title,
    diff: digest.text,
    questions: state.questions,
    answers: parsed,
    language: config.language,
    nonce: deps.nonce()
  })
  const { evaluations, summary } = await completeJson(
    deps.llm(),
    request,
    data =>
      validateEvaluation(
        data,
        state.questions.map(q => q.id)
      ),
    'evaluation'
  )

  const grades = evaluations.map(evaluation => evaluation.grade)
  const attempt: QuizResult = {
    grades,
    rank: rankFor(grades),
    deadReckoning: parsed.deadReckoning
  }
  const improved = isBetter(attempt, state.result)
  const best: QuizResult = improved
    ? { ...attempt, deadReckoning: attempt.deadReckoning || !!state.result?.deadReckoning }
    : {
        ...(state.result as QuizResult),
        deadReckoning: !!state.result?.deadReckoning || attempt.deadReckoning
      }
  const next: QuizState = {
    ...state,
    headSha: pr.headSha,
    status: 'evaluated',
    attempts: state.attempts + 1,
    result: best
  }

  const debrief = await gh.createComment(
    issue.number,
    renderDebrief({
      state: next,
      author: issue.user.login,
      messages,
      evaluations,
      summary,
      attemptRank: attempt.rank,
      bestRank: best.rank,
      improved,
      deadReckoning: attempt.deadReckoning,
      maxAttempts: config.maxAttempts
    })
  )
  if (improved) next.result = { ...best, debriefUrl: debrief.html_url }

  await gh.updateComment(
    existing.comment.id,
    renderQuizComment({
      state: next,
      author: issue.user.login,
      messages,
      modelLabel: modelLabel(config),
      maxAttempts: config.maxAttempts
    })
  )

  await gh.removeLabels(
    issue.number,
    RANKS.filter(rank => rank !== best.rank).map(rank => RANK_LABELS[rank].name)
  )
  await gh.addLabels(issue.number, [
    RANK_LABELS[best.rank],
    ...(best.deadReckoning ? [DEAD_RECKONING_LABEL] : [])
  ])
  await reportStatus(deps, pr.headSha, 'success', 'Quiz answered', existing.comment.html_url)

  core.info(
    `Attempt ${next.attempts}: ${attempt.rank} (best: ${best.rank}). Debrief: ${debrief.html_url}`
  )
  return {
    kind: 'evaluated',
    rank: best.rank,
    summary: evaluationSummary(issue.number, next, evaluations, attempt, best, debrief.html_url)
  }
}

function evaluationSummary(
  number: number,
  state: QuizState,
  evaluations: readonly Evaluation[],
  attempt: QuizResult,
  best: QuizResult,
  url: string
): string {
  const rows = state.questions.map(question => {
    const grade = evaluations.find(e => e.id === question.id)?.grade ?? 'missing'
    const text = sanitize(question.text).replace(/\n/g, ' ').replace(/\|/g, '\\|')
    return `| ${question.id} | ${text} | ${grade} |`
  })
  return [
    `### ⚓ OwnerShip: answers evaluated on #${number}`,
    '',
    `Attempt ${state.attempts}: **${rankName(attempt.rank)}**${attempt.deadReckoning ? ' · 🗺️ Dead Reckoning' : ''} · ` +
      `best result: **${rankName(best.rank)}** · [debrief](${url})`,
    '',
    '| # | Question | Grade |',
    '| - | - | - |',
    ...rows,
    ''
  ].join('\n')
}
