export const GRADES = ['solid', 'partial', 'missing'] as const
export type Grade = (typeof GRADES)[number]

export const FOCUS_AREAS = [
  'design',
  'edge-cases',
  'error-handling',
  'impact',
  'testing',
  'security',
  'performance'
] as const
export type Focus = (typeof FOCUS_AREAS)[number]

export const RANKS = ['deckhand', 'navigator', 'captain'] as const
export type Rank = (typeof RANKS)[number]

/** "multiple-choice": pick a letter. "open": answer in your own words. */
export const FORMATS = ['multiple-choice', 'open'] as const
export type QuizFormat = (typeof FORMATS)[number]

export const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const
export type OptionLetter = (typeof OPTION_LETTERS)[number]

export interface QuizQuestion {
  id: number
  text: string
  focus: Focus
  files: string[]
  /** Answer options of a multiple-choice question, in letter order. The right one is not stored. */
  options?: string[] | undefined
}

export interface QuizResult {
  grades: Grade[]
  rank: Rank
  deadReckoning: boolean
  /** Link to the debrief comment of the best attempt. */
  debriefUrl?: string | undefined
}

/**
 * Everything OwnerShip remembers about a PR, stored in a hidden HTML comment inside the quiz comment.
 * Expected answers are deliberately absent: anyone can read this marker through the API.
 */
export interface QuizState {
  v: 1
  /** Commit the questions were generated for. */
  quizSha: string
  /** Latest commit seen by the action. */
  headSha: string
  /** Fingerprint, size and source files of the filtered diff the questions were generated from. */
  diffHash: string
  changedLines: number
  sourceFiles: string[]
  /** Absent in states written before multiple-choice quizzes existed, which were all open. */
  format?: QuizFormat | undefined
  questions: QuizQuestion[]
  status: 'pending' | 'evaluated'
  attempts: number
  /** How many times the questions were regenerated after significant pushes. */
  refreshes: number
  result?: QuizResult | undefined
}

const MARKER_PREFIX = '<!-- ownership:state '
const MARKER_SUFFIX = ' -->'
const MARKER_PATTERN = /<!-- ownership:state (\{[^>]*\}) -->/

/**
 * Serialises the state into a hidden HTML comment. "<", ">" and "&" are escaped as JSON unicode
 * escapes, so no string in the state (for example a question written by the model) can close the
 * comment early or smuggle HTML, and the payload stays valid, readable JSON.
 */
export function encodeState(state: QuizState): string {
  const json = JSON.stringify(state)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
  return `${MARKER_PREFIX}${json}${MARKER_SUFFIX}`
}

/** Reads the state from a comment body. Returns undefined when absent or malformed. */
export function decodeState(body: string | undefined | null): QuizState | undefined {
  const match = body ? MARKER_PATTERN.exec(body) : null
  if (!match?.[1]) return undefined
  try {
    const data: unknown = JSON.parse(match[1])
    return isQuizState(data) ? data : undefined
  } catch {
    return undefined
  }
}

export function hasStateMarker(body: string | undefined | null): boolean {
  return !!body && body.includes(MARKER_PREFIX)
}

function isQuizState(data: unknown): data is QuizState {
  if (!isRecord(data) || data.v !== 1) return false
  const stringsOk = ['quizSha', 'headSha', 'diffHash'].every(key => typeof data[key] === 'string')
  const numbersOk = ['changedLines', 'attempts', 'refreshes'].every(
    key => typeof data[key] === 'number' && Number.isInteger(data[key])
  )
  if (!stringsOk || !numbersOk) return false
  if (data.status !== 'pending' && data.status !== 'evaluated') return false
  if (data.format !== undefined && !(FORMATS as readonly unknown[]).includes(data.format)) {
    return false
  }
  if (!Array.isArray(data.sourceFiles) || !data.sourceFiles.every(f => typeof f === 'string')) {
    return false
  }
  if (!Array.isArray(data.questions) || data.questions.length === 0) return false
  const questionsOk = data.questions.every(
    q =>
      isRecord(q) &&
      typeof q.id === 'number' &&
      typeof q.text === 'string' &&
      (FOCUS_AREAS as readonly unknown[]).includes(q.focus) &&
      Array.isArray(q.files) &&
      (q.options === undefined ||
        (Array.isArray(q.options) &&
          q.options.length >= 2 &&
          q.options.length <= OPTION_LETTERS.length &&
          q.options.every(option => typeof option === 'string')))
  )
  if (!questionsOk) return false
  if (data.result === undefined) return true
  const result = data.result
  return (
    isRecord(result) &&
    Array.isArray(result.grades) &&
    result.grades.every(g => (GRADES as readonly unknown[]).includes(g)) &&
    (RANKS as readonly unknown[]).includes(result.rank) &&
    typeof result.deadReckoning === 'boolean'
  )
}

export function formatOf(state: Pick<QuizState, 'format'>): QuizFormat {
  return state.format ?? 'open'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
