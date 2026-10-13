/**
 * CL13 (F20 F21 F22, gap G1) isolated pages over the in-memory CDP server.
 * Ticket 8468f7b1 · [chrome-lifecycle.13]
 *
 * `openIsolatedPage` / `withIsolatedPage` against `FakeCdpServer` (the global
 * WebSocket is stubbed) and a stubbed `fetch` for `/json/version` and
 * `/json/list`: no socket, no network, no Chrome. Every path is checked for
 * leaks: every socket the server ever opened (`openCount()`) is closed, and
 * every context created by `Target.createBrowserContext` got a
 * `Target.disposeBrowserContext`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeCdpServer, loadFixture, type CdpFixture, type CdpFixtureStep } from '../../support/fake-cdp.js'
import { openIsolatedPage, withIsolatedPage } from '../../../lib/lifecycle/isolated-page.js'
import { LifecycleError } from '../../../lib/lifecycle/errors.js'

const HOST = '127.0.0.1:9333'
const BROWSER_WS = 'ws://fake/devtools/browser/b1'
const PAGE_WS = 'ws://fake/devtools/page/T1'

interface World {
  server: FakeCdpServer
  sockets: Array<{ url: string; readyState: number }>
  /** /json/list answer. */
  list: Array<{ id: string; type: string; url: string; webSocketDebuggerUrl?: string }>
  /** URLs whose socket fails to open (closes before open). */
  failUrls: Set<string>
  /** Fail /json/version (Chrome unreachable). */
  versionDown: boolean
  restore: () => void
}

let w: World

function withSteps(base: string, extra: CdpFixtureStep[], replace: Record<string, CdpFixtureStep['reply']> = {}): CdpFixture {
  const f = loadFixture(base)
  const steps = f.steps.map((s) => (s.when.method in replace ? { ...s, reply: replace[s.when.method] } : s))
  return { ...f, steps: [...extra, ...steps] }
}

const WINDOW_STEPS: CdpFixtureStep[] = [
  { when: { method: 'Browser.getWindowForTarget' }, reply: { result: { windowId: 7 } } },
  { when: { method: 'Browser.setWindowBounds' } },
]

function install(fixture: CdpFixture): void {
  const server = new FakeCdpServer(fixture)
  const restoreWs = server.install()
  const Bound = (globalThis as { WebSocket: unknown }).WebSocket as (url: string) => { url: string; readyState: number; close(): void }
  const sockets: World['sockets'] = []
  const failUrls = new Set<string>()
  ;(globalThis as { WebSocket: unknown }).WebSocket = Object.assign(
    function Tracked(url: string) {
      const ws = Bound(url)
      sockets.push(ws)
      if (failUrls.has(url)) ws.close() // a close before open: the connect fails
      return ws
    },
    { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  )
  w = {
    server,
    sockets,
    list: [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: PAGE_WS }],
    failUrls,
    versionDown: false,
    restore: restoreWs,
  }
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/json/version')) {
      if (w.versionDown) throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') })
      return new Response(JSON.stringify({ webSocketDebuggerUrl: BROWSER_WS, Browser: 'Chrome/126', 'Protocol-Version': '1.3', 'User-Agent': 'UA' }))
    }
    if (url.endsWith('/json/list')) return new Response(JSON.stringify(w.list))
    throw new Error(`unexpected fetch ${url}`)
  })
}

const methods = (): string[] => w.server.received.map((r) => r.method)
const count = (m: string): number => methods().filter((x) => x === m).length

/** Every socket the server ever opened is closed again: openCount() minus closed sockets is zero. */
async function expectNoLeak(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  const closed = w.sockets.filter((s) => s.readyState === 3).length
  expect(w.server.openCount()).toBe(w.sockets.length)
  expect(w.server.openCount() - closed).toBe(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  w?.restore()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [chrome-lifecycle.13] openIsolatedPage — success path', () => {
  it('opens a page in its own new context (no shared context), background by default, minimized', async () => {
    install(withSteps('isolated-context-ok', WINDOW_STEPS))
    const p = await openIsolatedPage(HOST)
    expect(p.browserContextId).toBe('CTX1')
    expect(p.targetId).toBe('T1')
    expect(p.page.connected).toBe(true)
    const create = w.server.received.find((r) => r.method === 'Target.createTarget')!
    expect(create.params).toMatchObject({ url: 'about:blank', browserContextId: 'CTX1', background: true, focus: false })
    const bounds = w.server.received.find((r) => r.method === 'Browser.setWindowBounds')!
    expect(bounds.params).toEqual({ windowId: 7, bounds: { windowState: 'minimized' } })
    await p.dispose()
    await expectNoLeak()
  })

  it('every open creates its own context (never the default, never shared)', async () => {
    install(withSteps('isolated-context-ok', WINDOW_STEPS))
    const a = await openIsolatedPage(HOST)
    const b = await openIsolatedPage(HOST)
    expect(count('Target.createBrowserContext')).toBe(2)
    for (const r of w.server.received.filter((x) => x.method === 'Target.createTarget')) {
      expect(r.params.browserContextId).toBeDefined()
    }
    await a.dispose()
    await b.dispose()
  })

  it('foreground skips the minimize and focuses', async () => {
    install(withSteps('isolated-context-ok', WINDOW_STEPS))
    const p = await openIsolatedPage(HOST, { foreground: true })
    expect(w.server.received.find((r) => r.method === 'Target.createTarget')!.params).toMatchObject({ background: false, focus: true })
    expect(count('Browser.setWindowBounds')).toBe(0)
    await p.dispose()
  })

  it('reveal unminimizes the window (normal state, on-screen bounds)', async () => {
    install(withSteps('isolated-context-ok', WINDOW_STEPS))
    const p = await openIsolatedPage(HOST)
    await p.reveal()
    const last = w.server.received.filter((r) => r.method === 'Browser.setWindowBounds').at(-1)!
    expect(last.params).toEqual({ windowId: 7, bounds: { left: 80, top: 80, width: 1100, height: 850, windowState: 'normal' } })
    await p.dispose()
    await expectNoLeak()
  })

  it('dispose disposes the context, closes the page session and is idempotent', async () => {
    install(withSteps('isolated-context-ok', WINDOW_STEPS))
    const p = await openIsolatedPage(HOST)
    await p.dispose()
    await p.dispose()
    expect(w.server.received.filter((r) => r.method === 'Target.disposeBrowserContext').map((r) => r.params)).toEqual([{ browserContextId: 'CTX1' }])
    expect(p.page.connected).toBe(false)
    await expectNoLeak()
  })
})

