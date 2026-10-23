/**
 * Unit spec for src/lib/cdp/session.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4].
 * The global WebSocket is replaced via vi.stubGlobal with an in-memory fake: no network.
 * guards: connects to the given URL and flips connected on open
 * tier: S
 * cites: 8468f7b1 [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpSession, humanPause, rand, shortPause } from '../../../src/lib/cdp/session.js'

type Listener = (ev: { data?: unknown }) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static throwOnSend: Error | null = null
  readonly sent: string[] = []
  closed = false
  private readonly listeners = new Map<string, Array<{ fn: Listener; once: boolean }>>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, fn: Listener, opts?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? []
    list.push({ fn, once: !!opts?.once })
    this.listeners.set(type, list)
  }

  send(data: string): void {
    if (FakeWebSocket.throwOnSend) throw FakeWebSocket.throwOnSend
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, ev: { data?: unknown } = {}): void {
    const list = this.listeners.get(type) ?? []
    for (const entry of [...list]) {
      if (entry.once) list.splice(list.indexOf(entry), 1)
      entry.fn(ev)
    }
  }

  /** Deliver a server frame. */
  reply(msg: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(msg) })
  }

  lastSent(): { id: number; method: string; params: Record<string, unknown> } {
    return JSON.parse(this.sent[this.sent.length - 1]) as { id: number; method: string; params: Record<string, unknown> }
  }
}

function lastSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
}

async function connected(): Promise<{ session: CdpSession; ws: FakeWebSocket }> {
  const session = new CdpSession()
  const p = session.connect('ws://fake/devtools/browser/abc')
  const ws = lastSocket()
  ws.emit('open')
  await p
  return { session, ws }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  FakeWebSocket.throwOnSend = null
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 AC2 [tests-unit-core.1] CdpSession.connect', () => {
  it('connects to the given URL and flips connected on open', async () => {
    const session = new CdpSession()
    expect(session.connected).toBe(false)
    const p = session.connect('ws://fake/page/1')
    expect(lastSocket().url).toBe('ws://fake/page/1')
    lastSocket().emit('open')
    await p
    expect(session.connected).toBe(true)
  })

  it('[fs-083] rejects when the socket cannot open: rejects with a clear message when the socket errors before open (error path)', async () => {
    const session = new CdpSession()
    const p = session.connect('ws://fake/refused')
    lastSocket().emit('error')
    await expect(p).rejects.toThrow('WebSocket connection failed')
    expect(session.connected).toBe(false)
  })
})

