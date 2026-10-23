/**
 * Feature-level pins for the CDP domain services (failsafe inventory fs-177, fs-179, fs-180, fs-181, fs-182).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [tests-unit-data.6].
 * Scenario: an agent inspects a running Chrome through the CdpClient facade. fetch and WebSocket are
 * stubbed with a fake DevTools endpoint that records every request; no network, no real Chrome.
 * guards: [fs-177] cdpCall returns null on failure and times out
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [tests-unit-data.6]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpClient } from '../../../src/lib/domains/index.js'
import { cdpCall } from '../../../src/lib/domains/transport.js'
import { FakeCdpServer } from '../../helpers/fake-cdp.js'

type Reply = (req: { id: number; method: string; params: Record<string, unknown> }) => Record<string, unknown> | null
type Listener = (ev: { data: string }) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static reply: Reply = () => null
  static autoOpen = true
  readyState = 0
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  closed = false
  private listeners = new Map<string, Listener[]>()
  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
    if (FakeWebSocket.autoOpen) setTimeout(() => { this.readyState = 1; this.emit('open') }, 1)
  }
  send(raw: string): void {
    const req = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }
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
  webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/browser/b',
}
const fetched: string[] = []
let routes: Record<string, unknown> = {}
const fetchMock = vi.fn(async (url: string) => {
  fetched.push(url)
  const path = url.replace(/^http:\/\/[^/]+/, '')
  if (!(path in routes)) throw new Error('ECONNREFUSED')
  return { json: async () => routes[path] }
})

const methods = (): string[] => FakeWebSocket.instances.flatMap((w) => w.sent.map((s) => s.method))

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

  it('[fs-177] cdpCall returns null on failure and times out', async () => {
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
      await expect(cdpCall('h:1', 'Browser.getVersion')).resolves.toEqual({ ok: true })
      // protocol error -> null
      await expect(cdpCall('h:1', 'Target.activateTarget', { targetId: 'x' })).resolves.toBeNull()
    } finally {
      restore()
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // unreachable browser -> null
    routes = {}
    await expect(cdpCall('h:1', 'Browser.getVersion')).resolves.toBeNull()
    // silent browser -> null after 10 s, socket closed
    routes = { '/json/version': VERSION }
    FakeWebSocket.reply = () => null
    vi.useFakeTimers()
    const p = cdpCall('h:1', 'Browser.getVersion')
    let settled = false
    void p.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(9_000)
    expect(settled).toBe(false) // still waiting inside the window
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(p).resolves.toBeNull()
    expect(FakeWebSocket.instances[FakeWebSocket.instances.length - 1]?.closed).toBe(true)
  })

  it('[fs-179] lists page targets and target info', async () => {
    routes['/json/list'] = [
      { id: 'P1', type: 'page', title: 'Alpha', url: 'https://a.test/', webSocketDebuggerUrl: 'ws://x/1' },
      { id: 'P2', type: 'page', title: 'Beta', url: 'about:blank' }, // nobody attached
      { id: 'W1', type: 'service_worker', title: 'sw', url: 'https://a.test/sw.js' },
      { id: 'B1', type: 'background_page', title: 'ext', url: 'chrome-extension://x' },
    ]
    const cdp = new CdpClient('h:1')
    const pages = await cdp.listPageTargets()
    expect(fetched).toContain('http://h:1/json/list')
    expect(pages).toEqual([
      { targetId: 'P1', type: 'page', title: 'Alpha', url: 'https://a.test/', attached: true },
      { targetId: 'P2', type: 'page', title: 'Beta', url: 'about:blank', attached: false },
    ])
    expect(await cdp.countActivePages()).toBe(1) // about:blank is not activity

    FakeWebSocket.reply = (r) => ({ result: { targetInfo: { targetId: r.params['targetId'], type: 'page', title: 'T', url: 'u', attached: true } } })
    expect((await cdp.getTargetInfo('P1'))?.targetId).toBe('P1')
    expect(await cdp.activateTarget('P1')).toBe(true)
    expect(methods()).toEqual(['Target.getTargetInfo', 'Target.activateTarget'])
    expect(FakeWebSocket.instances[0].sent[0].params).toEqual({ targetId: 'P1' })

    // failures: unknown target -> null / false; unreachable list endpoint -> rejects (no silent empty list)
    FakeWebSocket.reply = () => ({ error: { message: 'gone' } })
    expect(await cdp.getTargetInfo('nope')).toBeNull()
    expect(await cdp.activateTarget('nope')).toBe(false)
    delete routes['/json/list']
    await expect(cdp.listPageTargets()).rejects.toThrow()
  })

  it('[fs-180] reports the browser version or null', async () => {
    const cdp = new CdpClient('h:1')
    expect(await cdp.getVersion()).toEqual({
      browserVersion: 'Chrome/130.0.0.0', protocolVersion: '1.3', userAgent: 'UA/1', jsVersion: '13.0', v8Version: '13.0',
    })
    // histograms, window bounds and command line degrade to empty when the browser says no
    FakeWebSocket.reply = () => ({ error: { message: 'unsupported' } })
    expect(await cdp.getHistograms('Net')).toEqual([])
    expect(await cdp.getHistogram('Net.X')).toBeNull()
    expect(await cdp.getWindowBounds('P1')).toBeNull()
    expect(await cdp.getWindowForTarget('P1')).toBeNull()
    expect(await cdp.getBrowserCommandLine()).toEqual([])
    // and map real answers through
    FakeWebSocket.reply = (r) => {
      if (r.method === 'Browser.getHistograms') return { result: { histograms: [{ name: 'h' }] } }
      if (r.method === 'Browser.getBrowserCommandLine') return { result: { arguments: ['chrome', '--remote-debugging-port=9222'] } }
      return { result: { windowId: 3, bounds: { width: 800 } } }
    }
    expect(await cdp.getHistograms('Net')).toEqual([{ name: 'h' }])
    expect(await cdp.getBrowserCommandLine()).toContain('--remote-debugging-port=9222')
    expect(await cdp.getWindowForTarget('P1')).toMatchObject({ windowId: 3 })
    expect(FakeWebSocket.instances.some((w) => w.sent.some((s) => s.method === 'Browser.getHistograms' && s.params['query'] === 'Net'))).toBe(true)
    // unreachable browser: version is null rather than a throw
    routes = {}
    expect(await cdp.getVersion()).toBeNull()
  })

  it('[fs-181] maps system network and page services', async () => {
    const cdp = new CdpClient('h:1')
    FakeWebSocket.reply = (r) => {
      switch (r.method) {
        case 'SystemInfo.getInfo': return { result: { modelName: 'Mac', gpu: { vendorString: 'Apple' } } } // missing fields default to ''
        case 'SystemInfo.getProcessInfo': return { result: { processInfo: [{ type: 'renderer', id: 7, cpuTime: 1.5 }] } }
        case 'Memory.getDOMCounters': return { result: { documents: 2, nodes: 40 } } // missing counters default to 0
        case 'Network.getCookies': return { result: { cookies: [{ name: 'a' }] } }
        case 'Network.getAllCookies': return { result: { cookies: [{ name: 'a' }, { name: 'b' }] } }
        case 'Page.getMetrics': return { result: { metrics: [{ name: 'Nodes', value: 12 }, { name: 'JSHeapUsedSize', value: 99 }] } }
        default: return { result: {} }
      }
    }
    expect(await cdp.getSystemInfo()).toEqual({
      modelName: 'Mac', modelVersion: '', commandLine: '', gpu: { vendor: 'Apple', device: '', driverVersion: '' },
    })
    expect(await cdp.getProcessInfo()).toEqual([{ type: 'renderer', id: 7, cpuTime: 1.5 }])
    expect(await cdp.getMemoryCounters()).toEqual({ documents: 2, nodes: 40, jsEventListeners: 0, layouts: 0, recalcStyleCount: 0 })
    expect(await cdp.getCookies(['https://a.test'])).toHaveLength(1)
    expect(await cdp.getAllCookies()).toHaveLength(2)
    const metrics = await cdp.getPageMetrics('P1')
    expect(metrics).toMatchObject({ nodes: 12, jsHeapUsedSize: 99, documents: 0, layoutCount: 0 })
    const cookieReq = FakeWebSocket.instances.flatMap((w) => w.sent).find((s) => s.method === 'Network.getCookies')
    expect(cookieReq?.params).toEqual({ urls: ['https://a.test'] })

    // failures degrade to null / [] — never throw
    FakeWebSocket.reply = () => ({ error: { message: 'denied' } })
    expect(await cdp.getSystemInfo()).toBeNull()
    expect(await cdp.getProcessInfo()).toEqual([])
    expect(await cdp.getMemoryCounters()).toBeNull()
    expect(await cdp.getCookies()).toEqual([])
    expect(await cdp.getAllCookies()).toEqual([])
    expect(await cdp.getPageMetrics('P1')).toBeNull()
    expect(await cdp.getNavigationHistory('P1')).toBeNull()
    expect(await cdp.getFrameTree('P1')).toBeNull()
    expect(await cdp.getResourceTree('P1')).toBeNull()
    expect(await cdp.getLayoutMetrics('P1')).toBeNull()
    expect(await cdp.captureScreenshot('P1')).toBeNull()
  })

  it('[fs-182] the CdpClient facade delegates to the services', async () => {
    const dflt = new CdpClient()
    await dflt.getVersion()
    expect(fetched).toEqual(['http://127.0.0.1:9222/json/version']) // default host (fetch is stubbed; nothing real is contacted)
    const cdp = new CdpClient('h:2')
    expect(cdp.target).toBeDefined()
    expect(cdp.browser).toBeDefined()
    expect(cdp.page).toBeDefined()
    expect(cdp.network).toBeDefined()
    expect(cdp.system).toBeDefined()
    FakeWebSocket.reply = (r) => (r.method === 'Page.captureScreenshot' ? { result: { data: 'PNGDATA' } } : { result: { frameTree: { f: 1 } } })
    expect(await cdp.captureScreenshot('P1', 'jpeg')).toBe('PNGDATA')
    expect(await cdp.getFrameTree('P1')).toEqual({ f: 1 })
    expect(await cdp.getResourceTree('P1')).toEqual({ f: 1 })
    const shot = FakeWebSocket.instances.flatMap((w) => w.sent).find((s) => s.method === 'Page.captureScreenshot')
    expect(shot?.params).toEqual({ targetId: 'P1', format: 'jpeg' })
    // every call goes to the configured host
    expect(fetched.filter((u) => u.includes('h:2')).length).toBeGreaterThan(0)
    // stealth: the facade never evaluates script in the page
    expect(methods()).not.toContain('Runtime.evaluate')
  })
})