describe('8468f7b1 [chrome-lifecycle.13] openIsolatedPage — every failure leaves no open socket and no undisposed context', () => {
  it('fails at Target.createBrowserContext: no context exists, every socket closed', async () => {
    install(withSteps('isolated-context-ok', WINDOW_STEPS, { 'Target.createBrowserContext': { error: { code: -32000, message: 'Failed to create context' } } }))
    const err = await openIsolatedPage(HOST).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LifecycleError)
    expect((err as LifecycleError).code).toBe('ISOLATED_CONTEXT_FAILED')
    expect(count('Target.createTarget')).toBe(0)
    expect(count('Target.disposeBrowserContext')).toBe(0)
    await expectNoLeak()
    expect(w.sockets.every((s) => s.readyState === 3)).toBe(true)
  })

  it('fails at Target.createTarget: the created context is disposed before the error propagates', async () => {
    install(withSteps('isolated-context-ok', WINDOW_STEPS, { 'Target.createTarget': { error: { code: -32000, message: 'Failed to create target' } } }))
    const err = await openIsolatedPage(HOST).catch((e: unknown) => e)
    expect((err as LifecycleError).code).toBe('ISOLATED_CONTEXT_FAILED')
    expect((err as LifecycleError).cause).toBeInstanceOf(Error)
    expect(w.server.received.filter((r) => r.method === 'Target.disposeBrowserContext').map((r) => r.params)).toEqual([{ browserContextId: 'CTX1' }])
    await expectNoLeak()
    expect(w.sockets.every((s) => s.readyState === 3)).toBe(true)
  })

  it('a window bounds failure is non-fatal and the page still opens', async () => {
    install(
      withSteps('isolated-context-ok', [
        { when: { method: 'Browser.getWindowForTarget' }, reply: { result: { windowId: 7 } } },
        { when: { method: 'Browser.setWindowBounds' }, reply: { error: { code: -32000, message: 'Browser window not found' } } },
      ]),
    )
    const p = await openIsolatedPage(HOST)
    expect(p.targetId).toBe('T1')
    await p.dispose()
    await expectNoLeak()
    expect(w.sockets.every((s) => s.readyState === 3)).toBe(true)
  })

  it('fails to connect the page session: the context is disposed and every socket closed', async () => {
    install(withSteps('isolated-context-ok', WINDOW_STEPS))
    w.failUrls.add(PAGE_WS)
    const err = await openIsolatedPage(HOST).catch((e: unknown) => e)
    expect((err as LifecycleError).code).toBe('ISOLATED_CONTEXT_FAILED')
    expect((err as LifecycleError).detail).toMatchObject({ step: 'connect' })
    expect(w.server.received.filter((r) => r.method === 'Target.disposeBrowserContext').map((r) => r.params)).toEqual([{ browserContextId: 'CTX1' }])
    await expectNoLeak()
    expect(w.sockets.every((s) => s.readyState === 3)).toBe(true)
  })

  it('target missing (isolated-context-target-missing): disposes the context after 3 s, then fails', async () => {
    install(loadFixture('isolated-context-target-missing'))
    w.list = []
    const pending = openIsolatedPage(HOST).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(3_500)
    const err = await pending
    expect((err as LifecycleError).code).toBe('ISOLATED_CONTEXT_FAILED')
    expect(count('Target.disposeBrowserContext')).toBe(1)
    await expectNoLeak()
    expect(w.sockets.every((s) => s.readyState === 3)).toBe(true)
  })

  it('Chrome unreachable: fails typed, nothing was created', async () => {
    install(loadFixture('isolated-context-ok'))
    w.versionDown = true
    const err = await openIsolatedPage(HOST).catch((e: unknown) => e)
    expect((err as LifecycleError).code).toBe('ISOLATED_CONTEXT_FAILED')
    expect(w.server.openCount()).toBe(0)
  })
})

describe('8468f7b1 [chrome-lifecycle.13] withIsolatedPage', () => {
  it('returns fn result and disposes', async () => {
    install(withSteps('isolated-context-ok', WINDOW_STEPS))
    const out = await withIsolatedPage(HOST, undefined, async (p) => p.targetId)
    expect(out).toBe('T1')
    expect(count('Target.disposeBrowserContext')).toBe(1)
    await expectNoLeak()
  })

  it('disposes when fn throws, and rethrows fn error', async () => {
    install(withSteps('isolated-context-ok', WINDOW_STEPS))
    const boom = new Error('extract failed')
    await expect(
      withIsolatedPage(HOST, undefined, async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(w.server.received.filter((r) => r.method === 'Target.disposeBrowserContext').map((r) => r.params)).toEqual([{ browserContextId: 'CTX1' }])
    await expectNoLeak()
    expect(w.sockets.every((s) => s.readyState === 3)).toBe(true)
  })
})
