/**
 * @adhd/stealth-core-browser — src/lib/endpoint.ts
 *
 * Which Chrome DevTools endpoint a verb may talk to. The `host` input of every chrome verb reaches the host
 * process from an MCP caller, so it is validated here once ([audit-fixes.1], pre-review P9):
 *
 *  - the host is a bare DNS name, an IPv4 address or an IPv6 address; `@ ? # / \ :` (outside an IPv6
 *    literal), whitespace and percent escapes are refused, so it cannot smuggle credentials, a path or a
 *    second port into `http://<host>:<port>`;
 *  - only loopback (`localhost`, `127.0.0.0/8`, `::1`) is allowed by default; any other host must be
 *    allowed explicitly by the process that hosts the verbs with `configureEndpointPolicy`, never by a
 *    verb input;
 *  - `assertSameEndpoint` refuses a debugger WebSocket URL that points anywhere but the endpoint that
 *    was asked, so a hostile endpoint cannot redirect the connection to a third host.
 *
 * Ticket 8468f7b1 · plan state audit-fixes.
 */
import net from 'node:net'
import { StealthCoreBrowserError } from '../errors.js'

/** Host used when a verb is called without one. */
export const DEFAULT_HOST = '127.0.0.1'
/** CDP port used when a verb is called without one. */
export const DEFAULT_PORT = 9222

/** A validated endpoint: `host` is bracketed when it is an IPv6 literal, so `cdpHost` is always `host:port`. */
export interface ResolvedEndpoint {
  host: string
  port: number
  cdpHost: string
}

/** What the hosting process allows beyond loopback. */
export interface EndpointPolicy {
  /** Extra hosts (names or addresses) the verbs may address. Compared case-insensitively, without brackets. */
  allowHosts?: readonly string[]
}

let allowed: ReadonlySet<string> = new Set()

/** Replace the set of non-loopback hosts the verbs may address (empty by default; loopback is always allowed). */
export function configureEndpointPolicy(policy: EndpointPolicy = {}): void {
  const next = new Set<string>()
  for (const h of policy.allowHosts ?? []) next.add(bare(normalizeHost(h)).toLowerCase())
  allowed = next
}

/** The extra hosts currently allowed (for logs and tests). */
export function allowedHosts(): string[] {
  return [...allowed]
}

const bare = (host: string): string => host.replace(/^\[|\]$/g, '')

/** True when `host` is `localhost`, an address of 127.0.0.0/8 or the IPv6 loopback. */
export function isLoopbackHost(host: string): boolean {
  const h = bare(host).toLowerCase()
  if (h === 'localhost') return true
  if (net.isIPv4(h)) return h.startsWith('127.')
  if (net.isIPv6(h)) return new URL(`http://[${h}]/`).hostname === '[::1]'
  return false
}

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)*$/

/** The syntactically valid, bracket-normalized form of a host, or the endpoint error naming the offence. */
function normalizeHost(raw: string): string {
  const host = raw.trim()
  const bracketed = host.startsWith('[') && host.endsWith(']')
  const inner = bracketed ? host.slice(1, -1) : host
  if (net.isIPv6(inner)) return `[${inner}]`
  if (!bracketed && (net.isIPv4(host) || HOSTNAME.test(host))) return host
  throw StealthCoreBrowserError.invalidEndpoint(`host must be a bare host name or address (no scheme, credentials, path, port, query or whitespace), got "${raw}"`)
}

/** Validate the endpoint of a verb input against the syntax rules and the loopback-or-allowed policy. */
export function resolveEndpoint(input: { host?: string; port?: number } = {}): ResolvedEndpoint {
  const port = input.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw StealthCoreBrowserError.invalidEndpoint(`port must be an integer between 1 and 65535, got ${String(port)}`)
  }
  const host = normalizeHost(input.host?.trim() || DEFAULT_HOST)
  if (!isLoopbackHost(host) && !allowed.has(bare(host).toLowerCase())) {
    throw StealthCoreBrowserError.invalidEndpoint(
      `host "${bare(host)}" is not a loopback address and is not on the allowed list; the process that hosts the verbs must allow it explicitly (configureEndpointPolicy, or --allow-cdp-hosts for stealth-search)`
    )
  }
  return { host, port, cdpHost: `${host}:${port}` }
}

/** The port of a `host:port` string (IPv6 hosts are bracketed), or `fallback` when it has none. */
export function portOf(cdpHost: string, fallback = DEFAULT_PORT): number {
  const m = cdpHost.match(/:(\d+)$/)
  const port = m?.[1] ? parseInt(m[1], 10) : NaN
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback
}

/**
 * Refuse a WebSocket URL that does not point at the host that was asked. Chrome echoes the `Host` header
 * of the request in `webSocketDebuggerUrl`, so an honest endpoint always matches.
 *
 * @throws StealthCoreBrowserError CDP_BAD_RESPONSE (detail.reason `ws-host-mismatch`)
 */
export function assertSameEndpoint(cdpHost: string, wsUrl: string): void {
  const expected = bare(cdpHost.replace(/:\d+$/, '')).toLowerCase()
  let actual: string
  try {
    actual = bare(new URL(wsUrl).hostname).toLowerCase()
  } catch {
    throw StealthCoreBrowserError.of('CDP_BAD_RESPONSE', `CDP on ${cdpHost} returned an invalid debugger WebSocket URL`, { detail: { cdpHost, reason: 'ws-url-invalid' } })
  }
  if (actual !== expected) {
    throw StealthCoreBrowserError.of('CDP_BAD_RESPONSE', `CDP on ${cdpHost} returned a debugger WebSocket URL for another host (${actual})`, { detail: { cdpHost, reason: 'ws-host-mismatch', wsHost: actual } })
  }
}
