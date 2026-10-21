import { OPTION_LETTERS, type OptionLetter } from './state.js'

export interface ParsedAnswers {
  /** Answer text per question id; missing ids were not answered. For multiple choice, the optional reason. */
  answers: Map<number, string>
  /** Multiple choice only: the option picked per question id. */
  choices?: Map<number, OptionLetter> | undefined
  /** Text that could not be split into numbered answers; the model grades it against every question. */
  freeform?: string | undefined
  deadReckoning: boolean
  /** True when the comment contains nothing gradable. */
  empty: boolean
}

const COMMAND = /^\s*\/ownership(?=\s|$)/i
const DEAD_RECKONING = /^\s*(?:[-*+]\s*)?\[([ xX✓✔])\]\s*.*dead[\s-]*reckoning/i
const NUMBER_MARKER =
  /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:(?:q|question|answer|r|réponse|reponse)\s*)?(\d{1,2})\s*(?:\*\*|__)?\s*[.):\-–]\s*(?:\*\*|__)?/i
const FENCE = /^\s*(```|~~~)/
const PLACEHOLDERS = new Set([
  'your answer',
  'ta réponse',
  'ta reponse',
  '...',
  '…',
  '?',
  'todo',
  'tbd'
])
const SEPARATORS = '\\s,;|/.()\\-'
/** "1B 2A 3D", "1-b, 2-a", "1) C": nothing but question numbers and letters. */
const ONLY_PAIRS = new RegExp(
  `^(?:[${SEPARATORS}]*\\d{1,2}\\s*[-.:)=]?\\s*\\(?[a-z]\\)?(?![a-z]))+[${SEPARATORS}]*$`,
  'i'
)
const PAIR = /(\d{1,2})\s*[-.:)=]?\s*\(?([a-z])\)?(?![a-z])/gi
/** "B A D", "b, a, d" or "BAD": letters in question order. */
const ONLY_LETTERS = new RegExp(`^[${SEPARATORS}]*(?:[a-d][${SEPARATORS}]*)+$`, 'i')
/** The letter opening a numbered answer, optionally followed by a reason: "B", "(b)", "B. because...". */
const LEADING_LETTER = /^\(?([a-z])\)?(?=$|[\s.,:;)\-–—])[\s.,:;)\-–—]*/i

/**
 * Hidden markers at the end of the checkbox lines of a multiple-choice quiz comment. Model text cannot
 * forge them: sanitize() escapes "<" outside code spans and breaks "<!--" inside them.
 */
export const pickMarker = (id: number, letter: OptionLetter): string =>
  `<!-- ownership:pick ${id} ${letter} -->`
export const SUBMIT_MARKER = '<!-- ownership:submit -->'
export const DEAD_RECKONING_MARKER = '<!-- ownership:dead-reckoning -->'
const TICK_LINE =
  /^\s*[-*+]\s+\[([ xX])\].*(<!-- ownership:(?:pick (\d{1,2}) ([A-D])|submit|dead-reckoning) -->)\s*$/

export interface TickedAnswers extends ParsedAnswers {
  /** The author ticked "Done". */
  submitted: boolean
  /** Questions with more than one box ticked. */
  conflicts: number[]
}

/** Reads the boxes ticked in the quiz comment itself. */
export function parseTicks(
  body: string,
  questions: readonly { id: number; options?: readonly string[] | undefined }[]
): TickedAnswers {
  const ticked = new Map<number, OptionLetter[]>()
  let submitted = false
  let deadReckoning = false
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const match = TICK_LINE.exec(line)
    if (!match || match[1] === ' ') continue
    if (match[2] === SUBMIT_MARKER) submitted = true
    else if (match[2] === DEAD_RECKONING_MARKER) deadReckoning = true
    else {
      const id = Number(match[3])
      ticked.set(id, [...(ticked.get(id) ?? []), match[4] as OptionLetter])
    }
  }

  const choices = new Map<number, OptionLetter>()
  const conflicts: number[] = []
  for (const question of questions) {
    const letters = (ticked.get(question.id) ?? []).filter(
      letter => OPTION_LETTERS.indexOf(letter) < (question.options?.length ?? 0)
    )
    if (letters.length > 1) conflicts.push(question.id)
    else if (letters[0]) choices.set(question.id, letters[0])
  }
  return {
    answers: new Map(),
    choices,
    deadReckoning,
    empty: choices.size === 0,
    submitted,
    conflicts
  }
}

/** Unticks "Done" in a quiz comment body, keeping the other boxes as the author left them. */
export function untickSubmit(body: string): string {
  return body
    .split('\n')
    .map(line => (line.includes(SUBMIT_MARKER) ? line.replace(/\[[xX]\]/, '[ ]') : line))
    .join('\n')
}

/**
 * Copies the author's ticks (options and Dead Reckoning, never "Done") from the current quiz comment to
 * a re-rendered one, so a push does not wipe answers in progress. Only valid when the questions did not
 * change.
 */
export function carryTicks(previous: string, next: string): string {
  const ticked = new Set<string>()
  for (const line of previous.split('\n')) {
    const match = TICK_LINE.exec(line)
    if (match && match[1] !== ' ' && match[2] !== SUBMIT_MARKER) ticked.add(match[2] as string)
  }
  return next
    .split('\n')
    .map(line => {
      const match = TICK_LINE.exec(line)
      return match && ticked.has(match[2] as string) ? line.replace('[ ]', '[x]') : line
    })
    .join('\n')
}

/** Whether a comment is an OwnerShip answer: its first line starts with "/ownership". */
export function isOwnershipCommand(body: string | undefined | null): boolean {
  return !!body && COMMAND.test(body)
}

/**
 * Parses "/ownership" replies. Numbered answers ("1.", "1)", "**1.**", "Q1:") are split per question;
 * quoted lines and code fences (from copying the template) are ignored, and the Dead Reckoning box is
 * read from its checkbox line.
 */
export function parseAnswers(body: string, questionIds: readonly number[]): ParsedAnswers {
  const { content, deadReckoning } = readLines(body)

  const answers = new Map<number, string>()
  const known = new Set(questionIds)
  let currentId: number | undefined
  let buffer: string[] = []
  const preamble: string[] = []
  const flush = (): void => {
    if (currentId !== undefined) answers.set(currentId, clean(buffer.join('\n')))
    buffer = []
  }

  for (const line of content) {
    const marker = NUMBER_MARKER.exec(line)
    const id = marker ? Number(marker[1]) : undefined
    // Only accept the next questions in increasing order, so numbered lists inside an answer stay put.
    if (id !== undefined && known.has(id) && (currentId === undefined || id > currentId)) {
      flush()
      currentId = id
      buffer.push(line.slice(marker![0].length))
    } else if (currentId === undefined) {
      preamble.push(line)
    } else {
      buffer.push(line)
    }
  }
  flush()

  for (const [id, text] of answers) {
    if (!text || PLACEHOLDERS.has(text.toLowerCase())) answers.delete(id)
  }

  let freeform: string | undefined
  const leftover = clean(preamble.join('\n'))
  if (answers.size === 0 && leftover) {
    if (questionIds.length === 1) answers.set(questionIds[0] as number, leftover)
    else freeform = leftover
  }

  return { answers, freeform, deadReckoning, empty: answers.size === 0 && !freeform }
}

/**
 * Parses "/ownership" replies to a multiple-choice quiz. Besides one numbered answer per line
 * ("1. B", optionally followed by a reason), it accepts the short forms "1B 2A 3D" and "B A D".
 * Letters outside a question's options are ignored.
 */
export function parseChoiceAnswers(
  body: string,
  questions: readonly { id: number; options?: readonly string[] | undefined }[]
): ParsedAnswers {
  const optionCount = new Map(
    questions.map(q => [q.id, q.options?.length ?? OPTION_LETTERS.length])
  )
  const choices = new Map<number, OptionLetter>()
  const pick = (id: number | undefined, letter: string | undefined): boolean => {
    const index = OPTION_LETTERS.indexOf(letter?.toUpperCase() as OptionLetter)
    const count = id === undefined ? undefined : optionCount.get(id)
    if (id === undefined || count === undefined || index < 0 || index >= count) return false
    choices.set(id, OPTION_LETTERS[index] as OptionLetter)
    return true
  }

  const { content, deadReckoning } = readLines(body)
  const text = content.join('\n').trim()
  const done = (answers = new Map<number, string>(), freeform?: string): ParsedAnswers => ({
    answers,
    choices,
    freeform,
    deadReckoning,
    empty: choices.size === 0 && answers.size === 0 && !freeform
  })

  if (ONLY_PAIRS.test(text)) {
    for (const [, id, letter] of text.matchAll(PAIR)) {
      if (!choices.has(Number(id))) pick(Number(id), letter)
    }
    return done()
  }
  if (ONLY_LETTERS.test(text)) {
    const letters = text.match(/[a-d]/gi) ?? []
    if (letters.length <= questions.length) {
      letters.forEach((letter, index) => pick(questions[index]?.id, letter))
      return done()
    }
  }

  const parsed = parseAnswers(
    body,
    questions.map(q => q.id)
  )
  const reasons = new Map<number, string>()
  for (const [id, answer] of parsed.answers) {
    const match = LEADING_LETTER.exec(answer)
    if (match && pick(id, match[1])) {
      const reason = answer.slice(match[0].length).trim()
      if (reason) reasons.set(id, reason)
    } else {
      // No usable letter: keep the text, the model reads it like an open answer.
      reasons.set(id, answer)
    }
  }
  return done(reasons, parsed.freeform)
}

function readLines(body: string): { content: string[]; deadReckoning: boolean } {
  const lines = body.replace(/\r\n?/g, '\n').replace(COMMAND, '').split('\n')
  let deadReckoning = false
  const content: string[] = []
  for (const line of lines) {
    const box = DEAD_RECKONING.exec(line)
    if (box) {
      deadReckoning = deadReckoning || box[1] !== ' '
      continue
    }
    if (line.trimStart().startsWith('>') || FENCE.test(line)) continue
    content.push(line)
  }
  return { content, deadReckoning }
}

function clean(text: string): string {
  return text.replace(/^\s*(?:\*\*|__)\s*/, '').trim()
}
