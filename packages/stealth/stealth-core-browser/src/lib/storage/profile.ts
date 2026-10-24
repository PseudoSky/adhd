import { chromeProfileDir, chromeTimeToDate } from '../helpers.js'
import { openDb } from './helpers.js'
import { join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'

/** The value shown in place of an autofill value when `redactValues` is set. */
export const AUTOFILL_REDACTED = '[REDACTED]'

export class ProfileClient {
  private readonly profileDir: string

  constructor(profileDir?: string) {
    this.profileDir = profileDir ?? chromeProfileDir()
  }

  get defaultDir(): string { return join(this.profileDir, 'Default') }

  getTopSites(limit = 20): Array<{ url: string; title: string; score: number }> {
    const db = openDb(join(this.defaultDir, 'Top Sites'))
    try {
      const rows = db.prepare('SELECT url, title, url_rank FROM top_sites ORDER BY url_rank DESC LIMIT ?').all(limit) as Array<{
        url: string; title: string; url_rank: unknown
      }>
      return rows.map((r) => ({ url: r.url ?? '', title: r.title ?? '', score: Number(r.url_rank ?? 0) }))
    } finally { db.close() }
  }

  getFaviconData(pageUrl: string): { url: string; data?: string; mimeType?: string } | null {
    const db = openDb(join(this.defaultDir, 'Favicons'))
    try {
      const row = db.prepare(`
        SELECT f.url, fb.image_data
        FROM icon_mapping im
        JOIN favicons f ON im.icon_id = f.id
        JOIN favicon_bitmaps fb ON f.id = fb.icon_id
        WHERE im.page_url = ?
        ORDER BY fb.last_updated DESC
        LIMIT 1
      `).get(pageUrl) as { url: string; image_data?: Buffer } | undefined
      if (!row) return null
      return {
        url: row.url ?? '',
        data: row.image_data ? Buffer.from(row.image_data).toString('base64') : undefined,
        mimeType: 'image/png',
      }
    } finally { db.close() }
  }

  /**
   * Saved form-fill entries, newest first (at most 100). The values are personal data (names, emails, addresses):
   * pass `{ redactValues: true }` to get the field names, counts and dates with every value replaced by
   * `[REDACTED]`. The default returns the values, because reading them is what this call is for.
   */
  getAutofillData(opts: { redactValues?: boolean } = {}): Array<{ name: string; value: string; count: number; lastUsed: Date }> {
    const db = openDb(join(this.defaultDir, 'Web Data'))
    try {
      const rows = db.prepare(`
        SELECT name, value, count, date_last_used
        FROM autofill
        ORDER BY date_last_used DESC
        LIMIT 100
      `).all() as Array<{ name: string; value: string; count: unknown; date_last_used: unknown }>
      return rows.map((r) => ({
        name: r.name ?? '',
        value: opts.redactValues ? AUTOFILL_REDACTED : (r.value ?? ''),
        count: Number(r.count ?? 0),
        lastUsed: chromeTimeToDate(Number(r.date_last_used ?? 0)),
      }))
    } finally { db.close() }
  }

  getSearchEngines(): Array<{ name: string; keyword: string; url: string }> {
    const db = openDb(join(this.defaultDir, 'Web Data'))
    try {
      const rows = db.prepare(`
        SELECT short_name, keyword, url
        FROM keywords
        ORDER BY keyword
      `).all() as Array<{ short_name: string; keyword: string; url: string }>
      return rows.map((r) => ({
        name: r.short_name ?? '',
        keyword: r.keyword ?? '',
        url: r.url ?? '',
      }))
    } finally { db.close() }
  }

  getPreference<T = unknown>(key: string): T | undefined {
    try {
      const raw = readFileSync(join(this.defaultDir, 'Preferences'), 'utf8')
      const data = JSON.parse(raw)
      const parts = key.split('.')
      let cur: unknown = data
      for (const part of parts) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
        cur = (cur as Record<string, unknown>)[part]
      }
      return cur as T
    } catch { return undefined }
  }

  getExtensionIds(): string[] {
    try {
      const extDir = join(this.defaultDir, 'Extensions')
      return readdirSync(extDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch { return [] }
  }

  hasSavedCredentials(): boolean {
    try {
      const db = openDb(join(this.defaultDir, 'Login Data'))
      try {
        const row = db.prepare('SELECT COUNT(*) AS cnt FROM logins').get() as { cnt: unknown } | undefined
        return Number(row?.cnt ?? 0) > 0
      } finally { db.close() }
    } catch { return false }
  }
}
