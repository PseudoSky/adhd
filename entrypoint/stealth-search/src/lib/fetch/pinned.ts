/**
 * @adhd/stealth-search — src/lib/fetch/pinned.ts
 *
 * The direct byte fetch of the fetch provider (the PDF fallback): one GET that CONNECTS to an address the
 * caller already validated, never to the name, so a DNS answer that changes between the policy check and
 * the connection cannot redirect it ([audit-fixes.1], pre-review P4). The TLS handshake still uses the
 * hostname (SNI and certificate check). The response is bounded in size and time: an oversized or endless
 * body ends the request instead of filling memory (P29).
 *
 * Redirects are never followed here: a 3xx comes back as `status` + `location` so the caller can run its
 * policy on the next hop and pin that one too.
 *
 * Ticket 8468f7b1 · plan state audit-fixes.
 */
import https from 'node:https'
import net from 'node:net'
import { searchError } from '../../errors.js'

/** Largest direct PDF body accepted, in bytes. */
export const PDF_MAX_BYTES = 32 * 1024 * 1024

/** Time allowed for the whole direct fetch (connect, headers and body), in milliseconds. */
export const PDF_DIRECT_TIMEOUT_MS = 30_000

/** What a direct fetch answers. `body` is empty for a redirect. */
export interface DirectResponse {
  status: number
  location: string | null
  body: Uint8Array
}

/** Options of one direct fetch. */
export interface DirectFetchOptions {
  headers: Record<string, string>
  maxBytes: number
  timeoutMs: number
}

/** The direct fetch collaborator of `FetchDeps`: GET `url`, connecting to `address`. */
export type DirectFetch = (url: string, address: string, opts: DirectFetchOptions) => Promise<DirectResponse>

/** A `lookup` that always answers `address`, in the single and the `all` shape Node's connect may ask for. */
export function pinnedLookup(address: string): (host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => void {
  const family = net.isIP(address)
  return (_host, options, cb) => {
    if (options.all) cb(null, [{ address, family }])
    else cb(null, address, family)
  }
}

/** The production direct fetch: HTTPS GET to the pinned address, bounded in bytes and time. */
export const pinnedGet: DirectFetch = (url, address, opts) =>
  new Promise<DirectResponse>((resolve, reject) => {
    const u = new URL(url)
    // WHATWG URLs keep the brackets of an IPv6 literal; net.isIP, TLS server names and the socket want the bare address.
    const host = u.hostname.replace(/^\[|\]$/g, '')
    let settled = false
    const chunks: Buffer[] = []
    let total = 0
    let request: ReturnType<typeof https.request> | undefined
    const timer = setTimeout(() => end(searchError('SEARCH_FAILED', `fetching ${u.hostname} took longer than ${opts.timeoutMs} ms`, { detail: { reason: 'direct-fetch-timeout', host: u.hostname } })), opts.timeoutMs)
    const end = (outcome: DirectResponse | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (outcome instanceof Error) {
        request?.destroy()
        reject(outcome)
      } else {
        resolve(outcome)
      }
    }
    const tooLarge = (): Error => searchError('SEARCH_FAILED', `the response from ${u.hostname} is larger than ${opts.maxBytes} bytes`, { detail: { reason: 'direct-fetch-too-large', host: u.hostname, maxBytes: opts.maxBytes } })
    try {
      request = https.request(
        {
          hostname: host,
          port: u.port || undefined,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: opts.headers,
          ...(net.isIP(host) ? {} : { servername: host }),
          lookup: pinnedLookup(address) as never,
        },
        (res) => {
          const status = res.statusCode ?? 0
          const location = typeof res.headers.location === 'string' ? res.headers.location : null
          if (status >= 300 && status < 400) {
            res.destroy()
            end({ status, location, body: new Uint8Array(0) })
            return
          }
          const declared = Number(res.headers['content-length'])
          if (Number.isFinite(declared) && declared > opts.maxBytes) {
            res.destroy()
            end(tooLarge())
            return
          }
          res.on('data', (chunk: Buffer) => {
            total += chunk.length
            if (total > opts.maxBytes) {
              res.destroy()
              end(tooLarge())
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => end({ status, location, body: new Uint8Array(Buffer.concat(chunks)) }))
          res.on('error', (err: Error) => end(searchError('SEARCH_FAILED', `reading ${u.hostname} failed: ${err.message}`, { cause: err, detail: { reason: 'direct-fetch-failed', host: u.hostname } })))
        },
      )
      request.on('error', (err: Error) => end(searchError('SEARCH_FAILED', `fetching ${u.hostname} failed: ${err.message}`, { cause: err, detail: { reason: 'direct-fetch-failed', host: u.hostname } })))
      request.end()
    } catch (err) {
      end(searchError('SEARCH_FAILED', `fetching ${u.hostname} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err, detail: { reason: 'direct-fetch-failed', host: u.hostname } }))
    }
  })
