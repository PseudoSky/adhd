/**
 * Unit spec for src/lib/cdp/targets.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4].
 * fetch is stubbed (vi.stubGlobal) and CdpSession is replaced by an in-memory fake: no network, no WebSocket.
 * Also chrome-lifecycle [chrome-lifecycle.13] (the gap-G1 cleanup of createIsolatedPageTarget) and the
 * failsafe-inventory pins [fs-053] .. [fs-069] (see the last two describe blocks).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cdp = vi.hoisted(() => {
  const state = {
    sent: [] as Array<{ method: string; params: Record<string, unknown> }>,
    connects: [] as string[],
    closes: 0,
    connectError: null as unknown,
    respond: (_method: string, _params: Record<string, unknown>): unknown => ({}),
  }
  class CdpSession {
    async connect(url: string): Promise<void> {
      state.connects.push(url)
      if (state.connectError) throw state.connectError
    }
    async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      state.sent.push({ method, params })
      return state.respond(method, params)
    }
    close(): void {
      state.closes++
    }
  }
  return { state, CdpSession }
})

vi.mock('../../../lib/cdp/session.js', () => ({ CdpSession: cdp.CdpSession }))

import {
  closeAllPageTargets,
  closePageTarget,
  createIsolatedPageTarget,
  createPageTarget,
  getChromeInfo,
  hideAllWindows,
  isChromeReachable,
  listPageTargets,
  listPageTargetsOnly,
} from '../../../lib/cdp/targets.js'
import type { PageTargetInfo } from '../../../lib/cdp/targets.js'
import { loadFixture } from '../../support/fake-cdp.js'

const HOST = '127.0.0.1:9333'
const VERSION = {
  webSocketDebuggerUrl: 'ws://fake/devtools/browser/b1',
  Browser: 'Chrome/150.0',
  'Protocol-Version': '1.3',
  'User-Agent': 'Mozilla/5.0 Fake',
}

interface Net {
  list: PageTargetInfo[]
  versionStatus: number
  versionBody: () => unknown
  fetchError: unknown
  urls: string[]
}
let net: Net

function sentMethods(): string[] {
  return cdp.state.sent.map((s) => s.method)
}

beforeEach(() => {
  cdp.state.sent.length = 0
  cdp.state.connects.length = 0
  cdp.state.closes = 0
  cdp.state.respond = () => ({})
  net = { list: [], versionStatus: 200, versionBody: () => VERSION, fetchError: null, urls: [] }
  vi.stubGlobal('fetch', async (input: string) => {
    net.urls.push(input)
    if (net.fetchError) throw net.fetchError
    if (input.endsWith('/json/version')) {
      return {
        ok: net.versionStatus < 400,
        status: net.versionStatus,
        json: async () => net.versionBody(),
      }
    }
    return { ok: true, status: 200, json: async () => net.list }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('8468f7b1 AC2 [tests-unit-core.1] getChromeInfo / isChromeReachable', () => {
  it('maps /json/version onto ChromeVersionInfo', async () => {
    const info = await getChromeInfo(HOST)
    expect(net.urls).toEqual([`http://${HOST}/json/version`])
    expect(info).toEqual({
      browserWsUrl: 'ws://fake/devtools/browser/b1',
      browserVersion: 'Chrome/150.0',
      protocolVersion: '1.3',
      userAgent: 'Mozilla/5.0 Fake',
      webSocketDebuggerUrl: 'ws://fake/devtools/browser/b1',
    })
  })

  it('surfaces the nested undici cause (ECONNREFUSED) instead of "fetch failed"', async () => {
    net.fetchError = Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:9333') })
    await expect(getChromeInfo(HOST)).rejects.toThrow(
      `CDP unreachable on ${HOST} — Chrome is not running or remote debugging is not enabled on that port (connect ECONNREFUSED 127.0.0.1:9333)`,
    )
  })

  it('falls back to the error message when there is no distinct cause', async () => {
    net.fetchError = new Error('boom')
    await expect(getChromeInfo(HOST)).rejects.toThrow('(boom)')
  })

  it('stringifies a non-Error fetch rejection', async () => {
    net.fetchError = 'offline'
    await expect(getChromeInfo(HOST)).rejects.toThrow('(offline)')
  })

  it('reports a non-2xx status with the HTTP code and path', async () => {
    net.versionStatus = 503
    await expect(getChromeInfo(HOST)).rejects.toThrow(
      `CDP on ${HOST} returned HTTP 503 for /json/version — Chrome may be starting or shutting down`,
    )
  })

  it('reports a non-JSON /json/version body', async () => {
    net.versionBody = () => {
      throw new SyntaxError('Unexpected token <')
    }
    await expect(getChromeInfo(HOST)).rejects.toThrow(
      `CDP on ${HOST} returned a non-JSON /json/version response (Unexpected token <)`,
    )
  })

  it('isChromeReachable is true when the endpoint answers', async () => {
    expect(await isChromeReachable(HOST)).toBe(true)
  })

  it('isChromeReachable is false (never throws) when Chrome is down', async () => {
    net.fetchError = new Error('refused')
    expect(await isChromeReachable(HOST)).toBe(false)
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] target listing', () => {
  const targets: PageTargetInfo[] = [
    { id: 'p1', type: 'page', url: 'https://a.test/', webSocketDebuggerUrl: 'ws://fake/page/p1' },
    { id: 'sw1', type: 'service_worker', url: 'https://a.test/sw.js' },
    { id: 'p2', type: 'page', url: 'about:blank' },
  ]

  it('listPageTargets returns every target from /json/list', async () => {
    net.list = targets
    expect(await listPageTargets(HOST)).toEqual(targets)
    expect(net.urls).toEqual([`http://${HOST}/json/list`])
  })

  it('listPageTargetsOnly excludes service workers and other non-page types', async () => {
    net.list = targets
    const pages = await listPageTargetsOnly(HOST)
    expect(pages.map((t) => t.id)).toEqual(['p1', 'p2'])
    expect(pages.map((t) => t.id)).not.toContain('sw1')
  })

  it('listPageTargets rejects with an actionable message when Chrome is down', async () => {
    net.fetchError = new Error('refused')
    await expect(listPageTargets(HOST)).rejects.toThrow('CDP unreachable')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] createPageTarget', () => {
  beforeEach(() => {
    cdp.state.respond = (method) => (method === 'Target.createTarget' ? { targetId: 'T1' } : {})
  })

  it('creates a background about:blank target and returns its page WebSocket URL', async () => {
    net.list = [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/page/T1' }]
    const r = await createPageTarget(HOST)
    expect(r).toEqual({ targetId: 'T1', pageWsUrl: 'ws://fake/page/T1' })
    expect(cdp.state.connects).toEqual(['ws://fake/devtools/browser/b1'])
    expect(cdp.state.sent[0]).toEqual({
      method: 'Target.createTarget',
      params: { url: 'about:blank', background: true, focus: false },
    })
    expect(cdp.state.closes).toBe(1)
  })

  it('foreground flips background/focus', async () => {
    net.list = [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/page/T1' }]
    await createPageTarget(HOST, { foreground: true })
    expect(cdp.state.sent[0].params).toMatchObject({ background: false, focus: true })
  })

  it('polls /json/list until the target registers its WebSocket URL', async () => {
    vi.useFakeTimers()
    net.list = [{ id: 'T1', type: 'page', url: 'about:blank' }]
    const p = createPageTarget(HOST)
    await vi.advanceTimersByTimeAsync(250)
    net.list = [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/page/T1' }]
    await vi.advanceTimersByTimeAsync(200)
    await expect(p).resolves.toEqual({ targetId: 'T1', pageWsUrl: 'ws://fake/page/T1' })
  })

  it('throws after 3s when the target never registers (error path)', async () => {
    vi.useFakeTimers()
    net.list = []
    const p = createPageTarget(HOST)
    const assertion = expect(p).rejects.toThrow('Target T1 not found in /json/list after 3s')
    await vi.advanceTimersByTimeAsync(3500)
    await assertion
    expect(console.error).toHaveBeenCalled()
  })

  it('propagates a Target.createTarget failure', async () => {
    cdp.state.respond = () => {
      throw new Error('Target.createTarget denied')
    }
    await expect(createPageTarget(HOST)).rejects.toThrow('Target.createTarget denied')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] createIsolatedPageTarget', () => {
  beforeEach(() => {
    cdp.state.respond = (method) => {
      if (method === 'Target.createBrowserContext') return { browserContextId: 'CTX1' }
      if (method === 'Target.createTarget') return { targetId: 'T9' }
      if (method === 'Browser.getWindowForTarget') return { windowId: 77 }
      return {}
    }
    net.list = [{ id: 'T9', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/page/T9' }]
  })

  it('creates an isolated context, a background target inside it, and minimizes the window', async () => {
    const r = await createIsolatedPageTarget(HOST)
    expect(r).toMatchObject({ targetId: 'T9', pageWsUrl: 'ws://fake/page/T9', browserContextId: 'CTX1' })
    expect(sentMethods()).toEqual([
      'Target.createBrowserContext',
      'Target.createTarget',
      'Browser.getWindowForTarget',
      'Browser.setWindowBounds',
    ])
    expect(cdp.state.sent[1].params).toEqual({
      url: 'about:blank',
      browserContextId: 'CTX1',
      background: true,
      focus: false,
    })
    expect(cdp.state.sent[3].params).toEqual({ windowId: 77, bounds: { windowState: 'minimized' } })
  })

  it('does not minimize when foreground is requested', async () => {
    await createIsolatedPageTarget(HOST, { foreground: true })
    expect(sentMethods()).not.toContain('Browser.setWindowBounds')
    expect(cdp.state.sent[1].params).toMatchObject({ background: false, focus: true })
  })

  it('tolerates a window lookup failure and still returns the target', async () => {
    const respond = cdp.state.respond
    cdp.state.respond = (method, params) => {
      if (method === 'Browser.getWindowForTarget') throw new Error('no window')
      return respond(method, params)
    }
    const r = await createIsolatedPageTarget(HOST)
    expect(r.targetId).toBe('T9')
    expect(console.warn).toHaveBeenCalled()
  })

  it('dispose() disposes the browser context on a fresh browser session', async () => {
    const r = await createIsolatedPageTarget(HOST)
    cdp.state.sent.length = 0
    await r.dispose()
    expect(cdp.state.sent).toEqual([
      { method: 'Target.disposeBrowserContext', params: { browserContextId: 'CTX1' } },
    ])
  })

  it('dispose() never throws when Chrome is already gone (error path)', async () => {
    const r = await createIsolatedPageTarget(HOST)
    net.fetchError = new Error('refused')
    await expect(r.dispose()).resolves.toBeUndefined()
  })

  it('reveal() restores a visible window using the remembered windowId', async () => {
    const r = await createIsolatedPageTarget(HOST)
    cdp.state.sent.length = 0
    await r.reveal()
    expect(cdp.state.sent).toEqual([
      {
        method: 'Browser.setWindowBounds',
        params: { windowId: 77, bounds: { left: 80, top: 80, width: 1100, height: 850, windowState: 'normal' } },
      },
    ])
  })

  it('reveal() is a no-op when the window id was never resolved', async () => {
    const respond = cdp.state.respond
    cdp.state.respond = (method, params) => {
      if (method === 'Browser.getWindowForTarget') throw new Error('no window')
      return respond(method, params)
    }
    const r = await createIsolatedPageTarget(HOST)
    cdp.state.sent.length = 0
    await r.reveal()
    expect(cdp.state.sent).toEqual([])
  })

  it('disposes the context and throws when the target never registers', async () => {
    vi.useFakeTimers()
    net.list = []
    const p = createIsolatedPageTarget(HOST)
    const assertion = expect(p).rejects.toThrow('Isolated target T9 not found in /json/list after 3s')
    await vi.advanceTimersByTimeAsync(3500)
    await assertion
    expect(sentMethods()).toContain('Target.disposeBrowserContext')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] closing and hiding', () => {
  it('closePageTarget sends Target.closeTarget on the browser session and closes it', async () => {
    await closePageTarget(HOST, 'T1')
    expect(cdp.state.sent).toEqual([{ method: 'Target.closeTarget', params: { targetId: 'T1' } }])
    expect(cdp.state.closes).toBe(1)
  })

  it('closePageTarget swallows failures with a warning (error path)', async () => {
    net.fetchError = new Error('refused')
    await expect(closePageTarget(HOST, 'T1')).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalled()
  })

  it('closeAllPageTargets closes only page-type targets', async () => {
    net.list = [
      { id: 'p1', type: 'page', url: 'https://a.test/' },
      { id: 'sw1', type: 'service_worker', url: 'https://a.test/sw.js' },
      { id: 'p2', type: 'page', url: 'https://b.test/' },
    ]
    await closeAllPageTargets(HOST)
    const closed = cdp.state.sent.filter((s) => s.method === 'Target.closeTarget').map((s) => s.params['targetId'])
    expect(closed.sort()).toEqual(['p1', 'p2'])
    expect(closed).not.toContain('sw1')
  })

  it('closeAllPageTargets rejects when the target list cannot be fetched', async () => {
    net.fetchError = new Error('refused')
    await expect(closeAllPageTargets(HOST)).rejects.toThrow('CDP unreachable')
  })

  it('hideAllWindows minimizes the window of every page target', async () => {
    net.list = [
      { id: 'p1', type: 'page', url: 'https://a.test/' },
      { id: 'p2', type: 'page', url: 'https://b.test/' },
    ]
    cdp.state.respond = (method, params) =>
      method === 'Browser.getWindowForTarget' ? { windowId: params['targetId'] === 'p1' ? 1 : 2 } : {}
    await hideAllWindows(HOST)
    const bounds = cdp.state.sent.filter((s) => s.method === 'Browser.setWindowBounds').map((s) => s.params)
    expect(bounds).toEqual([
      { windowId: 1, bounds: { windowState: 'minimized' } },
      { windowId: 2, bounds: { windowState: 'minimized' } },
    ])
    expect(cdp.state.closes).toBe(1)
  })

  it('hideAllWindows continues past a failing target and never throws', async () => {
    net.list = [
      { id: 'p1', type: 'page', url: 'https://a.test/' },
      { id: 'p2', type: 'page', url: 'https://b.test/' },
    ]
    cdp.state.respond = (method, params) => {
      if (method === 'Browser.getWindowForTarget') {
        if (params['targetId'] === 'p1') throw new Error('no window for p1')
        return { windowId: 2 }
      }
      return {}
    }
    await expect(hideAllWindows(HOST)).resolves.toBeUndefined()
    const bounds = cdp.state.sent.filter((s) => s.method === 'Browser.setWindowBounds')
    expect(bounds).toHaveLength(1)
    expect(console.warn).toHaveBeenCalled()
  })

  it('hideAllWindows swallows an unreachable Chrome', async () => {
    net.fetchError = new Error('refused')
    await expect(hideAllWindows(HOST)).resolves.toBeUndefined()
    expect(cdp.state.sent).toEqual([])
  })
})

/**
 * A CdpSession `respond` that answers from a harness fixture's steps (first
 * step whose method matches; an `error` reply throws like CDP does).
 */
