import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeState } from '../src/comment/state.js'
import { handlePullRequest, type PullRequestEvent } from '../src/handlers/quiz.js'
import * as core from './support/core-mock.js'
import { AUTHOR, FakeGitHub, FakeLlm, loadFixture, makeDeps, quizReply } from './support/fakes.js'

vi.mock('@actions/core', () => import('./support/core-mock.js'))

function event(
  overrides: Partial<NonNullable<PullRequestEvent['pull_request']>> = {},
  action = 'opened'
): PullRequestEvent {
  return {
    action,
    pull_request: {
      number: 7,
      title: 'Add retries to the HTTP client',
      body: 'Retries 429 and 5xx responses.',
      draft: false,
      user: AUTHOR,
      head: { sha: 'aaaaaaa1111111', repo: { full_name: 'acme/app' } },
      base: { repo: { full_name: 'acme/app' } },
      ...overrides
    }
  }
}

let gh: FakeGitHub
let llm: FakeLlm

beforeEach(() => {
  vi.clearAllMocks()
  gh = new FakeGitHub()
  gh.files = loadFixture('feature-pr.json')
  llm = new FakeLlm()
})

describe('handlePullRequest: first quiz', () => {
  it('posts a single quiz comment with the state', async () => {
    llm.push(quizReply(3))
    const outcome = await handlePullRequest(event(), makeDeps(gh, llm))

    expect(outcome.kind).toBe('quiz-posted')
    expect(gh.comments).toHaveLength(1)
    const state = decodeState(gh.comments[0]?.body)
    expect(state).toMatchObject({
      quizSha: 'aaaaaaa1111111',
      status: 'pending',
      attempts: 0,
      refreshes: 0
    })
    expect(state?.questions.map(q => q.id)).toEqual([1, 2, 3])
    expect(state?.questions[0]?.files).toEqual(['src/http/client.ts'])
    expect(outcome.summary).toContain('3 questions')

    // The model saw the filtered diff, not the noise.
    const prompt = llm.requests[0]?.prompt ?? ''
    expect(prompt).toContain('=== src/http/client.ts (modified) ===')
    expect(prompt).not.toContain('package-lock.json')
    expect(prompt).not.toContain('openapi-typescript')
  })

  it('never logs the diff itself', async () => {
    llm.push(quizReply(3))
    await handlePullRequest(event(), makeDeps(gh, llm))
    const logged = [...core.info.mock.calls, ...core.debug.mock.calls].flat().join('\n')
    expect(logged).not.toContain('RETRYABLE')
    expect(logged).toContain('characters sent to the model')
  })

  it('skips drafts, bots and unhandled actions without calling the model', async () => {
    expect((await handlePullRequest(event({ draft: true }), makeDeps(gh, llm))).kind).toBe(
      'skipped'
    )
    expect(
      (
        await handlePullRequest(
          event({ user: { login: 'dependabot[bot]', type: 'Bot' } }),
          makeDeps(gh, llm)
        )
      ).kind
    ).toBe('skipped')
    expect((await handlePullRequest(event({}, 'labeled'), makeDeps(gh, llm))).kind).toBe('skipped')
    expect(llm.requests).toHaveLength(0)
    expect(gh.comments).toHaveLength(0)
  })

  it('skips tiny changes', async () => {
    gh.files = loadFixture('tiny-pr.json')
    const outcome = await handlePullRequest(event(), makeDeps(gh, llm))
    expect(outcome.kind).toBe('skipped')
    expect(outcome.summary).toContain(
      'only 5 changed lines after filtering (min-changed-lines: 10)'
    )
  })

  it('explains, without failing, that fork PRs have no secrets', async () => {
    const forkEvent = event({ head: { sha: 'f', repo: { full_name: 'someone/app' } } })
    const outcome = await handlePullRequest(forkEvent, makeDeps(gh, llm, { apiKey: '' }))
    expect(outcome.kind).toBe('skipped')
    expect(core.notice).toHaveBeenCalledWith(
      expect.stringContaining('does not share repository secrets')
    )
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('sets a pending commit status when fail-on-unanswered is on', async () => {
    llm.push(quizReply(3))
    await handlePullRequest(event(), makeDeps(gh, llm, { failOnUnanswered: true }))
    expect(gh.statuses).toEqual([
      {
        sha: 'aaaaaaa1111111',
        state: 'pending',
        description: 'Waiting for the author to answer the quiz'
      }
    ])
  })

  it('does not touch statuses by default', async () => {
    gh.files = loadFixture('tiny-pr.json')
    await handlePullRequest(event(), makeDeps(gh, llm))
    expect(gh.statuses).toEqual([])
  })
})

describe('handlePullRequest: new pushes', () => {
  async function postQuiz(): Promise<void> {
    llm.push(quizReply(3))
    await handlePullRequest(event(), makeDeps(gh, llm))
  }
  const push = (sha: string) =>
    event({ head: { sha, repo: { full_name: 'acme/app' } } }, 'synchronize')

  it('is idempotent for the same commit', async () => {
    await postQuiz()
    const outcome = await handlePullRequest(event({}, 'synchronize'), makeDeps(gh, llm))
    expect(outcome.kind).toBe('unchanged')
    expect(gh.updates).toBe(0)
  })

  it('keeps the questions for a small fixup and notes the new commit', async () => {
    await postQuiz()
    const client = gh.files[0]!
    gh.files[0] = {
      ...client,
      patch: `${client.patch}\n+// small comment`,
      additions: client.additions + 1,
      changes: client.changes + 1
    }
    const outcome = await handlePullRequest(push('bbbbbbb2222222'), makeDeps(gh, llm))

    expect(outcome.kind).toBe('quiz-updated')
    expect(llm.requests).toHaveLength(1)
    expect(gh.comments).toHaveLength(1)
    const state = decodeState(gh.comments[0]?.body)
    expect(state).toMatchObject({
      quizSha: 'aaaaaaa1111111',
      headSha: 'bbbbbbb2222222',
      refreshes: 0
    })
    expect(gh.comments[0]?.body).toContain('`aaaaaaa` → `bbbbbbb`')
  })

  it('regenerates a pending quiz in place when new source files appear', async () => {
    await postQuiz()
    gh.files = [
      ...gh.files,
      {
        filename: 'src/http/circuit-breaker.ts',
        status: 'added',
        additions: 60,
        deletions: 0,
        changes: 60,
        patch: '@@ -0,0 +1,60 @@\n+export class CircuitBreaker {}'
      }
    ]
    llm.push({
      questions: quizReply(3).questions.map(q => ({ ...q, question: `New: ${q.question}` }))
    })
    const outcome = await handlePullRequest(push('ccccccc3333333'), makeDeps(gh, llm))

    expect(outcome.kind).toBe('quiz-refreshed')
    expect(gh.comments).toHaveLength(1)
    const state = decodeState(gh.comments[0]?.body)
    expect(state).toMatchObject({
      quizSha: 'ccccccc3333333',
      headSha: 'ccccccc3333333',
      refreshes: 1
    })
    expect(state?.questions[0]?.text).toMatch(/^New: /)
    expect(state?.sourceFiles).toContain('src/http/circuit-breaker.ts')
  })

  it('never regenerates an answered quiz', async () => {
    await postQuiz()
    const quiz = gh.comments[0]!
    const state = decodeState(quiz.body)!
    quiz.body = quiz.body.replace(
      /<!-- ownership:state .* -->/,
      `<!-- ownership:state ${JSON.stringify({ ...state, status: 'evaluated', attempts: 1, result: { grades: ['solid', 'solid', 'solid'], rank: 'captain', deadReckoning: false } })} -->`
    )
    gh.files = [
      ...gh.files,
      {
        filename: 'src/new.ts',
        status: 'added',
        additions: 500,
        deletions: 0,
        changes: 500,
        patch: '@@ -0,0 +1 @@\n+x'
      }
    ]
    const outcome = await handlePullRequest(
      push('ddddddd4444444'),
      makeDeps(gh, llm, { failOnUnanswered: true })
    )

    expect(outcome.kind).toBe('quiz-updated')
    expect(llm.requests).toHaveLength(1)
    expect(decodeState(gh.comments[0]?.body)).toMatchObject({
      status: 'evaluated',
      headSha: 'ddddddd4444444',
      quizSha: 'aaaaaaa1111111'
    })
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'ddddddd4444444', state: 'success' })
  })
})
