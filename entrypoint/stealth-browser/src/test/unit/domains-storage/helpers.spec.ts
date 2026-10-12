/**
 * Unit spec for src/lib/storage/helpers.ts (openDb, toUnixTimeSql).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * node:sqlite is replaced by a recording fake; no database file is opened.
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

import { openDb, toUnixTimeSql } from '../../../lib/storage/helpers.js'

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
