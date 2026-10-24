/**
 * Unit spec for src/lib/domains/transport.ts (cdpCall, cdpPageCall, cdpPageSession).
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [port-fixes.4] [capture-upgrade.1] [resolve-findings.1].
 * Failures are typed errors, never null (F146-F152): page commands ride an attached flat session,
 * the debugger URL is checked against the asked host, and the version fetch has a deadline and a status check.
 * cdpCall rides the shared CdpSession, so the socket is the harness FakeCdpServer (opens on a later
 * tick like a real socket, throws on send-before-open); sockets that must stay closed or fail are a
 * small manual stub. fetch is stubbed; no network, no Chrome.
 * guards: discovers the browser ws url from /json/version on the given host
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [port-fixes.4] [capture-upgrade.1] [resolve-findings.1]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cdpCall, cdpPageCall, cdpPageSession } from '../../../src/lib/domains/transport.js'
import { StealthCoreBrowserError } from '../../../src/errors.js'
import { FakeCdpServer, type CdpFixture, type CdpFixtureStep } from '../../helpers/fake-cdp.js'

const WS_URL = 'ws://127.0.0.1:1/devtools/browser/x'

function server(steps: CdpFixtureStep[]): FakeCdpServer {
  const fixture: CdpFixture = { meta: { name: 'transport', origin: 'synthetic-protocol-conformant' }, steps }
  return new FakeCdpServer(fixture)
}

/** A socket under test control: never opens on its own; records sends and closes. */
class ManualSocket {
  static instances: ManualSocket[] = []
  /** When true an open socket never answers (silent browser). */
  static silent = false
  readyState = 0
  sent: Array<{ id: number; method: string; params: unknown }> = []
  closed = false
  private listeners = new Map<string, Array<(ev: { data?: string }) => void>>()
  constructor(public readonly url: string) { ManualSocket.instances.push(this) }
  addEventListener(type: string, fn: (ev: { data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  removeEventListener(type: string, fn: (ev: { data?: string }) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn))
  }
  send(raw: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError: WebSocket is not open')
    const req = JSON.parse(raw) as { id: number; method: string; params: unknown }
    this.sent.push(req)
    if (ManualSocket.silent) return
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: req.id, result: { ok: true } }) }))
  }
  close(): void { this.closed = true; this.readyState = 3 }
  open(): void { this.readyState = 1; this.emit('open', {}) }
  fail(): void { this.emit('error', {}) }
  private emit(type: string, ev: { data?: string }): void { (this.listeners.get(type) ?? []).forEach((l) => l(ev)) }
}

const fetchMock = vi.fn()
let restore: (() => void) | null = null

function useServer(steps: CdpFixtureStep[]): FakeCdpServer {
  const s = server(steps)
  restore = s.install()
  return s
}