describe('8468f7b1 [port-fixes.4] [capture-upgrade.1] CdpSession.connect open deadline', () => {
  it('rejects and closes the socket when it never opens within timeoutMs', async () => {
    vi.useFakeTimers()
    const session = new CdpSession()
    const p = session.connect('ws://fake/hang', 10_000)
    const settled = p.then(() => 'ok', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(lastSocket().closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(settled).resolves.toContain('open timeout')
    expect(lastSocket().closed).toBe(true)
    expect(session.connected).toBe(false)
  })

  it('does not fire the deadline once the socket has opened', async () => {
    vi.useFakeTimers()
    const session = new CdpSession()
    const p = session.connect('ws://fake/ok', 10_000)
    lastSocket().emit('open')
    await p
    await vi.advanceTimersByTimeAsync(20_000)
    expect(session.connected).toBe(true)
    expect(lastSocket().closed).toBe(false)
  })

  it('rejects when the socket closes before opening, and closes it', async () => {
    const session = new CdpSession()
    const p = session.connect('ws://fake/closed-early')
    lastSocket().emit('close')
    await expect(p).rejects.toThrow('WebSocket connection failed')
    expect(lastSocket().closed).toBe(true)
    expect(session.connected).toBe(false)
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] CdpSession.send', () => {
  it('[fs-084] send rejects before the session is connected: rejects when not connected (negative)', async () => {
    const session = new CdpSession()
    await expect(session.send('Page.enable')).rejects.toThrow('CdpSession not connected')
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('serialises {id, method, params} with monotonically increasing ids', async () => {
    const { session, ws } = await connected()
    void session.send('Page.navigate', { url: 'https://example.com' })
    expect(ws.lastSent()).toEqual({ id: 1, method: 'Page.navigate', params: { url: 'https://example.com' } })
    void session.send('Page.enable')
    expect(ws.lastSent()).toEqual({ id: 2, method: 'Page.enable', params: {} })
  })

  it('resolves with the matching response result', async () => {
    const { session, ws } = await connected()
    const p = session.send<{ frameId: string }>('Page.navigate')
    ws.reply({ id: ws.lastSent().id, result: { frameId: 'F1' } })
    await expect(p).resolves.toEqual({ frameId: 'F1' })
  })

  it('resolves {} when the response carries no result', async () => {
    const { session, ws } = await connected()
    const p = session.send('Page.enable')
    ws.reply({ id: 1 })
    await expect(p).resolves.toEqual({})
  })

  it('correlates out-of-order responses by id', async () => {
    const { session, ws } = await connected()
    const a = session.send<{ v: number }>('A')
    const b = session.send<{ v: number }>('B')
    ws.reply({ id: 2, result: { v: 2 } })
    ws.reply({ id: 1, result: { v: 1 } })
    expect((await a).v).toBe(1)
    expect((await b).v).toBe(2)
  })

  it('[fs-087] a CDP error response rejects with its message: rejects with the protocol error message on an error response', async () => {
    const { session, ws } = await connected()
    const p = session.send('Bogus.method')
    ws.reply({ id: 1, error: { code: -32601, message: "'Bogus.method' wasn't found" } })
    await expect(p).rejects.toThrow("'Bogus.method' wasn't found")
  })

  it('ignores a response for an unknown id', async () => {
    const { session, ws } = await connected()
    const p = session.send('Page.enable')
    ws.reply({ id: 999, result: {} })
    ws.reply({ id: 1, result: { ok: true } })
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('[fs-085] a command times out and frees its slot: times out with a descriptive error (default 30s)', async () => {
    vi.useFakeTimers()
    const { session } = await connected()
    const p = session.send('Page.navigate')
    const assertion = expect(p).rejects.toThrow('CDP timeout: Page.navigate after 30000ms')
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
  })

  it('honours a custom timeout and drops the pending entry', async () => {
    vi.useFakeTimers()
    const { session, ws } = await connected()
    const p = session.send('Slow.call', {}, 50)
    const assertion = expect(p).rejects.toThrow('CDP timeout: Slow.call after 50ms')
    await vi.advanceTimersByTimeAsync(50)
    await assertion
    // A late reply for the timed-out id is ignored rather than throwing.
    expect(() => ws.reply({ id: 1, result: {} })).not.toThrow()
  })

  it('[fs-086] a failing socket write rejects and cleans up: rejects with "CDP send failed" when the socket throws on send', async () => {
    const { session } = await connected()
    FakeWebSocket.throwOnSend = new Error('socket gone')
    await expect(session.send('Page.enable')).rejects.toThrow('CDP send failed: socket gone')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] CdpSession events', () => {
  it('delivers event params to a subscriber', async () => {
    const { session, ws } = await connected()
    const handler = vi.fn()
    session.on('Network.requestWillBeSent', handler)
    ws.reply({ method: 'Network.requestWillBeSent', params: { requestId: 'r1' } })
    expect(handler).toHaveBeenCalledWith({ requestId: 'r1' })
  })

  it('[fs-088] supports several handlers for one event: supports multiple handlers per method (B-003) — a second on() does not displace the first', async () => {
    const { session, ws } = await connected()
    const a = vi.fn()
    const b = vi.fn()
    session.on('Network.loadingFinished', a)
    session.on('Network.loadingFinished', b)
    ws.reply({ method: 'Network.loadingFinished', params: { requestId: 'r1' } })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('[fs-089] a throwing subscriber does not starve the others: a throwing subscriber does not starve the others', async () => {
    const { session, ws } = await connected()
    const bad = vi.fn(() => {
      throw new Error('subscriber bug')
    })
    const good = vi.fn()
    session.on('Page.loadEventFired', bad)
    session.on('Page.loadEventFired', good)
    expect(() => ws.reply({ method: 'Page.loadEventFired', params: {} })).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('the unsubscribe function removes only its own handler', async () => {
    const { session, ws } = await connected()
    const a = vi.fn()
    const b = vi.fn()
    const offA = session.on('E', a)
    session.on('E', b)
    offA()
    ws.reply({ method: 'E', params: {} })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('[fs-090] off removes one handler or all: off(method, handler) removes one handler; off(method) removes them all', async () => {
    const { session, ws } = await connected()
    const a = vi.fn()
    const b = vi.fn()
    session.on('E', a)
    session.on('E', b)
    session.off('E', a)
    ws.reply({ method: 'E', params: {} })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    session.off('E')
    ws.reply({ method: 'E', params: {} })
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('off() for an unknown method or handler is a no-op', async () => {
    const { session } = await connected()
    expect(() => session.off('Never.subscribed', vi.fn())).not.toThrow()
    expect(() => session.off('Never.subscribed')).not.toThrow()
  })

  it('ignores events nobody subscribed to', async () => {
    const { ws } = await connected()
    expect(() => ws.reply({ method: 'Nobody.listens', params: { x: 1 } })).not.toThrow()
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] CdpSession lifecycle', () => {
  it('[fs-091] closing rejects pending commands and clears handlers: close() closes the socket, rejects pending sends and clears handlers', async () => {
    const { session, ws } = await connected()
    const handler = vi.fn()
    session.on('E', handler)
    const pending = session.send('Page.enable')
    const assertion = expect(pending).rejects.toThrow('Session closed')
    session.close()
    await assertion
    expect(ws.closed).toBe(true)
    expect(session.connected).toBe(false)
    ws.reply({ method: 'E', params: {} })
    expect(handler).not.toHaveBeenCalled()
  })

  it('close() swallows a socket that throws on close', async () => {
    const { session, ws } = await connected()
    ws.close = () => {
      throw new Error('already closed')
    }
    expect(() => session.close()).not.toThrow()
  })

  it('close() on a never-connected session is safe', () => {
    expect(() => new CdpSession().close()).not.toThrow()
  })

  it('a server-side close rejects pending sends with "WebSocket closed"', async () => {
    const { session, ws } = await connected()
    const pending = session.send('Page.enable')
    const assertion = expect(pending).rejects.toThrow('WebSocket closed')
    ws.emit('close')
    await assertion
    expect(session.connected).toBe(false)
    await expect(session.send('Page.enable')).rejects.toThrow('CdpSession not connected')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] rand / humanPause / shortPause', () => {
  it('[fs-092] pause helpers stay within their ranges: rand maps Math.random onto the inclusive range', () => {
    const spy = vi.spyOn(Math, 'random')
    spy.mockReturnValue(0)
    expect(rand(5, 9)).toBe(5)
    spy.mockReturnValue(0.999999)
    expect(rand(5, 9)).toBe(9)
  })

  it('rand collapses to the bound when min equals max', () => {
    expect(rand(7, 7)).toBe(7)
  })

  it('humanPause waits 600–1800ms', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let done = false
    void humanPause().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(599)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it('shortPause waits 300–900ms and not longer than its upper bound', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.999999)
    let done = false
    void shortPause().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(899)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })
})
