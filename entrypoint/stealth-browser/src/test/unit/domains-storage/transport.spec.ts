/**
 * Unit spec for src/lib/domains/transport.ts (cdpCall).
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [port-fixes.4].
 * fetch and WebSocket are stubbed with a recording fake that opens ASYNCHRONOUSLY (like a real
 * socket) and throws on send-before-open; no network, no Chrome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cdpCall } from '../../../lib/domains/transport.js'

type Reply = (req: { id: number; method: string; params: unknown }) => Record<string, unknown> | null

type Listener = (ev: { data: string }) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static reply: Reply = () => null
  /** When false the socket never opens (connection hangs). */
  static autoOpen = true
  static CONNECTING = 0
  static OPEN = 1
  readyState = 0
  sent: Array<{ id: number; method: string; params: unknown }> = []
  sentBeforeOpen = false
  closed = false
  private listeners = new Map<string, Listener[]>()
  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
    if (FakeWebSocket.autoOpen) setTimeout(() => this.open(), 5)
  }
  open(): void {
    this.readyState = 1
    this.emit('open', { data: '' })
  }
  fail(): void { this.emit('error', { data: '' }) }
  send(raw: string): void {
    if (this.readyState !== 1) {
      this.sentBeforeOpen = true
      throw new Error('InvalidStateError: WebSocket is not open')
    }
    const req = JSON.parse(raw) as { id: number; method: string; params: unknown }
    this.sent.push(req)
    const body = FakeWebSocket.reply(req)
    if (body) queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: req.id, ...body }) }))
  }
  addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn))
  }
  close(): void { this.closed = true; this.readyState = 3 }
  private emit(type: string, ev: { data: string }): void { (this.listeners.get(type) ?? []).forEach((l) => l(ev)) }
}

const fetchMock = vi.fn()

describe('8468f7b1 AC2 [tests-unit-data.1] cdpCall', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.reply = () => null
    FakeWebSocket.autoOpen = true
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/x' }) })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('discovers the browser ws url from /json/version on the given host', async () => {
    FakeWebSocket.reply = () => ({ result: {} })
    await cdpCall('h:1', 'Browser.getVersion')
    expect(fetchMock).toHaveBeenCalledWith('http://h:1/json/version')
    expect(FakeWebSocket.instances[0].url).toBe('ws://127.0.0.1:1/devtools/browser/x')
  })

  it('sends {id, method, params} and resolves with the result payload', async () => {
    FakeWebSocket.reply = () => ({ result: { ok: 1 } })
    const out = await cdpCall<{ ok: number }>('h:1', 'Target.getTargetInfo', { targetId: 'T1' })
    const sent = FakeWebSocket.instances[0].sent[0]
    expect(sent.method).toBe('Target.getTargetInfo')
    expect(sent.params).toEqual({ targetId: 'T1' })
    expect(typeof sent.id).toBe('number')
    expect(out).toEqual({ ok: 1 })
  })

  it('defaults params to an empty object', async () => {
    FakeWebSocket.reply = () => ({ result: {} })
    await cdpCall('h:1', 'SystemInfo.getInfo')
    expect(FakeWebSocket.instances[0].sent[0].params).toEqual({})
  })

  it('never uses Runtime.evaluate semantics: method is passed through verbatim', async () => {
    FakeWebSocket.reply = () => ({ result: {} })
    await cdpCall('h:1', 'Page.getFrameTree')
    expect(FakeWebSocket.instances[0].sent[0].method).not.toBe('Runtime.evaluate')
  })

  it('closes the socket after success', async () => {
    FakeWebSocket.reply = () => ({ result: {} })
    await cdpCall('h:1', 'X.y')
    expect(FakeWebSocket.instances[0].closed).toBe(true)
  })

  it('returns null and closes the socket when the CDP reply carries an error (error path)', async () => {
    FakeWebSocket.reply = () => ({ error: { message: 'boom' } })
    const out = await cdpCall('h:1', 'X.y')
    expect(out).toBeNull()
    expect(FakeWebSocket.instances[0].closed).toBe(true)
  })

  it('returns null when /json/version is unreachable (error path)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const out = await cdpCall('h:1', 'X.y')
    expect(out).toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('returns null after the 10s timeout when no reply arrives (error path)', async () => {
    vi.useFakeTimers()
    const p = cdpCall('h:1', 'X.y')
    await vi.advanceTimersByTimeAsync(10_100) // 5ms socket open + 10s reply window
    await expect(p).resolves.toBeNull()
    expect(FakeWebSocket.instances[0].closed).toBe(true)
  })

  it('[port-fixes.4] waits for an asynchronously-opening socket, never sends before open, and resolves with the reply (not null)', async () => {
    FakeWebSocket.reply = () => ({ result: { product: 'Chrome' } })
    const out = await cdpCall<{ product: string }>('h:1', 'Browser.getVersion')
    const ws = FakeWebSocket.instances[0]
    expect(ws.sentBeforeOpen).toBe(false)
    expect(ws.sent).toHaveLength(1)
    expect(out).not.toBeNull()
    expect(out).toEqual({ product: 'Chrome' })
  })

  it('[port-fixes.4] sends nothing while the socket is still connecting, then sends once it opens', async () => {
    FakeWebSocket.autoOpen = false
    FakeWebSocket.reply = () => ({ result: { ok: true } })
    const p = cdpCall<{ ok: boolean }>('h:1', 'Target.getTargets')
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    await new Promise((r) => setTimeout(r, 20))
    expect(ws.sent).toHaveLength(0)
    expect(ws.readyState).toBe(0)
    ws.open()
    await expect(p).resolves.toEqual({ ok: true })
    expect(ws.sent.map((m) => m.method)).toEqual(['Target.getTargets'])
    expect(ws.sentBeforeOpen).toBe(false)
  })

  it('[port-fixes.4] returns null and closes the socket when it errors before opening (error path)', async () => {
    FakeWebSocket.autoOpen = false
    const p = cdpCall('h:1', 'X.y')
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    FakeWebSocket.instances[0].fail()
    await expect(p).resolves.toBeNull()
    expect(FakeWebSocket.instances[0].closed).toBe(true)
    expect(FakeWebSocket.instances[0].sent).toHaveLength(0)
  })

  it('[port-fixes.4] returns null after the 10s timeout when the socket never opens (error path)', async () => {
    FakeWebSocket.autoOpen = false
    vi.useFakeTimers()
    const p = cdpCall('h:1', 'X.y')
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toBeNull()
    expect(FakeWebSocket.instances[0].closed).toBe(true)
  })
})
