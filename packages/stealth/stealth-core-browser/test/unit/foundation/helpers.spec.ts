/**
 * Unit spec for src/lib/helpers.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4].
 * node:sqlite and node:os are mocked: no real database and no real HOME or Chrome profile is touched.
 * guards: maps every documented Chrome transition code to its name
 * tier: S
 * cites: 8468f7b1 [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sqlite = vi.hoisted(() => {
  const state = {
    uris: [] as string[],
    execs: [] as string[],
    execError: null as Error | null,
    ctorError: null as Error | null,
  }
  class DatabaseSync {
    constructor(uri: string) {
      if (state.ctorError) throw state.ctorError
      state.uris.push(uri)
    }
    exec(sql: string): void {
      if (state.execError) throw state.execError
      state.execs.push(sql)
    }
  }
  return { state, DatabaseSync }
})

vi.mock('node:sqlite', () => ({ DatabaseSync: sqlite.DatabaseSync }))
vi.mock('node:os', () => ({ homedir: () => '/fake/home' }))

import {
  VISIT_COLUMNS,
  chromeProfileDir,
  chromeTimeToDate,
  defaultChromeDir,
  hydrateVisit,
  notYet,
  toUnixTimeSql,
  transitionName,
} from '../../../src/lib/helpers.js'
import type { VisitRow } from '../../../src/lib/helpers.js'

describe('8468f7b1 AC2 [tests-unit-core.1] transitionName', () => {
  it('maps every documented Chrome transition code to its name', () => {
    const names = [
      'LINK', 'TYPED', 'AUTO_BOOKMARK', 'AUTO_SUBFRAME', 'MANUAL_SUBFRAME', 'GENERATED',
      'AUTO_TOPLEVEL', 'FORM_SUBMIT', 'RELOAD', 'KEYWORD', 'KEYWORD_GENERATED',
    ]
    expect(names.map((_, i) => transitionName(i))).toEqual(names)
  })

  it('masks the qualifier bits so only the core type (low byte) is named', () => {
    expect(transitionName(0x00800001)).toBe('TYPED')
    expect(transitionName(0x10000000)).toBe('LINK')
  })

  it('reports an unmapped code as UNKNOWN(n) (error path)', () => {
    expect(transitionName(99)).toBe('UNKNOWN(99)')
    expect(transitionName(0x100 + 42)).toBe('UNKNOWN(42)')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.3] profile paths (homedir mocked)', () => {
  it('chromeProfileDir is the dedicated Chrome-CDP profile under the mocked HOME', () => {
    const dir = chromeProfileDir()
    expect(dir.startsWith('/fake/home/')).toBe(true)
    expect(dir.endsWith('Chrome-CDP')).toBe(true)
  })

  it('defaultChromeDir is the everyday Chrome profile, distinct from the CDP one', () => {
    const dir = defaultChromeDir()
    expect(dir.startsWith('/fake/home/')).toBe(true)
    expect(dir.endsWith('Chrome')).toBe(true)
    expect(dir).not.toBe(chromeProfileDir())
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] notYet', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns with the feature name and does not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() => notYet('bookmarks.sync')).not.toThrow()
    expect(warn).toHaveBeenCalledWith('[cdp-query] bookmarks.sync is not yet implemented')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] Chrome time conversion', () => {
  it('maps the Chrome epoch offset to the unix epoch', () => {
    expect(chromeTimeToDate(11644473600 * 1_000_000).getTime()).toBe(0)
  })

  it('converts a known microsecond timestamp to the matching Date', () => {
    const chromeTime = (11644473600 + 1_700_000_000) * 1_000_000
    expect(chromeTimeToDate(chromeTime).toISOString()).toBe('2023-11-14T22:13:20.000Z')
  })

  it('yields a pre-1970 date for Chrome time 0 (negative boundary)', () => {
    expect(chromeTimeToDate(0).getUTCFullYear()).toBe(1601)
  })

  it('builds the SQL expression for a column', () => {
    expect(toUnixTimeSql('v.visit_time')).toBe('((v.visit_time / 1000000) - 11644473600)')
  })

  it('embeds that expression in VISIT_COLUMNS', () => {
    expect(VISIT_COLUMNS).toContain(`${toUnixTimeSql('v.visit_time')} AS visit_time_unix`)
    expect(VISIT_COLUMNS).toContain('v.url AS url_id')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] hydrateVisit', () => {
  const row: VisitRow = {
    id: 7,
    url_id: 3,
    url: 'https://example.com/',
    title: 'Example',
    visit_time_unix: 1_700_000_000,
    transition: 0x00800001,
    from_visit: 5,
    visit_duration: 2_500_000,
    opener_visit: 2,
  }

  it('maps snake_case DB columns onto the ChromeVisit shape', () => {
    expect(hydrateVisit(row)).toEqual({
      id: 7,
      urlId: 3,
      url: 'https://example.com/',
      title: 'Example',
      visitTimeUnix: 1_700_000_000,
      visitTime: new Date(1_700_000_000_000),
      transitionType: 'TYPED',
      transitionRaw: 0x00800001,
      fromVisitId: 5,
      visitDurationMs: 2500,
      openerVisitId: 2,
    })
  })

  it('rounds sub-millisecond durations and names unknown transitions', () => {
    const v = hydrateVisit({ ...row, visit_duration: 1_499, transition: 77 })
    expect(v.visitDurationMs).toBe(1)
    expect(v.transitionType).toBe('UNKNOWN(77)')
  })
})
