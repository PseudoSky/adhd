/**
 * Unit spec for src/lib/storage/helpers.ts (openDb, toUnixTimeSql).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * node:sqlite is replaced by a recording fake; no database file is opened.
 * guards: [fs-175] maps transitions and hydrates visits
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sqlite = vi.hoisted(() => ({
  uris: [] as Array<{ uri: string; opts: unknown }>,
  exec: vi.fn(),
  fail: false,
}))
vi.mock('node:sqlite', () => ({
  DatabaseSync: class {
    constructor(uri: string, opts?: unknown) {
      if (sqlite.fail) throw new Error('unable to open database file')
      sqlite.uris.push({ uri, opts })
    }
    exec(sql: string) { sqlite.exec(sql) }
  },
}))

vi.mock('node:os', () => ({ homedir: () => '/fake/home' }))

import { openDb, toUnixTimeSql } from '../../../src/lib/storage/helpers.js'
import { chromeProfileDir, chromeTimeToDate, hydrateVisit, notYet, transitionName, type VisitRow } from '../../../src/lib/helpers.js'

describe('8468f7b1 AC2 [tests-unit-data.6] lib/helpers feature pins', () => {
  it('[fs-175] maps transitions and hydrates visits', () => {
    expect(transitionName(0)).toBe('LINK')
    expect(transitionName(1)).toBe('TYPED')
    expect(transitionName(0x20000000 | 3)).toBe('AUTO_SUBFRAME') // qualifier bits ignored
    expect(transitionName(99)).toBe('UNKNOWN(99)') // unknown codes labelled
    expect(chromeProfileDir().startsWith('/fake/home/')).toBe(true)
    expect(chromeProfileDir().endsWith('/Google/Chrome-CDP')).toBe(true) // dedicated profile, never the default Chrome dir
    expect(chromeTimeToDate(11644473600 * 1_000_000).getTime()).toBe(0)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      notYet('someRead')
      expect(warn).toHaveBeenCalledWith('[cdp-query] someRead is not yet implemented')
    } finally { warn.mockRestore() }
    const v = hydrateVisit({
      id: BigInt(5), url_id: BigInt(2), url: 'https://a.test/', title: 'A', visit_time_unix: BigInt(1_800_000_000),
      transition: BigInt(1 | 0x20000000), from_visit: BigInt(4), visit_duration: BigInt(2_000_000), opener_visit: BigInt(0),
    })
    expect(v).toMatchObject({ id: 5, urlId: 2, transitionType: 'TYPED', fromVisitId: 4, openerVisitId: 0, url: 'https://a.test/' })
  })

  it('[fs-176] hydrateVisit converts durations and dates', () => {
    const row: VisitRow = {
      id: 1, url_id: 1, url: 'u', title: 't', visit_time_unix: 1_700_000_000, transition: 0,
      from_visit: 0, visit_duration: 1_500_400, opener_visit: 0,
    }
    const v = hydrateVisit(row)
    expect(v.visitDurationMs).toBe(1500) // microseconds -> rounded milliseconds
    expect(v.visitTimeUnix).toBe(1_700_000_000)
    expect(v.visitTime.getTime()).toBe(1_700_000_000_000) // unix seconds -> Date
    expect(typeof v.visitDurationMs).toBe('number')
    expect(hydrateVisit({ ...row, visit_duration: 0 }).visitDurationMs).toBe(0)
  })
})

describe('8468f7b1 AC2 [tests-unit-data.1] storage helpers', () => {
  beforeEach(() => { sqlite.uris.length = 0; sqlite.exec.mockReset(); sqlite.fail = false })

  it('openDb opens a read-only immutable URI', () => {
    openDb('/tmp/fixture/History')
    expect(sqlite.uris[0].uri).toBe('file:/tmp/fixture/History?mode=ro&immutable=1')
    expect(sqlite.uris[0].uri).toContain('mode=ro&immutable=1')
  })

  it('openDb reads bigints and forces PRAGMA query_only', () => {
    openDb('/tmp/fixture/History')
    expect(sqlite.uris[0].opts).toEqual({ readBigInts: true })
    expect(sqlite.exec).toHaveBeenCalledWith('PRAGMA query_only = ON')
  })

  it('openDb never opens read-write', () => {
    openDb('/tmp/fixture/History')
    expect(sqlite.uris[0].uri).not.toContain('mode=rw')
  })

  it('openDb propagates open failures (error path)', () => {
    sqlite.fail = true
    expect(() => openDb('/tmp/missing')).toThrow('unable to open database file')
  })

  it('toUnixTimeSql converts Chrome microseconds-since-1601 to unix seconds', () => {
    expect(toUnixTimeSql('v.visit_time')).toBe('((v.visit_time / 1000000) - 11644473600)')
  })
})
