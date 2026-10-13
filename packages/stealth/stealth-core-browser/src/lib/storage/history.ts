import { openDb, toUnixTimeSql } from './helpers.js'
import { join } from 'node:path'
import { transitionName, chromeProfileDir, hydrateVisit } from '../helpers.js'
import type { VisitRow } from '../helpers.js'
import type {
  ChromeVisit,
  UrlInfo,
  VisitStat,
  RedirectChainEntry,
  ClusterInfo,
} from '../types.js'

const VISIT_COLUMNS = `
  v.id, v.url AS url_id, u.url, u.title,
  ${toUnixTimeSql('v.visit_time')} AS visit_time_unix,
  v.transition, v.from_visit, v.visit_duration, v.opener_visit
`

export class HistoryClient {
  private readonly dbPath: string

  constructor(profileDir?: string) {
    const base = profileDir ?? chromeProfileDir()
    this.dbPath = join(base, 'Default', 'History')
  }

  get path(): string { return this.dbPath }

  /** Opens the DB in immutable mode (no lock). Close when done. */
  private openDb(): ReturnType<typeof openDb> {
    return openDb(this.dbPath)
  }

  /** ── Visits ── */

  getLastVisit(): ChromeVisit | null {
    const db = this.openDb()
    try {
      const row = db.prepare(`
        SELECT ${VISIT_COLUMNS}
        FROM visits v
        JOIN urls u ON v.url = u.id
        WHERE (v.transition & 0x20000000) != 0
          AND (v.transition & 255) NOT IN (3, 4, 10)
        ORDER BY v.visit_time DESC
        LIMIT 1
      `).get() as unknown as VisitRow | undefined
      return row ? hydrateVisit(row) : null
    } finally {
      db.close()
    }
  }

  getRecentVisits(limit = 20, offset = 0): ChromeVisit[] {
    const db = this.openDb()
    try {
      const rows = db.prepare(`
        SELECT ${VISIT_COLUMNS}
        FROM visits v
        JOIN urls u ON v.url = u.id
        WHERE (v.transition & 0x20000000) != 0
          AND (v.transition & 255) NOT IN (3, 4, 10)
        ORDER BY v.visit_time DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset) as unknown as VisitRow[]
      return rows.map(hydrateVisit)
    } finally {
      db.close()
    }
  }

  isRecentlyUsed(withinMinutes = 2): boolean {
    const last = this.getLastVisit()
    if (!last) return false
    return (Date.now() - last.visitTime.getTime()) < withinMinutes * 60 * 1000
  }

  getRedirectChain(visitId: number): RedirectChainEntry[] {
    const db = this.openDb()
    try {
      const rows = db.prepare(`
        WITH RECURSIVE chain(visit_id, url_id, from_visit, depth) AS (
          SELECT id, url, from_visit, 0 FROM visits WHERE id = ?
          UNION ALL
          SELECT v.id, v.url, v.from_visit, c.depth + 1
          FROM visits v JOIN chain c ON v.id = c.from_visit
          WHERE c.from_visit != 0 AND c.depth < 32
        )
        SELECT c.visit_id, u.url, c.depth
        FROM chain c JOIN urls u ON c.url_id = u.id
        ORDER BY c.depth ASC
      `).all(visitId) as Array<{ visit_id: number | bigint; url: string; depth: number | bigint }>
      return rows.map((r) => ({ visitId: Number(r.visit_id), url: r.url, depth: Number(r.depth) }))
    } finally {
      db.close()
    }
  }

  /** ── URLs ── */

  getUrlInfo(urlOrId: string | number): UrlInfo | null {
    const db = this.openDb()
    try {
      const stmt = typeof urlOrId === 'number'
        ? db.prepare('SELECT * FROM urls WHERE id = ?')
        : db.prepare('SELECT * FROM urls WHERE url = ?')
      const r = stmt.get(urlOrId) as Record<string, unknown> | undefined
      if (!r) return null
      return {
        id: Number(r['id']),
        url: String(r['url'] ?? ''),
        title: String(r['title'] ?? ''),
        visitCount: Number(r['visit_count']),
        typedCount: Number(r['typed_count']),
        lastVisitTime: new Date(((Number(r['last_visit_time']) / 1000) - 11644473600000)),
        hidden: Boolean(r['hidden']),
      }
    } finally {
      db.close()
    }
  }

  searchUrls(query: string, limit = 20): UrlInfo[] {
    const db = this.openDb()
    try {
      const rows = db.prepare(`
        SELECT * FROM urls
        WHERE url LIKE ? OR title LIKE ?
        ORDER BY last_visit_time DESC
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, limit) as Record<string, unknown>[]
      return rows.map((r) => ({
        id: Number(r['id']),
        url: String(r['url'] ?? ''),
        title: String(r['title'] ?? ''),
        visitCount: Number(r['visit_count']),
        typedCount: Number(r['typed_count']),
        lastVisitTime: new Date(((Number(r['last_visit_time']) / 1000) - 11644473600000)),
        hidden: Boolean(r['hidden']),
      }))
    } finally {
      db.close()
    }
  }

