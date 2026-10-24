/**
 * Unit spec for the review-finding fixes in src/lib/storage/* and src/lib/helpers.ts.
 * Ticket 8468f7b1 · criteria [resolve-findings.2] F67 F68 F69 F70 F71 F72 F73 F74 F79 F157 F159.
 * guards: Chrome timestamps lose sub-second precision or the 1601 offset, a profile path containing URI syntax opens the wrong file, cookie values leak through a redacting read, domain filters miss dotted domain cookies, unset times read as year 1601, stats ignore transitions, LIKE wildcards in a search match everything
 * tier: S
 * cites: 8468f7b1 [resolve-findings.2] F67 F68 F69 F70 F71 F72 F73 F74 F157 F159
 * plan: stealth-browser, state resolve-findings, task resolve-findings-implementer
 * teeth: red: nx run stealth-core-browser:test --skip-nx-cache -- test/unit/domains-storage/storage-fixes.spec.ts -> exit 1 with src/lib/storage/helpers.ts reverted to integer division and an unencoded file: URI and history.ts reverted to unescaped LIKE: 7 failed | 16 passed.
 * Every case reads a throwaway SQLite/JSON profile under the OS temp dir through the shipped read-only opener.
 */
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chromeTimeToDate, chromeTimeToDateOrNull, googleSupportDir, hydrateVisit } from '../../../src/lib/helpers.js'
import { BookmarkClient } from '../../../src/lib/storage/bookmarks.js'
import { COOKIE_REDACTED, CookieClient, hostFilterKeys } from '../../../src/lib/storage/cookies.js'
import { openDb, toUnixTimeSql } from '../../../src/lib/storage/helpers.js'
import { HistoryClient, likeContains } from '../../../src/lib/storage/history.js'
import { makeProfile, type Fixture } from '../../helpers/domains-storage/profile-fixture.js'
import { chromeMicros } from '../../helpers/profile-fixtures.js'

const COOKIE_DDL = `CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, path TEXT,
  creation_utc INTEGER, last_access_utc INTEGER, has_expires INTEGER, expires_utc INTEGER,
  is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, priority INTEGER)`
const HISTORY_DDL = [
  'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)',
  'CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER, from_visit INTEGER, visit_duration INTEGER, opener_visit INTEGER)',
]
const CHAIN_END = 0x20000000

describe('[resolve-findings.2] F67 F157 sub-second Chrome timestamps survive SQL and JS conversion', () => {
  let fx: Fixture
  beforeEach(() => { fx = makeProfile() })
  afterEach(() => fx.cleanup())

  it('a visit at 1_800_000_000.75 s reads back with its 750 ms, in SQL seconds and in the hydrated Date', () => {
    const d = fx.db('History', HISTORY_DDL)
    d.prepare('INSERT INTO urls VALUES (1,?,?,1,0,0,0)').run('https://a.test/', 'A')
    d.prepare('INSERT INTO visits VALUES (1,1,?,?,0,0,0)').run(chromeMicros(1_800_000_000.75), CHAIN_END)
    d.close()
    const [visit] = new HistoryClient(fx.root).getRecentVisits(1)
    expect(visit?.visitTimeUnix).toBeCloseTo(1_800_000_000.75, 3)
    expect(visit?.visitTime.getTime()).toBe(1_800_000_000_750)
  })

  it('toUnixTimeSql keeps fractional seconds', () => {
    fx.db('probe', ['CREATE TABLE t (x INTEGER)']).close()
    const db = openDb(join(fx.defaultDir, 'probe'))
    try {
      const row = db.prepare(`SELECT ${toUnixTimeSql('?')} AS s`).get(chromeMicros(100.5)) as { s: number }
      expect(row.s).toBeCloseTo(100.5, 6)
    } finally { db.close() }
  })

  it('cookies keep sub-second creation times too', () => {
    const d = fx.db('Cookies', [COOKIE_DDL])
    d.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('a', 'v', 'x.test', '/', chromeMicros(1000.25), chromeMicros(2000.5), 0, 0, 0, 0, 0, 0)
    d.close()
    const [c] = new CookieClient(fx.root).getCookies()
    expect(c?.creationUtc?.getTime()).toBe(1_000_250)
    expect(c?.lastAccessUtc?.getTime()).toBe(2_000_500)
  })

  it('hydrateVisit rounds fractional seconds to the nearest millisecond', () => {
    const v = hydrateVisit({ id: 1, url_id: 1, url: 'u', title: 't', visit_time_unix: 10.1239, transition: 0, from_visit: 0, visit_duration: 0, opener_visit: 0 })
    expect(v.visitTime.getTime()).toBe(10_124)
  })

  it('chromeTimeToDate accepts number, bigint and string; chromeTimeToDateOrNull maps unset to null', () => {
    const micros = chromeMicros(5)
    expect(chromeTimeToDate(micros).getTime()).toBe(5000)
    expect(chromeTimeToDate(BigInt(micros)).getTime()).toBe(5000)
    expect(chromeTimeToDate(String(micros)).getTime()).toBe(5000)
    for (const unset of [0, '0', '', null, undefined, Number.NaN, -1]) expect(chromeTimeToDateOrNull(unset)).toBeNull()
    expect(chromeTimeToDateOrNull('abc')).toBeNull()
  })
})

