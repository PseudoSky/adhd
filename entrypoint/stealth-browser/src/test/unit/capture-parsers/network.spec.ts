/**
 * Unit spec for src/lib/capture/network.ts (event-driven CDP network capture).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-extract.1] [tests-unit-extract.2]
 * [tests-unit-extract.3] [tests-unit-extract.4].
 * The global WebSocket is replaced via vi.stubGlobal with a fake that the test
 * drives by emitting Network.* events; nothing touches a socket or Chrome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureNetworkResponse } from '../../../lib/capture/network.js'
import type { BanRule } from '../../../lib/types.js'

type Listener = (ev: { data?: string }) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  closed = false
  private listeners = new Map<string, Listener[]>()

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw))
  }
  close(): void {
    this.closed = true
  }
  emit(type: string, ev: { data?: string } = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }
  event(method: string, params: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify({ method, params }) })
  }
  /** Reply to the most recent Network.getResponseBody command. */
  replyBody(result: Record<string, unknown> | undefined, error?: { code: number; message: string }): void {
    const cmd = [...this.sent].reverse().find((m) => m.method === 'Network.getResponseBody')
    if (!cmd) throw new Error('no getResponseBody was sent')
    this.emit('message', { data: JSON.stringify({ id: cmd.id, result, error }) })
  }
  /** Run one full request lifecycle for url and answer the body fetch. */
  load(requestId: string, url: string, body: string, base64 = false): void {
    this.event('Network.requestWillBeSent', { requestId, request: { url, method: 'GET' } })
    this.event('Network.loadingFinished', { requestId })
    this.replyBody({ body: base64 ? Buffer.from(body).toString('base64') : body, base64Encoded: base64 })
  }
}

const ws = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]

const baseOpts = { urlPattern: /\/search/, navigateUrl: 'https://site.test/home', timeoutMs: 5_000 }

describe('8468f7b1 AC2 [tests-unit-extract.1][tests-unit-extract.3] captureNetworkResponse', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('connects to the page ws url, enables Page+Network and navigates', async () => {
    const p = captureNetworkResponse('ws://127.0.0.1:1/devtools/page/X', baseOpts)
    const assertion = expect(p).rejects.toThrow('timeout')
    ws().emit('open')
    expect(ws().url).toBe('ws://127.0.0.1:1/devtools/page/X')
    expect(ws().sent.map((m) => m.method)).toEqual(['Page.enable', 'Network.enable', 'Page.navigate'])
    expect(ws().sent[2].params).toEqual({ url: 'https://site.test/home' })
    expect(ws().sent.map((m) => m.method)).not.toContain('Runtime.evaluate')
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
    expect(ws().closed).toBe(true)
  })

  it('resolves with the matching response body after the settle delay', async () => {
    const p = captureNetworkResponse('ws://x/1', { ...baseOpts, extraWaitMs: 200 })
    ws().emit('open')
    ws().load('r1', 'https://site.test/search?q=a', '<html>hit</html>')
    await vi.advanceTimersByTimeAsync(200)
    const out = await p
    expect(out.body).toBe('<html>hit</html>')
    expect(out.url).toBe('https://site.test/search?q=a')
    expect(out.status).toBe(200)
    expect(ws().closed).toBe(true)
  })

  it('decodes base64 bodies', async () => {
    const p = captureNetworkResponse('ws://x/1', baseOpts)
    ws().emit('open')
    ws().load('r1', 'https://site.test/search', 'café ✓', true)
    await vi.advanceTimersByTimeAsync(500)
    expect((await p).body).toBe('café ✓')
  })

  it('prefers the largest captured body', async () => {
    const p = captureNetworkResponse('ws://x/1', { ...baseOpts, extraWaitMs: 300 })
    ws().emit('open')
    ws().load('small', 'https://site.test/search?a', 'tiny')
    ws().load('big', 'https://site.test/search?b', 'a considerably larger document body')
    await vi.advanceTimersByTimeAsync(300)
    const out = await p
    expect(out.url).toBe('https://site.test/search?b')
    expect(out.body).toBe('a considerably larger document body')
  })

  it('ignores responses whose request url does not match the pattern, then times out', async () => {
    const p = captureNetworkResponse('ws://x/1', { ...baseOpts, timeoutMs: 1_000 })
    const assertion = expect(p).rejects.toThrow('timeout')
    ws().emit('open')
    ws().event('Network.requestWillBeSent', { requestId: 'z', request: { url: 'https://site.test/img.png', method: 'GET' } })
    ws().event('Network.loadingFinished', { requestId: 'z' })
    expect(ws().sent.some((m) => m.method === 'Network.getResponseBody')).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('discards a body fetch that comes back as a CDP error', async () => {
    const p = captureNetworkResponse('ws://x/1', { ...baseOpts, timeoutMs: 1_000 })
    const assertion = expect(p).rejects.toThrow('timeout')
    ws().emit('open')
    ws().event('Network.requestWillBeSent', { requestId: 'e', request: { url: 'https://site.test/search', method: 'GET' } })
    ws().event('Network.loadingFinished', { requestId: 'e' })
    ws().replyBody(undefined, { code: -32000, message: 'No resource' })
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('rejects with "WebSocket error" when the socket errors', async () => {
    const p = captureNetworkResponse('ws://x/1', baseOpts)
    const assertion = expect(p).rejects.toThrow('WebSocket error')
    ws().emit('error')
    await assertion
    expect(ws().closed).toBe(true)
  })

  it('throws "Ban detected" when a ban rule matches the captured body', async () => {
    const rules: BanRule[] = [{ name: 'captcha-body', signal: 'captcha', checkBody: /unusual traffic/ }]
    const p = captureNetworkResponse('ws://x/1', { ...baseOpts, banRules: rules })
    const assertion = expect(p).rejects.toThrow('Ban detected: captcha')
    ws().emit('open')
    ws().load('r1', 'https://site.test/search', '<p>unusual traffic from your network</p>')
    await vi.advanceTimersByTimeAsync(500)
    await assertion
  })

  it('returns normally when ban rules exist but none match', async () => {
    const rules: BanRule[] = [{ name: 'captcha-body', signal: 'captcha', checkBody: /unusual traffic/ }]
    const p = captureNetworkResponse('ws://x/1', { ...baseOpts, banRules: rules })
    ws().emit('open')
    ws().load('r1', 'https://site.test/search', '<p>fine</p>')
    await vi.advanceTimersByTimeAsync(500)
    await expect(p).resolves.toMatchObject({ body: '<p>fine</p>' })
  })

  it('surfaces a failed command send without crashing the capture', async () => {
    const p = captureNetworkResponse('ws://x/1', { ...baseOpts, timeoutMs: 500 })
    const assertion = expect(p).rejects.toThrow('timeout')
    ws().send = () => {
      throw new Error('closed')
    }
    ws().emit('open')
    await vi.advanceTimersByTimeAsync(500)
    await assertion
    expect(console.error).toHaveBeenCalled()
  })
})
