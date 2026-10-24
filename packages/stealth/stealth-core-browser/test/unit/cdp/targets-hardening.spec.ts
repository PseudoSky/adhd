/**
 * guards: a CDP endpoint that never answers hangs the status, list and launch poll; a non-JSON or non-array list answer throws a bare SyntaxError or TypeError; a failed Target.createTarget leaks the browser session; a page that never registers is left open
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1]
 * Pre-review P11 (every CDP HTTP request is bounded by CDP_HTTP_TIMEOUT_MS and fails with CDP_TIMEOUT), P12 (listPageTargets
 * answers typed errors for a bad body), P13 (createPageTarget closes its browser session on every path and closes the
 * page it created when the page never becomes addressable). fetch is stubbed and CdpSession is an in-memory fake.
 * Ticket 8468f7b1 · [audit-fixes.1]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cdp = vi.hoisted(() => {
  const state = { sent: [] as string[], closes: 0, failCreate: false }
  class CdpSession {
    async connect(): Promise<void> {
      return undefined
    }
    async send(method: string): Promise<unknown> {
      state.sent.push(method)
      if (method === 'Target.createTarget' && state.failCreate) throw new Error('createTarget refused')
      return method === 'Target.createTarget' ? { targetId: 'T1' } : {}
    }
    close(): void {
      state.closes++
    }
  }
  return { state, CdpSession }
})
vi.mock('../../../src/lib/cdp/session.js', () => ({ CdpSession: cdp.CdpSession }))

import { CDP_HTTP_TIMEOUT_MS, createPageTarget, getChromeInfo, listPageTargets, listPageTargetsOnly } from '../../../src/lib/cdp/targets.js'

const HOST = '127.0.0.1:9333'
const VERSION = { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/b1', Browser: 'Chrome/150', 'Protocol-Version': '1.3', 'User-Agent': 'UA' }

const json = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response

beforeEach(() => {
  cdp.state.sent.length = 0
  cdp.state.closes = 0
  cdp.state.failCreate = false
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('every CDP HTTP request is bounded [audit-fixes.1]', () => {
  it('P11 a host that accepts and never answers fails with CDP_TIMEOUT after CDP_HTTP_TIMEOUT_MS and the request is aborted', async () => {
    vi.useFakeTimers()
    let aborted = false
    vi.stubGlobal(
      'fetch',
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )
    const pending = getChromeInfo(HOST)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'CDP_TIMEOUT', detail: { path: '/json/version', timeoutMs: CDP_HTTP_TIMEOUT_MS } })
    await vi.advanceTimersByTimeAsync(CDP_HTTP_TIMEOUT_MS + 1)
    await assertion
    expect(aborted).toBe(true)
  })

  it('P11 a prompt answer clears the timer (no timeout fires later)', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => json(VERSION))
    await expect(getChromeInfo(HOST)).resolves.toMatchObject({ browserVersion: 'Chrome/150' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('listPageTargets answers typed errors [audit-fixes.1]', () => {
  it('P12 a body that is not JSON is CDP_BAD_RESPONSE with the cause kept', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => JSON.parse('<html>') }) as unknown as Response)
    await expect(listPageTargets(HOST)).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { cdpHost: HOST }, cause: expect.any(SyntaxError) as unknown })
  })

  it.each([{ error: 'nope' }, 'text', 7, null])('P12 a JSON body that is not an array (%j) is CDP_BAD_RESPONSE, not a TypeError in filter', async (body) => {
    vi.stubGlobal('fetch', async () => json(body))
    await expect(listPageTargetsOnly(HOST)).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { reason: 'not-an-array' } })
  })

  it('P12 entries that are not target objects are dropped and a debugger URL on another host is refused', async () => {
    vi.stubGlobal('fetch', async () => json([null, 5, { id: 'a', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/a' }]))
    await expect(listPageTargets(HOST)).resolves.toHaveLength(1)
    vi.stubGlobal('fetch', async () => json([{ id: 'a', type: 'page', url: 'x', webSocketDebuggerUrl: 'ws://evil.example.net:9333/devtools/page/a' }]))
    await expect(listPageTargets(HOST)).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { reason: 'ws-host-mismatch' } })
  })

  it('P12 /json/version without a debugger URL is CDP_BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', async () => json({ Browser: 'Chrome' }))
    await expect(getChromeInfo(HOST)).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { reason: 'missing-ws-url' } })
  })
})

describe('createPageTarget leaves nothing behind [audit-fixes.1]', () => {
  it('P13 Target.createTarget throwing still closes the browser session', async () => {
    vi.stubGlobal('fetch', async () => json(VERSION))
    cdp.state.failCreate = true
    await expect(createPageTarget(HOST)).rejects.toThrow('createTarget refused')
    expect(cdp.state.closes).toBe(1)
  })

  it('P13 a page that never registers in /json/list is closed before TARGET_NOT_FOUND is thrown', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', async (url: string) => (url.endsWith('/json/version') ? json(VERSION) : json([])))
    const pending = createPageTarget(HOST)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await vi.advanceTimersByTimeAsync(3500)
    await assertion
    expect(cdp.state.sent).toContain('Target.closeTarget')
  })
})
