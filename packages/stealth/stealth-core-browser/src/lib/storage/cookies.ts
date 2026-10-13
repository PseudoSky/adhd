import { openDb, toUnixTimeSql } from './helpers.js'
import { join } from 'node:path'
import { chromeProfileDir } from '../helpers.js'
import type { CookieInfo } from '../types.js'

export class CookieClient {
  private readonly defaultDir: string

  constructor(profileDir?: string) {
    this.defaultDir = join(profileDir ?? chromeProfileDir(), 'Default')
  }

  private _cookiesDb(): string { return join(this.defaultDir, 'Cookies') }

  getCookies(hostFilter?: string): CookieInfo[] {
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
        ${hostFilter ? 'WHERE host_key = ?' : ''}
        ORDER BY last_access_utc DESC
        LIMIT 200
      `).all(...(hostFilter ? [hostFilter] : [])) as Record<string, unknown>[]
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

  getCookiesByDomain(domain: string): CookieInfo[] {
    return this.getCookies(domain)
  }
}
