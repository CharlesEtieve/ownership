import * as core from '@actions/core'
import { modelLabel, OwnershipError, type Config } from '../config.js'
import { postJson, ProviderHttpError, type HttpOptions } from './http.js'
import { SchemaError, type JsonSchema } from './schemas.js'

export interface CompletionRequest {
  system: string
  prompt: string
  schema: JsonSchema
  schemaName: string
  maxTokens: number
}

export interface LlmClient {
  /** "provider/model", shown in comments and logs. */
  readonly label: string
  /** Returns the raw text of the model's reply. */
  complete(request: CompletionRequest): Promise<string>
}

/** The model replied, but not with something usable (cut off, refused, not JSON...). */
export class ModelOutputError extends Error {
  override name = 'ModelOutputError'
}

const MAX_TOKENS_HINT = 'the reply was cut off by the token limit'

export function createClient(config: Config, http: HttpOptions = {}): LlmClient {
  switch (config.provider) {
    case 'anthropic':
      return anthropicClient(config, http)
    case 'openai':
    case 'openai-compatible':
      return openAiClient(config, http)
  }
}

/** Joins a base URL and a path, accepting base URLs with or without the version segment. */
export function endpoint(baseUrl: string, version: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith(`/${version}`) ? `${base}/${path}` : `${base}/${version}/${path}`
}

/**
 * Anthropic Messages API. Uses structured outputs (output_config.format) so the reply matches the
 * schema; if the model or a proxy rejects it, falls back to plain JSON instructions.
 */
function anthropicClient(config: Config, http: HttpOptions): LlmClient {
  const url = endpoint(config.baseUrl ?? 'https://api.anthropic.com', 'v1', 'messages')
  let structured = true

  const send = async (request: CompletionRequest): Promise<unknown> =>
    postJson(
      'Anthropic',
      url,
      { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: config.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
        ...(structured
          ? { output_config: { format: { type: 'json_schema', schema: request.schema } } }
          : {})
      },
      http
    )

  return {
    label: modelLabel(config),
    async complete(request) {
      let data: unknown
      try {
        data = await send(request)
      } catch (error) {
        if (!(structured && error instanceof ProviderHttpError && error.status === 400)) throw error
        core.info(
          `Structured outputs not accepted (${error.detail}); retrying with plain JSON instructions.`
        )
        structured = false
        data = await send(request)
      }
      const message = data as {
        stop_reason?: string
        content?: { type: string; text?: string }[]
      }
      if (message.stop_reason === 'refusal') {
        throw new ModelOutputError('the model declined to answer this request')
      }
      if (message.stop_reason === 'max_tokens') throw new ModelOutputError(MAX_TOKENS_HINT)
      return (message.content ?? [])
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('')
    }
  }
}

type ResponseFormat = 'json_schema' | 'json_object' | 'none'

/**
 * OpenAI Chat Completions, also spoken by Ollama, vLLM, LM Studio and most gateways. Tries a strict
 * JSON schema first, then JSON mode, then plain instructions, as local servers support less.
 */
function openAiClient(config: Config, http: HttpOptions): LlmClient {
  const isOpenAi = config.provider === 'openai'
  const url = endpoint(config.baseUrl ?? 'https://api.openai.com/v1', 'v1', 'chat/completions')
  const formats: ResponseFormat[] = ['json_schema', 'json_object', 'none']
  let formatIndex = 0
  const headers: Record<string, string> = config.apiKey
    ? { authorization: `Bearer ${config.apiKey}` }
    : {}

  const responseFormat = (request: CompletionRequest): Record<string, unknown> => {
    switch (formats[formatIndex]) {
      case 'json_schema':
        return {
          response_format: {
            type: 'json_schema',
            json_schema: { name: request.schemaName, strict: true, schema: request.schema }
          }
        }
      case 'json_object':
        return { response_format: { type: 'json_object' } }
      default:
        return {}
    }
  }

  const send = async (request: CompletionRequest): Promise<unknown> =>
    postJson(
      isOpenAi ? 'OpenAI' : 'OpenAI-compatible',
      url,
      headers,
      {
        model: config.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt }
        ],
        // Current OpenAI models only accept max_completion_tokens; most compatible servers expect max_tokens.
        ...(isOpenAi
          ? { max_completion_tokens: request.maxTokens }
          : { max_tokens: request.maxTokens }),
        ...responseFormat(request)
      },
      http
    )

  return {
    label: modelLabel(config),
    async complete(request) {
      let data: unknown
      for (;;) {
        try {
          data = await send(request)
          break
        } catch (error) {
          const canDowngrade = formatIndex < formats.length - 1
          if (!(canDowngrade && error instanceof ProviderHttpError && error.status === 400))
            throw error
          formatIndex++
          core.info(
            `Response format not accepted (${error.detail}); retrying with ${formats[formatIndex]}.`
          )
        }
      }
      const completion = data as {
        choices?: {
          finish_reason?: string
          message?: { content?: string | null; refusal?: string | null }
        }[]
      }
      const choice = completion.choices?.[0]
      if (choice?.message?.refusal) {
        throw new ModelOutputError('the model declined to answer this request')
      }
      if (choice?.finish_reason === 'length') throw new ModelOutputError(MAX_TOKENS_HINT)
      return choice?.message?.content ?? ''
    }
  }
}

/** Pulls a JSON object out of a reply that may be wrapped in code fences or reasoning tags. */
export function extractJson(text: string): unknown {
  const withoutThinking = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
  const start = withoutThinking.indexOf('{')
  const end = withoutThinking.lastIndexOf('}')
  if (start === -1 || end <= start) throw new SchemaError('the reply contains no JSON object')
  try {
    return JSON.parse(withoutThinking.slice(start, end + 1)) as unknown
  } catch (error) {
    throw new SchemaError(`the reply is not valid JSON (${(error as Error).message})`)
  }
}

/**
 * Asks for JSON and validates it. On an unusable reply, asks once more with the validation error,
 * then fails with a clear message.
 */
export async function completeJson<T>(
  client: LlmClient,
  request: CompletionRequest,
  validate: (data: unknown) => T,
  task: string
): Promise<T> {
  let lastError = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? request.prompt
        : `${request.prompt}\n\nYour previous reply could not be used: ${lastError}. ` +
          'Reply again with a single JSON object that matches the required format, and nothing else.'
    try {
      const text = await client.complete({ ...request, prompt })
      return validate(extractJson(text))
    } catch (error) {
      if (!(error instanceof SchemaError || error instanceof ModelOutputError)) {
        if (error instanceof ProviderHttpError) throw new OwnershipError(providerHint(error))
        throw error
      }
      lastError = error.message
      core.warning(`${task}: attempt ${attempt} returned an unusable reply (${lastError}).`)
    }
  }
  throw new OwnershipError(
    `${client.label} did not return a valid ${task} after 2 attempts (last problem: ${lastError}). ` +
      'Try again, or use a more capable model.'
  )
}

function providerHint(error: ProviderHttpError): string {
  const hints: Record<number, string> = {
    401: 'Check that "api-key" holds a valid key for this provider.',
    403: 'The key is not allowed to use this model or endpoint.',
    404: 'Check the "model" name and, if set, the "base-url".',
    429: 'The provider is rate limiting or the account is out of credits.'
  }
  const hint = hints[error.status]
  return hint ? `${error.message}. ${hint}` : error.message
}
