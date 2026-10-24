import { openDb, toUnixTimeOrNullSql } from './helpers.js'
import { join } from 'node:path'
import { chromeProfileDir } from '../helpers.js'
import type { CookieInfo } from '../types.js'

/** The value shown in place of a cookie value when `redactValues` is set. */
export const COOKIE_REDACTED = '[redacted]'

/** Options of every cookie read. */
export interface CookieReadOptions {
  /**
   * Replace every cookie value with {@link COOKIE_REDACTED}. Session cookies are credentials: pass this whenever the
   * result can reach a log, a transcript or any other party. Names, hosts, flags and dates are unaffected.
   */
  redactValues?: boolean
}

/**
 * The `host_key` values a domain filter matches: the name as given and its counterpart with or without the
 * leading dot (Chrome stores a domain cookie for `example.com` as `.example.com`).
 */
export function hostFilterKeys(filter: string): string[] {
  const host = filter.trim().toLowerCase()
  if (host === '' || host === '.') return []
  return host.startsWith('.') ? [host, host.slice(1)] : [host, `.${host}`]
}

/**
 * Every `host_key` that can hold a cookie for `hostname`: the host itself, the dotted form of it, and the dotted
 * form of each parent domain down to (not including) the bare top-level label. IP literals and single-label
 * hosts only match themselves.
 */
export function cookieHostKeys(hostname: string): string[] {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (host === '') return []
  const keys = [host]
  const isIp = /^[0-9.]+$/.test(host) || host.includes(':')
  if (isIp || !host.includes('.')) return keys
  const labels = host.split('.')
  for (let i = 0; i <= labels.length - 2; i++) keys.push(`.${labels.slice(i).join('.')}`)
  return keys
}

export class CookieClient {
  private readonly defaultDir: string

  constructor(profileDir?: string) {
    this.defaultDir = join(profileDir ?? chromeProfileDir(), 'Default')
  }

  private _cookiesDb(): string { return join(this.defaultDir, 'Cookies') }

  /**
   * Cookies ordered by last access, newest first, at most 200. With `hostFilter`, only the cookies whose
   * `host_key` is that name or its dotted/undotted counterpart (`example.com` matches `example.com` and
   * `.example.com`).
   */
  getCookies(hostFilter?: string, opts: CookieReadOptions = {}): CookieInfo[] {
    const keys = hostFilter ? hostFilterKeys(hostFilter) : []
    if (hostFilter && keys.length === 0) return []
    return this.readCookies(keys, opts)
  }

  private readCookies(hostKeys: readonly string[], opts: CookieReadOptions): CookieInfo[] {
    const db = openDb(this._cookiesDb())
    try {
      const rows = db.prepare(`
        SELECT name, value, host_key, path,
               ${toUnixTimeOrNullSql('creation_utc')} AS creation_unix,
               ${toUnixTimeOrNullSql('last_access_utc')} AS last_access_unix,
               has_expires,
               ${toUnixTimeOrNullSql('expires_utc')} AS expires_unix,
               is_secure, is_httponly, samesite, priority
        FROM cookies
        ${hostKeys.length > 0 ? `WHERE host_key IN (${hostKeys.map(() => '?').join(', ')})` : ''}
        ORDER BY last_access_utc DESC
        LIMIT 200
      `).all(...hostKeys) as Record<string, unknown>[]
      const toDate = (v: unknown): Date | null => (v == null ? null : new Date(Math.round(Number(v) * 1000)))
      return rows.map((r) => ({
        name: String(r['name']),
        value: opts.redactValues ? COOKIE_REDACTED : String(r['value']),
        host: String(r['host_key']),
        path: String(r['path']),
        creationUtc: toDate(r['creation_unix']),
        lastAccessUtc: toDate(r['last_access_unix']),
        hasExpires: Boolean(r['has_expires']),
        expiresUtc: toDate(r['expires_unix']),
        isSecure: Boolean(r['is_secure']),
        isHttpOnly: Boolean(r['is_httponly']),
        samesite: String(r['samesite'] ?? 'unspecified'),
        priority: String(r['priority'] ?? 'medium'),
      }))
    } finally {
      db.close()
    }
  }

  /**
   * The cookies a request to `hostname` would carry by domain: a host-only cookie for exactly that host and a
   * domain cookie (`.example.com`) for the host or any parent domain. A different site that merely contains the
   * name (`notexample.com`, `example.com.evil.net`) never matches. The host keys are matched in SQL, so the
   * 200-row cap of an unfiltered read cannot hide a match.
   */
  getCookiesForHostname(hostname: string, opts: CookieReadOptions = {}): CookieInfo[] {
    const keys = cookieHostKeys(hostname)
    if (keys.length === 0) return []
    return this.readCookies(keys, opts)
  }

  /** The cookies set for `domain` (host-only or `.domain`); same as `getCookies(domain, opts)`. */
  getCookiesByDomain(domain: string, opts: CookieReadOptions = {}): CookieInfo[] {
    return this.getCookies(domain, opts)
  }
}