function respondFromFixture(name: string): (method: string, params?: Record<string, unknown>) => unknown {
  const steps = loadFixture(name).steps
  return (method: string) => {
    const step = steps.find((s) => s.when.method === method)
    if (!step) return {}
    if (step.reply?.error) throw new Error(step.reply.error.message)
    return step.reply?.result ?? {}
  }
}

/** Sockets opened by the creator/dispose sessions minus sockets closed: 0 means no leak. */
function openSockets(): number {
  return cdp.state.connects.length - cdp.state.closes
}

describe('8468f7b1 [chrome-lifecycle.13] createIsolatedPageTarget cleans up on every failure (gap G1)', () => {
  beforeEach(() => {
    cdp.state.connectError = null
    cdp.state.respond = respondFromFixture('isolated-context-ok')
    net.list = [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/page/T1' }]
  })

  it('closes the creator browser session on success', async () => {
    await createIsolatedPageTarget(HOST)
    expect(openSockets()).toBe(0)
  })

  it('Target.createBrowserContext throws: the browser session is closed (finally), nothing to dispose', async () => {
    cdp.state.respond = (method) => {
      if (method === 'Target.createBrowserContext') throw new Error('Failed to create context')
      return {}
    }
    await expect(createIsolatedPageTarget(HOST)).rejects.toThrow('Failed to create context')
    expect(openSockets()).toBe(0)
    expect(sentMethods()).not.toContain('Target.disposeBrowserContext')
  })

  it('Target.createTarget throws: the created context is disposed and the session closed', async () => {
    const ok = respondFromFixture('isolated-context-ok')
    cdp.state.respond = (method, params) => {
      if (method === 'Target.createTarget') throw new Error('Failed to create target')
      return ok(method, params)
    }
    await expect(createIsolatedPageTarget(HOST)).rejects.toThrow('Failed to create target')
    expect(cdp.state.sent.filter((s) => s.method === 'Target.disposeBrowserContext').map((s) => s.params)).toEqual([{ browserContextId: 'CTX1' }])
    expect(openSockets()).toBe(0)
  })

  it('a failing disposeBrowserContext after createTarget throws still surfaces the createTarget error', async () => {
    cdp.state.respond = (method) => {
      if (method === 'Target.createBrowserContext') return { browserContextId: 'CTX1' }
      if (method === 'Target.createTarget') throw new Error('Failed to create target')
      if (method === 'Target.disposeBrowserContext') throw new Error('Failed to find context with id CTX1')
      return {}
    }
    await expect(createIsolatedPageTarget(HOST)).rejects.toThrow('Failed to create target')
    expect(openSockets()).toBe(0)
  })

  it('the browser connect fails: nothing was created and nothing is left open', async () => {
    cdp.state.connectError = new Error('WebSocket connection failed')
    await expect(createIsolatedPageTarget(HOST)).rejects.toThrow('WebSocket connection failed')
    expect(cdp.state.sent).toEqual([])
    expect(openSockets()).toBe(0)
  })

  it('a window-bounds failure is non-fatal and the session is still closed', async () => {
    const ok = respondFromFixture('isolated-context-ok')
    cdp.state.respond = (method, params) => {
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 }
      if (method === 'Browser.setWindowBounds') throw new Error('Browser window not found')
      return ok(method, params)
    }
    const r = await createIsolatedPageTarget(HOST)
    expect(r.browserContextId).toBe('CTX1')
    expect(openSockets()).toBe(0)
  })

  it('isolated-context-target-missing: the target never registers, the context is disposed (disposeBrowserContext) and every session closed', async () => {
    vi.useFakeTimers()
    cdp.state.respond = respondFromFixture('isolated-context-target-missing')
    net.list = []
    const p = createIsolatedPageTarget(HOST)
    const assertion = expect(p).rejects.toThrow('Isolated target T1 not found in /json/list after 3s')
    await vi.advanceTimersByTimeAsync(3500)
    await assertion
    expect(cdp.state.sent.filter((s) => s.method === 'Target.disposeBrowserContext').map((s) => s.params)).toEqual([{ browserContextId: 'CTX1' }])
    expect(openSockets()).toBe(0)
  })
})

