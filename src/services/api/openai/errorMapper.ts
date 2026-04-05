import {
  APIError,
  APIConnectionError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'

/**
 * Map OpenAI SDK errors (or raw fetch errors) to Anthropic APIError shapes
 * so that withRetry.ts retry logic works unchanged.
 */
export function mapOpenAIError(err: unknown): Error {
  if (err instanceof APIError) return err

  if (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'APIUserAbortError')
  ) {
    return new APIUserAbortError({ message: err.message })
  }

  // OpenAI SDK errors expose .status and .message
  const e = err as { status?: number; message?: string; headers?: unknown }
  if (typeof e.status === 'number') {
    // OpenAI SDK error headers may be a plain object, not a Headers instance.
    // Anthropic's APIError constructor calls headers?.get("request-id") which
    // crashes on plain objects. Normalise to a proper Headers or undefined.
    let headers: Headers | undefined
    if (e.headers instanceof Headers) {
      headers = e.headers
    } else if (e.headers && typeof e.headers === 'object') {
      try { headers = new Headers(e.headers as Record<string, string>) } catch { /* ignore */ }
    }
    return APIError.generate(
      e.status,
      { type: 'error', error: { type: mapErrorType(e.status), message: e.message ?? '' } },
      e.message,
      headers,
    )
  }

  if (
    err instanceof TypeError &&
    (err.message.includes('fetch') || err.message.includes('network'))
  ) {
    return new APIConnectionError({ cause: err })
  }

  return err instanceof Error ? err : new Error(String(err))
}

function mapErrorType(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error'
    case 401:
      return 'authentication_error'
    case 403:
      return 'permission_error'
    case 404:
      return 'not_found_error'
    case 429:
      return 'rate_limit_error'
    default:
      return 'api_error'
  }
}
