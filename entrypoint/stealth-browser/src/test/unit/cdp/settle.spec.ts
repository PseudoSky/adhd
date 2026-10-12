/**
 * Unit spec for src/lib/cdp/settle.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4].
 * The CdpSession is an in-memory fake driven by hand-emitted events under fake timers:
 * no WebSocket, no network, no Chrome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { awaitPageSettled } from '../../../lib/cdp/settle.js'
import type { SettleResult } from '../../../lib/cdp/settle.js'
import type { CdpSession } from '../../../lib/cdp/session.js'

type Handler = (params: Record<string, unknown>) => void

interface Fake {
  session: CdpSession
  send: ReturnType<typeof vi.fn>
  emit: (method: string, params?: Record<string, unknown>) => void
  listenerCount: () => number
}

interface FakeOpts {
  navigateResult?: { loaderId?: string; errorText?: string }
  navigateError?: Error
  perfTimelineFails?: boolean
}

function makeFake(o: FakeOpts = {}): Fake {
  const handlers = new Map<string, Set<Handler>>()
  const send = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'Page.navigate') {
      if (o.navigateError) throw o.navigateError
      return o.navigateResult ?? { loaderId: 'L1' }
    }
    if (method === 'PerformanceTimeline.enable' && o.perfTimelineFails) throw new Error('unsupported')
    return {}
  })
  const on = vi.fn((method: string, handler: Handler) => {
    const set = handlers.get(method) ?? new Set<Handler>()
    set.add(handler)
    handlers.set(method, set)
    return () => {
      set.delete(handler)
    }
  })
  return {
    session: { send, on } as unknown as CdpSession,
    send,
    emit: (method, params = {}) => {
      for (const h of [...(handlers.get(method) ?? [])]) h(params)
    },
    listenerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  }
}

/** Let the arming awaits and the Page.navigate round trip settle. */
const arm = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1)
}

function track(p: Promise<SettleResult>): { result: () => SettleResult | undefined; settled: () => boolean } {
  let value: SettleResult | undefined
  let done = false
  p.then((r) => {
    value = r
    done = true
  }, () => {
    done = true
  })
  return { result: () => value, settled: () => done }
}

const lifecycle = (f: Fake, name: string, loaderId = 'L1'): void => f.emit('Page.lifecycleEvent', { name, loaderId })

const forbidden = vi.fn(() => {
  throw new Error('network touched in a unit spec')
})

beforeEach(() => {
  vi.useFakeTimers()
  // Purity tripwire: settle logic must only ever talk to the injected fake session.
  vi.stubGlobal('WebSocket', forbidden)
  vi.stubGlobal('fetch', forbidden)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  forbidden.mockClear()
})