describe('[resolve-findings.2] F68 a profile path containing URI syntax opens exactly that file', () => {
  let fx: Fixture
  beforeEach(() => { fx = makeProfile() })
  afterEach(() => fx.cleanup())

  it.each(['has?question', 'has#hash', 'has%41percent', 'has space', 'has&amp=eq'])('opens a History under a directory named %s', (dirName) => {
    const awkwardRoot = join(fx.root, dirName)
    mkdirSync(join(awkwardRoot, 'Default'), { recursive: true })
    const d = new DatabaseSync(join(awkwardRoot, 'Default', 'History'))
    for (const stmt of HISTORY_DDL) d.exec(stmt)
    d.prepare('INSERT INTO urls VALUES (7,?,?,3,1,0,0)').run('https://real.test/', 'real')
    d.close()
    expect(new HistoryClient(awkwardRoot).getUrlInfo(7)?.url).toBe('https://real.test/')
  })

  it('a path whose unencoded form would name a different file still opens the right one', () => {
    // "x?y" unencoded would be read as file "x" plus a query: a decoy named "x" must not be opened
    const decoyDir = join(fx.root, 'x')
    mkdirSync(join(decoyDir, 'Default'), { recursive: true })
    const decoy = new DatabaseSync(join(decoyDir, 'Default', 'History'))
    for (const stmt of HISTORY_DDL) decoy.exec(stmt)
    decoy.prepare('INSERT INTO urls VALUES (7,?,?,3,1,0,0)').run('https://decoy.test/', 'decoy')
    decoy.close()
    const realRoot = join(fx.root, 'x?y')
    mkdirSync(join(realRoot, 'Default'), { recursive: true })
    const real = new DatabaseSync(join(realRoot, 'Default', 'History'))
    for (const stmt of HISTORY_DDL) real.exec(stmt)
    real.prepare('INSERT INTO urls VALUES (7,?,?,3,1,0,0)').run('https://real.test/', 'real')
    real.close()
    expect(new HistoryClient(realRoot).getUrlInfo(7)?.url).toBe('https://real.test/')
  })
})

describe('[resolve-findings.2] F69 F70 F71 cookies: redaction option, dotted domain filter, unset times', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = makeProfile()
    const d = fx.db('Cookies', [COOKIE_DDL])
    const ins = d.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    ins.run('sid', 'secret-A', '.example.com', '/', chromeMicros(1000), chromeMicros(3000), 1, chromeMicros(9000), 1, 1, 1, 1)
    ins.run('host', 'secret-B', 'example.com', '/', chromeMicros(1000), chromeMicros(2000), 0, 0, 0, 0, 0, 0)
    ins.run('other', 'secret-C', '.notexample.com', '/', chromeMicros(1000), chromeMicros(1500), 0, 0, 0, 0, 0, 0)
    ins.run('fresh', 'secret-D', 'fresh.test', '/', 0, 0, 0, 0, 0, 0, 0, 0)
    d.close()
  })
  afterEach(() => fx.cleanup())

  it('redactValues replaces every value and leaves names, hosts and dates intact', () => {
    const jar = new CookieClient(fx.root)
    const redacted = jar.getCookies(undefined, { redactValues: true })
    expect(redacted.map((c) => c.value)).toEqual(Array(4).fill(COOKIE_REDACTED))
    expect(JSON.stringify(redacted)).not.toContain('secret-')
    expect(redacted.map((c) => c.name).sort()).toEqual(['fresh', 'host', 'other', 'sid'])
    expect(jar.getCookies().map((c) => c.value)).toContain('secret-A') // default is unchanged: values readable
    for (const read of [
      jar.getCookiesByDomain('example.com', { redactValues: true }),
      jar.getCookiesForHostname('www.example.com', { redactValues: true }),
    ]) expect(JSON.stringify(read)).not.toContain('secret-')
  })

  it('getCookies(host) and getCookiesByDomain(domain) match the dotted domain cookie as well as the host-only one', () => {
    const jar = new CookieClient(fx.root)
    expect(jar.getCookies('example.com').map((c) => c.name).sort()).toEqual(['host', 'sid'])
    expect(jar.getCookiesByDomain('.example.com').map((c) => c.name).sort()).toEqual(['host', 'sid'])
    expect(jar.getCookies('EXAMPLE.com').map((c) => c.name).sort()).toEqual(['host', 'sid'])
    expect(jar.getCookies('example.org')).toEqual([])
    expect(jar.getCookies('.')).toEqual([])
    expect(hostFilterKeys(' .Example.com ')).toEqual(['.example.com', 'example.com'])
  })

  it('a cookie Chrome never timestamped has null creation/last-access, not the year 1601', () => {
    const fresh = new CookieClient(fx.root).getCookies('fresh.test')[0]
    expect(fresh?.creationUtc).toBeNull()
    expect(fresh?.lastAccessUtc).toBeNull()
    expect(fresh?.expiresUtc).toBeNull()
  })
})

