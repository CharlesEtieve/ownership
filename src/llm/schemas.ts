import {
  FOCUS_AREAS,
  GRADES,
  OPTION_LETTERS,
  type Focus,
  type Grade,
  type OptionLetter,
  type QuizFormat
} from '../comment/state.js'

export type JsonSchema = Record<string, unknown>

/** Thrown when the model's output does not match the expected shape; the message is fed back to it. */
export class SchemaError extends Error {
  override name = 'SchemaError'
}

export interface GeneratedQuestion {
  question: string
  focus: Focus
  files: string[]
  /** Multiple-choice only: the options and the one the model considers right. */
  options?: string[] | undefined
  answer?: OptionLetter | undefined
}

export interface GeneratedQuiz {
  questions: GeneratedQuestion[]
}

export interface Evaluation {
  id: number
  grade: Grade
  feedback: string
  explanation: string
  /** Multiple-choice only: the right option. */
  correct?: OptionLetter | undefined
}

export interface EvaluationResult {
  evaluations: Evaluation[]
  summary: string
}

// Schemas follow the subset accepted by both Anthropic and OpenAI structured outputs: every object
// lists all its properties as required and forbids additional ones. Counts are checked in code.
export const QUIZ_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'focus', 'files'],
        properties: {
          question: { type: 'string' },
          focus: { type: 'string', enum: [...FOCUS_AREAS] },
          files: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
}

export const CHOICE_QUIZ_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'focus', 'files', 'options', 'answer'],
        properties: {
          question: { type: 'string' },
          focus: { type: 'string', enum: [...FOCUS_AREAS] },
          files: { type: 'array', items: { type: 'string' } },
          options: { type: 'array', items: { type: 'string' } },
          answer: { type: 'string', enum: [...OPTION_LETTERS] }
        }
      }
    }
  }
}

export const EVALUATION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['evaluations', 'summary'],
  properties: {
    evaluations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'grade', 'feedback', 'explanation'],
        properties: {
          id: { type: 'integer' },
          grade: { type: 'string', enum: [...GRADES] },
          feedback: { type: 'string' },
          explanation: { type: 'string' }
        }
      }
    },
    summary: { type: 'string' }
  }
}

export const CHOICE_EVALUATION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['evaluations', 'summary'],
  properties: {
    evaluations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'correct', 'grade', 'feedback', 'explanation'],
        properties: {
          id: { type: 'integer' },
          correct: { type: 'string', enum: [...OPTION_LETTERS] },
          grade: { type: 'string', enum: [...GRADES] },
          feedback: { type: 'string' },
          explanation: { type: 'string' }
        }
      }
    },
    summary: { type: 'string' }
  }
}

const FOCUS_ALIASES: Record<string, Focus> = {
  'edge-case': 'edge-cases',
  edge: 'edge-cases',
  errors: 'error-handling',
  error: 'error-handling',
  'failure-modes': 'error-handling',
  tests: 'testing',
  test: 'testing',
  perf: 'performance',
  architecture: 'design',
  'trade-offs': 'design',
  tradeoffs: 'design'
}

/** Validates a generated quiz. Extra questions are dropped; missing ones are an error. */
export function validateQuiz(
  data: unknown,
  expectedCount: number,
  format: QuizFormat = 'open'
): GeneratedQuiz {
  const root = expectObject(data, '$')
  const questions = expectArray(root.questions, '$.questions')
  if (questions.length < expectedCount) {
    throw new SchemaError(
      `expected ${expectedCount} questions in "questions", got ${questions.length}`
    )
  }
  return {
    questions: questions.slice(0, expectedCount).map((item, index) => {
      const path = `$.questions[${index}]`
      const question = expectObject(item, path)
      const text = expectString(question.question, `${path}.question`).trim()
      if (!text) throw new SchemaError(`${path}.question is empty`)
      return {
        ...(format === 'multiple-choice' ? validateOptions(question, path) : {}),
        question: text,
        focus: normalizeFocus(question.focus),
        files:
          question.files === undefined
            ? []
            : expectArray(question.files, `${path}.files`)
                .filter((file): file is string => typeof file === 'string' && file.trim() !== '')
                .slice(0, 3)
      }
    })
  }
}

