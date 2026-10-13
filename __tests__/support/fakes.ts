import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { LabelSpec } from '../../src/badges.js'
import type { Config } from '../../src/config.js'
import type { PrFile } from '../../src/diff/filter.js'
import type {
  GitHubApi,
  IssueComment,
  PullRequestInfo,
  Reaction,
  StatusState
} from '../../src/github.js'
import type { Deps } from '../../src/handlers/shared.js'
import type { CompletionRequest, LlmClient } from '../../src/llm/provider.js'

export function loadFixture(name: string): PrFile[] {
  const path = fileURLToPath(new URL(`../../__fixtures__/files/${name}`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as PrFile[]
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    apiKey: 'sk-test-key',
    baseUrl: undefined,
    githubToken: 'gh-token',
    questions: 3,
    language: 'en',
    maxDiffChars: 40_000,
    excludePaths: [],
    minChangedLines: 10,
    failOnUnanswered: false,
    maxAttempts: 3,
    ...overrides
  }
}

export const BOT = { login: 'github-actions[bot]', type: 'Bot' }
export const AUTHOR = { login: 'octocat', type: 'User' }

/** In-memory GitHub, recording every write. */
export class FakeGitHub implements GitHubApi {
  files: PrFile[] = []
  comments: IssueComment[] = []
  labels = new Set<string>()
  createdLabels: LabelSpec[] = []
  statuses: { sha: string; state: StatusState; description: string }[] = []
  reactions: { commentId: number; reaction: Reaction }[] = []
  updates = 0
  private nextId = 1000

  pr: PullRequestInfo = {
    number: 7,
    title: 'Add retries to the HTTP client',
    body: 'Retries 429 and 5xx responses.',
    draft: false,
    headSha: 'aaaaaaa1111111',
    author: AUTHOR,
    isFork: false
  }

  async getPullRequest(): Promise<PullRequestInfo> {
    return this.pr
  }
  async listFiles(): Promise<PrFile[]> {
    return this.files
  }
  async listComments(): Promise<IssueComment[]> {
    return this.comments.map(comment => ({ ...comment }))
  }
  async createComment(number: number, body: string): Promise<IssueComment> {
    const id = this.nextId++
    const comment = {
      id,
      body,
      html_url: `https://github.com/acme/app/pull/${number}#issuecomment-${id}`,
      user: BOT
    }
    this.comments.push(comment)
    return { ...comment }
  }
  async updateComment(id: number, body: string): Promise<void> {
    const comment = this.comments.find(c => c.id === id)
    if (!comment) throw new Error(`no comment ${id}`)
    comment.body = body
    this.updates++
  }
  async addReaction(commentId: number, reaction: Reaction): Promise<void> {
    this.reactions.push({ commentId, reaction })
  }
  async addLabels(_number: number, labels: readonly LabelSpec[]): Promise<void> {
    for (const label of labels) {
      this.labels.add(label.name)
      if (!this.createdLabels.some(l => l.name === label.name)) this.createdLabels.push(label)
    }
  }
  async removeLabels(_number: number, names: readonly string[]): Promise<void> {
    for (const name of names) this.labels.delete(name)
  }
  async setStatus(sha: string, state: StatusState, description: string): Promise<void> {
    this.statuses.push({ sha, state, description })
  }

  /** Comments written by the action, excluding the quiz. */
  botReplies(): IssueComment[] {
    return this.comments.filter(c => c.user?.type === 'Bot' && !c.body.includes('ownership:state'))
  }
  quizComments(): IssueComment[] {
    return this.comments.filter(c => c.body.includes('ownership:state'))
  }
}

/** Model double: answers from a queue and records the requests it got. */
export class FakeLlm implements LlmClient {
  readonly label = 'anthropic/claude-opus-5-5'
  requests: CompletionRequest[] = []
  constructor(private readonly replies: (string | object)[] = []) {}
  push(...replies: (string | object)[]): this {
    this.replies.push(...replies)
    return this
  }
  async complete(request: CompletionRequest): Promise<string> {
    this.requests.push(request)
    const reply = this.replies.shift()
    if (reply === undefined) throw new Error('FakeLlm: no reply queued')
    return typeof reply === 'string' ? reply : JSON.stringify(reply)
  }
}

export function makeDeps(gh: FakeGitHub, llm: FakeLlm, config: Partial<Config> = {}): Deps {
  return { gh, config: makeConfig(config), llm: () => llm, nonce: () => 'n0nce' }
}

export interface QuizReply {
  questions: { question: string; focus: string; files: string[] }[]
}

export function quizReply(count = 3): QuizReply {
  const focus = ['design', 'error-handling', 'testing', 'impact', 'edge-cases']
  return {
    questions: Array.from({ length: count }, (_, i) => ({
      question: `Why does the client handle case ${i + 1} this way?`,
      focus: focus[i % focus.length] as string,
      files: ['src/http/client.ts']
    }))
  }
}

export interface EvaluationReply {
  evaluations: { id: number; grade: string; feedback: string; explanation: string }[]
  summary: string
}

export function evaluationReply(grades: string[]): EvaluationReply {
  return {
    evaluations: grades.map((grade, i) => ({
      id: i + 1,
      grade,
      feedback: `Feedback ${i + 1}`,
      explanation: `Explanation ${i + 1}`
    })),
    summary: 'Nice work overall.'
  }
}
