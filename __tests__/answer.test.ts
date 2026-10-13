import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeState } from '../src/comment/state.js'
import { handleIssueComment, type IssueCommentEvent } from '../src/handlers/answer.js'
import { handlePullRequest } from '../src/handlers/quiz.js'
import {
  AUTHOR,
  evaluationReply,
  FakeGitHub,
  FakeLlm,
  loadFixture,
  makeDeps,
  quizReply
} from './support/fakes.js'

vi.mock('@actions/core', () => import('./support/core-mock.js'))

let gh: FakeGitHub
let llm: FakeLlm

async function postQuiz(): Promise<void> {
  llm.push(quizReply(3))
  await handlePullRequest(
    {
      action: 'opened',
      pull_request: {
        number: 7,
        title: 'Add retries',
        user: AUTHOR,
        head: { sha: 'aaaaaaa1111111', repo: { full_name: 'acme/app' } },
        base: { repo: { full_name: 'acme/app' } }
      }
    },
    makeDeps(gh, llm)
  )
}

let commentId = 1
function answer(body: string, user = AUTHOR): IssueCommentEvent {
  return {
    action: 'created',
    issue: { number: 7, user: AUTHOR, pull_request: {} },
    comment: { id: commentId++, body, html_url: 'https://github.com/acme/app/pull/7#c', user }
  }
}

const ANSWERS =
  '/ownership\n1. Only transient errors.\n2. It throws after the last try.\n3. With a fake fetch.'

beforeEach(async () => {
  vi.clearAllMocks()
  gh = new FakeGitHub()
  gh.files = loadFixture('feature-pr.json')
  llm = new FakeLlm()
  await postQuiz()
})

