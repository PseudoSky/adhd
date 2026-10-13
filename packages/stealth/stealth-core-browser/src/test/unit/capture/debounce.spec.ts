/**
 * The settle debounce and the in-flight body guard.
 * Ticket 8468f7b1 AC capture-upgrade.8 · [capture-upgrade.8]
 * Real use: the capture resolves when the page has answered. The old default
 * silently waited 500 ms even for an explicit 0; now unset and 0 add no wait,
 * an explicit extraWaitMs is an exact quiet period that restarts on every
 * landed body, and a settle never resolves while a body fetch is in flight
 * (the bodyFetchPending guard).
 */
import { describe, expect, it, vi } from 'vitest'
import { captureAllNetworkResponses, captureNetworkResponse } from '../../../lib/capture/network.js'
import type { CdpSession } from '../../../lib/cdp/session.js'
import { fixtureWith, optionsFor, useFixture, WS_URL } from './capture-kit.js'

function track<T>(p: Promise<T>): { done: () => boolean; value: () => Promise<T> } {
  let done = false
  void p.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  return { done: () => done, value: () => p }
}

describe('8468f7b1 [capture-upgrade.8] no added wait by default', () => {
  useFixture('doc-200')

  it.each([
    ['unset', undefined],
    ['explicit 0', 0],
  ])('extraWaitMs %s resolves without advancing the clock', async (_name, extraWaitMs) => {
    vi.useFakeTimers()
    const t = track(captureNetworkResponse(WS_URL, optionsFor('doc-200', { extraWaitMs })))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.done()).toBe(true)
    expect((await t.value()).body).toContain('hello')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('8468f7b1 [capture-upgrade.8] explicit extraWaitMs is an exact quiet period', () => {
  useFixture('doc-200')

  it('300 is pending at 299 ms and resolved at 300 ms', async () => {
    vi.useFakeTimers()
    const t = track(captureNetworkResponse(WS_URL, optionsFor('doc-200', { extraWaitMs: 300 })))
    await vi.advanceTimersByTimeAsync(299)
    expect(t.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.done()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('8468f7b1 [capture-upgrade.8] each landed body restarts the quiet period', () => {
  useFixture(() =>
    fixtureWith('two-tabs-parallel', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      for (const ev of nav?.emit ?? []) {
        if (ev.params['requestId'] === 'B1') ev.delayMs = 200
      }
    }),
  )

  it('with extraWaitMs 300 the second body at 200 ms pushes the settle to 500 ms', async () => {
    vi.useFakeTimers()
    const t = track(captureAllNetworkResponses(WS_URL, optionsFor('two-tabs-parallel', { extraWaitMs: 300 })))
    await vi.advanceTimersByTimeAsync(299) // would have settled here without the restart
    expect(t.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(200) // t=499
    expect(t.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1) // t=500
    expect(t.done()).toBe(true)
    expect((await t.value()).map((c) => c.requestId)).toEqual(['A1', 'B1'])
  })
})

describe('8468f7b1 [capture-upgrade.8] the bodyFetchPending guard (real harness)', () => {
  useFixture('two-tabs-parallel')

  it('extraWaitMs 0 still returns both tabs: the first body must not settle the capture while the second body fetch is in flight', async () => {
    const all = await captureAllNetworkResponses(WS_URL, optionsFor('two-tabs-parallel', { extraWaitMs: 0 }))
    expect(all.map((c) => c.requestId)).toEqual(['A1', 'B1'])
  })
})

/** A session whose Network.getResponseBody replies are released by hand. */
function manualSession(): {
  session: CdpSession
  emit: (method: string, params: Record<string, unknown>) => void
  answer: (requestId: string, body: string | Error) => void
  closed: () => boolean
} {
  const handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>()
  const bodies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let closed = false
  const session = {
    connected: true,
    on(method: string, h: (p: Record<string, unknown>) => void) {
      const set = handlers.get(method) ?? new Set()
      set.add(h)
      handlers.set(method, set)
      return () => set.delete(h)
    },
    send(method: string, params: Record<string, unknown> = {}) {
      if (method === 'Network.getResponseBody') {
        return new Promise((resolve, reject) => bodies.set(String(params['requestId']), { resolve, reject }))
      }
      return Promise.resolve({})
    },
    close() {
      closed = true
    },
  } as unknown as CdpSession
  return {
    session,
    emit: (m, p) => handlers.get(m)?.forEach((h) => h(p)),
    answer: (id, body) => {
      const b = bodies.get(id)
      if (!b) throw new Error(`no pending body fetch for ${id}`)
      if (body instanceof Error) b.reject(body)
      else b.resolve({ body, base64Encoded: false })
    },
    closed: () => closed,
  }
}

function load(m: ReturnType<typeof manualSession>, id: string): void {
  m.emit('Network.requestWillBeSent', { requestId: id, request: { url: `https://site.test/${id}`, method: 'GET', headers: {} }, timestamp: 1 })
  m.emit('Network.responseReceived', { requestId: id, response: { url: `https://site.test/${id}`, status: 200, headers: {} } })
  m.emit('Network.loadingFinished', { requestId: id, timestamp: 1.1 })
}

describe('8468f7b1 [capture-upgrade.8] the bodyFetchPending guard (manual body replies)', () => {
  it('a quiet period that ends while a body fetch is in flight does not resolve; the fetch landing restarts it', async () => {
    vi.useFakeTimers()
    const m = manualSession()
    const t = track(captureAllNetworkResponses('ws://unused', { ...optionsFor('doc-200'), urlPattern: /site\.test/, extraWaitMs: 100, session: m.session }))
    await vi.advanceTimersByTimeAsync(0)
    load(m, 'A')
    load(m, 'B')
    await vi.advanceTimersByTimeAsync(0) // both body fetches are now in flight
    m.answer('A', 'first')
    await vi.advanceTimersByTimeAsync(100) // quiet period over, but B is still in flight
    expect(t.done()).toBe(false)
    m.answer('B', 'second body')
    await vi.advanceTimersByTimeAsync(99)
    expect(t.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.done()).toBe(true)
    expect((await t.value()).map((c) => c.body)).toEqual(['first', 'second body'])
    expect(m.closed()).toBe(false) // a supplied session is never closed
  })

  it('when the in-flight fetch ends without a body the settle resolves at once, not after another quiet period', async () => {
    vi.useFakeTimers()
    const m = manualSession()
    const t = track(captureNetworkResponse('ws://unused', { ...optionsFor('doc-200'), urlPattern: /site\.test/, extraWaitMs: 100, session: m.session }))
    await vi.advanceTimersByTimeAsync(0)
    load(m, 'A')
    load(m, 'B')
    await vi.advanceTimersByTimeAsync(0)
    m.answer('A', 'only body')
    await vi.advanceTimersByTimeAsync(100)
    expect(t.done()).toBe(false)
    m.answer('B', new Error('No resource with given identifier found'))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.done()).toBe(true)
    expect((await t.value()).body).toBe('only body')
  })
})
