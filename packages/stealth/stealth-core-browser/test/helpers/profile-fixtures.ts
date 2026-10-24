/**
 * Real-shape Chrome profile builder for the use-case lane.
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.3]
 *
 * Writes `Default/History` (urls, visits with redirect chains, keyword_search_terms), `Default/Cookies`
 * (Chrome's column set, session plus persistent cookies), `Default/Bookmarks` (JSON with checksum/roots)
 * and `Default/Top Sites` under a throwaway OS temp directory with `node:sqlite`. Nothing reads a real profile.
 * `openReadOnly` opens a file through the library's immutable read-only opener (`storage.openDb`).
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storage } from '../../src/index.js'
import { must } from './must.js'

/** Unix seconds to Chrome microseconds since 1601-01-01. */
export const chromeMicros = (unixSeconds: number): number => (unixSeconds + 11644473600) * 1_000_000

export const CHAIN_START = 0x10000000
export const CHAIN_END = 0x20000000
export const SERVER_REDIRECT = 0x80000000
export const CLIENT_REDIRECT = 0x40000000
export const TRANSITION = { LINK: 0, TYPED: 1, AUTO_BOOKMARK: 2, AUTO_SUBFRAME: 3, GENERATED: 5, FORM_SUBMIT: 7, RELOAD: 8 } as const

export interface HistorySite {
  url: string
  title: string
  /** Seconds before `now` of the last visit. */
  secondsAgo: number
  visits?: number
  transition?: number
}

export interface RedirectChainSpec {
  /** URLs in hop order; the last one is the page the person landed on. */
  hops: string[]
  title: string
  secondsAgo: number
}

export interface CookieSpec {
  name: string
  value: string
  host: string
  path?: string
  /** Absent: a session cookie (expires_utc = 0, is_persistent = 0). */
  expiresInSeconds?: number
  secure?: boolean
  httpOnly?: boolean
  secondsAgo?: number
}

export interface BuiltProfile {
  root: string
  defaultDir: string
  /** Visit id of the landing hop of every redirect chain, in spec order. */
  chainLandingVisitIds: number[]
  cleanup(): void
}

/** The sites of a week of ordinary browsing: 24 plain pages. */
export function ordinaryBrowsing(): HistorySite[] {
  const sites: HistorySite[] = []
  const hosts = ['docs.test', 'news.test', 'mail.test', 'shop.test', 'video.test', 'wiki.test']
  for (let i = 0; i < 24; i++) {
    const host = must(hosts[i % hosts.length])
    sites.push({
      url: `https://${host}/page/${i}`,
      title: `${host} page ${i}`,
      secondsAgo: 3_600 * (i + 2),
      visits: 1 + (i % 4),
      transition: i % 5 === 0 ? TRANSITION.TYPED : TRANSITION.LINK,
    })
  }
  return sites
}

export const REDIRECT_CHAINS: RedirectChainSpec[] = [
  { hops: ['http://short.test/x1', 'https://short.test/x1', 'https://target.test/article/42'], title: 'Article 42', secondsAgo: 1_800 },
  { hops: ['https://login.test/start?next=/inbox', 'https://login.test/sso', 'https://mail.test/inbox'], title: 'Inbox', secondsAgo: 5_400 },
]

export const SESSION_COOKIES: CookieSpec[] = [
  { name: 'sid', value: 'opaque-session-token', host: 'app.test', httpOnly: true, secure: true },
  { name: 'csrf', value: 'opaque-csrf', host: 'app.test' },
  { name: 'remember', value: 'opaque-remember', host: 'app.test', expiresInSeconds: 86_400 * 30, httpOnly: true, secure: true },
  { name: 'theme', value: 'dark', host: 'app.test', expiresInSeconds: 86_400 * 365 },
  { name: 'ads', value: 'x', host: 'tracker.test', expiresInSeconds: 3_600 },
]