describe('8468f7b1 [chrome-lifecycle.13] failsafe-inventory pins fs-053..fs-069 (targets)', () => {
  beforeEach(() => {
    cdp.state.connectError = null
  })

  it('explains an unreachable CDP with the nested cause', async () => {
    // [fs-053]
    net.fetchError = Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:9333') })
    await expect(getChromeInfo(HOST)).rejects.toThrow(`CDP unreachable on ${HOST}`)
    await expect(getChromeInfo(HOST)).rejects.toThrow('connect ECONNREFUSED 127.0.0.1:9333')
  })

  it('reports a non-OK CDP HTTP status', async () => {
    // [fs-054]
    net.versionStatus = 503
    await expect(getChromeInfo(HOST)).rejects.toThrow('returned HTTP 503 for /json/version — Chrome may be starting or shutting down')
  })

  it('reports a non-JSON version response', async () => {
    // [fs-055]
    net.versionBody = () => {
      throw new SyntaxError('Unexpected token <')
    }
    await expect(getChromeInfo(HOST)).rejects.toThrow('non-JSON /json/version response (Unexpected token <)')
  })

  it('isChromeReachable is false on any failure', async () => {
    // [fs-056]
    net.fetchError = new Error('refused')
    await expect(isChromeReachable(HOST)).resolves.toBe(false)
    net.fetchError = null
    net.versionStatus = 500
    await expect(isChromeReachable(HOST)).resolves.toBe(false)
  })

  it('maps /json/version into chrome info', async () => {
    // [fs-057]
    await expect(getChromeInfo(HOST)).resolves.toEqual({
      browserWsUrl: VERSION.webSocketDebuggerUrl,
      browserVersion: VERSION.Browser,
      protocolVersion: VERSION['Protocol-Version'],
      userAgent: VERSION['User-Agent'],
      webSocketDebuggerUrl: VERSION.webSocketDebuggerUrl,
    })
  })

  it('lists only page targets', async () => {
    // [fs-058]
    net.list = [
      { id: 'P', type: 'page', url: 'https://a.example/' },
      { id: 'SW', type: 'service_worker', url: 'https://a.example/sw.js' },
      { id: 'BG', type: 'background_page', url: 'chrome-extension://x/bg.html' },
    ]
    expect((await listPageTargets(HOST)).map((t) => t.id)).toEqual(['P', 'SW', 'BG'])
    expect((await listPageTargetsOnly(HOST)).map((t) => t.id)).toEqual(['P'])
  })

  it('creates a background page and waits for its socket', async () => {
    // [fs-059]
    vi.useFakeTimers()
    cdp.state.respond = (method) => (method === 'Target.createTarget' ? { targetId: 'N1' } : {})
    net.list = []
    const p = createPageTarget(HOST)
    await vi.advanceTimersByTimeAsync(150)
    net.list = [{ id: 'N1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/page/N1' }]
    await vi.advanceTimersByTimeAsync(150)
    await expect(p).resolves.toEqual({ targetId: 'N1', pageWsUrl: 'ws://fake/page/N1' })
    expect(cdp.state.sent[0]).toEqual({ method: 'Target.createTarget', params: { url: 'about:blank', background: true, focus: false } })
  })

  it('fails when the new target never registers', async () => {
    // [fs-060]
    vi.useFakeTimers()
    cdp.state.respond = (method) => (method === 'Target.createTarget' ? { targetId: 'N2' } : {})
    net.list = []
    const p = createPageTarget(HOST)
    const assertion = expect(p).rejects.toThrow('Target N2 not found in /json/list after 3s')
    await vi.advanceTimersByTimeAsync(3500)
    await assertion
  })

  it('creates a cookie-less isolated context', async () => {
    // [fs-061]
    cdp.state.respond = respondFromFixture('isolated-context-ok')
    net.list = [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/page/T1' }]
    const r = await createIsolatedPageTarget(HOST)
    expect(sentMethods()[0]).toBe('Target.createBrowserContext')
    expect(cdp.state.sent[1].params).toMatchObject({ browserContextId: 'CTX1' })
    expect(r.browserContextId).toBe('CTX1')
  })

  it('the context survives the creator connection closing', async () => {
    // [fs-062] NOT disposeOnDetach: the context is created without it and is only disposed by dispose().
    cdp.state.respond = respondFromFixture('isolated-context-ok')
    net.list = [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/page/T1' }]
    await createIsolatedPageTarget(HOST)
    expect(cdp.state.sent[0].params).toEqual({})
    expect(cdp.state.closes).toBe(1)
    expect(sentMethods()).not.toContain('Target.disposeBrowserContext')
  })

  it('isolated pages are background and minimized by default', async () => {
    // [fs-063]
    const ok = respondFromFixture('isolated-context-ok')
    cdp.state.respond = (method, params) => (method === 'Browser.getWindowForTarget' ? { windowId: 5 } : ok(method, params))
    net.list = [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/page/T1' }]
    await createIsolatedPageTarget(HOST)
    expect(cdp.state.sent[1].params).toMatchObject({ background: true, focus: false })
    expect(cdp.state.sent.find((s) => s.method === 'Browser.setWindowBounds')?.params).toEqual({ windowId: 5, bounds: { windowState: 'minimized' } })
  })

  it('reveal brings the window on screen', async () => {
    // [fs-064]
    const ok = respondFromFixture('isolated-context-ok')
    cdp.state.respond = (method, params) => (method === 'Browser.getWindowForTarget' ? { windowId: 5 } : ok(method, params))
    net.list = [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/page/T1' }]
    const r = await createIsolatedPageTarget(HOST)
    cdp.state.sent.length = 0
    await r.reveal()
    expect(cdp.state.sent).toEqual([
      { method: 'Browser.setWindowBounds', params: { windowId: 5, bounds: { left: 80, top: 80, width: 1100, height: 850, windowState: 'normal' } } },
    ])
  })

  it('dispose closes the whole context', async () => {
    // [fs-065]
    cdp.state.respond = respondFromFixture('isolated-context-ok')
    net.list = [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/page/T1' }]
    const r = await createIsolatedPageTarget(HOST)
    cdp.state.sent.length = 0
    await r.dispose()
    expect(cdp.state.sent).toEqual([{ method: 'Target.disposeBrowserContext', params: { browserContextId: 'CTX1' } }])
    expect(openSockets()).toBe(0)
  })

  it('disposes the context when creation fails', async () => {
    // [fs-066]
    vi.useFakeTimers()
    cdp.state.respond = respondFromFixture('isolated-context-target-missing')
    net.list = []
    const p = createIsolatedPageTarget(HOST)
    const assertion = expect(p).rejects.toThrow('not found in /json/list after 3s')
    await vi.advanceTimersByTimeAsync(3500)
    await assertion
    expect(sentMethods()).toContain('Target.disposeBrowserContext')
  })

  it('closes a page target and never throws', async () => {
    // [fs-067]
    await closePageTarget(HOST, 'T1')
    expect(cdp.state.sent).toEqual([{ method: 'Target.closeTarget', params: { targetId: 'T1' } }])
    cdp.state.respond = () => {
      throw new Error('No target with given id found')
    }
    await expect(closePageTarget(HOST, 'T404')).resolves.toBeUndefined()
  })

  it('one failing close does not block the others', async () => {
    // [fs-068]
    net.list = [
      { id: 'A', type: 'page', url: 'https://a/' },
      { id: 'B', type: 'page', url: 'https://b/' },
      { id: 'C', type: 'page', url: 'https://c/' },
    ]
    cdp.state.respond = (method, params) => {
      if (method === 'Target.closeTarget' && params['targetId'] === 'A') throw new Error('boom')
      return {}
    }
    await expect(closeAllPageTargets(HOST)).resolves.toBeUndefined()
    expect(cdp.state.sent.filter((s) => s.method === 'Target.closeTarget').map((s) => s.params['targetId'])).toEqual(['A', 'B', 'C'])
  })

  it('hideAllWindows minimizes every page window', async () => {
    // [fs-069]
    net.list = [
      { id: 'A', type: 'page', url: 'https://a/' },
      { id: 'B', type: 'page', url: 'chrome://newtab/' },
    ]
    cdp.state.respond = (method, params) => (method === 'Browser.getWindowForTarget' ? { windowId: params['targetId'] === 'A' ? 1 : 2 } : {})
    await hideAllWindows(HOST)
    expect(cdp.state.sent.filter((s) => s.method === 'Browser.setWindowBounds').map((s) => s.params)).toEqual([
      { windowId: 1, bounds: { windowState: 'minimized' } },
      { windowId: 2, bounds: { windowState: 'minimized' } },
    ])
  })
})
