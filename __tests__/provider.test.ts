import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OwnershipError } from '../src/config.js'
import { completeJson, createClient, endpoint, extractJson } from '../src/llm/provider.js'
import { QUIZ_SCHEMA, validateQuiz } from '../src/llm/schemas.js'
import { FakeLlm, makeConfig, quizReply } from './support/fakes.js'

vi.mock('@actions/core', () => import('./support/core-mock.js'))

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = []
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    })
    const next = responses.shift()
    if (!next) throw new Error('no response queued')
    return next()
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

const json =
  (data: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

const request = {
  system: 'sys',
  prompt: 'user',
  schema: QUIZ_SCHEMA,
  schemaName: 'ownership_quiz',
  maxTokens: 1000
}
const noSleep = async () => {}

describe('anthropic provider', () => {
  it('calls the Messages API with structured outputs and returns the text blocks', async () => {
    const { impl, calls } = fakeFetch([
      json({
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: '{"a":1}' }
        ]
      })
    ])
    const client = createClient(makeConfig(), { fetchImpl: impl })
    expect(await client.complete(request)).toBe('{"a":1}')
    const [call] = calls
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call?.headers['x-api-key']).toBe('sk-test-key')
    expect(call?.headers['anthropic-version']).toBe('2023-06-01')
    expect(call?.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 1000,
      system: 'sys',
      messages: [{ role: 'user', content: 'user' }],
      output_config: { format: { type: 'json_schema', schema: QUIZ_SCHEMA } }
    })
  })

  it('falls back to plain JSON instructions when structured outputs are rejected', async () => {
    const { impl, calls } = fakeFetch([
      json({ error: { message: 'output_config: unsupported for this model' } }, 400),
      json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] })
    ])
    const client = createClient(makeConfig(), { fetchImpl: impl })
    await client.complete(request)
    expect(calls[1]?.body).not.toHaveProperty('output_config')
  })

  it('reports refusals and truncation as unusable output', async () => {
    const { impl } = fakeFetch([
      json({ stop_reason: 'refusal', content: [] }),
      json({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"q' }] })
    ])
    const client = createClient(makeConfig(), { fetchImpl: impl })
    await expect(client.complete(request)).rejects.toThrow('declined')
    await expect(client.complete(request)).rejects.toThrow('cut off')
  })

  it('retries rate limits and server errors, honouring retry-after', async () => {
    const sleep = vi.fn(noSleep)
    const { impl, calls } = fakeFetch([
      () => new Response('{}', { status: 429, headers: { 'retry-after': '3' } }),
      () => new Response('oops', { status: 529 }),
      json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })
    ])
    const client = createClient(makeConfig(), { fetchImpl: impl, sleep })
    expect(await client.complete(request)).toBe('ok')
    expect(calls).toHaveLength(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 3_000)
  })
})

describe('openai providers', () => {
  it('uses a strict JSON schema and max_completion_tokens with OpenAI', async () => {
    const { impl, calls } = fakeFetch([
      json({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })
    ])
    const client = createClient(makeConfig({ provider: 'openai', model: 'gpt-5' }), {
      fetchImpl: impl
    })
    await client.complete(request)
    const [call] = calls
    expect(call?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(call?.headers.authorization).toBe('Bearer sk-test-key')
    expect(call?.body).toMatchObject({
      model: 'gpt-5',
      max_completion_tokens: 1000,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user' }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'ownership_quiz', strict: true, schema: QUIZ_SCHEMA }
      }
    })
  })

  it('talks to a local server without a key and downgrades the response format', async () => {
    const { impl, calls } = fakeFetch([
      json({ error: 'json_schema not supported' }, 400),
      json({ error: 'response_format not supported' }, 400),
      json({
        choices: [{ finish_reason: 'stop', message: { content: '<think>hmm</think>{"ok":true}' } }]
      })
    ])
    const config = makeConfig({
      provider: 'openai-compatible',
      apiKey: '',
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5-coder:14b'
    })
    const client = createClient(config, { fetchImpl: impl })
    expect(extractJson(await client.complete(request))).toEqual({ ok: true })
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(calls[0]?.headers).not.toHaveProperty('authorization')
    expect(calls[0]?.body).toHaveProperty('max_tokens', 1000)
    expect(calls[1]?.body.response_format).toEqual({ type: 'json_object' })
    expect(calls[2]?.body).not.toHaveProperty('response_format')
  })
})

describe('endpoint', () => {
  it('accepts base URLs with or without the version segment', () => {
    expect(endpoint('https://proxy.example/v1/', 'v1', 'messages')).toBe(
      'https://proxy.example/v1/messages'
    )
    expect(endpoint('https://proxy.example/anthropic', 'v1', 'messages')).toBe(
      'https://proxy.example/anthropic/v1/messages'
    )
  })
})

describe('extractJson', () => {
  it('finds JSON inside code fences and prose', () => {
    expect(extractJson('Sure!\n```json\n{"a": [1, 2]}\n```')).toEqual({ a: [1, 2] })
  })

  it('explains failures', () => {
    expect(() => extractJson('no json')).toThrow('no JSON object')
    expect(() => extractJson('{"a": }')).toThrow('not valid JSON')
  })
})

describe('completeJson', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks again once with the validation error', async () => {
    const llm = new FakeLlm(['not json at all', quizReply(1)])
    const quiz = await completeJson(llm, request, data => validateQuiz(data, 1), 'quiz')
    expect(quiz.questions).toHaveLength(1)
    expect(llm.requests[1]?.prompt).toContain(
      'Your previous reply could not be used: the reply contains no JSON object'
    )
  })

  it('fails cleanly after two unusable replies', async () => {
    const llm = new FakeLlm(['{"questions": []}', '{"questions": []}'])
    await expect(completeJson(llm, request, data => validateQuiz(data, 2), 'quiz')).rejects.toThrow(
      /did not return a valid quiz after 2 attempts \(last problem: expected 2 questions/
    )
  })

  it('turns provider errors into actionable messages without leaking the key', async () => {
    const { impl } = fakeFetch([
      json({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)
    ])
    const client = createClient(makeConfig(), { fetchImpl: impl, sleep: noSleep })
    const error = (await completeJson(client, request, data => data, 'quiz').then(
      () => undefined,
      (e: unknown) => e
    )) as Error
    expect(error).toBeInstanceOf(OwnershipError)
    expect(error.message).toContain('HTTP 401')
    expect(error.message).toContain('Check that "api-key" holds a valid key')
    expect(error.message).not.toContain('sk-test-key')
  })
})
