/**
 * Feature-level pins for the CDP domain services (failsafe inventory fs-177, fs-179, fs-180, fs-181, fs-182).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [tests-unit-data.6] [resolve-findings.1].
 * Scenario: an agent inspects a running Chrome through the CdpClient facade. fetch and WebSocket are
 * stubbed with a fake DevTools endpoint that records every request; no network, no real Chrome.
 * Page-level commands (Page.*, Network.*, Performance.*, Memory.getDOMCounters) must arrive on an attached
 * flat page session without a targetId parameter; Browser.getWindowBounds must carry the windowId that
 * Browser.getWindowForTarget returned; every failure is a typed StealthCoreBrowserError, never null or [] (F146-F152).
 * Inventory pin names (row wording predates the typed-error fix; the behaviour pinned is the one-shot,
 * 10 s-bounded, failure-surfacing call): [fs-177] [fs-180] [fs-181].
 * guards: [fs-177] cdpCall fails typed (never null) and times out · [fs-180] browser version reports or fails typed · [fs-181] page and network commands reach the attached page session
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [tests-unit-data.6] [resolve-findings.1]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpClient } from '../../../src/lib/domains/index.js'
import { cdpCall } from '../../../src/lib/domains/transport.js'
import { StealthCoreBrowserError } from '../../../src/errors.js'
import { FakeCdpServer } from '../../helpers/fake-cdp.js'

type Reply = (req: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }) => Record<string, unknown> | null
type Listener = (ev: { data: string }) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static reply: Reply = () => null
  static autoOpen = true
  readyState = 0
  sent: Array<{ id: number; method: string; params: Record<string, unknown>; sessionId?: string }> = []
  closed = false
  private listeners = new Map<string, Listener[]>()
  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
    if (FakeWebSocket.autoOpen) setTimeout(() => { this.readyState = 1; this.emit('open') }, 1)
  }
  send(raw: string): void {
    const req = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
    this.sent.push(req)
    const body = FakeWebSocket.reply(req)
    if (body) queueMicrotask(() => this.emit('message', JSON.stringify({ id: req.id, ...body })))
  }
  addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) }
  removeEventListener(type: string, fn: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn)) }
  close(): void { this.closed = true; this.readyState = 3 }
  private emit(type: string, data = ''): void { (this.listeners.get(type) ?? []).forEach((l) => l({ data })) }
}

const VERSION = {
  Browser: 'Chrome/130.0.0.0', 'Protocol-Version': '1.3', 'User-Agent': 'UA/1', 'V8-Version': '13.0',
  webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/b',
}
const fetched: string[] = []
let routes: Record<string, unknown> = {}
const fetchMock = vi.fn(async (url: string, _init?: unknown) => {
  fetched.push(url)
  const path = url.replace(/^http:\/\/[^/]+/, '')
  if (!(path in routes)) throw new Error('ECONNREFUSED')
  return { ok: true, status: 200, json: async () => routes[path] }
})

const methods = (): string[] => FakeWebSocket.instances.flatMap((w) => w.sent.map((s) => s.method))
const sentOf = (method: string) => FakeWebSocket.instances.flatMap((w) => w.sent).find((s) => s.method === method)
/** Chrome's answer for a page session: attach hands out a sessionId, anything else goes to `rest`. */
const withSession = (rest: Reply): Reply => (r) => (r.method === 'Target.attachToTarget' ? { result: { sessionId: 'SESS' } } : rest(r))
const HOST = '127.0.0.1:1'

