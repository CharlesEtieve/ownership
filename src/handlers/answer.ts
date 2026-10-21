import * as core from '@actions/core'
import { DEAD_RECKONING_LABEL, isBetter, RANK_LABELS, rankFor } from '../badges.js'
import { modelLabel } from '../config.js'
import {
  isOwnershipCommand,
  parseAnswers,
  parseChoiceAnswers,
  parseTicks,
  untickSubmit,
  type ParsedAnswers
} from '../comment/answers.js'
import { formatTexts, messagesFor, type Messages } from '../comment/i18n.js'
import {
  rankName,
  renderAnswerTemplate,
  renderDebrief,
  renderQuizComment,
  sanitize
} from '../comment/render.js'
import { formatOf, RANKS, type QuizResult, type QuizState } from '../comment/state.js'
import { findQuizComment, isBotAccount, type QuizComment } from '../github.js'
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
  /** Who triggered the event: for "edited", the person who ticked a box. */
  sender?: { login: string; type: string }
}

export async function handleIssueComment(event: IssueCommentEvent, deps: Deps): Promise<Outcome> {
  const { issue, comment } = event
  if (!issue || !comment) return skipped('the event has no comment.')
  if (!issue.pull_request) return skipped('the comment is on an issue, not a pull request.')
  if (event.action === 'edited') return handleTicks(event, deps)
  if (event.action !== 'created') return skipped(`comment action "${event.action}" is not handled.`)
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
  const format = formatOf(state)
  const bestRankName = state.result ? rankName(state.result.rank) : RANK_LABELS.deckhand.name
  // The debrief reveals the right options, so a multiple-choice quiz is answered once.
  const maxAttempts = format === 'multiple-choice' ? 1 : config.maxAttempts

  if (state.attempts >= maxAttempts) {
    await gh.createComment(issue.number, messages.outOfAttempts(maxAttempts, bestRankName))
    return skipped(
      maxAttempts === 1
        ? 'the quiz was already answered.'
        : `all ${maxAttempts} attempts were already used.`
    )
  }

  const body = comment.body ?? ''
  const parsed: ParsedAnswers =
    format === 'multiple-choice'
      ? parseChoiceAnswers(body, state.questions)
      : parseAnswers(
          body,
          state.questions.map(q => q.id)
        )
  if (parsed.empty) {
    await gh.createComment(
      issue.number,
      `${formatTexts(messages, format).emptyAnswers}\n\n${renderAnswerTemplate(state, messages)}\n`
    )
    return skipped('the /ownership comment contains no answers.')
  }

  await gh.addReaction(comment.id, 'eyes').catch(error => {
    core.debug(`Could not add a reaction: ${String(error)}`)
  })
  return grade(deps, {
    number: issue.number,
    author: issue.user.login,
    existing,
    parsed,
    messages,
    maxAttempts
  })
}

/**
 * Multiple-choice quizzes are answered by ticking boxes in the quiz comment. Each tick edits the
 * comment; grading starts when the PR author ticks "Done".
 */
async function handleTicks(event: IssueCommentEvent, deps: Deps): Promise<Outcome> {
  const issue = event.issue as NonNullable<IssueCommentEvent['issue']>
  const comment = event.comment as NonNullable<IssueCommentEvent['comment']>
  if (!isBotAccount(comment.user)) return skipped('the edited comment is not an OwnerShip quiz.')
  if (event.sender?.login !== issue.user.login) {
    return skipped(
      `only the pull request author (@${issue.user.login}) can submit the quiz; ` +
        `the edit by @${event.sender?.login ?? 'unknown'} is ignored.`
    )
  }

  const { gh, config } = deps
  const existing = findQuizComment(await gh.listComments(issue.number))
  if (!existing || existing.comment.id !== comment.id) {
    return skipped('the edited comment is not the OwnerShip quiz.')
  }
  const { state } = existing
  if (formatOf(state) !== 'multiple-choice' || state.status !== 'pending') {
    return skipped('the quiz is not waiting for ticked answers.')
  }

  // The freshest body, in case the author kept ticking while this run was queued.
  const body = existing.comment.body
  const ticks = parseTicks(body, state.questions)
  if (!ticks.submitted) return skipped('"Done" is not ticked yet.')

  const messages = messagesFor(config.language)
  if (ticks.conflicts.length > 0 || ticks.empty) {
    await gh.updateComment(existing.comment.id, untickSubmit(body))
    await gh.createComment(
      issue.number,
      ticks.conflicts.length > 0
        ? messages.conflicts(ticks.conflicts.join(', '))
        : messages.nothingTicked
    )
    return skipped(
      ticks.conflicts.length > 0
        ? `several boxes ticked for question(s) ${ticks.conflicts.join(', ')}.`
        : '"Done" was ticked without any option.'
    )
  }

  return grade(deps, {
    number: issue.number,
    author: issue.user.login,
    existing,
    parsed: ticks,
    messages,
    maxAttempts: 1
  })
}

interface GradeInput {
  number: number
  author: string
  existing: QuizComment
  parsed: ParsedAnswers
  messages: Messages
  maxAttempts: number
}

/** Grades one attempt, posts the debrief, updates the quiz, the labels and the status. */
async function grade(deps: Deps, input: GradeInput): Promise<Outcome> {
  const { gh, config } = deps
  const { existing, parsed, messages, maxAttempts, author } = input
  const { state } = existing
  const issue = { number: input.number, user: { login: author } }

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
  const optionCounts = parsed.choices
    ? new Map(state.questions.map(q => [q.id, q.options?.length ?? 0]))
    : undefined
  const { evaluations, summary } = await completeJson(
    deps.llm(),
    request,
    data =>
      validateEvaluation(
        data,
        state.questions.map(q => q.id),
        optionCounts
      ),
    'evaluation'
  )
  if (parsed.choices) alignGrades(evaluations, parsed.choices)

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
      choices: parsed.choices,
      summary,
      attemptRank: attempt.rank,
      bestRank: best.rank,
      improved,
      deadReckoning: attempt.deadReckoning,
      maxAttempts
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
      maxAttempts
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

/**
 * A pick is right or wrong, whatever the model's wording: a right pick is solid, and a wrong pick is
 * at best partial (when the author's reason shows understanding).
 */
function alignGrades(evaluations: Evaluation[], choices: ReadonlyMap<number, string>): void {
  for (const evaluation of evaluations) {
    const picked = choices.get(evaluation.id)
    if (!picked || !evaluation.correct) continue
    if (picked === evaluation.correct) evaluation.grade = 'solid'
    else if (evaluation.grade === 'solid') evaluation.grade = 'partial'
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
