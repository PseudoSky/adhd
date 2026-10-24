/**
 * Typed capture errors.
 * Ticket 8468f7b1 AC capture-upgrade.10 · [capture-upgrade.10]
 * Real use: a caller branches on `error.code`. Each of the eight codes must
 * appear on exactly its own failure path and nowhere else.
 * guards: has exactly the eight capture codes
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.10]
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureNetworkResponse } from '../../../src/lib/capture/network.js'
import { CAPTURE_ERROR_CODES, CaptureError } from '../../../src/lib/recording/errors.js'
import { NetworkRecorder } from '../../../src/lib/recording/network-recorder.js'
import { openStoreRecordingSink } from '../../../src/lib/recording/open-store-sink.js'
import { connectSession, fixtureWith, flushMicrotasks, makeSinkSpy, optionsFor, useFixture, WS_URL } from '../../helpers/capture/capture-kit.js'

async function rejection(p: Promise<unknown>): Promise<CaptureError> {
  try {
    await p
  } catch (e) {
    if (e instanceof CaptureError) return e
    throw e
  }
  throw new Error('expected the capture to reject')
}

describe('8468f7b1 [capture-upgrade.10] the code set', () => {
  it('has exactly the eight capture codes', () => {
    expect([...CAPTURE_ERROR_CODES].sort()).toEqual(
      [
        'CAPTURE_BAN_DETECTED',
        'CAPTURE_CONNECT_FAILED',
        'CAPTURE_NAVIGATE_FAILED',
        'CAPTURE_NO_MATCH',
        'CAPTURE_SESSION_CLOSED',
        'CAPTURE_SINK_FAILED',
        'CAPTURE_SINK_UNAVAILABLE',
        'CAPTURE_TIMEOUT',
      ].sort(),
    )
  })
})

describe('8468f7b1 [capture-upgrade.10] CAPTURE_CONNECT_FAILED', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('a socket error before open is CONNECT_FAILED with the original error as cause', async () => {
    class ErroringSocket {
      private readonly listeners = new Map<string, Array<() => void>>()
      constructor() {
        queueMicrotask(() => (this.listeners.get('error') ?? []).forEach((l) => l()))
      }
      addEventListener(type: string, fn: () => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
      }
      close(): void {
        /* nothing to release */
      }
    }
    vi.stubGlobal('WebSocket', ErroringSocket)
    const e = await rejection(captureNetworkResponse(WS_URL, optionsFor('doc-200')))
    expect(e.code).toBe('CAPTURE_CONNECT_FAILED')
    expect(e.cause).toBeInstanceOf(Error)
  })

  it('a synchronous invalid-url throw is CONNECT_FAILED and keeps the thrown error as cause', async () => {
    const boom = new SyntaxError('Invalid URL')
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          throw boom
        }
      },
    )
    const e = await rejection(captureNetworkResponse('not a url', optionsFor('doc-200')))
    expect(e.code).toBe('CAPTURE_CONNECT_FAILED')
    expect(e.cause).toBe(boom)
  })
})

describe('8468f7b1 [capture-upgrade.10] CAPTURE_NAVIGATE_FAILED', () => {
  useFixture(() =>
    fixtureWith('doc-200', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      if (nav) {
        nav.reply = { result: { errorText: 'net::ERR_NAME_NOT_RESOLVED' } }
        nav.emit = []
      }
    }),
  )

  it('Page.navigate errorText with no candidate and nothing in flight fails at once, not at the timeout', async () => {
    const started = Date.now()
    const e = await rejection(captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: 5_000 })))
    expect(e.code).toBe('CAPTURE_NAVIGATE_FAILED')
    expect(e.detail?.['errorText']).toBe('net::ERR_NAME_NOT_RESOLVED')
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('8468f7b1 [capture-upgrade.10] CAPTURE_NAVIGATE_FAILED from a rejected command', () => {
  useFixture(() =>
    fixtureWith('doc-200', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      if (nav) {
        nav.reply = { error: { code: -32000, message: 'Cannot navigate to invalid URL' } }
        nav.emit = []
      }
    }),
  )

  it('keeps the CDP rejection as cause', async () => {
    const e = await rejection(captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: 5_000 })))
    expect(e.code).toBe('CAPTURE_NAVIGATE_FAILED')
    expect((e.cause as Error).message).toContain('invalid URL')
  })
})

