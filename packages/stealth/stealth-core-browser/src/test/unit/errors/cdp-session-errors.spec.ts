/**
 * The CdpSession failure modes reach the caller as typed StealthCoreBrowserError codes, through the real session
 * against an in-memory WebSocket.
 * Ticket 8468f7b1 · [prod-errors.2] · PA5.1 / PA5.4 · CDP_CONNECT_FAILED, CDP_NOT_CONNECTED, CDP_TIMEOUT,
 * CDP_REMOTE_ERROR, CDP_SESSION_CLOSED, CDP_SEND_FAILED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpSession } from '../../../lib/cdp/session.js'
import { StealthCoreBrowserError } from '../../../errors.js'

type Listener = (ev: { data?: unknown }) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static throwOnSend: Error | null = null
  private readonly listeners = new Map<string, Array<{ fn: Listener; once: boolean }>>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, fn: Listener, opts?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? []
    list.push({ fn, once: !!opts?.once })
    this.listeners.set(type, list)
  }

  send(): void {
    if (FakeWebSocket.throwOnSend) throw FakeWebSocket.throwOnSend
  }

  close(): void {
    /* in memory */
  }

  emit(type: string, ev: { data?: unknown } = {}): void {
    const list = this.listeners.get(type) ?? []
    for (const entry of [...list]) {
      if (entry.once) list.splice(list.indexOf(entry), 1)
      entry.fn(ev)
    }
  }

  reply(msg: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(msg) })
  }
}

const lastSocket = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!

async function connected(): Promise<{ session: CdpSession; ws: FakeWebSocket }> {
  const session = new CdpSession()
  const p = session.connect('ws://fake/page/1')
  lastSocket().emit('open')
  await p
  return { session, ws: lastSocket() }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  FakeWebSocket.throwOnSend = null
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('8468f7b1 [prod-errors.2] CdpSession rejects with a typed code (PA5.4)', () => {
  it('connect rejects with CDP_CONNECT_FAILED when the socket errors before opening, message and remediation intact', async () => {
    const session = new CdpSession()
    const p = session.connect('ws://fake/refused')
    lastSocket().emit('error')
    await expect(p).rejects.toMatchObject({ code: 'CDP_CONNECT_FAILED', message: expect.stringContaining('WebSocket connection failed') })
    await expect(p).rejects.toBeInstanceOf(StealthCoreBrowserError)
  })

  it('connect rejects with CDP_CONNECT_FAILED when the open times out, carrying the url and timeout in detail', async () => {
    vi.useFakeTimers()
    const session = new CdpSession()
    const p = session.connect('ws://fake/slow', 40)
    const assertion = expect(p).rejects.toMatchObject({ code: 'CDP_CONNECT_FAILED', detail: { wsUrl: 'ws://fake/slow', timeoutMs: 40 } })
    await vi.advanceTimersByTimeAsync(40)
    await assertion
  })

  it('send rejects with CDP_NOT_CONNECTED before the session connects', async () => {
    await expect(new CdpSession().send('Page.enable')).rejects.toMatchObject({ code: 'CDP_NOT_CONNECTED', message: expect.stringContaining('CdpSession not connected') })
  })

  it('send rejects with CDP_TIMEOUT when Chrome never answers, naming the method', async () => {
    vi.useFakeTimers()
    const { session } = await connected()
    const p = session.send('Page.navigate', {}, 50)
    const assertion = expect(p).rejects.toMatchObject({ code: 'CDP_TIMEOUT', detail: { method: 'Page.navigate', timeoutMs: 50 } })
    await vi.advanceTimersByTimeAsync(50)
    await assertion
  })

  it('send rejects with CDP_REMOTE_ERROR when Chrome answers with a protocol error, keeping its message and code', async () => {
    const { session, ws } = await connected()
    const p = session.send('Bogus.method')
    ws.reply({ id: 1, error: { code: -32601, message: "'Bogus.method' wasn't found" } })
    await expect(p).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR', message: expect.stringContaining("'Bogus.method' wasn't found"), detail: { remoteCode: -32601 } })
  })

  it('a pending send rejects with CDP_SESSION_CLOSED when the socket closes under it', async () => {
    const { session, ws } = await connected()
    const p = session.send('Page.enable')
    ws.emit('close')
    await expect(p).rejects.toMatchObject({ code: 'CDP_SESSION_CLOSED', message: expect.stringContaining('WebSocket closed') })
  })

  it('a pending send rejects with CDP_SESSION_CLOSED when the caller closes the session', async () => {
    const { session } = await connected()
    const p = session.send('Page.enable')
    session.close()
    await expect(p).rejects.toMatchObject({ code: 'CDP_SESSION_CLOSED', message: expect.stringContaining('Session closed') })
  })

  it('send rejects with CDP_SEND_FAILED when the socket write throws, keeping the cause', async () => {
    const { session } = await connected()
    const boom = new Error('socket gone')
    FakeWebSocket.throwOnSend = boom
    await expect(session.send('Page.enable')).rejects.toMatchObject({ code: 'CDP_SEND_FAILED', message: expect.stringContaining('CDP send failed: socket gone'), cause: boom })
  })
})
