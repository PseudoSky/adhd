/**
 * guards: a long-snippet result list (30 or more hits) serializes over 8192 bytes under a count-only bound
 * tier: S
 * cites: ticket 8468f7b1 [fix-search-output.1]
 * The default search output is bounded by result count AND bytes. 40 results whose raw snippets are 600 bytes
 * serialize within DEFAULT_MAX_RESULT_BYTES (8192) by dropping whole results from the tail (never a result cut
 * mid-record), with `omitted` carrying the dropped count (the truncation marker; api.ts allows no optional boolean); 5 short results are untouched;
 * `maxResultBytes` overrides the bound and a non-positive value is a typed SEARCH_FAILED usage error.
 *
 * Ticket 8468f7b1 · [fix-search-output.1]
 */
import { describe, expect, it } from 'vitest'
import type { SearchOutput } from '../../../src/api.js'
import { StealthSearchError } from '../../../src/errors.js'
import { DEFAULT_MAX_RESULT_BYTES } from '../../../src/lib/search.js'
import { input, makeWorld, response, scriptedEngine } from '../../helpers/verbs/harness.js'

const bytes = (out: SearchOutput): number => Buffer.byteLength(JSON.stringify(out))
const longResults = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ title: `Result ${i}`, url: `https://example.com/p/${i}`, snippet: `${String(i).padStart(3, '0')} ${'lorem ipsum '.repeat(50)}`.slice(0, 600) }))
const run = (n: number, over: Record<string, unknown> = {}) => {
  const world = makeWorld({ strategies: scriptedEngine(response({ results: longResults(n), count: n })).strategies })
  return world.svc.search(input(over))
}

describe('fix-search-output.1: the 8192 byte bound on the default result list', () => {
  it('8192 bytes count: 40 long-snippet results serialize within the default byte bound (DEFAULT_MAX_RESULT_BYTES is 8192)', async () => {
    expect(DEFAULT_MAX_RESULT_BYTES).toBe(8192)
    const out = await run(40)
    expect(out.outcome).toBe('success')
    expect(bytes(out)).toBeLessThanOrEqual(8192)
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results.length).toBeLessThan(40)
  })

  it('whole results truncated: the kept results are an unbroken prefix, each intact, with omitted the dropped count', async () => {
    const out = await run(40)
    const all = longResults(40)
    expect(out.omitted).toBeGreaterThan(0)
    expect(out.omitted).toBe(40 - out.results.length)
    expect(out.count).toBe(40)
    out.results.forEach((hit, i) => {
      expect(hit.title).toBe(all[i]?.title)
      expect(hit.url).toBe(all[i]?.url)
      expect(hit.snippet).toBe(`${all[i]?.snippet.slice(0, 300)}…`)
    })
  })

  it('whole results: dropping one more result would not be needed, so the bound is filled greedily', async () => {
    const out = await run(40)
    expect(out.omitted).toBeGreaterThan(0)
    const next = longResults(40)[out.results.length]
    const withNext: SearchOutput = { ...out, omitted: (out.omitted ?? 0) - 1, results: [...out.results, { title: next?.title ?? '', url: next?.url ?? '', snippet: `${next?.snippet.slice(0, 300)}…` }] }
    expect(bytes(withNext)).toBeGreaterThan(8192)
  })

  it('count: 5 short results are untouched, with no omitted marker', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response({ results: longResults(5).map((r) => ({ ...r, snippet: 'short' })), count: 5 })).strategies })
    const out = await world.svc.search(input())
    expect(out.results).toHaveLength(5)
    expect(out.results.every((r) => r.snippet === 'short')).toBe(true)
    expect(out).not.toHaveProperty('omitted')
  })

  it('maxResultBytes overrides the default bound: a larger bound keeps more whole results, still within the bound', async () => {
    const small = await run(40)
    const big = await run(40, { maxResultBytes: 20_000 })
    expect(big.results.length).toBeGreaterThan(small.results.length)
    expect(bytes(big)).toBeLessThanOrEqual(20_000)
  })

  it('a bound smaller than one result drops every result and still marks omitted, never a partial record', async () => {
    const out = await run(40, { maxResultBytes: 1 })
    expect(out.results).toEqual([])
    expect(out.omitted).toBeGreaterThan(0)
    expect(out.omitted).toBe(40)
  })

  it.each([0, -1, 1.5, Number.NaN])('typed error: maxResultBytes %s is a SEARCH_FAILED invalid-option error before any page opens', async (bad) => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    const err = await world.svc.search(input({ maxResultBytes: bad })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StealthSearchError)
    expect(err).toMatchObject({ code: 'SEARCH_FAILED', detail: { reason: 'invalid-option', field: 'maxResultBytes' } })
    expect(world.core.pages).toHaveLength(0)
  })
})
