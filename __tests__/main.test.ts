import { beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/main.js'
import * as core from './support/core-mock.js'
import { AUTHOR, FakeGitHub, FakeLlm, loadFixture, makeConfig, quizReply } from './support/fakes.js'

vi.mock('@actions/core', () => import('./support/core-mock.js'))
vi.mock('@actions/github', () => ({ context: {}, getOctokit: vi.fn() }))

const prPayload = {
  action: 'opened',
  pull_request: {
    number: 7,
    title: 'Add retries',
    user: AUTHOR,
    head: { sha: 'aaaaaaa1111111', repo: { full_name: 'acme/app' } },
    base: { repo: { full_name: 'acme/app' } }
  }
}
const repo = { owner: 'acme', repo: 'app' }

let gh: FakeGitHub
beforeEach(() => {
  vi.clearAllMocks()
  core.summary.chunks.length = 0
  gh = new FakeGitHub()
  gh.files = loadFixture('feature-pr.json')
})

describe('run', () => {
  it('routes pull_request events and writes outputs and the job summary', async () => {
    const llm = new FakeLlm([quizReply(3)])
    await run({
      context: { eventName: 'pull_request', payload: prPayload, repo },
      config: makeConfig(),
      gh,
      llm
    })
    expect(core.setOutput).toHaveBeenCalledWith('result', 'quiz-posted')
    expect(core.summary.chunks.join('')).toContain('Quiz posted')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails with a clear message when the API key is missing on a same-repo PR', async () => {
    await run({
      context: { eventName: 'pull_request', payload: prPayload, repo },
      config: makeConfig({ apiKey: '' }),
      gh
    })
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('"api-key" is empty'))
  })

  it('fails cleanly when the model keeps returning invalid JSON', async () => {
    const llm = new FakeLlm(['nope', '{"questions": "nope"}'])
    await run({
      context: { eventName: 'pull_request', payload: prPayload, repo },
      config: makeConfig(),
      gh,
      llm
    })
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringMatching(
        /did not return a valid quiz after 2 attempts.*\$\.questions must be an array/
      )
    )
    expect(gh.comments).toHaveLength(0)
  })

  it('refuses pull_request_target and ignores other events', async () => {
    const llm = new FakeLlm()
    await run({
      context: { eventName: 'pull_request_target', payload: prPayload, repo },
      config: makeConfig(),
      gh,
      llm
    })
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('does not run on pull_request_target')
    )
    await run({ context: { eventName: 'push', payload: {}, repo }, config: makeConfig(), gh, llm })
    expect(core.setOutput).toHaveBeenCalledWith('result', 'skipped')
    expect(llm.requests).toHaveLength(0)
  })
})