describe('8468f7b1 AC2 [tests-unit-data.1] cdpCall', () => {
  beforeEach(() => {
    ManualSocket.instances = []
    ManualSocket.silent = false
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: WS_URL }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    restore?.()
    restore = null
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('discovers the browser ws url from /json/version on the given host', async () => {
    const s = useServer([{ when: { method: 'Browser.getVersion' } }])
    await cdpCall('127.0.0.1:1', 'Browser.getVersion')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:1/json/version')
    expect(s.openCount()).toBe(1)
    expect(s.received.map((r) => r.method)).toEqual(['Browser.getVersion'])
  })

  it('opens the socket on the discovered url', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    const p = cdpCall('127.0.0.1:1', 'X.y')
    await vi.waitFor(() => expect(ManualSocket.instances).toHaveLength(1))
    expect(ManualSocket.instances[0].url).toBe(WS_URL)
    ManualSocket.instances[0].open()
    await p
  })

  it('sends {id, method, params} and resolves with the result payload', async () => {
    const s = useServer([{ when: { method: 'Target.getTargetInfo' }, reply: { result: { ok: 1 } } }])
    const out = await cdpCall<{ ok: number }>('127.0.0.1:1', 'Target.getTargetInfo', { targetId: 'T1' })
    const sent = s.received[0]
    expect(sent.method).toBe('Target.getTargetInfo')
    expect(sent.params).toEqual({ targetId: 'T1' })
    expect(typeof sent.id).toBe('number')
    expect(out).toEqual({ ok: 1 })
  })

  it('defaults params to an empty object', async () => {
    const s = useServer([{ when: { method: 'SystemInfo.getInfo' } }])
    await cdpCall('127.0.0.1:1', 'SystemInfo.getInfo')
    expect(s.received[0].params).toEqual({})
  })

  it('never uses Runtime.evaluate semantics: method is passed through verbatim', async () => {
    const s = useServer([{ when: { method: 'Page.getFrameTree' } }])
    await cdpCall('127.0.0.1:1', 'Page.getFrameTree')
    expect(s.received[0].method).toBe('Page.getFrameTree')
    expect(s.received.map((r) => r.method)).not.toContain('Runtime.evaluate')
  })

  it('closes the socket after success', async () => {
    useServer([{ when: { method: 'X.y' } }])
    const sockets: Array<{ readyState: number }> = []
    const Wrapped = globalThis.WebSocket
    vi.stubGlobal('WebSocket', function Spy(url: string) {
      const ws = new Wrapped(url)
      sockets.push(ws)
      return ws
    })
    await cdpCall('127.0.0.1:1', 'X.y')
    await vi.waitFor(() => expect(sockets[0].readyState).toBe(3))
  })

  it('rejects CDP_REMOTE_ERROR and closes the socket when the CDP reply carries an error (error path)', async () => {
    const s = useServer([{ when: { method: 'X.y' }, reply: { error: { code: -32000, message: 'boom' } } }])
    const sockets: Array<{ readyState: number }> = []
    const Wrapped = globalThis.WebSocket
    vi.stubGlobal('WebSocket', function Spy(url: string) {
      const ws = new Wrapped(url)
      sockets.push(ws)
      return ws
    })
    await expect(cdpCall('127.0.0.1:1', 'X.y')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR', detail: { remoteCode: -32000 } })
    expect(s.received).toHaveLength(1)
    await vi.waitFor(() => expect(sockets[0].readyState).toBe(3))
  })

  it('rejects CDP_UNREACHABLE when /json/version is unreachable (error path)', async () => {
    const s = useServer([])
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(cdpCall('127.0.0.1:1', 'X.y')).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    expect(s.openCount()).toBe(0)
  })

  it('rejects CDP_TIMEOUT after the 10s timeout when no reply arrives (error path)', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    ManualSocket.silent = true
    vi.useFakeTimers()
    const p = cdpCall('127.0.0.1:1', 'X.y')
    await vi.advanceTimersByTimeAsync(0)
    ManualSocket.instances[0].open()
    const settled = expect(p).rejects.toMatchObject({ code: 'CDP_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(10_100) // 10s reply window
    await settled
    expect(ManualSocket.instances[0].sent).toHaveLength(1)
    expect(ManualSocket.instances[0].closed).toBe(true)
  })

  it('[port-fixes.4] waits for an asynchronously-opening socket, never sends before open, and resolves with the reply (not null)', async () => {
    const s = useServer([{ when: { method: 'Browser.getVersion' }, reply: { result: { product: 'Chrome' } } }])
    const out = await cdpCall<{ product: string }>('127.0.0.1:1', 'Browser.getVersion')
    // FakeWebSocket throws on send-before-open, which now surfaces as a CDP_SEND_FAILED rejection.
    expect(out).toEqual({ product: 'Chrome' })
    expect(s.received).toHaveLength(1)
  })

  it('[port-fixes.4] sends nothing while the socket is still connecting, then sends once it opens', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    const p = cdpCall<{ ok: boolean }>('127.0.0.1:1', 'Target.getTargets')
    await vi.waitFor(() => expect(ManualSocket.instances).toHaveLength(1))
    const ws = ManualSocket.instances[0]
    await new Promise((r) => setTimeout(r, 20))
    expect(ws.sent).toHaveLength(0)
    expect(ws.readyState).toBe(0)
    ws.open()
    await expect(p).resolves.toEqual({ ok: true })
    expect(ws.sent.map((m) => m.method)).toEqual(['Target.getTargets'])
  })

  it('[port-fixes.4] rejects CDP_CONNECT_FAILED and closes the socket when it errors before opening (error path)', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    const p = cdpCall('127.0.0.1:1', 'X.y')
    await vi.waitFor(() => expect(ManualSocket.instances).toHaveLength(1))
    ManualSocket.instances[0].fail()
    await expect(p).rejects.toMatchObject({ code: 'CDP_CONNECT_FAILED' })
    expect(ManualSocket.instances[0].closed).toBe(true)
    expect(ManualSocket.instances[0].sent).toHaveLength(0)
  })

  it('[port-fixes.4] rejects CDP_CONNECT_FAILED after the 10s timeout when the socket never opens (error path)', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    vi.useFakeTimers()
    const p = cdpCall('127.0.0.1:1', 'X.y')
    const settled = expect(p).rejects.toMatchObject({ code: 'CDP_CONNECT_FAILED' })
    await vi.advanceTimersByTimeAsync(10_000)
    await settled
    expect(ManualSocket.instances[0].closed).toBe(true)
    expect(ManualSocket.instances[0].sent).toHaveLength(0)
  })

  it('rejects CDP_CONNECT_FAILED when the socket closes before opening (error path)', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    const p = cdpCall('127.0.0.1:1', 'X.y')
    await vi.waitFor(() => expect(ManualSocket.instances).toHaveLength(1))
    ManualSocket.instances[0].close()
    ManualSocket.instances[0]['emit']('close', {})
    await expect(p).rejects.toMatchObject({ code: 'CDP_CONNECT_FAILED' })
    expect(ManualSocket.instances[0].sent).toHaveLength(0)
  })
})

