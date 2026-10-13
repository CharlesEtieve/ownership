import { describe, expect, it } from 'vitest'
import { isOwnershipCommand, parseAnswers } from '../src/comment/answers.js'

describe('isOwnershipCommand', () => {
  it.each([
    ['/ownership\n1. a', true],
    ['  /OwnerShip 1. a', true],
    ['/ownership', true],
    ['/ownershipx', false],
    ['I ran /ownership', false],
    ['', false]
  ])('%j → %s', (body, expected) => {
    expect(isOwnershipCommand(body)).toBe(expected)
  })
})

describe('parseAnswers', () => {
  it('splits numbered answers, including multi-line ones', () => {
    const parsed = parseAnswers(
      '/ownership\n1. Because retries hide transient failures.\nThey are capped at 3.\n2) It throws after the last attempt.\n**3.** A unit test with a fake fetch.',
      [1, 2, 3]
    )
    expect(Object.fromEntries(parsed.answers)).toEqual({
      1: 'Because retries hide transient failures.\nThey are capped at 3.',
      2: 'It throws after the last attempt.',
      3: 'A unit test with a fake fetch.'
    })
    expect(parsed.deadReckoning).toBe(false)
    expect(parsed.empty).toBe(false)
  })

  it('reads the Dead Reckoning box and ignores the copied template fence and quotes', () => {
    const parsed = parseAnswers(
      '/ownership\n```text\n> 1. Why retries?\n1. To survive 503s\n2. your answer\n\n- [x] ⚓ Dead Reckoning: I answered without AI help\n```',
      [1, 2]
    )
    expect(Object.fromEntries(parsed.answers)).toEqual({ 1: 'To survive 503s' })
    expect(parsed.deadReckoning).toBe(true)
  })

  it('treats an unticked box as no Dead Reckoning, in any language', () => {
    expect(
      parseAnswers('/ownership\n1. a\n- [ ] ⚓ Dead Reckoning : j’ai répondu sans aide', [1])
        .deadReckoning
    ).toBe(false)
    expect(parseAnswers('/ownership\n1. a\n- [X] Dead reckoning', [1]).deadReckoning).toBe(true)
  })

  it('only moves forward through question numbers, so later lists stay inside an answer', () => {
    const parsed = parseAnswers(
      '/ownership\n1. Steps:\n2. first\n1. back\n2. Second answer',
      [1, 2]
    )
    expect(parsed.answers.get(1)).toBe('Steps:')
    expect(parsed.answers.get(2)).toBe('first\n1. back\n2. Second answer')
  })

  it('accepts "Q1:" and heading styles', () => {
    const parsed = parseAnswers('/ownership\nQ1: alpha\n### 2. beta', [1, 2])
    expect(Object.fromEntries(parsed.answers)).toEqual({ 1: 'alpha', 2: 'beta' })
  })

  it('falls back to free form when nothing is numbered', () => {
    const parsed = parseAnswers(
      '/ownership\nRetries protect us from flaky upstreams; tests cover it.',
      [1, 2]
    )
    expect(parsed.answers.size).toBe(0)
    expect(parsed.freeform).toBe('Retries protect us from flaky upstreams; tests cover it.')
    expect(parsed.empty).toBe(false)
  })

  it('maps free text to the only question when there is one', () => {
    const parsed = parseAnswers('/ownership it avoids a race', [1])
    expect(parsed.answers.get(1)).toBe('it avoids a race')
  })

  it('reports empty answers', () => {
    expect(parseAnswers('/ownership', [1, 2]).empty).toBe(true)
    expect(parseAnswers('/ownership\n1. your answer\n2. ...', [1, 2]).empty).toBe(true)
  })
})
