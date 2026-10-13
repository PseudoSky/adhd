/**
 * @adhd/stealth-browser — src/lib/recording/redact.ts
 *
 * Header redaction for persisted recordings. Identity is the recorder default
 * (replay use needs the cookies); pass `redactHeaders()` as `redact` to mask
 * credentials at the sink and `onExchange` boundary while in-memory
 * exchanges stay raw.
 *
 * Ticket 8468f7b1 · plan state capture-upgrade [capture-upgrade.16].
 */
import type { Headers, RecordedExchange, RecordedRequest, RecordedResponse } from './types.js'

export const DEFAULT_REDACTED_HEADERS: readonly string[] = ['cookie', 'set-cookie', 'authorization', 'proxy-authorization']

export const REDACTED = '[REDACTED]'

function maskHeaders(headers: Headers, names: ReadonlySet<string>): Headers {
  const out: Headers = {}
  for (const [k, v] of Object.entries(headers)) out[k] = names.has(k.toLowerCase()) ? REDACTED : v
  return out
}

/**
 * Returns a `redact` function masking the named headers (case-insensitive) in
 * the request, the response and every redirect hop. The input exchange is
 * never mutated.
 */
export function redactHeaders(names: readonly string[] = DEFAULT_REDACTED_HEADERS): (exchange: RecordedExchange) => RecordedExchange {
  const set = new Set(names.map((n) => n.toLowerCase()))
  const req = (r: RecordedRequest): RecordedRequest => ({ ...r, headers: maskHeaders(r.headers, set) })
  const res = (r: RecordedResponse): RecordedResponse => ({ ...r, headers: maskHeaders(r.headers, set) })
  return (ex) => ({
    ...ex,
    request: req(ex.request),
    response: ex.response ? res(ex.response) : undefined,
    redirects: ex.redirects.map((h) => ({ request: req(h.request), response: res(h.response) })),
  })
}