describe('8468f7b1 AC2 [resolve-findings.1] transport endpoint hardening (F150, F152)', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    restore?.()
    restore = null
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('refuses a debugger URL that points at another host before opening any socket', async () => {
    const s = useServer([])
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: 'ws://evil.example:9222/devtools/browser/x' }) })
    await expect(cdpCall('127.0.0.1:1', 'Browser.getVersion')).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { reason: 'ws-host-mismatch' } })
    expect(s.openCount()).toBe(0)
  })

  it('rejects CDP_BAD_RESPONSE on a non-2xx /json/version answer instead of parsing the error body', async () => {
    const s = useServer([])
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ webSocketDebuggerUrl: WS_URL }) })
    await expect(cdpCall('127.0.0.1:1', 'Browser.getVersion')).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { status: 503 } })
    expect(s.openCount()).toBe(0)
  })

  it('passes an abort signal so the version fetch has a deadline, and reports CDP_TIMEOUT when it fires', async () => {
    useServer([])
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const settled = expect(cdpCall('127.0.0.1:1', 'Browser.getVersion')).rejects.toMatchObject({ code: 'CDP_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(5_100)
    await settled
  })
})

describe('8468f7b1 AC2 [resolve-findings.1] page commands ride an attached flat session (F146)', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: WS_URL }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    restore?.()
    restore = null
    vi.unstubAllGlobals()
  })

  it('attaches with flatten:true, then sends the page command with the returned sessionId and without a targetId', async () => {
    const s = useServer([
      { when: { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } }, reply: { result: { sessionId: 'S1' } } },
      { when: { method: 'Page.getFrameTree', sessionId: 'S1' }, reply: { result: { frameTree: { frame: { id: 'F' } } } } },
    ])
    const out = await cdpPageCall<{ frameTree: unknown }>('127.0.0.1:1', 'T1', 'Page.getFrameTree')
    expect(out).toEqual({ frameTree: { frame: { id: 'F' } } })
    expect(s.received.map((r) => r.method)).toEqual(['Target.attachToTarget', 'Page.getFrameTree'])
    expect(s.received[0]?.sessionId).toBeUndefined()
    expect(s.received[1]).toMatchObject({ method: 'Page.getFrameTree', sessionId: 'S1', params: {} })
    expect(s.received[1]?.params).not.toHaveProperty('targetId')
  })

  it('maps a target Chrome does not know to TARGET_NOT_FOUND', async () => {
    useServer([{ when: { method: 'Target.attachToTarget' }, reply: { error: { code: -32602, message: 'No target with given id found' } } }])
    const err = await cdpPageCall('127.0.0.1:1', 'GONE', 'Page.getFrameTree').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StealthCoreBrowserError)
    expect(err).toMatchObject({ code: 'TARGET_NOT_FOUND', detail: { targetId: 'GONE' } })
  })

  it('surfaces a protocol error from the page command as CDP_REMOTE_ERROR (not an empty value)', async () => {
    useServer([
      { when: { method: 'Target.attachToTarget' }, reply: { result: { sessionId: 'S1' } } },
      { when: { method: 'Page.captureScreenshot' }, reply: { error: { code: -32000, message: 'Unable to capture screenshot' } } },
    ])
    await expect(cdpPageCall('127.0.0.1:1', 'T1', 'Page.captureScreenshot')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
  })

  it('cdpPageSession runs several commands on the one session and closes the socket afterwards', async () => {
    const s = useServer([
      { when: { method: 'Target.attachToTarget' }, reply: { result: { sessionId: 'S9' } } },
      { when: { method: 'Performance.enable', sessionId: 'S9' } },
      { when: { method: 'Performance.getMetrics', sessionId: 'S9' }, reply: { result: { metrics: [{ name: 'Nodes', value: 4 }] } } },
    ])
    const sockets: Array<{ readyState: number }> = []
    const Wrapped = globalThis.WebSocket
    vi.stubGlobal('WebSocket', function Spy(url: string) {
      const ws = new Wrapped(url)
      sockets.push(ws)
      return ws
    })
    const out = await cdpPageSession('127.0.0.1:1', 'T1', async (send) => {
      await send('Performance.enable')
      return send<{ metrics: unknown[] }>('Performance.getMetrics')
    })
    expect(out.metrics).toEqual([{ name: 'Nodes', value: 4 }])
    expect(s.received.filter((r) => r.sessionId === 'S9')).toHaveLength(2)
    await vi.waitFor(() => expect(sockets[0]?.readyState).toBe(3))
  })
})
