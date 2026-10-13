/**
 * Unit spec for src/lib/storage/cookies.ts (CookieClient).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [port-fixes.3].
 * Reads a SQLite fixture created in the OS temp dir; a spy on console proves no real profile path is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieClient } from '../../../lib/storage/cookies.js'
import { chromeMicros, makeProfile, type Fixture } from './profile-fixture.js'

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

  it('throws when the Cookies database is missing (error path)', () => {
    const empty = makeProfile()
    try {
      expect(() => new CookieClient(empty.root).getCookies()).toThrow()
    } finally { empty.cleanup() }
  })
})
