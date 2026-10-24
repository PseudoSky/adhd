/**
 * guards: one malformed frame from a broken or hostile endpoint throws inside the WebSocket listener and takes the host process down, or a throwing event subscriber leaves no trace
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1]
 * Pre-review P10 (a frame that is not a JSON object fails closed with a typed CDP_BAD_RESPONSE for every command in
 * flight) and P38 (a throwing subscriber is reported through `onHandlerError`, not swallowed, and does not starve the
 * other subscribers). The global WebSocket is an in-memory fake: no network.
 * Ticket 8468f7b1 · [audit-fixes.1]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpSession } from '../../../src/lib/cdp/session.js'

type Listener = (ev: { data?: unknown }) => void

class FakeWebSocket {
  static last: FakeWebSocket
  closed = false
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Listener[]>()
  constructor(readonly url: string) {
    FakeWebSocket.last = this
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  emit(type: string, ev: { data?: unknown } = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }
}

async function connected(): Promise<{ session: CdpSession; ws: FakeWebSocket }> {
  const session = new CdpSession()
  const p = session.connect('ws://127.0.0.1/devtools/browser/x')
  FakeWebSocket.last.emit('open')
  await p
  return { session, ws: FakeWebSocket.last }
}

beforeEach(() => vi.stubGlobal('WebSocket', FakeWebSocket))
afterEach(() => vi.unstubAllGlobals())

describe('a malformed frame fails closed with a typed error [audit-fixes.1]', () => {
  it.each(['not json at all', '{"id":', 'null', '42', '"text"', '[1,2]'])('P10 frame %j rejects the in-flight command with CDP_BAD_RESPONSE and closes the socket', async (frame) => {
    const { session, ws } = await connected()
    const pending = session.send('Page.enable')
    const assertion = expect(pending).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { reason: 'malformed-frame' } })
    expect(() => ws.emit('message', { data: frame })).not.toThrow()
    await assertion
    expect(ws.closed).toBe(true)
    expect(session.connected).toBe(false)
  })

  it('P10 a well-formed frame after good traffic still resolves its command', async () => {
    const { session, ws } = await connected()
    const pending = session.send('Page.enable')
    const id = (JSON.parse(ws.sent[0] as string) as { id: number }).id
    ws.emit('message', { data: JSON.stringify({ id, result: { ok: true } }) })
    await expect(pending).resolves.toEqual({ ok: true })
  })
})

describe('a throwing subscriber is reported, not swallowed [audit-fixes.1]', () => {
  it('P38 onHandlerError receives the event method and the error, and the next subscriber still runs', async () => {
    const { session, ws } = await connected()
    const seen: Array<[string, unknown]> = []
    session.onHandlerError = (method, err) => void seen.push([method, err])
    const boom = new Error('capture handler bug')
    const after = vi.fn()
    session.on('Network.responseReceived', () => {
      throw boom
    })
    session.on('Network.responseReceived', after)
    ws.emit('message', { data: JSON.stringify({ method: 'Network.responseReceived', params: { a: 1 } }) })
    expect(seen).toEqual([['Network.responseReceived', boom]])
    expect(after).toHaveBeenCalledWith({ a: 1 })
  })

  it('P38 default report: with no override the failure is one stderr line naming the event and the message', async () => {
    const { session, ws } = await connected()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    session.on('Page.loadEventFired', () => {
      throw new Error('boom')
    })
    ws.emit('message', { data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }) })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Page.loadEventFired threw: boom'))
    spy.mockRestore()
  })
})
