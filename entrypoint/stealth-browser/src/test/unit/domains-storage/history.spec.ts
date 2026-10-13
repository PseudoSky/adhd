/**
 * Unit spec for src/lib/storage/history.ts (HistoryClient).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [port-fixes.2].
 * SQLite fixture built in the OS temp dir; the real Chrome profile is never read.
 * Every test runs through the shipped read-only `readBigInts` opener (no opener mock).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HistoryClient } from '../../../lib/storage/history.js'
import { chromeMicros, makeProfile, type Fixture } from './profile-fixture.js'

const NOW = 1_800_000_000 // unix seconds
const TYPED = 1 | 0x20000000 // TYPED + CHAIN_END (user-visible)
const LINK = 0 | 0x20000000
const SUBFRAME = 3 | 0x20000000 // AUTO_SUBFRAME, filtered out

describe('8468f7b1 AC2 [tests-unit-data.1] HistoryClient', () => {
  let fx: Fixture
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW * 1000))
    fx = makeProfile()
    const d = fx.db('History', [
      'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)',
      'CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER, from_visit INTEGER, visit_duration INTEGER, opener_visit INTEGER)',
      'CREATE TABLE keyword_search_terms (url_id INTEGER, term TEXT, normalized_term TEXT)',
      'CREATE TABLE clusters (cluster_id INTEGER, label TEXT)',
      'CREATE TABLE clusters_and_visits (cluster_id INTEGER, visit_id INTEGER, score REAL)',
      'CREATE TABLE content_annotations (visit_id INTEGER, model_version INTEGER)',
      'CREATE TABLE context_annotations (visit_id INTEGER, total_foreground_duration INTEGER)',
    ])
    const url = d.prepare('INSERT INTO urls VALUES (?,?,?,?,?,?,?)')
    url.run(1, 'https://a.test/', 'Alpha', 5, 2, chromeMicros(NOW - 100), 0)
    url.run(2, 'https://b.test/', 'Beta', 1, 0, chromeMicros(NOW - 200), 1)
    url.run(3, 'https://frame.test/', 'Frame', 1, 0, chromeMicros(NOW - 50), 0)
    const v = d.prepare('INSERT INTO visits VALUES (?,?,?,?,?,?,?)')
    v.run(1, 2, chromeMicros(NOW - 200), LINK, 0, 1000, 0)
    v.run(2, 1, chromeMicros(NOW - 100), TYPED, 1, 2_000_000, 0)
    v.run(3, 3, chromeMicros(NOW - 50), SUBFRAME, 2, 0, 0)
    v.run(4, 1, chromeMicros(NOW - 86400 * 40), LINK, 0, 0, 0) // outside 30 days
    d.prepare('INSERT INTO keyword_search_terms VALUES (?,?,?)').run(1, 'Alpha Query', 'alpha query')
    d.prepare('INSERT INTO clusters VALUES (?,?)').run(7, 'Reading')
    d.prepare('INSERT INTO clusters VALUES (?,?)').run(8, null)
    d.prepare('INSERT INTO clusters_and_visits VALUES (?,?,?)').run(7, 1, 0.4)
    d.prepare('INSERT INTO clusters_and_visits VALUES (?,?,?)').run(7, 2, 0.9)
    d.prepare('INSERT INTO content_annotations VALUES (?,?)').run(2, 99)
    d.prepare('INSERT INTO context_annotations VALUES (?,?)').run(2, 1234)
    d.close()
  })
  afterEach(() => { fx.cleanup(); vi.useRealTimers() })

  it('path points at <profile>/Default/History', () => {
    expect(new HistoryClient(fx.root).path).toBe(`${fx.root}/Default/History`)
  })

  it('getLastVisit returns the newest user-visible visit and skips subframes', () => {
    const last = new HistoryClient(fx.root).getLastVisit()
    expect(last?.id).toBe(2)
    expect(last?.url).toBe('https://a.test/')
    expect(last?.transitionType).toBe('TYPED')
    expect(last?.visitTime.getTime()).toBe((NOW - 100) * 1000)
  })

  it('getRecentVisits honours limit/offset and ordering', () => {
    const c = new HistoryClient(fx.root)
    expect(c.getRecentVisits(2, 0).map((x) => x.id)).toEqual([2, 1])
    expect(c.getRecentVisits(1, 1).map((x) => x.id)).toEqual([1])
  })

  it('isRecentlyUsed compares the last visit against the window', () => {
    const c = new HistoryClient(fx.root)
    expect(c.isRecentlyUsed(2)).toBe(true) // 100s ago
    expect(c.isRecentlyUsed(1)).toBe(false)
  })

  it('getRedirectChain walks from_visit back to the root', () => {
    const chain = new HistoryClient(fx.root).getRedirectChain(2)
    expect(chain.map((x) => x.visitId)).toEqual([2, 1])
    expect(chain.map((x) => x.depth)).toEqual([0, 1])
    expect(chain[1].url).toBe('https://b.test/')
  })

  it('getUrlInfo looks up by url string or numeric id', () => {
    const c = new HistoryClient(fx.root)
    const byUrl = c.getUrlInfo('https://a.test/')
    expect(byUrl).toMatchObject({ id: 1, title: 'Alpha', visitCount: 5, typedCount: 2, hidden: false })
    expect(c.getUrlInfo(2)?.hidden).toBe(true)
  })

  it('getUrlInfo returns null for unknown urls (error path)', () => {
    expect(new HistoryClient(fx.root).getUrlInfo('https://nope.test/')).toBeNull()
    expect(new HistoryClient(fx.root).getUrlInfo(999)).toBeNull()
  })

  it('searchUrls matches url or title and orders by recency', () => {
    const c = new HistoryClient(fx.root)
    expect(c.searchUrls('test').map((u) => u.id)).toEqual([3, 1, 2])
    expect(c.searchUrls('beta').map((u) => u.id)).toEqual([2])
    expect(c.searchUrls('test', 1)).toHaveLength(1)
    expect(c.searchUrls('zzz')).toEqual([])
  })

  it('getVisitStats groups recent visits by day and excludes older ones', () => {
    const stats = new HistoryClient(fx.root).getVisitStats(30)
    expect(stats.reduce((n, s) => n + s.visits, 0)).toBe(3)
    expect(stats[0].transitionBreakdown).toEqual({})
  })

  it('getTransitionBreakdown names transitions and respects the window', () => {
    const b = new HistoryClient(fx.root).getTransitionBreakdown(30)
    expect(b).toEqual({ LINK: 1, TYPED: 1, AUTO_SUBFRAME: 1 })
    expect(new HistoryClient(fx.root).getTransitionBreakdown(60)['LINK']).toBe(2)
  })

  it('getSearchTermsForUrl returns term pairs', () => {
    const c = new HistoryClient(fx.root)
    expect(c.getSearchTermsForUrl('https://a.test/')).toEqual([{ term: 'Alpha Query', normalizedTerm: 'alpha query' }])
    expect(c.getSearchTermsForUrl('https://b.test/')).toEqual([])
  })

  it('getClusterData nests visits ordered by score desc', () => {
    const clusters = new HistoryClient(fx.root).getClusterData()
    expect(clusters.map((c) => c.clusterId)).toEqual([7, 8])
    expect(clusters[0].label).toBe('Reading')
    expect(clusters[0].visits.map((v) => v.score)).toEqual([0.9, 0.4])
    expect(clusters[1].label).toBeNull()
    expect(clusters[1].visits).toEqual([])
  })

  it('content and context annotations return the row or null', () => {
    const c = new HistoryClient(fx.root)
    expect(c.getContentAnnotations(2)).toMatchObject({ visit_id: BigInt(2) })
    expect(c.getContextAnnotations(2)).toMatchObject({ total_foreground_duration: BigInt(1234) })
    expect(c.getContentAnnotations(404)).toBeNull()
    expect(c.getContextAnnotations(404)).toBeNull()
  })

  it('opens the database read-only: a write on the same URI form is rejected (error path)', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const ro = new DatabaseSync(`file:${fx.defaultDir}/History?mode=ro&immutable=1`)
    expect(() => ro.exec("INSERT INTO urls VALUES (9,'x','x',0,0,0,0)")).toThrow()
    ro.close()
  })

  it('[port-fixes.2] getLastVisit works through the shipped BigInt opener and returns plain numbers', () => {
    const last = new HistoryClient(fx.root).getLastVisit()
    expect(last?.id).toBe(2)
    for (const v of [last?.id, last?.urlId, last?.transitionRaw, last?.fromVisitId, last?.openerVisitId, last?.visitDurationMs, last?.visitTimeUnix]) {
      expect(typeof v).toBe('number')
    }
    expect(last?.visitDurationMs).toBe(2000)
  })

  it('[port-fixes.2] getRedirectChain returns number ids and depths, never BigInt', () => {
    const chain = new HistoryClient(fx.root).getRedirectChain(2)
    expect(chain.length).toBeGreaterThan(0)
    for (const e of chain) {
      expect(typeof e.visitId).toBe('number')
      expect(typeof e.depth).toBe('number')
      expect(e.visitId).toBeTypeOf('number')
    }
    expect(chain.map((e) => e.visitId)).toEqual([2, 1])
  })

  it('throws when the History database is missing (error path)', () => {
    const empty = makeProfile()
    try {
      expect(() => new HistoryClient(empty.root).getLastVisit()).toThrow()
      expect(() => new HistoryClient(empty.root).getVisitStats()).toThrow()
    } finally { empty.cleanup() }
  })
})