describe('8468f7b1 AC2 [tests-unit-data.6] CDP domain services', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.reply = () => ({ result: {} })
    FakeWebSocket.autoOpen = true
    fetched.length = 0
    routes = { '/json/version': VERSION }
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('[fs-177] cdpCall is one-shot, surfaces every failure as a typed error and times out after 10 s', async () => {
    // success and protocol error ride the shared CdpSession over the harness FakeCdpServer
    const harness = new FakeCdpServer({
      meta: { name: 'fs-177', origin: 'synthetic-protocol-conformant' },
      steps: [
        { when: { method: 'Browser.getVersion' }, reply: { result: { ok: true } } },
        { when: { method: 'Target.activateTarget' }, reply: { error: { code: -32602, message: 'No such target' } } },
      ],
    })
    const restore = harness.install()
    try {
      await expect(cdpCall(HOST, 'Browser.getVersion')).resolves.toEqual({ ok: true })
      // protocol error -> CDP_REMOTE_ERROR carrying Chrome's code
      await expect(cdpCall(HOST, 'Target.activateTarget', { targetId: 'x' })).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR', detail: { remoteCode: -32602 } })
    } finally {
      restore()
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // unreachable browser -> CDP_UNREACHABLE
    routes = {}
    await expect(cdpCall(HOST, 'Browser.getVersion')).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    // silent browser -> CDP_TIMEOUT after 10 s, socket closed
    routes = { '/json/version': VERSION }
    FakeWebSocket.reply = () => null
    vi.useFakeTimers()
    const p = cdpCall(HOST, 'Browser.getVersion')
    let settled = false
    const outcome = p.then(() => 'resolved', (e: unknown) => { settled = true; return e })
    await vi.advanceTimersByTimeAsync(9_000)
    expect(settled).toBe(false) // still waiting inside the window
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await outcome).toMatchObject({ code: 'CDP_TIMEOUT' })
    expect(FakeWebSocket.instances[FakeWebSocket.instances.length - 1]?.closed).toBe(true)
  })

  it('[fs-179] lists page targets and target info; an unknown target is TARGET_NOT_FOUND', async () => {
    routes['/json/list'] = [
      { id: 'P1', type: 'page', title: 'Alpha', url: 'https://a.test/', webSocketDebuggerUrl: 'ws://x/1' },
      { id: 'P2', type: 'page', title: 'Beta', url: 'about:blank' }, // nobody attached
      { id: 'W1', type: 'service_worker', title: 'sw', url: 'https://a.test/sw.js' },
      { id: 'B1', type: 'background_page', title: 'ext', url: 'chrome-extension://x' },
    ]
    const cdp = new CdpClient(HOST)
    const pages = await cdp.listPageTargets()
    expect(fetched).toContain(`http://${HOST}/json/list`)
    expect(pages).toEqual([
      { targetId: 'P1', type: 'page', title: 'Alpha', url: 'https://a.test/', attached: true },
      { targetId: 'P2', type: 'page', title: 'Beta', url: 'about:blank', attached: false },
    ])
    expect(await cdp.countActivePages()).toBe(1) // about:blank is not activity

    FakeWebSocket.reply = (r) => ({ result: { targetInfo: { targetId: r.params['targetId'], type: 'page', title: 'T', url: 'u', attached: true } } })
    expect((await cdp.getTargetInfo('P1')).targetId).toBe('P1')
    await expect(cdp.activateTarget('P1')).resolves.toBeUndefined()
    expect(methods()).toEqual(['Target.getTargetInfo', 'Target.activateTarget'])
    expect(FakeWebSocket.instances[0].sent[0].params).toEqual({ targetId: 'P1' })

    // failures: an unknown target is TARGET_NOT_FOUND; an unreachable list endpoint rejects (no silent empty list)
    FakeWebSocket.reply = () => ({ error: { code: -32602, message: 'No target with given id found' } })
    await expect(cdp.getTargetInfo('nope')).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(cdp.activateTarget('nope')).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    delete routes['/json/list']
    await expect(cdp.listPageTargets()).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
  })

  it('[fs-180] reports the browser version and rejects typed when the browser cannot answer', async () => {
    const cdp = new CdpClient(HOST)
    expect(await cdp.getVersion()).toEqual({
      browserVersion: 'Chrome/130.0.0.0', protocolVersion: '1.3', userAgent: 'UA/1', jsVersion: '13.0', v8Version: '13.0',
    })
    // a refusal from the browser is a CDP_REMOTE_ERROR, never an empty value that looks like "none"
    FakeWebSocket.reply = () => ({ error: { code: -32601, message: 'unsupported' } })
    await expect(cdp.getHistograms('Net')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getHistogram('Net.X')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getWindowBounds('P1')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getWindowForTarget('P1')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getBrowserCommandLine()).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    // and map real answers through
    FakeWebSocket.reply = (r) => {
      if (r.method === 'Browser.getHistograms') return { result: { histograms: [{ name: 'h' }] } }
      if (r.method === 'Browser.getBrowserCommandLine') return { result: { arguments: ['chrome', '--remote-debugging-port=9222'] } }
      return { result: { windowId: 3, bounds: { width: 800 } } }
    }
    expect(await cdp.getHistograms('Net')).toEqual([{ name: 'h' }])
    expect(await cdp.getBrowserCommandLine()).toContain('--remote-debugging-port=9222')
    expect(await cdp.getWindowForTarget('P1')).toMatchObject({ windowId: 3 })
    expect(sentOf('Browser.getHistograms')?.params).toEqual({ query: 'Net' })
    // unreachable browser: a CDP_UNREACHABLE rejection, not a null
    routes = {}
    await expect(cdp.getVersion()).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
  })

  it('[F147] getWindowBounds resolves the windowId first and sends it to Browser.getWindowBounds', async () => {
    const cdp = new CdpClient(HOST)
    FakeWebSocket.reply = (r) => {
      if (r.method === 'Browser.getWindowForTarget') return { result: { windowId: 41, bounds: { width: 1 } } }
      if (r.method === 'Browser.getWindowBounds') return { result: { bounds: { left: 5, width: 800 } } }
      return { result: {} }
    }
    expect(await cdp.getWindowBounds('P1')).toEqual({ left: 5, width: 800 })
    expect(methods()).toEqual(['Browser.getWindowForTarget', 'Browser.getWindowBounds'])
    expect(sentOf('Browser.getWindowForTarget')?.params).toEqual({ targetId: 'P1' })
    expect(sentOf('Browser.getWindowBounds')?.params).toEqual({ windowId: 41 })
  })

  it('[fs-181] maps system network and page services', async () => {
    routes['/json/list'] = [{ id: 'P1', type: 'page', title: 'Alpha', url: 'https://a.test/', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/P1' }]
    const cdp = new CdpClient(HOST)
    FakeWebSocket.reply = withSession((r) => {
      switch (r.method) {
        case 'SystemInfo.getInfo': return { result: { modelName: 'Mac', gpu: { vendorString: 'Apple' } } } // missing fields default to ''
        case 'SystemInfo.getProcessInfo': return { result: { processInfo: [{ type: 'renderer', id: 7, cpuTime: 1.5 }] } }
        case 'Memory.getDOMCounters': return { result: { documents: 2, nodes: 40 } } // missing counters default to 0
        case 'Network.getCookies': return { result: { cookies: [{ name: 'a' }] } }
        case 'Network.getAllCookies': return { result: { cookies: [{ name: 'a' }, { name: 'b' }] } }
        case 'Performance.getMetrics': return { result: { metrics: [{ name: 'Nodes', value: 12 }, { name: 'JSHeapUsedSize', value: 99 }] } }
        default: return { result: {} }
      }
    })
    expect(await cdp.getSystemInfo()).toEqual({
      modelName: 'Mac', modelVersion: '', commandLine: '', gpu: { vendor: 'Apple', device: '', driverVersion: '' },
    })
    expect(await cdp.getProcessInfo()).toEqual([{ type: 'renderer', id: 7, cpuTime: 1.5 }])
    expect(await cdp.getMemoryCounters()).toEqual({ documents: 2, nodes: 40, jsEventListeners: 0, layouts: 0, recalcStyleCount: 0 })
    expect(await cdp.getCookies(['https://a.test'])).toHaveLength(1)
    expect(await cdp.getAllCookies()).toHaveLength(2)
    const metrics = await cdp.getPageMetrics('P1')
    expect(metrics).toMatchObject({ nodes: 12, jsHeapUsedSize: 99, documents: 0, layoutCount: 0 })
    expect(sentOf('Network.getCookies')?.params).toEqual({ urls: ['https://a.test'] })
    // page-level commands travel on the attached session; browser-level ones do not
    expect(sentOf('Network.getCookies')?.sessionId).toBe('SESS')
    expect(sentOf('Memory.getDOMCounters')?.sessionId).toBe('SESS')
    expect(sentOf('Performance.getMetrics')?.sessionId).toBe('SESS')
    expect(sentOf('SystemInfo.getInfo')?.sessionId).toBeUndefined()
    expect(methods().filter((m) => m === 'Performance.enable' || m === 'Performance.disable')).toEqual(['Performance.enable', 'Performance.disable'])

    // failures surface as typed errors — a failed read is never an empty answer
    FakeWebSocket.reply = withSession(() => ({ error: { code: -32000, message: 'denied' } }))
    await expect(cdp.getSystemInfo()).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getProcessInfo()).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getMemoryCounters()).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getCookies()).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getAllCookies()).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getPageMetrics('P1')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getNavigationHistory('P1')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getFrameTree('P1')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getResourceTree('P1')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.getLayoutMetrics('P1')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    await expect(cdp.captureScreenshot('P1')).rejects.toMatchObject({ code: 'CDP_REMOTE_ERROR' })
    for (const call of [() => cdp.getFrameTree('P1')]) await expect(call()).rejects.toBeInstanceOf(StealthCoreBrowserError)
  })

  it('[F148] cookie reads without a page fail TARGET_NOT_FOUND instead of returning an empty jar', async () => {
    routes['/json/list'] = []
    const cdp = new CdpClient(HOST)
    await expect(cdp.getAllCookies()).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(cdp.getCookies()).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
  })

  it('[fs-182] the CdpClient facade delegates to the services', async () => {
    const dflt = new CdpClient()
    await dflt.getVersion()
    expect(fetched).toEqual(['http://127.0.0.1:9222/json/version']) // default host (fetch is stubbed; nothing real is contacted)
    const cdp = new CdpClient(HOST)
    expect(cdp.target).toBeDefined()
    expect(cdp.browser).toBeDefined()
    expect(cdp.page).toBeDefined()
    expect(cdp.network).toBeDefined()
    expect(cdp.system).toBeDefined()
    FakeWebSocket.reply = withSession((r) => (r.method === 'Page.captureScreenshot' ? { result: { data: 'PNGDATA' } } : { result: { frameTree: { f: 1 } } }))
    expect(await cdp.captureScreenshot('P1', 'jpeg')).toBe('PNGDATA')
    expect(await cdp.getFrameTree('P1')).toEqual({ f: 1 })
    expect(await cdp.getResourceTree('P1')).toEqual({ f: 1 })
    const attach = sentOf('Target.attachToTarget')
    expect(attach?.params).toEqual({ targetId: 'P1', flatten: true })
    const shot = sentOf('Page.captureScreenshot')
    expect(shot?.params).toEqual({ format: 'jpeg' }) // Page commands take no targetId
    expect(shot?.sessionId).toBe('SESS')
    // every call goes to the configured host
    expect(fetched.filter((u) => u.includes(HOST)).length).toBeGreaterThan(0)
    // stealth: the facade never evaluates script in the page
    expect(methods()).not.toContain('Runtime.evaluate')
  })
})
