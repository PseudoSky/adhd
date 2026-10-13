/**
 * Unit spec for src/lib/capture/network.ts (the capture entry point over the
 * recorder pipeline).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-extract.1] [tests-unit-extract.2]
 * [tests-unit-extract.3] [tests-unit-extract.4] [capture-upgrade.12].
 * The protocol is served by the in-memory FakeCdpServer (fixtures); the
 * WebSocket is replaced globally, nothing touches a socket or Chrome.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureNetworkResponse } from '../../../lib/capture/network.js'
import { CaptureError } from '../../../lib/recording/errors.js'
import type { BanRule } from '../../../lib/types.js'
import { FakeCdpServer, loadFixture, type CdpFixture } from '../../support/fake-cdp.js'

const WS = 'ws://127.0.0.1:1/devtools/page/X'
const baseOpts = { urlPattern: /\/search/, navigateUrl: 'https://site.test/search?q=x', timeoutMs: 5_000, logger: () => undefined }

let restore: (() => void) | undefined
function boot(fixture: string | CdpFixture): FakeCdpServer {
  const server = new FakeCdpServer(typeof fixture === 'string' ? loadFixture(fixture) : fixture)
  restore = server.install()
  return server
}
afterEach(() => {
  restore?.()
  restore = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('8468f7b1 AC2 [tests-unit-extract.1][tests-unit-extract.3] captureNetworkResponse', () => {
  it('connects to the page ws url, enables Page+Network and navigates (never Runtime.evaluate)', async () => {
    const server = boot('search-404')
    await captureNetworkResponse(WS, baseOpts)
    const methods = server.received.map((m) => m.method)
    expect(methods.slice(0, 3)).toEqual(['Page.enable', 'Network.enable', 'Page.navigate'])
    expect(server.received[2]?.params).toEqual({ url: 'https://site.test/search?q=x' })
    expect(methods).not.toContain('Runtime.evaluate')
  })

  it('resolves with the matching response body after the settle delay', async () => {
    boot('search-404')
    vi.useFakeTimers()
    let out: Awaited<ReturnType<typeof captureNetworkResponse>> | undefined
    void captureNetworkResponse(WS, { ...baseOpts, extraWaitMs: 200 }).then((r) => {
      out = r
    })
    await vi.advanceTimersByTimeAsync(199)
    expect(out).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(out?.body).toBe('{"error":"not found"}')
    expect(out?.url).toBe('https://site.test/search?q=x')
    expect(out?.status).toBe(404) // the real status, no longer a hard-coded success
  })

  it('decodes base64 bodies', async () => {
    boot('binary-base64')
    const out = await captureNetworkResponse(WS, { ...baseOpts, urlPattern: /img/, navigateUrl: 'https://site.test/img.png' })
    expect(out.body).toBe(Buffer.from('iVBORw0KGgo=', 'base64').toString('utf-8'))
  })

  it('prefers the largest captured body', async () => {
    const f = loadFixture('two-tabs-parallel')
    const generic = f.steps.findIndex((s) => s.when.method === 'Network.getResponseBody')
    f.steps.splice(
      generic,
      1,
      { when: { method: 'Network.getResponseBody', params: { requestId: 'A1' } }, reply: { result: { body: 'tiny', base64Encoded: false } } },
      { when: { method: 'Network.getResponseBody', params: { requestId: 'B1' } }, reply: { result: { body: 'a considerably larger document body', base64Encoded: false } } },
    )
    boot(f)
    const out = await captureNetworkResponse(WS, { ...baseOpts, urlPattern: /site\.test/, navigateUrl: 'https://site.test/a' })
    expect(out.url).toBe('https://site.test/b')
    expect(out.body).toBe('a considerably larger document body')
  })

  it('ignores responses whose request url does not match the pattern, then reports what it saw', async () => {
    const server = boot('doc-200')
    vi.useFakeTimers()
    const p = captureNetworkResponse(WS, { ...baseOpts, urlPattern: /\/search/, navigateUrl: 'https://site.test/home', timeoutMs: 1_000 })
    const assertion = expect(p).rejects.toMatchObject({ code: 'CAPTURE_NO_MATCH', detail: { urls: ['https://site.test/home'] } })
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
    expect(server.received.some((m) => m.method === 'Network.getResponseBody')).toBe(false)
  })

  it('discards a body fetch that comes back as a CDP error', async () => {
    const f = loadFixture('search-404')
    const body = f.steps.find((s) => s.when.method === 'Network.getResponseBody')
    if (body) body.reply = { error: { code: -32000, message: 'No resource' } }
    boot(f)
    vi.useFakeTimers()
    const p = captureNetworkResponse(WS, { ...baseOpts, timeoutMs: 1_000 })
    const assertion = expect(p).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('rejects with a typed connection error when the socket errors before opening', async () => {
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
    const err = await captureNetworkResponse(WS, baseOpts).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CaptureError)
    expect(err).toMatchObject({ code: 'CAPTURE_CONNECT_FAILED' })
  })

  it('throws a ban error when a ban rule matches the captured body', async () => {
    boot('search-404')
    const rules: BanRule[] = [{ name: 'not-found-body', signal: 'captcha', checkBody: /not found/ }]
    await expect(captureNetworkResponse(WS, { ...baseOpts, banRules: rules })).rejects.toMatchObject({
      code: 'CAPTURE_BAN_DETECTED',
      detail: { signal: 'captcha' },
    })
  })

  it('returns normally when ban rules exist but none match', async () => {
    boot('search-404')
    const rules: BanRule[] = [{ name: 'captcha-body', signal: 'captcha', checkBody: /unusual traffic/ }]
    await expect(captureNetworkResponse(WS, { ...baseOpts, banRules: rules })).resolves.toMatchObject({ body: '{"error":"not found"}' })
  })

  it('logs a failed setup command without crashing the capture', async () => {
    const f = loadFixture('search-404')
    const enable = f.steps.find((s) => s.when.method === 'Page.enable')
    if (enable) enable.reply = { error: { code: -32000, message: 'Page domain unavailable' } }
    boot(f)
    const logs: string[] = []
    const out = await captureNetworkResponse(WS, { ...baseOpts, logger: (m) => logs.push(m) })
    expect(out.status).toBe(404)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('Page.enable')
  })

  it('does not hang when the navigation itself fails: the failure is typed', async () => {
    const f = loadFixture('search-404')
    const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
    if (nav) {
      nav.reply = { result: { errorText: 'net::ERR_ABORTED' } }
      nav.emit = []
    }
    boot(f)
    await expect(captureNetworkResponse(WS, { ...baseOpts, timeoutMs: 30_000 })).rejects.toMatchObject({ code: 'CAPTURE_NAVIGATE_FAILED' })
  })
})
