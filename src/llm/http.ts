export type FetchLike = typeof fetch

export interface HttpOptions {
  fetchImpl?: FetchLike | undefined
  timeoutMs?: number | undefined
  /** Extra attempts for rate limits, server errors and network failures. */
  retries?: number | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
}

/** An HTTP error from a model provider. The message never includes request headers or the API key. */
export class ProviderHttpError extends Error {
  override name = 'ProviderHttpError'
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly provider: string
  ) {
    super(`${provider} API returned HTTP ${status}${detail ? `: ${detail}` : ''}`)
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const MAX_RETRY_DELAY_MS = 30_000

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/** POSTs JSON and returns the parsed JSON response, retrying transient failures with backoff. */
export async function postJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: HttpOptions = {}
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch
  const retries = options.retries ?? 2
  const sleep = options.sleep ?? defaultSleep

  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      if (timedOut) {
        const seconds = Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1_000)
        throw new ProviderHttpError(0, `no response within ${seconds}s`, provider)
      }
      if (attempt < retries) {
        await sleep(backoff(attempt))
        continue
      }
      const reason = error instanceof Error ? error.message : String(error)
      throw new ProviderHttpError(
        0,
        `request to ${new URL(url).origin} failed (${reason})`,
        provider
      )
    }

    if (response.ok) {
      const text = await response.text()
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new ProviderHttpError(response.status, 'response body is not JSON', provider)
      }
    }

    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    if (retryable && attempt < retries) {
      await sleep(retryDelay(response.headers.get('retry-after'), attempt))
      continue
    }
    throw new ProviderHttpError(response.status, await errorDetail(response), provider)
  }
}

function backoff(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 2_000 * 2 ** attempt)
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_DELAY_MS, seconds * 1_000)
  return backoff(attempt)
}

/** Extracts a short error message from the provider's error body. */
async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const data = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown }
    const message =
      typeof data.error === 'string'
        ? data.error
        : typeof data.error?.message === 'string'
          ? data.error.message
          : typeof data.message === 'string'
            ? data.message
            : ''
    if (message) return message.slice(0, 500)
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 200)
}
