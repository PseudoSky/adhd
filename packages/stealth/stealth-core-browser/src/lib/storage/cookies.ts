import { openDb, toUnixTimeSql } from './helpers.js'
import { join } from 'node:path'
import { chromeProfileDir } from '../helpers.js'
import type { CookieInfo } from '../types.js'

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

  getCookies(hostFilter?: string): CookieInfo[] {
    return this.readCookies(hostFilter ? [hostFilter] : [])
  }

  private readCookies(hostKeys: readonly string[]): CookieInfo[] {
    const db = openDb(this._cookiesDb())
    try {
      const rows = db.prepare(`
        SELECT name, value, host_key, path,
               ${toUnixTimeSql('creation_utc')} AS creation_unix,
               ${toUnixTimeSql('last_access_utc')} AS last_access_unix,
               has_expires,
               CASE WHEN expires_utc = 0 THEN NULL ELSE ${toUnixTimeSql('expires_utc')} END AS expires_unix,
               is_secure, is_httponly, samesite, priority
        FROM cookies
        ${hostKeys.length > 0 ? `WHERE host_key IN (${hostKeys.map(() => '?').join(', ')})` : ''}
        ORDER BY last_access_utc DESC
        LIMIT 200
      `).all(...hostKeys) as Record<string, unknown>[]
      return rows.map((r) => ({
        name: String(r['name']),
        value: String(r['value']),
        host: String(r['host_key']),
        path: String(r['path']),
        creationUtc: new Date(Number(r['creation_unix']) * 1000),
        lastAccessUtc: new Date(Number(r['last_access_unix']) * 1000),
        hasExpires: Boolean(r['has_expires']),
        expiresUtc: r['expires_unix'] != null ? new Date(Number(r['expires_unix']) * 1000) : null,
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
  getCookiesForHostname(hostname: string): CookieInfo[] {
    const keys = cookieHostKeys(hostname)
    if (keys.length === 0) return []
    return this.readCookies(keys)
  }

  getCookiesByDomain(domain: string): CookieInfo[] {
    return this.getCookies(domain)
  }
}