function validateOptions(
  question: Record<string, unknown>,
  path: string
): { options: string[]; answer: OptionLetter } {
  const options = expectArray(question.options, `${path}.options`).map((option, index) =>
    expectString(option, `${path}.options[${index}]`)
      .replace(/\s+/g, ' ')
      // Models sometimes prefix options with their letter ("B) ..."); the letter is added on display.
      .replace(/^\(?[A-D]\s*[).:]\s+/i, '')
      .trim()
  )
  if (options.length !== OPTION_LETTERS.length) {
    throw new SchemaError(
      `${path}.options must contain exactly ${OPTION_LETTERS.length} options, got ${options.length}`
    )
  }
  if (options.some(option => !option)) throw new SchemaError(`${path}.options has an empty option`)
  if (new Set(options.map(option => option.toLowerCase())).size !== options.length) {
    throw new SchemaError(`${path}.options must all be different`)
  }
  const answer = expectString(question.answer, `${path}.answer`).trim().toUpperCase()
  if (!isOptionLetter(answer)) {
    throw new SchemaError(`${path}.answer must be one of ${OPTION_LETTERS.join(', ')}`)
  }
  return { options, answer }
}

export function isOptionLetter(value: string): value is OptionLetter {
  return (OPTION_LETTERS as readonly string[]).includes(value)
}

/**
 * Validates an evaluation: one entry per question id, a known grade, non-empty texts. For
 * multiple-choice quizzes, pass the number of options per question id to also require the right option.
 */
export function validateEvaluation(
  data: unknown,
  questionIds: readonly number[],
  optionCounts?: ReadonlyMap<number, number>
): EvaluationResult {
  const root = expectObject(data, '$')
  const items = expectArray(root.evaluations, '$.evaluations')
  const byId = new Map<number, Evaluation>()
  items.forEach((item, index) => {
    const path = `$.evaluations[${index}]`
    const entry = expectObject(item, path)
    const id = typeof entry.id === 'string' ? Number(entry.id) : entry.id
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new SchemaError(`${path}.id must be an integer question id`)
    }
    const grade = expectString(entry.grade, `${path}.grade`).trim().toLowerCase()
    if (!(GRADES as readonly string[]).includes(grade)) {
      throw new SchemaError(`${path}.grade must be one of ${GRADES.join(', ')} (got "${grade}")`)
    }
    if (questionIds.includes(id) && !byId.has(id)) {
      const evaluation: Evaluation = {
        id,
        grade: grade as Grade,
        feedback: expectString(entry.feedback, `${path}.feedback`).trim(),
        explanation: expectString(entry.explanation, `${path}.explanation`).trim()
      }
      const optionCount = optionCounts?.get(id)
      if (optionCount !== undefined) {
        const correct = expectString(entry.correct, `${path}.correct`).trim().toUpperCase()
        if (!OPTION_LETTERS.slice(0, optionCount).includes(correct as OptionLetter)) {
          throw new SchemaError(
            `${path}.correct must be one of ${OPTION_LETTERS.slice(0, optionCount).join(', ')}`
          )
        }
        evaluation.correct = correct as OptionLetter
      }
      byId.set(id, evaluation)
    }
  })
  const missing = questionIds.filter(id => !byId.has(id))
  if (missing.length > 0) {
    throw new SchemaError(`missing evaluations for question id(s) ${missing.join(', ')}`)
  }
  return {
    evaluations: questionIds.map(id => byId.get(id) as Evaluation),
    summary: typeof root.summary === 'string' ? root.summary.trim() : ''
  }
}

function normalizeFocus(value: unknown): Focus {
  if (typeof value !== 'string') return 'design'
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
  if ((FOCUS_AREAS as readonly string[]).includes(key)) return key as Focus
  return FOCUS_ALIASES[key] ?? 'design'
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SchemaError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new SchemaError(`${path} must be an array`)
  return value
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new SchemaError(`${path} must be a string`)
  return value
}
