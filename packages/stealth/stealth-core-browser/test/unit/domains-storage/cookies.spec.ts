/**
 * Unit spec for src/lib/storage/cookies.ts (CookieClient).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [port-fixes.3].
 * Reads a SQLite fixture created in the OS temp dir; a spy on console proves no real profile path is used.
 * guards: reads all cookies ordered by last access desc with converted timestamps
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [port-fixes.3] [audit-fixes.5]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieClient, cookieHostKeys } from '../../../src/lib/storage/cookies.js'
import { chromeMicros, makeProfile, type Fixture } from '../../helpers/domains-storage/profile-fixture.js'

const DDL = `CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, path TEXT,
  creation_utc INTEGER, last_access_utc INTEGER, has_expires INTEGER, expires_utc INTEGER,
  is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, priority INTEGER)`

describe('8468f7b1 AC2 [tests-unit-data.1] CookieClient', () => {
  let fx: Fixture
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fx = makeProfile()
    const d = fx.db('Cookies', [DDL])
    const ins = d.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    ins.run('sid', 'abc', 'a.test', '/', chromeMicros(1000), chromeMicros(3000), 1, chromeMicros(9000), 1, 1, 1, 1)
    ins.run('pref', 'dark', 'b.test', '/x', chromeMicros(1000), chromeMicros(2000), 0, 0, 0, 0, 0, 0)
    d.close()
  })
  afterEach(() => { fx.cleanup(); vi.restoreAllMocks() })

  it('reads all cookies ordered by last access desc with converted timestamps', () => {
    const cookies = new CookieClient(fx.root).getCookies()
    expect(cookies.map((c) => c.name)).toEqual(['sid', 'pref'])
    expect(cookies[0].creationUtc.getTime()).toBe(1_000_000)
    expect(cookies[0].lastAccessUtc.getTime()).toBe(3_000_000)
    expect(cookies[0].expiresUtc?.getTime()).toBe(9_000_000)
  })

  it('maps flags and host/path fields', () => {
    const [sid] = new CookieClient(fx.root).getCookies()
    expect(sid).toMatchObject({ value: 'abc', host: 'a.test', path: '/', hasExpires: true, isSecure: true, isHttpOnly: true })
  })

  it('[port-fixes.3] a session cookie (expires_utc = 0) reports a null expiry, not 1601-01-01', () => {
    const pref = new CookieClient(fx.root).getCookies().find((c) => c.name === 'pref')
    expect(pref?.hasExpires).toBe(false)
    expect(pref?.expiresUtc).toBeNull()
    expect(pref?.expiresUtc?.getUTCFullYear()).not.toBe(1601)
  })

  it('getCookies filters by host', () => {
    const only = new CookieClient(fx.root).getCookies('b.test')
    expect(only.map((c) => c.name)).toEqual(['pref'])
    expect(new CookieClient(fx.root).getCookies('none.test')).toEqual([])
  })

  it('getCookiesByDomain delegates to the host filter', () => {
    const rows = new CookieClient(fx.root).getCookiesByDomain('a.test')
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('sid')
  })

  it('[fs-168] reads cookies with host filter and limit', () => {
    const w = fx.db('Cookies', [])
    const ins = w.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    for (let i = 0; i < 210; i++) ins.run(`bulk${i}`, 'v', 'bulk.test', '/', chromeMicros(1), chromeMicros(10_000 + i), 0, 0, 0, 0, 0, 0)
    w.close()
    const c = new CookieClient(fx.root)
    const all = c.getCookies()
    expect(all).toHaveLength(200) // hard cap
    expect(all[0].name).toBe('bulk209') // newest access first
    expect(c.getCookies('bulk.test')).toHaveLength(200)
    expect(c.getCookies('a.test').map((x) => x.name)).toEqual(['sid'])
    // secure / httpOnly / samesite / priority are mapped
    expect(c.getCookies('a.test')[0]).toMatchObject({ isSecure: true, isHttpOnly: true, samesite: '1', priority: '1' })
    expect(c.getCookies('b.test')[0]).toMatchObject({ isSecure: false, isHttpOnly: false })
    expect(c.getCookies('absent.test')).toEqual([])
  })

  it('throws when the Cookies database is missing (error path)', () => {
    const empty = makeProfile()
    try {
      expect(() => new CookieClient(empty.root).getCookies()).toThrow()
    } finally { empty.cleanup() }
  })
})

describe('8468f7b1 [audit-fixes.5] P25 cookies are matched to a host by domain, not by substring', () => {
  let fx: Fixture
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fx = makeProfile()
    const d = fx.db('Cookies', [DDL])
    const ins = d.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    const hosts = ['example.com', '.example.com', 'www.example.com', '.www.example.com', 'notexample.com', '.notexample.com', 'example.com.evil.net', 'sub.www.example.com', 'other.org', '.com']
    hosts.forEach((h, i) => ins.run(`c${i}`, 'v', h, '/', chromeMicros(1000), chromeMicros(2000 + i), 0, 0, 0, 0, 0, 0))
    d.close()
  })
  afterEach(() => { fx.cleanup(); vi.restoreAllMocks() })

  it('www.example.com matches its own host-only and domain cookies and its parents, never a lookalike', () => {
    const hosts = new CookieClient(fx.root).getCookiesForHostname('www.example.com').map((c) => c.host).sort()
    expect(hosts).toEqual(['.example.com', '.www.example.com', 'www.example.com'])
  })

  it('example.com does not match notexample.com, example.com.evil.net or a subdomain host-only cookie', () => {
    const hosts = new CookieClient(fx.root).getCookiesForHostname('example.com').map((c) => c.host).sort()
    expect(hosts).toEqual(['.example.com', 'example.com'])
  })

  it('a bare top-level domain cookie (.com) is not counted for a host under it', () => {
    expect(new CookieClient(fx.root).getCookiesForHostname('example.com').some((c) => c.host === '.com')).toBe(false)
  })

  it('an empty hostname matches nothing', () => {
    expect(new CookieClient(fx.root).getCookiesForHostname('')).toEqual([])
  })

  it('cookieHostKeys: host, then each dotted parent domain, never the bare top-level label; IPs match only themselves', () => {
    expect(cookieHostKeys('A.b.Example.com.')).toEqual(['a.b.example.com', '.a.b.example.com', '.b.example.com', '.example.com'])
    expect(cookieHostKeys('localhost')).toEqual(['localhost'])
    expect(cookieHostKeys('127.0.0.1')).toEqual(['127.0.0.1'])
    expect(cookieHostKeys('[::1]')).toEqual(['[::1]'])
  })
})
