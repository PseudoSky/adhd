/**
 * Unit spec for src/lib/domains/transport.ts (cdpCall).
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [port-fixes.4] [capture-upgrade.1].
 * cdpCall rides the shared CdpSession, so the socket is the harness FakeCdpServer (opens on a later
 * tick like a real socket, throws on send-before-open); sockets that must stay closed or fail are a
 * small manual stub. fetch is stubbed; no network, no Chrome.
 * guards: discovers the browser ws url from /json/version on the given host
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [port-fixes.4] [capture-upgrade.1]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cdpCall } from '../../../src/lib/domains/transport.js'
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
    fetchMock.mockResolvedValue({ json: async () => ({ webSocketDebuggerUrl: WS_URL }) })
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
    await cdpCall('h:1', 'Browser.getVersion')
    expect(fetchMock).toHaveBeenCalledWith('http://h:1/json/version')
    expect(s.openCount()).toBe(1)
    expect(s.received.map((r) => r.method)).toEqual(['Browser.getVersion'])
  })

  it('opens the socket on the discovered url', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    const p = cdpCall('h:1', 'X.y')
    await vi.waitFor(() => expect(ManualSocket.instances).toHaveLength(1))
    expect(ManualSocket.instances[0].url).toBe(WS_URL)
    ManualSocket.instances[0].open()
    await p
  })

  it('sends {id, method, params} and resolves with the result payload', async () => {
    const s = useServer([{ when: { method: 'Target.getTargetInfo' }, reply: { result: { ok: 1 } } }])
    const out = await cdpCall<{ ok: number }>('h:1', 'Target.getTargetInfo', { targetId: 'T1' })
    const sent = s.received[0]
    expect(sent.method).toBe('Target.getTargetInfo')
    expect(sent.params).toEqual({ targetId: 'T1' })
    expect(typeof sent.id).toBe('number')
    expect(out).toEqual({ ok: 1 })
  })

  it('defaults params to an empty object', async () => {
    const s = useServer([{ when: { method: 'SystemInfo.getInfo' } }])
    await cdpCall('h:1', 'SystemInfo.getInfo')
    expect(s.received[0].params).toEqual({})
  })

  it('never uses Runtime.evaluate semantics: method is passed through verbatim', async () => {
    const s = useServer([{ when: { method: 'Page.getFrameTree' } }])
    await cdpCall('h:1', 'Page.getFrameTree')
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
    await cdpCall('h:1', 'X.y')
    await vi.waitFor(() => expect(sockets[0].readyState).toBe(3))
  })

  it('returns null and closes the socket when the CDP reply carries an error (error path)', async () => {
    const s = useServer([{ when: { method: 'X.y' }, reply: { error: { code: -32000, message: 'boom' } } }])
    const sockets: Array<{ readyState: number }> = []
    const Wrapped = globalThis.WebSocket
    vi.stubGlobal('WebSocket', function Spy(url: string) {
      const ws = new Wrapped(url)
      sockets.push(ws)
      return ws
    })
    const out = await cdpCall('h:1', 'X.y')
    expect(out).toBeNull()
    expect(s.received).toHaveLength(1)
    await vi.waitFor(() => expect(sockets[0].readyState).toBe(3))
  })

  it('returns null when /json/version is unreachable (error path)', async () => {
    const s = useServer([])
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const out = await cdpCall('h:1', 'X.y')
    expect(out).toBeNull()
    expect(s.openCount()).toBe(0)
  })

  it('returns null after the 10s timeout when no reply arrives (error path)', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    ManualSocket.silent = true
    vi.useFakeTimers()
    const p = cdpCall('h:1', 'X.y')
    await vi.advanceTimersByTimeAsync(0)
    ManualSocket.instances[0].open()
    await vi.advanceTimersByTimeAsync(10_100) // 10s reply window
    await expect(p).resolves.toBeNull()
    expect(ManualSocket.instances[0].sent).toHaveLength(1)
    expect(ManualSocket.instances[0].closed).toBe(true)
  })

  it('[port-fixes.4] waits for an asynchronously-opening socket, never sends before open, and resolves with the reply (not null)', async () => {
    const s = useServer([{ when: { method: 'Browser.getVersion' }, reply: { result: { product: 'Chrome' } } }])
    const out = await cdpCall<{ product: string }>('h:1', 'Browser.getVersion')
    // FakeWebSocket throws on send-before-open, which would have surfaced as null.
    expect(out).not.toBeNull()
    expect(out).toEqual({ product: 'Chrome' })
    expect(s.received).toHaveLength(1)
  })

  it('[port-fixes.4] sends nothing while the socket is still connecting, then sends once it opens', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    const p = cdpCall<{ ok: boolean }>('h:1', 'Target.getTargets')
    await vi.waitFor(() => expect(ManualSocket.instances).toHaveLength(1))
    const ws = ManualSocket.instances[0]
    await new Promise((r) => setTimeout(r, 20))
    expect(ws.sent).toHaveLength(0)
    expect(ws.readyState).toBe(0)
    ws.open()
    await expect(p).resolves.toEqual({ ok: true })
    expect(ws.sent.map((m) => m.method)).toEqual(['Target.getTargets'])
  })

  it('[port-fixes.4] returns null and closes the socket when it errors before opening (error path)', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    const p = cdpCall('h:1', 'X.y')
    await vi.waitFor(() => expect(ManualSocket.instances).toHaveLength(1))
    ManualSocket.instances[0].fail()
    await expect(p).resolves.toBeNull()
    expect(ManualSocket.instances[0].closed).toBe(true)
    expect(ManualSocket.instances[0].sent).toHaveLength(0)
  })

  it('[port-fixes.4] returns null after the 10s timeout when the socket never opens (error path)', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    vi.useFakeTimers()
    const p = cdpCall('h:1', 'X.y')
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toBeNull()
    expect(ManualSocket.instances[0].closed).toBe(true)
    expect(ManualSocket.instances[0].sent).toHaveLength(0)
  })

  it('returns null when the socket closes before opening (error path)', async () => {
    vi.stubGlobal('WebSocket', ManualSocket)
    const p = cdpCall('h:1', 'X.y')
    await vi.waitFor(() => expect(ManualSocket.instances).toHaveLength(1))
    ManualSocket.instances[0].close()
    ManualSocket.instances[0]['emit']('close', {})
    await expect(p).resolves.toBeNull()
    expect(ManualSocket.instances[0].sent).toHaveLength(0)
  })
})