describe('8468f7b1 [capture-upgrade.10] CAPTURE_TIMEOUT and CAPTURE_NO_MATCH', () => {
  const rig = useFixture(() =>
    fixtureWith('doc-200', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      if (nav) nav.emit = []
    }),
  )
  void rig

  it('nothing at all within timeoutMs is TIMEOUT', async () => {
    vi.useFakeTimers()
    const p = rejection(captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: 500 })))
    await vi.advanceTimersByTimeAsync(500)
    const e = await p
    expect(e.code).toBe('CAPTURE_TIMEOUT')
    expect(e.detail?.['timeoutMs']).toBe(500)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('8468f7b1 [capture-upgrade.10] CAPTURE_NO_MATCH lists what was seen', () => {
  useFixture('doc-200')

  it('traffic seen but none matching urlPattern is NO_MATCH with the seen urls', async () => {
    vi.useFakeTimers()
    const p = rejection(captureNetworkResponse(WS_URL, optionsFor('doc-200', { urlPattern: /nomatch/, timeoutMs: 500 })))
    await vi.advanceTimersByTimeAsync(500)
    const e = await p
    expect(e.code).toBe('CAPTURE_NO_MATCH')
    expect(e.detail?.['urls']).toEqual(['https://site.test/home'])
  })
})

describe('8468f7b1 [capture-upgrade.10] CAPTURE_NO_MATCH caps detail.urls at 10', () => {
  useFixture(() =>
    fixtureWith('doc-200', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      if (nav) {
        nav.emit = Array.from({ length: 14 }, (_, i) => ({
          method: 'Network.requestWillBeSent',
          params: { requestId: `N${i}`, request: { url: `https://site.test/n${i}`, method: 'GET', headers: {} }, timestamp: 100 },
        }))
      }
    }),
  )

  it('keeps at most ten', async () => {
    vi.useFakeTimers()
    const p = rejection(captureNetworkResponse(WS_URL, optionsFor('doc-200', { urlPattern: /nomatch/, timeoutMs: 300 })))
    await vi.advanceTimersByTimeAsync(300)
    const e = await p
    expect(e.code).toBe('CAPTURE_NO_MATCH')
    expect((e.detail?.['urls'] as string[]).length).toBe(10)
  })
})

describe('8468f7b1 [capture-upgrade.10] CAPTURE_SESSION_CLOSED', () => {
  const rig = useFixture(() =>
    fixtureWith('doc-200', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      if (nav) nav.emit = []
    }),
  )

  it('Chrome dying (closeFromServer) with zero candidates is SESSION_CLOSED, well before the timeout', async () => {
    vi.useFakeTimers()
    const p = rejection(captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: 10_000 })))
    await vi.advanceTimersByTimeAsync(10)
    rig.server.closeFromServer()
    await vi.advanceTimersByTimeAsync(100)
    const e = await p
    expect(e.code).toBe('CAPTURE_SESSION_CLOSED')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('8468f7b1 [capture-upgrade.10] CAPTURE_BAN_DETECTED', () => {
  useFixture('doc-200')

  it('a matching ban rule is BAN_DETECTED carrying the signal', async () => {
    const e = await rejection(
      captureNetworkResponse(WS_URL, optionsFor('doc-200', { banRules: [{ name: 'hello', signal: 'captcha', checkBody: /hello/ }] })),
    )
    expect(e.code).toBe('CAPTURE_BAN_DETECTED')
    expect(e.detail?.['signal']).toBe('captcha')
  })
})

describe('8468f7b1 [capture-upgrade.10] CAPTURE_SINK_FAILED and CAPTURE_SINK_UNAVAILABLE', () => {
  useFixture('doc-200')

  it('a sink that rejects makes the recorder close() reject SINK_FAILED', async () => {
    const session = await connectSession()
    const sink = makeSinkSpy(() => {
      throw new Error('disk full')
    })
    const recorder = new NetworkRecorder(session, { sink, logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/home' })
    await recorder.settled()
    await flushMicrotasks()
    const e = await rejection(recorder.close())
    expect(e.code).toBe('CAPTURE_SINK_FAILED')
    expect(e.detail?.['failed']).toBe(1)
  })

  it('a store package that cannot be loaded is SINK_UNAVAILABLE with the load error as cause', async () => {
    const missing = Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' })
    const e = await rejection(openStoreRecordingSink({ dbPath: '/db/x.sqlite', loadAdapter: () => Promise.reject(missing) }))
    expect(e.code).toBe('CAPTURE_SINK_UNAVAILABLE')
    expect(e.cause).toBe(missing)
  })

  it('a plain Error is never raised for a capture failure path above (all are CaptureError)', () => {
    expect(new CaptureError('CAPTURE_TIMEOUT', 'x')).toBeInstanceOf(Error)
    expect(new CaptureError('CAPTURE_TIMEOUT', 'x').name).toBe('CaptureError')
  })
})
