/**
 * guards: the production direct fetch connects by name instead of the validated address, or buffers an oversized or endless body without a cap or a timeout
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1]
 * `pinnedGet` over a mocked `node:https` (no socket): the request carries a lookup that answers only the pinned
 * address, keeps the hostname for TLS, ends on an oversized body or a stalled one, and reports a redirect without
 * following it. Pre-review P4 and P29.
 * Ticket 8468f7b1 · [audit-fixes.1]
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ default: { request: hoisted.request }, request: hoisted.request }))

import { pinnedGet, pinnedLookup } from '../../../src/lib/fetch/pinned.js'

class FakeRes extends EventEmitter {
  destroyed = false
  constructor(
    public statusCode: number,
    public headers: Record<string, string> = {},
  ) {
    super()
  }
  destroy(): void {
    this.destroyed = true
  }
}
class FakeReq extends EventEmitter {
  destroyed = false
  ended = false
  destroy(): void {
    this.destroyed = true
  }
  end(): void {
    this.ended = true
  }
}

/** Make `https.request` answer with `res` (called once the request is created) and return the captured request. */
function serve(res: FakeRes | null): { req: FakeReq; options: () => Record<string, unknown> } {
  const req = new FakeReq()
  let captured: Record<string, unknown> = {}
  hoisted.request.mockImplementation((options: Record<string, unknown>, cb: (r: FakeRes) => void) => {
    captured = options
    if (res) queueMicrotask(() => cb(res))
    return req
  })
  return { req, options: () => captured }
}

const OPTS = { headers: { Accept: '*/*' }, maxBytes: 10, timeoutMs: 1000 }

afterEach(() => {
  vi.useRealTimers()
  hoisted.request.mockReset()
})

describe('the production direct fetch connects to the validated address and is bounded [audit-fixes.1]', () => {
  it('P4 pinned lookup: the request connects through a lookup that answers only the pinned address and keeps the hostname for TLS', async () => {
    const res = new FakeRes(200)
    const s = serve(res)
    const done = pinnedGet('https://docs.example.test/a.pdf?x=1', '93.184.216.34', OPTS)
    await Promise.resolve()
    res.emit('data', Buffer.from('abc'))
    res.emit('end')
    await expect(done).resolves.toMatchObject({ status: 200, location: null, body: new Uint8Array(Buffer.from('abc')) })
    const o = s.options()
    expect(o['hostname']).toBe('docs.example.test')
    expect(o['servername']).toBe('docs.example.test')
    expect(o['path']).toBe('/a.pdf?x=1')
    const lookup = o['lookup'] as (h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => void
    const single: unknown[] = []
    lookup('docs.example.test', {}, (...a) => single.push(...a))
    expect(single).toEqual([null, '93.184.216.34', 4])
    const all: unknown[] = []
    lookup('anything.else', { all: true }, (...a) => all.push(...a))
    expect(all).toEqual([null, [{ address: '93.184.216.34', family: 4 }]])
    expect(s.req.ended).toBe(true)
  })

  it('P4 pinned lookup: an IPv6 pinned address answers family 6', () => {
    const out: unknown[] = []
    pinnedLookup('2606:4700::1')('h', {}, (...a) => out.push(...a))
    expect(out).toEqual([null, '2606:4700::1', 6])
  })

  it('P29 byte cap: a streamed body above maxBytes ends the request with a typed error', async () => {
    const res = new FakeRes(200)
    const s = serve(res)
    const done = pinnedGet('https://docs.example.test/a.pdf', '93.184.216.34', OPTS)
    await Promise.resolve()
    res.emit('data', Buffer.alloc(6))
    res.emit('data', Buffer.alloc(6))
    await expect(done).rejects.toMatchObject({ code: 'SEARCH_FAILED', detail: { reason: 'direct-fetch-too-large' } })
    expect(res.destroyed).toBe(true)
    expect(s.req.destroyed).toBe(true)
  })

  it('P29 byte cap: a declared content-length above maxBytes is refused before any body is read', async () => {
    const res = new FakeRes(200, { 'content-length': '999' })
    serve(res)
    await expect(pinnedGet('https://docs.example.test/a.pdf', '93.184.216.34', OPTS)).rejects.toMatchObject({ detail: { reason: 'direct-fetch-too-large' } })
    expect(res.destroyed).toBe(true)
  })

  it('P29 timeout: a response that never arrives ends with a typed timeout error', async () => {
    vi.useFakeTimers()
    const s = serve(null)
    const done = pinnedGet('https://docs.example.test/a.pdf', '93.184.216.34', OPTS)
    const assertion = expect(done).rejects.toMatchObject({ code: 'SEARCH_FAILED', detail: { reason: 'direct-fetch-timeout' } })
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
    expect(s.req.destroyed).toBe(true)
  })

  it('P29 timeout: an endless body that stalls after the headers also ends on the deadline', async () => {
    vi.useFakeTimers()
    const res = new FakeRes(200)
    serve(res)
    const done = pinnedGet('https://docs.example.test/a.pdf', '93.184.216.34', { ...OPTS, maxBytes: 1_000_000 })
    const assertion = expect(done).rejects.toMatchObject({ detail: { reason: 'direct-fetch-timeout' } })
    await vi.advanceTimersByTimeAsync(0)
    res.emit('data', Buffer.alloc(3))
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
  })

  it('P4 redirect: a 3xx is reported with its Location and no body, never followed', async () => {
    const res = new FakeRes(302, { location: 'https://cdn.example.test/a.pdf' })
    serve(res)
    await expect(pinnedGet('https://docs.example.test/a.pdf', '93.184.216.34', OPTS)).resolves.toEqual({ status: 302, location: 'https://cdn.example.test/a.pdf', body: new Uint8Array(0) })
    expect(res.destroyed).toBe(true)
  })

  it('P29 transport failure: a socket error is a typed SEARCH_FAILED', async () => {
    const s = serve(null)
    const done = pinnedGet('https://docs.example.test/a.pdf', '93.184.216.34', OPTS)
    s.req.emit('error', new Error('ECONNRESET'))
    await expect(done).rejects.toMatchObject({ code: 'SEARCH_FAILED', detail: { reason: 'direct-fetch-failed' } })
  })
})
