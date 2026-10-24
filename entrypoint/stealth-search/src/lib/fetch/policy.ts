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
 * carrying the offending address in `detail`. A resolver failure is a typed `SEARCH_FAILED`.
 *
 * Resolve once, validate every answer, connect to what was validated: the direct PDF fetch connects
 * to the first validated address (`pinned`), never to the name. Chrome resolves by name itself, so for
 * the browser the validated address is enforced after the fact: the address each document actually
 * connected to (`Network.Response.remoteIPAddress`, including every redirect hop) must pass
 * `isForbiddenAddress` before any content is read.
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

/** True when the dotted-quad octets `p` lie in the range `a.b.c.0/prefix` (arithmetic stays below 2^32, so plain numbers are exact). */
function inV4(p: readonly number[], a: number, b: number, c: number, prefix: number): boolean {
  const n = (p[0] ?? 0) * 2 ** 24 + (p[1] ?? 0) * 2 ** 16 + (p[2] ?? 0) * 2 ** 8 + (p[3] ?? 0)
  const base = a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8
  return n >= base && n < base + 2 ** (32 - prefix)
}

/** The non-public IPv4 ranges (IANA special-purpose registry, RFC 6890 and successors). */
const FORBIDDEN_V4: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 0, 8], // this network
  [10, 0, 0, 8], // RFC1918
  [100, 64, 0, 10], // CGNAT
  [127, 0, 0, 8], // loopback
  [169, 254, 0, 16], // link-local / cloud metadata
  [172, 16, 0, 12], // RFC1918
  [192, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 24], // TEST-NET-1
  [192, 88, 99, 24], // 6to4 relay anycast
  [192, 168, 0, 16], // RFC1918
  [198, 18, 0, 15], // benchmarking
  [198, 51, 100, 24], // TEST-NET-2
  [203, 0, 113, 24], // TEST-NET-3
  [224, 0, 0, 4], // multicast
  [240, 0, 0, 4], // reserved, includes 255.255.255.255 broadcast
]

function isForbiddenV4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true
  return FORBIDDEN_V4.some(([a, b, c, prefix]) => inV4(p, a, b, c, prefix))
}

/** The eight 16-bit groups of an IPv6 literal (a dotted-quad tail is folded into two groups), or null. */
function parseV6(raw: string): number[] | null {
  let s = raw.toLowerCase().replace(/^\[|\]$/g, '')
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted?.[1] !== undefined && dotted[2] !== undefined) {
    const q = dotted[2].split('.').map(Number)
    if (q.length !== 4 || q.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null
    s = `${dotted[1]}${(((q[0] ?? 0) << 8) | (q[1] ?? 0)).toString(16)}:${(((q[2] ?? 0) << 8) | (q[3] ?? 0)).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null
  const groups = [...head, ...(halves.length === 2 ? Array<string>(fill).fill('0') : []), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null
}

const v4Of = (hi: number, lo: number): string => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')

function isForbiddenV6(ip: string): boolean {
  const g = parseV6(ip)
  if (!g) return true // not parseable: refuse
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (firstFiveZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true // :: and ::1
  if (firstFiveZero && g5 === 0xffff) return isForbiddenV4(v4Of(g6, g7)) // IPv4-mapped ::ffff:a.b.c.d
  if (firstFiveZero && g5 === 0) return isForbiddenV4(v4Of(g6, g7)) // IPv4-compatible ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isForbiddenV4(v4Of(g6, g7)) // NAT64 64:ff9b::/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true // local-use NAT64 64:ff9b:1::/48
  if (g0 === 0x2002) return isForbiddenV4(v4Of(g1, g2)) // 6to4 2002::/16 embeds the v4 address
  if (g0 === 0x2001 && g1 === 0) return true // Teredo 2001::/32
  if (g0 === 0x2001 && g1 === 0xdb8) return true // documentation 2001:db8::/32
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true // discard-only 100::/64
  if ((g0 & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true // deprecated site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return true // multicast ff00::/8
  return false
}

/**
 * True for an address a fetch must never reach: private, loopback, link-local, CGNAT, reserved,
 * multicast, documentation, NAT64, 6to4, IPv4-mapped and Teredo forms. A string that is not an IP
 * literal is refused too, so the answer to "is it safe to connect" is never true by accident.
 */
export function isForbiddenAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '')
  const v = net.isIP(bare)
  if (v === 4) return isForbiddenV4(bare)
  if (v === 6) return isForbiddenV6(bare)
  return true
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
    return isForbiddenAddress(host) ? `blocked IP literal ${host} (private/loopback/link-local)` : null
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
    if (isForbiddenAddress(address)) {
      throw searchError('FETCH_URL_REFUSED', `${bare} resolves to ${address} (private/loopback/link-local)`, {
        detail: { reason: 'resolves-to-private-address', host: bare, address },
      })
    }
  }
  return addresses
}