describe('handleIssueComment', () => {
  it('evaluates the author answers, replies, updates the quiz and labels the PR', async () => {
    llm.push(evaluationReply(['solid', 'partial', 'solid']))
    const outcome = await handleIssueComment(
      answer(`${ANSWERS}\n- [x] Dead Reckoning`),
      makeDeps(gh, llm)
    )

    expect(outcome).toMatchObject({ kind: 'evaluated', rank: 'navigator' })
    const [debrief] = gh.botReplies()
    expect(debrief?.body).toContain('### 2. 🟡 Partial')
    expect(debrief?.body).toContain('**What a strong answer covers:** Explanation 2')
    expect(debrief?.body).toContain('Badge earned: **🧭 Navigator**')
    expect(debrief?.body).toContain('Dead Reckoning noted')

    const state = decodeState(gh.quizComments()[0]?.body)
    expect(state).toMatchObject({
      status: 'evaluated',
      attempts: 1,
      result: {
        rank: 'navigator',
        grades: ['solid', 'partial', 'solid'],
        deadReckoning: true,
        debriefUrl: debrief?.html_url
      }
    })
    expect([...gh.labels].sort()).toEqual(['🗺️ Dead Reckoning', '🧭 Navigator'])
    expect(gh.reactions).toEqual([{ commentId: expect.any(Number), reaction: 'eyes' }])
    expect(outcome.summary).toContain('| 2 |')

    // The model received the questions and the fenced answers.
    const prompt = llm.requests.at(-1)?.prompt ?? ''
    expect(prompt).toContain('<answer_2-n0nce>\nIt throws after the last try.\n</answer_2-n0nce>')
  })

  it('keeps the best attempt and swaps rank labels when improving', async () => {
    llm.push(evaluationReply(['solid', 'missing', 'solid']))
    await handleIssueComment(answer(ANSWERS), makeDeps(gh, llm))
    expect([...gh.labels]).toEqual(['⚓ Deckhand'])

    llm.push(evaluationReply(['solid', 'solid', 'solid']))
    await handleIssueComment(answer(ANSWERS), makeDeps(gh, llm))
    expect([...gh.labels]).toEqual(['🏴‍☠️ Captain'])
    expect(gh.botReplies().at(-1)?.body).toContain('The ship is yours, Captain!')

    llm.push(evaluationReply(['partial', 'partial', 'partial']))
    await handleIssueComment(answer(ANSWERS), makeDeps(gh, llm))
    expect([...gh.labels]).toEqual(['🏴‍☠️ Captain'])
    expect(gh.botReplies().at(-1)?.body).toContain('**🏴‍☠️ Captain** stays your badge')
    expect(decodeState(gh.quizComments()[0]?.body)).toMatchObject({
      attempts: 3,
      result: { rank: 'captain' }
    })
  })

  it('stops calling the model once all attempts are used', async () => {
    for (let i = 0; i < 2; i++) {
      llm.push(evaluationReply(['partial', 'partial', 'partial']))
      await handleIssueComment(answer(ANSWERS), makeDeps(gh, llm, { maxAttempts: 2 }))
    }
    expect(gh.botReplies().at(-1)?.body).toContain('That was your last attempt')
    const calls = llm.requests.length
    const outcome = await handleIssueComment(answer(ANSWERS), makeDeps(gh, llm, { maxAttempts: 2 }))
    expect(outcome.kind).toBe('skipped')
    expect(llm.requests).toHaveLength(calls)
    expect(gh.botReplies().at(-1)?.body).toContain('You have used all 2 attempts')
  })

  it('ignores other people, other comments and plain issues', async () => {
    const deps = makeDeps(gh, llm)
    const reviewer = { login: 'reviewer', type: 'User' }
    expect((await handleIssueComment(answer(ANSWERS, reviewer), deps)).kind).toBe('skipped')
    expect((await handleIssueComment(answer('LGTM'), deps)).kind).toBe('skipped')
    expect(
      (await handleIssueComment({ ...answer(ANSWERS), issue: { number: 3, user: AUTHOR } }, deps))
        .kind
    ).toBe('skipped')
    expect((await handleIssueComment({ ...answer(ANSWERS), action: 'edited' }, deps)).kind).toBe(
      'skipped'
    )
    expect(llm.requests).toHaveLength(1) // only the quiz generation
    expect(gh.botReplies()).toHaveLength(0)
  })

  it('does nothing when the PR has no quiz (for example a fork PR)', async () => {
    gh.comments = []
    const outcome = await handleIssueComment(answer(ANSWERS), makeDeps(gh, llm))
    expect(outcome.summary).toContain('no OwnerShip quiz')
    expect(llm.requests).toHaveLength(1)
  })

  it('replies with the template when the answers are empty, without using an attempt', async () => {
    const outcome = await handleIssueComment(answer('/ownership'), makeDeps(gh, llm))
    expect(outcome.kind).toBe('skipped')
    expect(gh.botReplies()[0]?.body).toContain('I could not find any answers')
    expect(gh.botReplies()[0]?.body).toContain(
      '/ownership\n1. your answer\n2. your answer\n3. your answer'
    )
    expect(decodeState(gh.quizComments()[0]?.body)?.attempts).toBe(0)
  })

  it('marks the commit status as answered when fail-on-unanswered is on', async () => {
    llm.push(evaluationReply(['missing', 'missing', 'missing']))
    await handleIssueComment(answer(ANSWERS), makeDeps(gh, llm, { failOnUnanswered: true }))
    expect(gh.statuses.at(-1)).toMatchObject({ state: 'success', description: 'Quiz answered' })
    expect([...gh.labels]).toEqual(['⚓ Deckhand'])
  })

  it('sanitises model feedback before posting it', async () => {
    const reply = evaluationReply(['solid', 'solid', 'solid'])
    reply.evaluations[0]!.feedback =
      'Great! cc @acme/security-team ![x](https://evil.example/?d=1) <script>alert(1)</script>'
    llm.push(reply)
    await handleIssueComment(answer(ANSWERS), makeDeps(gh, llm))
    const body = gh.botReplies()[0]?.body ?? ''
    expect(body).not.toContain('@acme')
    expect(body).not.toContain('<script>')
    expect(body).not.toContain('![x]')
  })
})
