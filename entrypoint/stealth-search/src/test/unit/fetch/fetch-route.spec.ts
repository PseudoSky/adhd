/**
 * The fetch provider route (inventory I-09): the query is the URL, no qualifier, no strategy loop.
 * Ticket 8468f7b1 · [search-port-fetch.2]
 */
import { describe, expect, it } from 'vitest'
import { isFetchProvider, runFetchProvider } from '../../../lib/fetch/fetch.js'
import { CF_BAN, longBody, makeWorld, page } from './harness.js'

describe('fetch provider skips the strategy loop', () => {
  it('hands the query through untouched even when the provider has a qualifier', async () => {
    const w = makeWorld({ html: [page('Guide', longBody())] })
    const nav: string[] = []
    const settle = w.deps.settle!
    w.deps.settle = async (s, o) => {
      nav.push(o.navigate)
      return settle(s, o)
    }
    const r = await runFetchProvider({ id: 'fetch', bans: CF_BAN, qualifier: 'site:example.com' }, 'https://example.com/a', {}, w.deps)
    expect(r.outcome).toBe('success')
    expect(nav).toEqual(['https://example.com/a'])
  })

  it('makes exactly one attempt even when the outcome is an error (no retry loop)', async () => {
    const w = makeWorld({ responses: [{ url: 'https://example.com/a', status: 503, mimeType: 'text/html' }], html: [page('x', 'y')] })
    w.deps.settle = async () => {
      throw new Error('boom')
    }
    const r = await runFetchProvider({ id: 'fetch', bans: [] }, 'https://example.com/a', {}, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.attempts).toBe(1)
    expect(w.opened).toBe(1)
  })

  it('identifies the fetch provider by id', () => {
    expect(isFetchProvider({ id: 'fetch' })).toBe(true)
    expect(isFetchProvider({ id: 'google' })).toBe(false)
  })
})
