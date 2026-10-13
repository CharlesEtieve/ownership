import { describe, expect, it } from 'vitest'
import { isBetter, rankFor } from '../src/badges.js'
import { messagesFor, languageName } from '../src/comment/i18n.js'
import { renderDebrief, renderQuizComment, sanitize } from '../src/comment/render.js'
import { decodeState, type QuizState } from '../src/comment/state.js'

const base: QuizState = {
  v: 1,
  quizSha: 'aaaaaaa1111111',
  headSha: 'aaaaaaa1111111',
  diffHash: 'sha256:00',
  changedLines: 50,
  sourceFiles: ['src/a.ts'],
  questions: [
    {
      id: 1,
      text: 'Why retry only on 429 and 5xx?',
      focus: 'design',
      files: ['src/http/client.ts']
    },
    { id: 2, text: 'What happens when `Retry-After` is a date?', focus: 'edge-cases', files: [] }
  ],
  status: 'pending',
  attempts: 0,
  refreshes: 0
}

const render = (state: QuizState, language = 'en'): string =>
  renderQuizComment({
    state,
    author: 'octocat',
    messages: messagesFor(language),
    modelLabel: 'anthropic/claude-opus-5-5',
    maxAttempts: 3
  })

describe('sanitize', () => {
  it('neutralises HTML, images and mentions outside code', () => {
    const out = sanitize(
      'Hi @everyone <img src=x> ![leak](https://evil.example/?d=1) <!-- ownership:state {} -->'
    )
    expect(out).not.toMatch(/@everyone/)
    expect(out).toContain('@​everyone')
    expect(out).not.toContain('<img')
    expect(out).toContain('!\\[leak]')
    expect(out).not.toContain('<!--')
  })

  it('leaves code spans readable', () => {
    expect(sanitize('Use `Map<string, number>` here')).toBe('Use `Map<string, number>` here')
    expect(sanitize('`<!-- x -->`')).not.toContain('<!--')
  })

  it('clips very long text', () => {
    expect(sanitize('a'.repeat(5_000)).length).toBeLessThanOrEqual(2_001)
  })
})

describe('renderQuizComment', () => {
  it('starts with the state marker and explains how to answer', () => {
    const body = render(base)
    expect(body.startsWith('<!-- ownership:state ')).toBe(true)
    expect(decodeState(body)).toEqual(base)
    expect(body).toContain('Hey @octocat!')
    expect(body).toContain('**1. Why retry only on 429 and 5xx?**')
    expect(body).toContain('`src/http/client.ts`')
    expect(body).toContain('/ownership\n1. your answer\n2. your answer')
    expect(body).toContain('- [ ] ⚓ Dead Reckoning: I answered without AI help')
    expect(body).toContain('waiting for your answers')
  })

  it('shows the result, refreshes and new commits', () => {
    const body = render({
      ...base,
      status: 'evaluated',
      attempts: 1,
      refreshes: 1,
      headSha: 'bbbbbbb2222222',
      result: {
        grades: ['solid', 'partial'],
        rank: 'navigator',
        deadReckoning: false,
        debriefUrl: 'https://x/1'
      }
    })
    expect(body).toContain(
      'Best result: **🧭 Navigator** (1/2 solid), see the [debrief](https://x/1).'
    )
    expect(body).toContain('Attempts used: 1/3.')
    expect(body).toContain('Questions refreshed')
    expect(body).toContain('`aaaaaaa` → `bbbbbbb`')
  })

  it('uses French interface texts when asked', () => {
    const body = render(base, 'fr')
    expect(body).toContain('Salut @octocat !')
    expect(body).toContain('1. ta réponse')
  })
})

describe('renderDebrief', () => {
  it('explains every answer and invites another try', () => {
    const body = renderDebrief({
      state: { ...base, attempts: 1, status: 'evaluated' },
      author: 'octocat',
      messages: messagesFor('en'),
      evaluations: [
        {
          id: 1,
          grade: 'solid',
          feedback: 'Spot on.',
          explanation: 'Only transient errors are worth retrying.'
        },
        {
          id: 2,
          grade: 'missing',
          feedback: 'No answer yet.',
          explanation: 'Dates parse to NaN, so it falls back to backoff.'
        }
      ],
      summary: 'Good start.',
      attemptRank: 'deckhand',
      bestRank: 'deckhand',
      improved: true,
      deadReckoning: true,
      maxAttempts: 3
    })
    expect(body).toContain('### 1. 🟢 Solid')
    expect(body).toContain('### 2. ⚪ Missing')
    expect(body).toContain('**What a strong answer covers:** Dates parse to NaN')
    expect(body).toContain('Badge earned: **⚓ Deckhand**')
    expect(body).toContain('Dead Reckoning noted')
    expect(body).toContain('2 attempts left')
  })
})

describe('badges', () => {
  it('ranks attempts', () => {
    expect(rankFor(['solid', 'solid'])).toBe('captain')
    expect(rankFor(['solid', 'partial'])).toBe('navigator')
    expect(rankFor(['solid', 'missing'])).toBe('deckhand')
  })

  it('keeps the best attempt', () => {
    const navigator = {
      grades: ['solid', 'partial'] as const,
      rank: 'navigator' as const,
      deadReckoning: false
    }
    const better = {
      grades: ['partial', 'solid'] as const,
      rank: 'navigator' as const,
      deadReckoning: false
    }
    const captain = {
      grades: ['solid', 'solid'] as const,
      rank: 'captain' as const,
      deadReckoning: false
    }
    expect(
      isBetter(
        { ...captain, grades: [...captain.grades] },
        { ...navigator, grades: [...navigator.grades] }
      )
    ).toBe(true)
    expect(
      isBetter(
        { ...navigator, grades: [...navigator.grades] },
        { ...captain, grades: [...captain.grades] }
      )
    ).toBe(false)
    expect(
      isBetter(
        { ...better, grades: [...better.grades] },
        { ...navigator, grades: [...navigator.grades] }
      )
    ).toBe(false)
    expect(isBetter({ ...navigator, grades: [...navigator.grades] }, undefined)).toBe(true)
  })
})

describe('languages', () => {
  it('names languages for the prompt', () => {
    expect(languageName('fr')).toBe('French')
    expect(languageName('pt-BR')).toBe('Brazilian Portuguese')
    expect(languageName('Klingon')).toBe('Klingon')
  })

  it('falls back to English interface texts', () => {
    expect(messagesFor('de').howToAnswerTitle).toBe('How to answer')
    expect(messagesFor('fr-CA').howToAnswerTitle).toBe('Comment répondre')
    expect(messagesFor('français').howToAnswerTitle).toBe('Comment répondre')
  })
})