  /** ── Stats ── */

  getVisitStats(days = 30): VisitStat[] {
    const db = this.openDb()
    try {
      const chromeNow = (Math.floor(Date.now() / 1000) + 11644473600) * 1_000_000
      const threshold = chromeNow - days * 86400 * 1_000_000
      const rows = db.prepare(`
        SELECT date(datetime((v.visit_time / 1000000) - 11644473600, 'unixepoch')) AS day,
               COUNT(*) AS visits,
               COUNT(DISTINCT u.url) AS unique_urls
        FROM visits v
        JOIN urls u ON v.url = u.id
        WHERE v.visit_time > ?
          AND (v.transition & 0x20000000) != 0
        GROUP BY day ORDER BY day DESC
      `).all(threshold) as Array<{ day: string; visits: number; unique_urls: number }>
      return rows.map((r) => ({
        date: String(r.day),
        visits: Number(r.visits),
        uniqueUrls: Number(r.unique_urls),
        transitionBreakdown: {},
      }))
    } finally {
      db.close()
    }
  }

  getTransitionBreakdown(days = 30): Record<string, number> {
    const db = this.openDb()
    try {
      const chromeNow = (Math.floor(Date.now() / 1000) + 11644473600) * 1_000_000
      const threshold = chromeNow - days * 86400 * 1_000_000
      const rows = db.prepare(`
        SELECT (v.transition & 255) AS core, COUNT(*) AS count
        FROM visits v
        WHERE v.visit_time > ?
        GROUP BY core ORDER BY count DESC
      `).all(threshold) as Array<{ core: number; count: number }>
      const result: Record<string, number> = {}
      for (const r of rows) result[transitionName(Number(r.core))] = Number(r.count)
      return result
    } finally {
      db.close()
    }
  }

  /** ── Keyword search terms ── */

  getSearchTermsForUrl(url: string): Array<{ term: string; normalizedTerm: string }> {
    const db = this.openDb()
    try {
      const rows = db.prepare(`
        SELECT kst.term, kst.normalized_term
        FROM keyword_search_terms kst
        JOIN urls u ON kst.url_id = u.id
        WHERE u.url = ?
      `).all(url) as Array<{ term: string; normalized_term: string }>
      return rows.map((r) => ({ term: r.term, normalizedTerm: r.normalized_term }))
    } finally {
      db.close()
    }
  }

  /** ── Clusters / Journeys ── */

  getClusterData(): ClusterInfo[] {
    const db = this.openDb()
    try {
      const clusters = db.prepare(`SELECT * FROM clusters ORDER BY cluster_id`).all() as Array<{
        cluster_id: unknown; label: string | null
      }>

      const visitStmt = db.prepare(`
        SELECT cav.visit_id, cav.score, u.url, u.title
        FROM clusters_and_visits cav
        JOIN urls u ON cav.visit_id = u.id
        WHERE cav.cluster_id = ?
        ORDER BY cav.score DESC
      `)

      return clusters.map((c) => ({
        clusterId: Number(c.cluster_id),
        label: c.label,
        visits: (visitStmt.all(Number(c.cluster_id)) as Array<{
          visit_id: unknown; score: unknown; url: string; title: string
        }>).map((v) => ({
          visitId: Number(v.visit_id),
          score: Number(v.score),
          url: v.url,
          title: v.title,
        })),
      }))
    } finally {
      db.close()
    }
  }

  /** ── Content annotations ── */

  getContentAnnotations(visitId: number): Record<string, unknown> | null {
    const db = this.openDb()
    try {
      const row = db.prepare('SELECT * FROM content_annotations WHERE visit_id = ?').get(visitId) as Record<string, unknown> | undefined
      return row ?? null
    } finally {
      db.close()
    }
  }

  getContextAnnotations(visitId: number): Record<string, unknown> | null {
    const db = this.openDb()
    try {
      const row = db.prepare('SELECT * FROM context_annotations WHERE visit_id = ?').get(visitId) as Record<string, unknown> | undefined
      return row ?? null
    } finally {
      db.close()
    }
  }
}