export const BOOKMARK_TREE = {
  checksum: '0123456789abcdef0123456789abcdef',
  version: 1,
  roots: {
    bookmark_bar: {
      id: '1', name: 'Bookmarks bar', type: 'folder', date_added: '13300000000000000',
      children: [
        { id: '4', name: 'API reference', type: 'url', url: 'https://docs.test/api', date_added: '13300000000000000' },
        { id: '5', name: 'Work', type: 'folder', children: [{ id: '6', name: 'Team wiki', type: 'url', url: 'https://wiki.test/team', date_added: '13300000000000000' }] },
      ],
    },
    other: { id: '2', name: 'Other bookmarks', type: 'folder', children: [] },
    synced: { id: '3', name: 'Mobile bookmarks', type: 'folder', children: [] },
  },
}

export class ProfileBuilder {
  private sites: HistorySite[] = []
  private chains: RedirectChainSpec[] = []
  private cookieRows: CookieSpec[] = []
  private bookmarks: unknown = null
  private topSites: Array<{ url: string; title: string; rank: number }> = []
  private searchTerms: Array<{ url: string; term: string }> = []

  constructor(private readonly now: number = Date.now() / 1000) {}

  history(sites: HistorySite[]): this { this.sites.push(...sites); return this }
  redirects(chains: RedirectChainSpec[]): this { this.chains.push(...chains); return this }
  cookies(rows: CookieSpec[]): this { this.cookieRows.push(...rows); return this }
  bookmarkFile(tree: unknown): this { this.bookmarks = tree; return this }
  top(rows: Array<{ url: string; title: string; rank: number }>): this { this.topSites.push(...rows); return this }
  searched(rows: Array<{ url: string; term: string }>): this { this.searchTerms.push(...rows); return this }

  /** A full profile: 24 ordinary visits, two redirect chains, session + persistent cookies, bookmarks. */
  static realistic(now: number = Date.now() / 1000): ProfileBuilder {
    return new ProfileBuilder(now)
      .history(ordinaryBrowsing())
      .redirects(REDIRECT_CHAINS)
      .cookies(SESSION_COOKIES)
      .bookmarkFile(BOOKMARK_TREE)
      .top([{ url: 'https://docs.test/', title: 'Docs', rank: 9 }])
      .searched([{ url: 'https://wiki.test/page/5', term: 'chrome history schema' }])
  }

