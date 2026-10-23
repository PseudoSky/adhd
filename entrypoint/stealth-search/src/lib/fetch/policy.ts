/**
 * @adhd/stealth-search — src/lib/fetch/policy.ts
 *
 * URL validation and SSRF target blocking for the fetch provider (inventory I-28, a security
 * failsafe, [search-port-fetch.3]).
 *
 * The check is a TARGET check ("is this pointed at my own infrastructure?"), never a reputation
 * blocklist. IP literals, RFC1918, link-local (cloud metadata), loopback, CGNAT, single-label hosts,
 * internal TLDs, a trailing DNS root dot, non-http(s) schemes, embedded credentials and over-long
 * URLs are refused locally BEFORE any navigation. A refusal is a RESPONSE outcome `error` whose
 * message carries `FETCH_URL_REFUSED` (built in fetch.ts), never a thrown error.
 *
 * `validateFetchUrl` is the name-based half. `resolveAndCheck` is the resolution half: a public
 * hostname is resolved through an INJECTED resolver and every returned address must be public, so a
 * name that RESOLVES to a private address (DNS rebinding) is refused with `FETCH_URL_REFUSED`
 * carrying the offending address in `detail`. A resolver failure is a typed `SEARCH_FAILED`. The
 * browser resolves again at connect time, so a resolve-then-pin step must still precede any
 * credential-bearing tier; the fetch tier is cookieless, which bounds what that can leak.
 *
 * Ticket 8468f7b1 · plan state search-port-fetch.
 */
import dns from 'node:dns'
import net from 'node:net'
import { searchError } from '../../errors.js'

/** Max URL length (matches the reference WebFetch cap). */
export const MAX_URL_LENGTH = 2000

/** The verdict of `validateFetchUrl`. */
export interface UrlVerdict {
  ok: boolean
  /** Present when ok=false. Safe to surface to the caller. */
  reason?: string
  /** The parsed, normalized URL (http upgraded to https) when ok=true. */
  url?: URL
}

function isForbiddenV4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  const [a, b] = [p[0] ?? -1, p[1] ?? -1]
  if (a === 10) return true // 10/8
  if (a === 127) return true // loopback
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 0) return true // 0.0.0.0/8
  return false
}

function embeddedV4(hi: string, lo: string): string | null {
  const h = parseInt(hi, 16)
  const l = parseInt(lo, 16)
  if (!Number.isFinite(h) || !Number.isFinite(l)) return null
  return [h >> 8, h & 255, l >> 8, l & 255].join('.')
}

/** Private / non-routable IP ranges. `ip` must already be a valid literal. */
function isForbiddenIp(ip: string): boolean {
  const v = net.isIP(ip)
  if (v === 4) return isForbiddenV4(ip)
  if (v !== 6) return false
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (s === '::1' || s === '::') return true // loopback / unspecified
  if (s.startsWith('fc') || s.startsWith('fd')) return true // unique-local fc00::/7
  if (/^fe[89ab]/.test(s)) return true // link-local fe80::/10
  // IPv4-mapped (::ffff:...) and IPv4-compatible (::a:b) forms: re-check the embedded v4.
  // `new URL()` re-serializes the tail to HEX-COMPRESSED form (::ffff:a9fe:a9fe), NOT dotted
  // decimal, so a decimal-only check would let ::ffff:169.254.169.254 (cloud metadata) through.
  const mapped = s.match(/^::(?:ffff:)?(.+)$/)
  if (mapped?.[1]) {
    const tail = mapped[1]
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isForbiddenV4(tail)
    const g = tail.split(':')
    if (g.length === 2 && g[0] !== undefined && g[1] !== undefined) {
      const v4 = embeddedV4(g[0], g[1])
      if (v4) return isForbiddenV4(v4)
    }
  }
  return false
}

/**
 * Is this URL pointed at infrastructure a fetch must never reach?
 * Returns a reason string when forbidden, or null when the target is allowed.
 */
export function forbiddenTargetReason(u: URL): string | null {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return `unsupported protocol '${u.protocol}' (only http/https)`
  }
  // Unwrap IPv6 brackets AND strip a trailing DNS root dot: `localhost.` resolves to loopback but
  // would otherwise slip past the localhost / single-label checks.
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (net.isIP(host)) {
    return isForbiddenIp(host) ? `blocked IP literal ${host} (private/loopback/link-local)` : null
  }
  const lower = host.toLowerCase()
  if (lower === 'localhost') return 'blocked host localhost'
  if (/\.(local|internal|home|lan|localdomain)$/.test(lower)) return `blocked internal TLD in ${host}`
  if (host.split('.').length < 2) return `blocked single-label host ${host} (not a public domain)`
  return null
}

/**
 * Validate + normalize a URL for fetching: length cap, parseable, no embedded credentials, not a
 * forbidden target, http upgraded to https.
 */
export function validateFetchUrl(raw: string): UrlVerdict {
  if (!raw || raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `URL missing or longer than ${MAX_URL_LENGTH} chars` }
  }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'not a valid URL' }
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'URL must not embed credentials (user:pass@)' }
  }
  const forbidden = forbiddenTargetReason(u)
  if (forbidden) return { ok: false, reason: forbidden }
  if (u.protocol === 'http:') u.protocol = 'https:'
  return { ok: true, url: u }
}

/** Resolves a hostname to every address it maps to. Injected so the unit lane never touches the network. */
export type HostResolver = (host: string) => Promise<string[]>

/** The production resolver: the system resolver, all A and AAAA answers. */
export const systemResolver: HostResolver = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address)

/**
 * Resolve `host` and refuse it when ANY returned address is private, loopback, link-local or
 * unique-local. IP literals are not resolved (the name-based check already judged them).
 *
 * @throws StealthSearchError `FETCH_URL_REFUSED` (detail.address, detail.host) for a private answer;
 *   `SEARCH_FAILED` (detail.reason `dns-resolution-failed`) when the resolver fails or answers nothing.
 */
export async function resolveAndCheck(host: string, resolve: HostResolver): Promise<string[]> {
  const bare = host.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (net.isIP(bare)) return [bare]
  let addresses: string[]
  try {
    addresses = await resolve(bare)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw searchError('SEARCH_FAILED', `could not resolve ${bare}: ${msg}`, { detail: { reason: 'dns-resolution-failed', host: bare } })
  }
  if (addresses.length === 0) {
    throw searchError('SEARCH_FAILED', `resolver returned no address for ${bare}`, { detail: { reason: 'dns-resolution-failed', host: bare } })
  }
  for (const address of addresses) {
    if (isForbiddenIp(address)) {
      throw searchError('FETCH_URL_REFUSED', `${bare} resolves to ${address} (private/loopback/link-local)`, {
        detail: { reason: 'resolves-to-private-address', host: bare, address },
      })
    }
  }
  return addresses
}