describe('[resolve-findings.2] F72 F73 F79 history stats and search', () => {
  let fx: Fixture
  const NOW = 1_800_000_000
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW * 1000))
    fx = makeProfile()
    const d = fx.db('History', HISTORY_DDL)
    const u = d.prepare('INSERT INTO urls VALUES (?,?,?,?,?,?,?)')
    u.run(1, 'https://a.test/100%25_done', '100% done', 1, 0, chromeMicros(NOW - 10), 0)
    u.run(2, 'https://a.test/other', 'plain title', 1, 0, chromeMicros(NOW - 20), 0)
    u.run(3, 'https://a.test/under_score', 'x', 1, 0, chromeMicros(NOW - 30), 0)
    u.run(4, 'https://a.test/underXscore', 'y', 1, 0, chromeMicros(NOW - 40), 0)
    const v = d.prepare('INSERT INTO visits VALUES (?,?,?,?,0,0,0)')
    v.run(1, 1, chromeMicros(NOW - 10), 0 | CHAIN_END)
    v.run(2, 2, chromeMicros(NOW - 20), 1 | CHAIN_END)
    v.run(3, 2, chromeMicros(NOW - 30), 1 | CHAIN_END)
    v.run(4, 3, chromeMicros(NOW - 40), 0) // mid-chain hop: not a real navigation
    v.run(5, 3, chromeMicros(NOW - 86400 * 3), 7 | CHAIN_END)
    d.close()
  })
  afterEach(() => { fx.cleanup(); vi.useRealTimers() })

  it('getVisitStats fills a per-day transition breakdown and getTransitionBreakdown counts the same visits', () => {
    const h = new HistoryClient(fx.root)
    const stats = h.getVisitStats(30)
    expect(stats).toHaveLength(2)
    const total: Record<string, number> = {}
    for (const day of stats) for (const [k, n] of Object.entries(day.transitionBreakdown)) total[k] = (total[k] ?? 0) + n
    expect(stats[0]?.transitionBreakdown).toEqual({ TYPED: 2, LINK: 1 })
    expect(stats[1]?.transitionBreakdown).toEqual({ FORM_SUBMIT: 1 })
    // same population, same answer: the chain-start hop (visit 4) is in neither
    expect(h.getTransitionBreakdown(30)).toEqual(total)
    expect(stats.reduce((n, s) => n + s.visits, 0)).toBe(4)
  })

  it('searchUrls treats % and _ as literal characters', () => {
    const h = new HistoryClient(fx.root)
    expect(h.searchUrls('100%').map((u) => u.id)).toEqual([1])
    expect(h.searchUrls('%').map((u) => u.id)).toEqual([1]) // only the url that contains a percent sign
    expect(h.searchUrls('under_score').map((u) => u.id)).toEqual([3]) // not underXscore
    expect(h.searchUrls('_').map((u) => u.id)).toEqual([1, 3]) // urls that contain an underscore, not every url
    expect(h.searchUrls('\\').map((u) => u.id)).toEqual([])
    expect(likeContains('a%b_c\\d')).toBe('%a\\%b\\_c\\\\d%')
  })

  it('getUrlInfo and searchUrls build identical UrlInfo values', () => {
    const h = new HistoryClient(fx.root)
    expect(h.searchUrls('plain')[0]).toEqual(h.getUrlInfo(2))
  })
})

describe('[resolve-findings.2] F74 bookmark dates use the 1601 epoch', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = makeProfile()
    fx.json('Bookmarks', {
      roots: {
        bookmark_bar: {
          id: '1', name: 'Bar', type: 'folder', date_added: String(chromeMicros(1_700_000_000)), date_modified: '0',
          children: [{ id: '2', name: 'A', type: 'url', url: 'https://a.test', date_added: String(chromeMicros(1_700_000_000.5)) }],
        },
      },
    })
  })
  afterEach(() => fx.cleanup())

  it('dateAdded is the real moment (2023-11-14), not 1601; a zero date_modified is undefined', () => {
    const [bar] = new BookmarkClient(fx.root).getBookmarks()
    expect(bar?.dateAdded?.toISOString()).toBe('2023-11-14T22:13:20.000Z')
    expect(bar?.dateModified).toBeUndefined()
    expect(bar?.children?.[0]?.dateAdded?.getTime()).toBe(1_700_000_000_500)
  })
})

describe('[resolve-findings.2] F159 Chrome profile directories follow the platform', () => {
  it.each([
    ['darwin', {}, '/h/Library/Application Support/Google'],
    ['win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, join('C:\\Users\\u\\AppData\\Local', 'Google')],
    ['win32', {}, join('/h', 'AppData', 'Local', 'Google')],
    ['linux', {}, '/h/.config/google'],
    ['linux', { XDG_CONFIG_HOME: '/x' }, '/x/google'],
  ] as const)('%s %j -> %s', (platformName, env, expected) => {
    expect(googleSupportDir(platformName, '/h', env)).toBe(expected)
  })
})