  build(): BuiltProfile {
    const root = mkdtempSync(join(tmpdir(), 'stealth-usecase-profile-'))
    const defaultDir = join(root, 'Default')
    mkdirSync(defaultDir, { recursive: true })
    const landing = this.writeHistory(join(defaultDir, 'History'))
    this.writeCookies(join(defaultDir, 'Cookies'))
    if (this.bookmarks) writeFileSync(join(defaultDir, 'Bookmarks'), JSON.stringify(this.bookmarks))
    this.writeTopSites(join(defaultDir, 'Top Sites'))
    return { root, defaultDir, chainLandingVisitIds: landing, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  private writeHistory(path: string): number[] {
    const d = new DatabaseSync(path)
    d.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)`)
    d.exec(`CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, from_visit INTEGER, external_referrer_url TEXT, transition INTEGER DEFAULT 0 NOT NULL, segment_id INTEGER, visit_duration INTEGER DEFAULT 0 NOT NULL, incremented_omnibox_typed_score BOOLEAN DEFAULT FALSE NOT NULL, opener_visit INTEGER, originator_cache_guid TEXT, is_known_to_sync BOOLEAN DEFAULT FALSE NOT NULL)`)
    d.exec(`CREATE TABLE keyword_search_terms (keyword_id INTEGER NOT NULL, url_id INTEGER NOT NULL, term LONGVARCHAR NOT NULL, normalized_term LONGVARCHAR NOT NULL)`)
    const insUrl = d.prepare('INSERT INTO urls (id, url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?,?,?,?,?,?,0)')
    const insVisit = d.prepare('INSERT INTO visits (id, url, visit_time, from_visit, transition, visit_duration, opener_visit) VALUES (?,?,?,?,?,?,0)')
    const urlIds = new Map<string, number>()
    let urlId = 0
    let visitId = 0
    const urlFor = (url: string, title: string, t: number, visits: number, typed: number): number => {
      const known = urlIds.get(url)
      if (known !== undefined) return known
      urlId += 1
      urlIds.set(url, urlId)
      insUrl.run(urlId, url, title, visits, typed, chromeMicros(t))
      return urlId
    }
    for (const s of this.sites) {
      const t = this.now - s.secondsAgo
      const transition = s.transition ?? TRANSITION.LINK
      const uid = urlFor(s.url, s.title, t, s.visits ?? 1, transition === TRANSITION.TYPED ? 1 : 0)
      visitId += 1
      insVisit.run(visitId, uid, chromeMicros(t), 0, (transition | CHAIN_START | CHAIN_END) >>> 0, 2_000)
    }
    const landing: number[] = []
    for (const c of this.chains) {
      let from = 0
      c.hops.forEach((url, i) => {
        const last = i === c.hops.length - 1
        const t = this.now - c.secondsAgo + i * 0.01
        const uid = urlFor(url, last ? c.title : '', t, 1, 0)
        visitId += 1
        const qualifiers = (i === 0 ? CHAIN_START : 0) | (last ? CHAIN_END : 0) | (i > 0 ? SERVER_REDIRECT : 0)
        insVisit.run(visitId, uid, chromeMicros(t), from, (TRANSITION.LINK | qualifiers) >>> 0, last ? 3_000 : 0)
        from = visitId
        if (last) landing.push(visitId)
      })
    }
    const insTerm = d.prepare('INSERT INTO keyword_search_terms VALUES (2, ?, ?, ?)')
    for (const s of this.searchTerms) {
      const id = urlIds.get(s.url)
      if (id !== undefined) insTerm.run(id, s.term, s.term.toLowerCase())
    }
    d.close()
    return landing
  }

  private writeCookies(path: string): void {
    const d = new DatabaseSync(path)
    d.exec(`CREATE TABLE cookies (creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL DEFAULT x'', path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL DEFAULT 1, is_persistent INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 1, samesite INTEGER NOT NULL DEFAULT -1, source_scheme INTEGER NOT NULL DEFAULT 0, source_port INTEGER NOT NULL DEFAULT -1, last_update_utc INTEGER NOT NULL DEFAULT 0)`)
    const ins = d.prepare('INSERT INTO cookies (creation_utc, host_key, name, value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, samesite) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    this.cookieRows.forEach((c, i) => {
      const created = this.now - 86_400 - i
      const persistent = c.expiresInSeconds !== undefined
      ins.run(
        chromeMicros(created), c.host, c.name, c.value, c.path ?? '/',
        persistent ? chromeMicros(this.now + must(c.expiresInSeconds)) : 0,
        c.secure ? 1 : 0, c.httpOnly ? 1 : 0, chromeMicros(this.now - (c.secondsAgo ?? 60) - i),
        persistent ? 1 : 0, persistent ? 1 : 0, 1,
      )
    })
    d.close()
  }

  private writeTopSites(path: string): void {
    const d = new DatabaseSync(path)
    d.exec('CREATE TABLE top_sites (url TEXT NOT NULL PRIMARY KEY, url_rank INTEGER NOT NULL, title TEXT NOT NULL, redirects TEXT NOT NULL DEFAULT "")')
    const ins = d.prepare('INSERT INTO top_sites (url, url_rank, title) VALUES (?,?,?)')
    for (const t of this.topSites) ins.run(t.url, t.rank, t.title)
    d.close()
  }
}

/** Read one table of a profile file through the library's immutable read-only opener. */
export function openReadOnly(path: string): ReturnType<typeof storage.openDb> {
  return storage.openDb(path)
}
