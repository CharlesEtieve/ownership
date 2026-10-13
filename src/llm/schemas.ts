import { FOCUS_AREAS, GRADES, type Focus, type Grade } from '../comment/state.js'

export type JsonSchema = Record<string, unknown>

/** Thrown when the model's output does not match the expected shape; the message is fed back to it. */
export class SchemaError extends Error {
  override name = 'SchemaError'
}

export interface GeneratedQuestion {
  question: string
  focus: Focus
  files: string[]
}

export interface GeneratedQuiz {
  questions: GeneratedQuestion[]
}

export interface Evaluation {
  id: number
  grade: Grade
  feedback: string
  explanation: string
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
export function validateQuiz(data: unknown, expectedCount: number): GeneratedQuiz {
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

/** Validates an evaluation: one entry per question id, a known grade, non-empty texts. */
export function validateEvaluation(
  data: unknown,
  questionIds: readonly number[]
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
      byId.set(id, {
        id,
        grade: grade as Grade,
        feedback: expectString(entry.feedback, `${path}.feedback`).trim(),
        explanation: expectString(entry.explanation, `${path}.explanation`).trim()
      })
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
