import { countGrade, DEAD_RECKONING_LABEL, RANK_LABELS } from '../badges.js'
import { formatTexts, type Messages } from './i18n.js'
import {
  encodeState,
  formatOf,
  OPTION_LETTERS,
  RANKS,
  type Grade,
  type OptionLetter,
  type QuizQuestion,
  type QuizState,
  type Rank
} from './state.js'

export interface QuestionEvaluation {
  id: number
  grade: Grade
  feedback: string
  explanation: string
  correct?: OptionLetter | undefined
}

const MAX_MODEL_TEXT = 2_000

/**
 * Makes model-written text safe to embed in a comment: no raw HTML or fake state markers, no
 * remote images (which could leak data through their URL), no @-mentions pinging people.
 * Code spans are left intact apart from HTML comment openers.
 */
export function sanitize(text: string): string {
  const trimmed = text.replace(/\r/g, '').trim()
  const clipped =
    trimmed.length > MAX_MODEL_TEXT ? `${trimmed.slice(0, MAX_MODEL_TEXT).trimEnd()}…` : trimmed
  return clipped
    .split(/(`+[\s\S]*?`+)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part.replace(/<!--/g, '<!​--')
      return part
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/!\[/g, '!\\[')
        .replace(/@(?=[A-Za-z0-9_-])/g, '@​')
    })
    .join('')
}

/** One-line sanitize for short fields such as file paths shown in code spans. */
function inlineCode(text: string): string {
  return `\`${text.replace(/[`\n\r]/g, '').slice(0, 200)}\``
}

const short = (sha: string): string => sha.slice(0, 7)

/** "**B.** option text", on one line. */
function optionLine(question: QuizQuestion, letter: OptionLetter): string | undefined {
  const option = question.options?.[OPTION_LETTERS.indexOf(letter)]
  return option === undefined ? undefined : `**${letter}.** ${sanitize(option).replace(/\n/g, ' ')}`
}

/** Badge names are the label names, identical in every language. */
export function rankName(rank: Rank): string {
  return RANK_LABELS[rank].name
}

export interface QuizCommentInput {
  state: QuizState
  author: string
  messages: Messages
  modelLabel: string
  maxAttempts: number
}

/** The single quiz comment, fully derived from the state so it can be re-rendered at any time. */
export function renderQuizComment({
  state,
  author,
  messages: m,
  modelLabel,
  maxAttempts
}: QuizCommentInput): string {
  const f = formatTexts(m, formatOf(state))
  const lines: string[] = [encodeState(state), '', `## ${m.quizTitle}`, '']
  lines.push(m.quizIntro(author, state.questions.length), '')

  for (const question of state.questions) {
    lines.push(`**${question.id}. ${sanitize(question.text)}**`)
    const files = question.files.slice(0, 3).map(inlineCode).join(', ')
    lines.push(`<sub>${m.focus[question.focus]}${files ? ` · ${files}` : ''}</sub>`, '')
    if (question.options) {
      for (const letter of OPTION_LETTERS) {
        const line = optionLine(question, letter)
        if (line) lines.push(`- ${line}`)
      }
      lines.push('')
    }
  }

  lines.push(`### ${m.howToAnswerTitle}`, '', f.howToAnswer, '', renderAnswerTemplate(state, m), '')
  lines.push(`<sub>${m.deadReckoningHint}</sub>`, '')

  lines.push(`<details><summary>${m.badgesTitle}</summary>`, '')
  for (const rank of RANKS) lines.push(`- **${RANK_LABELS[rank].name}**: ${f.rankRules[rank]}`)
  lines.push(`- **${DEAD_RECKONING_LABEL.name}**: ${m.deadReckoningRule}`, '', '</details>', '')

  lines.push('---', '')
  if (state.status === 'evaluated' && state.result) {
    const { result } = state
    const status = m.statusEvaluated(
      rankName(result.rank),
      f.score(countGrade(result.grades, 'solid'), result.grades.length),
      result.debriefUrl
    )
    lines.push(
      maxAttempts > 1 ? `${status} ${m.attemptsUsed(state.attempts, maxAttempts)}` : status
    )
  } else {
    lines.push(m.statusPending)
  }
  if (state.refreshes > 0) lines.push('', m.refreshedNote(short(state.quizSha)))
  if (state.headSha !== state.quizSha) {
    lines.push('', m.staleNote(short(state.quizSha), short(state.headSha)))
  }
  lines.push('', `<sub>${m.footer(modelLabel)}</sub>`, '')
  return lines.join('\n')
}

export interface DebriefInput {
  state: QuizState
  author: string
  messages: Messages
  evaluations: QuestionEvaluation[]
  /** Multiple choice only: the option picked per question id. */
  choices?: ReadonlyMap<number, OptionLetter> | undefined
  summary: string
  attemptRank: Rank
  /** Rank kept after this attempt (may be a previous, better attempt). */
  bestRank: Rank
  improved: boolean
  deadReckoning: boolean
  maxAttempts: number
}

/** Reply posted after each attempt: per-question feedback, the expected explanation, the badge. */
export function renderDebrief(input: DebriefInput): string {
  const { state, messages: m } = input
  const f = formatTexts(m, formatOf(state))
  const lines: string[] = [`## ${m.debriefTitle}`, '', m.debriefIntro(input.author), '']

  for (const question of state.questions) {
    const evaluation = input.evaluations.find(e => e.id === question.id)
    if (!evaluation) continue
    lines.push(`### ${question.id}. ${f.grades[evaluation.grade]}`, '')
    lines.push(`> ${sanitize(question.text).replace(/\n/g, '\n> ')}`, '')
    if (question.options) {
      const picked = input.choices?.get(question.id)
      const pickedLine = picked && optionLine(question, picked)
      lines.push(pickedLine ? m.yourPick(pickedLine) : m.noPick, '')
      const right = evaluation.correct && optionLine(question, evaluation.correct)
      if (right && picked !== evaluation.correct) lines.push(`**${m.rightOption}:** ${right}`, '')
    }
    lines.push(sanitize(evaluation.feedback), '')
    lines.push(`**${m.strongAnswer}:** ${sanitize(evaluation.explanation)}`, '')
  }

  if (input.summary.trim()) lines.push(`**${m.summaryTitle}:** ${sanitize(input.summary)}`, '')

  lines.push('---', '')
  if (input.improved) {
    lines.push(m.badgeEarned(rankName(input.attemptRank)))
    if (input.attemptRank === 'captain') lines.push('', m.captainCheer)
  } else {
    lines.push(m.previousBestStays(rankName(input.bestRank)))
  }
  if (input.deadReckoning) lines.push('', m.deadReckoningThanks)

  const left = input.maxAttempts - state.attempts
  if (input.bestRank !== 'captain' && input.maxAttempts > 1) {
    lines.push('', left > 0 ? m.tryAgain(left) : m.lastAttempt)
  }
  lines.push('')
  return lines.join('\n')
}

/** Answer template shown when someone sends "/ownership" with nothing usable after it. */
export function renderAnswerTemplate(state: QuizState, messages: Messages): string {
  const { answerPlaceholder } = formatTexts(messages, formatOf(state))
  const lines = ['```text', '/ownership']
  for (const question of state.questions) lines.push(`${question.id}. ${answerPlaceholder}`)
  lines.push('', `- [ ] ${messages.deadReckoningLine}`, '```')
  return lines.join('\n')
}
