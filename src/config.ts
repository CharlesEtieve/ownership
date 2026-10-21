import * as core from '@actions/core'
import { FORMATS, type QuizFormat } from './comment/state.js'

export const PROVIDERS = ['anthropic', 'openai', 'openai-compatible'] as const
export type Provider = (typeof PROVIDERS)[number]

export interface Config {
  provider: Provider
  model: string
  apiKey: string
  baseUrl: string | undefined
  githubToken: string
  format: QuizFormat
  questions: number
  language: string
  maxDiffChars: number
  excludePaths: string[]
  minChangedLines: number
  failOnUnanswered: boolean
  maxAttempts: number
}

/** Raised for problems the user can fix (bad input, unsupported event, model misbehaving). */
export class OwnershipError extends Error {
  override name = 'OwnershipError'
}

export type InputReader = (name: string) => string

const MIN_QUESTIONS = 1
const MAX_QUESTIONS = 5

export function readConfig(read: InputReader = name => core.getInput(name)): Config {
  const provider = read('provider').trim().toLowerCase() || 'anthropic'
  if (!isProvider(provider)) {
    throw new OwnershipError(
      `Unsupported provider "${provider}". Use one of: ${PROVIDERS.join(', ')}.`
    )
  }

  const model = read('model').trim()
  if (!model) {
    throw new OwnershipError('The "model" input is required (for example "claude-opus-5-5").')
  }

  const baseUrl = read('base-url').trim() || undefined
  if (provider === 'openai-compatible' && !baseUrl) {
    throw new OwnershipError(
      'The "openai-compatible" provider needs a "base-url" (for example "http://localhost:11434/v1" for Ollama).'
    )
  }
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    throw new OwnershipError(`"base-url" must start with http:// or https:// (got "${baseUrl}").`)
  }

  const format = read('format').trim().toLowerCase() || 'multiple-choice'
  if (!(FORMATS as readonly string[]).includes(format)) {
    throw new OwnershipError(`Unsupported format "${format}". Use one of: ${FORMATS.join(', ')}.`)
  }

  const apiKey = read('api-key').trim()
  if (apiKey) core.setSecret(apiKey)

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    githubToken: read('github-token').trim(),
    format: format as QuizFormat,
    questions: clamp(
      parseInteger(read('questions'), 'questions', 3),
      MIN_QUESTIONS,
      MAX_QUESTIONS,
      'questions'
    ),
    language: read('language').trim() || 'en',
    maxDiffChars: clamp(
      parseInteger(read('max-diff-chars'), 'max-diff-chars', 40_000),
      2_000,
      500_000,
      'max-diff-chars'
    ),
    excludePaths: parseList(read('exclude-paths')),
    minChangedLines: Math.max(0, parseInteger(read('min-changed-lines'), 'min-changed-lines', 10)),
    failOnUnanswered: parseBoolean(read('fail-on-unanswered'), 'fail-on-unanswered', false),
    maxAttempts: clamp(parseInteger(read('max-attempts'), 'max-attempts', 3), 1, 10, 'max-attempts')
  }
}

/** "provider/model", shown in comments and logs. */
export function modelLabel(config: Pick<Config, 'provider' | 'model'>): string {
  return `${config.provider}/${config.model}`
}

/** Whether the provider needs an API key (local OpenAI-compatible servers usually don't). */
export function requiresApiKey(provider: Provider): boolean {
  return provider !== 'openai-compatible'
}

function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value)
}

function parseInteger(raw: string, name: string, fallback: number): number {
  const value = raw.trim()
  if (!value) return fallback
  if (!/^-?\d+$/.test(value)) {
    throw new OwnershipError(`"${name}" must be a whole number (got "${value}").`)
  }
  return Number.parseInt(value, 10)
}

function clamp(value: number, min: number, max: number, name: string): number {
  if (value < min || value > max) {
    core.warning(
      `"${name}" must be between ${min} and ${max}; using ${Math.min(max, Math.max(min, value))}.`
    )
  }
  return Math.min(max, Math.max(min, value))
}

function parseBoolean(raw: string, name: string, fallback: boolean): boolean {
  const value = raw.trim().toLowerCase()
  if (!value) return fallback
  if (['true', 'yes', '1', 'on'].includes(value)) return true
  if (['false', 'no', '0', 'off'].includes(value)) return false
  throw new OwnershipError(`"${name}" must be true or false (got "${raw}").`)
}

/** Splits a multi-line or comma-separated input into trimmed, non-empty entries. */
export function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && !entry.startsWith('#'))
}