describe('8468f7b1 AC2 [tests-unit-core.1] awaitPageSettled — arming', () => {
  it('rejects when neither navigate nor loaderId is given (about:blank trap guard)', async () => {
    const f = makeFake()
    await expect(awaitPageSettled(f.session)).rejects.toThrow('pass `navigate` (preferred) or `loaderId`')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('enables Page, Network and lifecycle events, then navigates LAST', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/' }))
    await arm()
    const methods = f.send.mock.calls.map((c) => c[0])
    expect(methods).toEqual([
      'Page.enable',
      'Network.enable',
      'Page.setLifecycleEventsEnabled',
      'PerformanceTimeline.enable',
      'Page.navigate',
    ])
    expect(f.send).toHaveBeenCalledWith('Page.navigate', { url: 'https://react.test/' })
    lifecycle(f, 'networkIdle')
    await arm()
    expect(t.settled()).toBe(true)
  })

  it('never uses Runtime.evaluate', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/' }))
    await arm()
    lifecycle(f, 'networkIdle')
    await arm()
    expect(f.send.mock.calls.map((c) => c[0])).not.toContain('Runtime.evaluate')
    expect(t.settled()).toBe(true)
  })

  it('survives a Chrome without PerformanceTimeline (older Chrome)', async () => {
    const f = makeFake({ perfTimelineFails: true })
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/' }))
    await arm()
    lifecycle(f, 'networkIdle')
    await arm()
    expect(t.result()?.signal).toBe('networkIdle')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] awaitPageSettled — rungs', () => {
  it('rung 1: resolves on networkIdle for OUR loaderId and reports the scoping', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/' }))
    await arm()
    f.emit('Network.requestWillBeSent')
    f.emit('Network.requestWillBeSent')
    f.emit('Network.loadingFinished')
    f.emit('PerformanceTimeline.timelineEventAdded')
    lifecycle(f, 'networkIdle')
    await arm()
    expect(t.result()).toMatchObject({
      signal: 'networkIdle',
      settled: true,
      loaderId: 'L1',
      requests: 2,
      inflight: 1,
      uiEvents: 1,
    })
  })

  it('ignores a networkIdle replayed for the initial about:blank loader', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/', deadlineMs: 4000 }))
    await arm()
    lifecycle(f, 'networkIdle', 'blank-loader')
    await arm()
    expect(t.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(t.result()).toMatchObject({ signal: 'deadline', settled: false })
  })

  it('ignores every lifecycle event until the navigate loaderId is known', async () => {
    const f = makeFake()
    // Fire an event synchronously after arming but before Page.navigate has resolved.
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/', deadlineMs: 2000 }))
    await vi.advanceTimersByTimeAsync(0)
    f.emit('Page.lifecycleEvent', { name: 'networkIdle', loaderId: undefined })
    expect(t.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(t.result()?.signal).toBe('deadline')
  })

  it('rung 2: inflight-zero after load and a quiet window', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/' }))
    await arm()
    f.emit('Network.requestWillBeSent')
    lifecycle(f, 'load')
    f.emit('Network.loadingFinished')
    await vi.advanceTimersByTimeAsync(499)
    expect(t.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.result()).toMatchObject({ signal: 'inflight-zero', settled: true, inflight: 0, requests: 1 })
  })

  it('rung 2 is gated on load: a mid-parse lull does not settle (negative)', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/', deadlineMs: 3000 }))
    await arm()
    f.emit('Network.requestWillBeSent')
    f.emit('Network.loadingFinished')
    await vi.advanceTimersByTimeAsync(1000)
    expect(t.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(t.result()?.signal).toBe('deadline')
  })

  it('rung 2 restarts when a new request begins during the quiet window', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/', inflightQuietMs: 300 }))
    await arm()
    f.emit('Network.requestWillBeSent')
    lifecycle(f, 'load')
    f.emit('Network.loadingFinished')
    await vi.advanceTimersByTimeAsync(200)
    f.emit('Network.requestWillBeSent')
    await vi.advanceTimersByTimeAsync(400)
    expect(t.settled()).toBe(false)
    f.emit('Network.loadingFailed')
    await vi.advanceTimersByTimeAsync(300)
    expect(t.result()).toMatchObject({ signal: 'inflight-zero', requests: 2 })
  })

  it('rung 3: a networkAlmostIdle seen before grace is latched and used when grace closes', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/', graceMs: 1500 }))
    await arm()
    lifecycle(f, 'networkAlmostIdle')
    await vi.advanceTimersByTimeAsync(1000)
    expect(t.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(t.result()).toMatchObject({ signal: 'networkAlmostIdle', settled: true })
  })

  it('rung 3: a networkAlmostIdle after grace resolves immediately', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/', graceMs: 100 }))
    await arm()
    await vi.advanceTimersByTimeAsync(200)
    expect(t.settled()).toBe(false)
    lifecycle(f, 'networkAlmostIdle')
    await arm()
    expect(t.result()?.signal).toBe('networkAlmostIdle')
  })

  it('`load` alone never resolves within the grace window', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/' }))
    await arm()
    lifecycle(f, 'load')
    await vi.advanceTimersByTimeAsync(2000)
    expect(t.settled()).toBe(false)
    expect(t.result()?.signal).not.toBe('load')
  })

  it('rung 4: ui-quiet rescues a loaded page only after uiRescueAfterMs', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/', uiQuietMs: 1000, uiRescueAfterMs: 3000 }))
    await arm()
    lifecycle(f, 'load')
    await vi.advanceTimersByTimeAsync(2500)
    expect(t.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1500)
    const r = t.result()
    expect(r).toMatchObject({ signal: 'ui-quiet', settled: true })
    expect(r?.tookMs).toBeGreaterThanOrEqual(3000)
  })

  it('rung 4: every reflow re-arms the ui-quiet window', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/', uiQuietMs: 1000, uiRescueAfterMs: 500 }))
    await arm()
    lifecycle(f, 'load')
    await vi.advanceTimersByTimeAsync(900)
    f.emit('PerformanceTimeline.timelineEventAdded')
    await vi.advanceTimersByTimeAsync(900)
    expect(t.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(t.result()).toMatchObject({ signal: 'ui-quiet', uiEvents: 1 })
  })

  it('rung 5: the deadline circuit breaker reports settled:false', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/', deadlineMs: 1200 }))
    await arm()
    await vi.advanceTimersByTimeAsync(1200)
    expect(t.result()).toMatchObject({ signal: 'deadline', settled: false })
  })

  it('accept restricts which rungs may resolve', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, {
      navigate: 'https://react.test/',
      accept: ['networkIdle'],
      graceMs: 100,
      deadlineMs: 2000,
    }))
    await arm()
    lifecycle(f, 'networkAlmostIdle')
    await vi.advanceTimersByTimeAsync(500)
    expect(t.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(t.result()?.signal).toBe('deadline')
  })

  it('accept can disable networkIdle itself', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/', accept: ['deadline'], deadlineMs: 800 }))
    await arm()
    lifecycle(f, 'networkIdle')
    await arm()
    expect(t.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(800)
    expect(t.result()?.signal).toBe('deadline')
  })

  it('scopes to an explicit loaderId without navigating', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { loaderId: 'CLICK-1' }))
    await arm()
    expect(f.send.mock.calls.map((c) => c[0])).not.toContain('Page.navigate')
    lifecycle(f, 'networkIdle', 'L-other')
    await arm()
    expect(t.settled()).toBe(false)
    lifecycle(f, 'networkIdle', 'CLICK-1')
    await arm()
    expect(t.result()).toMatchObject({ signal: 'networkIdle', loaderId: 'CLICK-1' })
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] awaitPageSettled — redirects', () => {
  it('follows a main-frame redirect to its new loaderId and re-gates rung 2', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://redirect.test/' }))
    await arm()
    lifecycle(f, 'load', 'L1')
    f.emit('Page.frameNavigated', { frame: { loaderId: 'L2' } })
    lifecycle(f, 'networkIdle', 'L1')
    await arm()
    expect(t.settled()).toBe(false)
    lifecycle(f, 'networkIdle', 'L2')
    await arm()
    expect(t.result()).toMatchObject({ signal: 'networkIdle', loaderId: 'L2' })
  })

  it('ignores iframe navigations and frames without a loaderId', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://redirect.test/' }))
    await arm()
    f.emit('Page.frameNavigated', { frame: { parentId: 'main', loaderId: 'IFRAME' } })
    f.emit('Page.frameNavigated', { frame: {} })
    f.emit('Page.frameNavigated', {})
    lifecycle(f, 'networkIdle', 'L1')
    await arm()
    expect(t.result()).toMatchObject({ signal: 'networkIdle', loaderId: 'L1' })
  })

  it('does not follow navigations before the loaderId is armed', async () => {
    const f = makeFake({ navigateResult: {} })
    const t = track(awaitPageSettled(f.session, { navigate: 'https://redirect.test/', deadlineMs: 500 }))
    await arm()
    f.emit('Page.frameNavigated', { frame: { loaderId: 'BLANK' } })
    lifecycle(f, 'networkIdle', 'BLANK')
    await arm()
    expect(t.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(t.result()?.signal).toBe('deadline')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] awaitPageSettled — failure and cleanup', () => {
  it('rejects when Page.navigate reports an errorText', async () => {
    const f = makeFake({ navigateResult: { errorText: 'net::ERR_NAME_NOT_RESOLVED' } })
    const p = awaitPageSettled(f.session, { navigate: 'https://nope.invalid/' })
    const assertion = expect(p).rejects.toThrow('Page.navigate failed: net::ERR_NAME_NOT_RESOLVED')
    await arm()
    await assertion
    expect(f.listenerCount()).toBe(0)
  })

  it('rejects when Page.navigate itself throws', async () => {
    const f = makeFake({ navigateError: new Error('session closed') })
    const p = awaitPageSettled(f.session, { navigate: 'https://react.test/' })
    const assertion = expect(p).rejects.toThrow('session closed')
    await arm()
    await assertion
    expect(f.listenerCount()).toBe(0)
  })

  it('rejects immediately for an already-aborted signal', async () => {
    const f = makeFake()
    const ctl = new AbortController()
    ctl.abort(new Error('caller gave up'))
    const p = awaitPageSettled(f.session, { navigate: 'https://react.test/', abort: ctl.signal })
    const assertion = expect(p).rejects.toThrow('caller gave up')
    await arm()
    await assertion
  })

  it('rejects with the abort reason when aborted mid-wait and unsubscribes', async () => {
    const f = makeFake()
    const ctl = new AbortController()
    const p = awaitPageSettled(f.session, { navigate: 'https://react.test/', abort: ctl.signal })
    const assertion = expect(p).rejects.toThrow('stop now')
    await arm()
    ctl.abort(new Error('stop now'))
    await assertion
    expect(f.listenerCount()).toBe(0)
  })

  it('unsubscribes every listener once settled', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/' }))
    await arm()
    expect(f.listenerCount()).toBeGreaterThan(0)
    lifecycle(f, 'networkIdle')
    await arm()
    expect(t.settled()).toBe(true)
    expect(f.listenerCount()).toBe(0)
  })

  it('never touches the global WebSocket or fetch (purity)', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/' }))
    await arm()
    lifecycle(f, 'networkIdle')
    await arm()
    expect(t.settled()).toBe(true)
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('keeps no timers pending after resolving', async () => {
    const f = makeFake()
    const t = track(awaitPageSettled(f.session, { navigate: 'https://react.test/' }))
    await arm()
    lifecycle(f, 'networkIdle')
    await arm()
    expect(t.settled()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
