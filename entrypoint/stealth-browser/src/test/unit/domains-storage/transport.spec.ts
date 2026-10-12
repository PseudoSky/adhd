/**
 * Unit spec for src/lib/domains/transport.ts (cdpCall).
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * fetch and WebSocket are stubbed with a recording fake; no network, no Chrome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cdpCall } from '../../../lib/domains/transport.js'

type Reply = (req: { id: number; method: string; params: unknown }) => Record<string, unknown> | null

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static reply: Reply = () => null
  sent: Array<{ id: number; method: string; params: unknown }> = []
  closed = false
  private listeners: Array<(ev: { data: string }) => void> = []
  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(raw: string): void {
    const req = JSON.parse(raw) as { id: number; method: string; params: unknown }
    this.sent.push(req)
    const body = FakeWebSocket.reply(req)
    if (body) queueMicrotask(() => this.listeners.forEach((l) => l({ data: JSON.stringify({ id: req.id, ...body }) })))
  }
  addEventListener(_t: string, fn: (ev: { data: string }) => void): void { this.listeners.push(fn) }
  removeEventListener(_t: string, fn: (ev: { data: string }) => void): void {
    this.listeners = this.listeners.filter((l) => l !== fn)
  }
  close(): void { this.closed = true }
}

const fetchMock = vi.fn()

describe('8468f7b1 AC2 [tests-unit-data.1] cdpCall', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.reply = () => null
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
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toBeNull()
    expect(FakeWebSocket.instances[0].closed).toBe(true)
  })
})
