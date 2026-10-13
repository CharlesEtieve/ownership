import { describe, expect, it, vi } from 'vitest'
import { OwnershipError, parseList, readConfig } from '../src/config.js'
import * as core from './support/core-mock.js'

vi.mock('@actions/core', () => import('./support/core-mock.js'))

const reader = (inputs: Record<string, string>) => (name: string) => inputs[name] ?? ''

describe('readConfig', () => {
  it('applies defaults', () => {
    const config = readConfig(reader({ model: 'claude-opus-5-5', 'api-key': 'secret' }))
    expect(config).toMatchObject({
      provider: 'anthropic',
      questions: 3,
      language: 'en',
      maxDiffChars: 40_000,
      minChangedLines: 10,
      failOnUnanswered: false,
      maxAttempts: 3,
      excludePaths: []
    })
    expect(core.setSecret).toHaveBeenCalledWith('secret')
  })

  it('validates inputs with clear messages', () => {
    expect(() => readConfig(reader({}))).toThrow('"model" input is required')
    expect(() => readConfig(reader({ model: 'm', provider: 'gemini' }))).toThrow(
      'Unsupported provider "gemini"'
    )
    expect(() => readConfig(reader({ model: 'm', provider: 'openai-compatible' }))).toThrow(
      'needs a "base-url"'
    )
    expect(() => readConfig(reader({ model: 'm', questions: 'three' }))).toThrow(OwnershipError)
    expect(() => readConfig(reader({ model: 'm', 'fail-on-unanswered': 'maybe' }))).toThrow(
      'true or false'
    )
  })

  it('clamps out-of-range numbers', () => {
    const config = readConfig(reader({ model: 'm', questions: '12', 'max-diff-chars': '10' }))
    expect(config.questions).toBe(5)
    expect(config.maxDiffChars).toBe(2_000)
    expect(core.warning).toHaveBeenCalled()
  })
})

describe('parseList', () => {
  it('splits on newlines and commas and skips comments', () => {
    expect(parseList('docs/**, *.md\n# comment\n\n  !keep.md  ')).toEqual([
      'docs/**',
      '*.md',
      '!keep.md'
    ])
  })
})
