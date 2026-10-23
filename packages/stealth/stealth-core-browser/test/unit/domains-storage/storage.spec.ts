/**
 * Feature-level pins for the read-only profile access layer (failsafe inventory fs-157, fs-158, fs-159).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [tests-unit-data.6].
 * Scenario: an agent reads the history/cookies of a profile whose Chrome is running. Databases are
 * built in the OS temp dir inside the test; no real Chrome profile is ever read.
 * guards: [fs-157] opens databases read-only and immutable
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [tests-unit-data.6]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chromeTimeToDate } from '../../../src/lib/helpers.js'
import { CookieClient } from '../../../src/lib/storage/cookies.js'
import { openDb, toUnixTimeSql } from '../../../src/lib/storage/helpers.js'
import { HistoryClient } from '../../../src/lib/storage/history.js'
import { ProfileClient } from '../../../src/lib/storage/profile.js'
import { chromeMicros, makeProfile, type Fixture } from '../../helpers/domains-storage/profile-fixture.js'

describe('8468f7b1 AC2 [tests-unit-data.6] read-only profile access', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = makeProfile()
    const d = fx.db('History', ['CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT)'])
    d.prepare('INSERT INTO urls VALUES (1, ?)').run('https://a.test/')
    d.close()
  })
  afterEach(() => { fx.cleanup(); vi.restoreAllMocks() })

  it('[fs-157] opens databases read-only and immutable', () => {
    const path = join(fx.defaultDir, 'History')
    const before = readFileSync(path)
    const db = openDb(path)
    try {
      expect(db.prepare('SELECT url FROM urls WHERE id = 1').get()).toEqual({ url: 'https://a.test/' })
      // writes are refused, so a running Chrome is never contended and nothing is ever written
      expect(() => db.exec("INSERT INTO urls VALUES (2, 'https://x.test/')")).toThrow()
      expect(() => db.exec('DROP TABLE urls')).toThrow()
    } finally { db.close() }
    expect(readFileSync(path).equals(before)).toBe(true) // byte-identical after the session
    // mode=ro never creates a missing database
    const missing = join(fx.defaultDir, 'DoesNotExist')
    expect(() => openDb(missing)).toThrow()
    expect(() => readFileSync(missing)).toThrow()
  })

  it('[fs-158] sets query_only on every database', async () => {
    const path = join(fx.defaultDir, 'History')
    const db = openDb(path)
    try {
      expect(db.prepare('PRAGMA query_only').get()).toMatchObject({ query_only: BigInt(1) })
    } finally { db.close() }

    // every client opens through the guarded opener
    const { DatabaseSync } = await import('node:sqlite')
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
    const cookies = fx.db('Cookies', [`CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, path TEXT,
      creation_utc INTEGER, last_access_utc INTEGER, has_expires INTEGER, expires_utc INTEGER,
      is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, priority INTEGER)`])
    cookies.close()
    const logins = fx.db('Login Data', ['CREATE TABLE logins (origin_url TEXT)'])
    logins.close()
    exec.mockClear()
    new CookieClient(fx.root).getCookies()
    new ProfileClient(fx.root).hasSavedCredentials()
    expect(() => new HistoryClient(fx.root).getRecentVisits()).toThrow() // no visits table in this fixture
    const pragmas = exec.mock.calls.filter(([sql]) => sql === 'PRAGMA query_only = ON')
    expect(pragmas).toHaveLength(3)
  })

  it('[fs-159] converts chrome timestamps', () => {
    expect(toUnixTimeSql('t.col')).toBe('((t.col / 1000000) - 11644473600)')
    // the SQL expression really evaluates to unix seconds
    const db = openDb(join(fx.defaultDir, 'History'))
    try {
      const unix = 1_800_000_000
      const row = db.prepare(`SELECT ${toUnixTimeSql('?')} AS s`).get(chromeMicros(unix)) as { s: bigint | number }
      expect(Number(row.s)).toBe(unix)
    } finally { db.close() }
    // and to JS dates: the 1601 epoch offset is applied
    expect(chromeTimeToDate(chromeMicros(0)).toISOString()).toBe('1970-01-01T00:00:00.000Z')
    expect(chromeTimeToDate(chromeMicros(1_800_000_000)).getTime()).toBe(1_800_000_000_000)
    expect(chromeTimeToDate(0).getUTCFullYear()).toBe(1601)
  })
})
