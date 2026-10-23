/**
 * Unit spec for the runnable examples under examples/verbs and examples/namespaces.
 * Ticket 8468f7b1 · criteria [prod-examples.1] [prod-examples.2] [prod-examples.4] [prod-examples.5] [prod-examples.6]
 * (PA7.2 every example imports the package root only and typechecks; PA7.4 every example targets port 9333, never the default).
 *
 * Every example's `run()` is executed against the in-process harness: `fetch` answers
 * /json/version and /json/list from a fake Chrome, the `FakeCdpServer` replaces the global
 * WebSocket, the Chrome profile is a throwaway directory under the OS temp dir and the manager
 * seam (`managerFor`, `shutdownIdleAt`) is mocked. No Chrome, no process, no socket, no port 9222.
 * guards: chromeStatus: reports a running Chrome and a missing one
 * tier: S
 * cites: 8468f7b1 [prod-examples.1] [prod-examples.2] [prod-examples.4] [prod-examples.5] [prod-examples.6]
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/lib/managers.js', async (orig) => {
  const real = await orig<typeof import('../../../src/lib/managers.js')>()
  return { ...real, managerFor: vi.fn(), shutdownIdleAt: vi.fn() }
})

import { managerFor, shutdownIdleAt } from '../../../src/lib/managers.js'
import { FakeCdpServer, type CdpFixture } from '../../helpers/fake-cdp.js'
import { fixtureWith } from '../../helpers/capture/capture-kit.js'
import { chromeMicros, makeProfile } from '../../helpers/domains-storage/profile-fixture.js'

import { run as runChromeStatus } from '../../../examples/verbs/chromeStatus.js'
import { run as runLaunchChrome } from '../../../examples/verbs/launchChrome.js'
import { run as runShutdownChrome } from '../../../examples/verbs/shutdownChrome.js'
import { run as runListPageTargets } from '../../../examples/verbs/listPageTargets.js'
import { run as runCheckChromeActivity } from '../../../examples/verbs/checkChromeActivity.js'
import { run as runGetPageContext } from '../../../examples/verbs/getPageContext.js'
import { run as runCdp } from '../../../examples/namespaces/cdp.js'
import { run as runStorage } from '../../../examples/namespaces/storage.js'
import { run as runCapture } from '../../../examples/namespaces/capture.js'
import { run as runParsers } from '../../../examples/namespaces/parsers.js'
import { run as runChromeManager } from '../../../examples/namespaces/chromeManager.js'
import { run as runRecording } from '../../../examples/namespaces/recording.js'
import { run as runLifecycle } from '../../../examples/namespaces/lifecycle.js'

const PORT = 9333
const BROWSER_WS = `ws://127.0.0.1:${PORT}/devtools/browser/B1`

interface FakeTab { id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string }
const tab = (id: string, url: string, title = id): FakeTab => ({ id, type: 'page', url, title, webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/${id}` })

/** The step of a fixture that answers `method`; a missing step is a broken fixture. */
function stepFor(f: CdpFixture, method: string): CdpFixture['steps'][number] {
  const step = f.steps.find((s) => s.when.method === method)
  if (!step) throw new Error(`fixture ${f.meta.name} has no ${method} step`)
  return step
}

/** The fake Chrome behind `fetch`: reachable or not, with a tab list. */
const chrome = { up: true, tabs: [] as FakeTab[], requested: [] as string[] }

let restoreWs: (() => void) | undefined
let server: FakeCdpServer | undefined
let tempDirs: string[] = []
let savedHome: string | undefined

function useCdp(fixture: CdpFixture): FakeCdpServer {
  server = new FakeCdpServer(fixture, { strict: false })
  restoreWs = server.install()
  return server
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `stealth-examples-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

/** Make `os.homedir()` a throwaway directory so the default dedicated profile is a fixture. */
function useHome(): string {
  const home = tempDir('home')
  process.env['HOME'] = home
  const defaultDir = join(home, 'Library', 'Application Support', 'Google', 'Chrome-CDP', 'Default')
  mkdirSync(defaultDir, { recursive: true })
  return defaultDir
}

function writeHistory(defaultDir: string, rows: Array<{ url: string; title: string; visits: number; secondsAgo: number }>): void {
  const d = new DatabaseSync(join(defaultDir, 'History'))
  d.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)')
  d.exec('CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER, from_visit INTEGER, visit_duration INTEGER, opener_visit INTEGER)')
  const now = Date.now() / 1000
  rows.forEach((r, i) => {
    const t = chromeMicros(now - r.secondsAgo)
    d.prepare('INSERT INTO urls VALUES (?,?,?,?,?,?,?)').run(i + 1, r.url, r.title, r.visits, 0, t, 0)
    d.prepare('INSERT INTO visits VALUES (?,?,?,?,?,?,?)').run(i + 1, i + 1, t, 1 | 0x20000000, 0, 1000, 0)
  })
  d.close()
}

beforeEach(() => {
  chrome.up = true
  chrome.tabs = []
  chrome.requested = []
  savedHome = process.env['HOME']
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    chrome.requested.push(url)
    if (!chrome.up) throw new TypeError('fetch failed')
    const u = new URL(url)
    if (u.port !== String(PORT)) throw new Error(`unexpected port ${u.port}`)
    if (u.pathname === '/json/version') {
      return Response.json({ webSocketDebuggerUrl: BROWSER_WS, Browser: 'Chrome/150.0.1', 'Protocol-Version': '1.3', 'User-Agent': 'Mozilla/5.0 Fake' })
    }
    if (u.pathname === '/json/list') return Response.json(chrome.tabs)
    return new Response('not found', { status: 404 })
  })
})

afterEach(() => {
  restoreWs?.()
  restoreWs = undefined
  server = undefined
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  if (savedHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = savedHome
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe('8468f7b1 [prod-examples.6] verb examples (PA7.2, PA7.4)', () => {
  it('chromeStatus: reports a running Chrome and a missing one', async () => {
    const logs: string[] = []
    const up = await runChromeStatus({ port: PORT, log: (l) => logs.push(l) })
    expect(up).toEqual({ running: true, version: 'Chrome/150.0.1', protocol: '1.3', managed: false })
    expect(logs[0]).toContain(`port ${PORT}`)

    chrome.up = false
    const down = await runChromeStatus({ port: PORT, log: (l) => logs.push(l) })
    expect(down).toEqual({ running: false, managed: false })
    expect(logs[1]).toContain('launch Chrome')
  })

  it('launchChrome: asks the manager of the port to be ready with the dedicated profile', async () => {
    const ready = vi.fn().mockResolvedValue(undefined)
    vi.mocked(managerFor).mockReturnValue({ ready } as never)
    const logs: string[] = []
    const result = await runLaunchChrome({ port: PORT, userDataDir: '/tmp/example-profile', log: (l) => logs.push(l) })
    expect(result).toEqual({ ok: true, port: PORT })
    expect(managerFor).toHaveBeenCalledWith('127.0.0.1', PORT, '/tmp/example-profile')
    expect(ready).toHaveBeenCalledTimes(1)
    expect(logs[0]).toContain('/tmp/example-profile')
  })

  it('shutdownChrome: reports whether Chrome survived the soft shutdown', async () => {
    vi.mocked(shutdownIdleAt).mockResolvedValue(undefined)
    const logs: string[] = []
    const kept = await runShutdownChrome({ port: PORT, log: (l) => logs.push(l) })
    expect(shutdownIdleAt).toHaveBeenCalledWith('127.0.0.1', PORT)
    expect(kept).toEqual({ ok: true, running: true })

    chrome.up = false
    const gone = await runShutdownChrome({ port: PORT, log: (l) => logs.push(l) })
    expect(gone).toEqual({ ok: true, running: false })
    expect(logs).toEqual([expect.stringContaining('still in use'), expect.stringContaining('was shut down')])
  })

  it('listPageTargets: finds the tab on a site and drops non-page targets', async () => {
    chrome.tabs = [tab('T1', 'https://docs.test/a'), tab('T2', 'https://other.test/'), { id: 'SW', type: 'service_worker', url: 'https://docs.test/sw.js', title: 'sw' }]
    const logs: string[] = []
    const found = await runListPageTargets({ port: PORT, urlIncludes: 'docs.test', log: (l) => logs.push(l) })
    expect(found.map((t) => t.id)).toEqual(['T1'])
    expect(logs).toEqual(['T1  https://docs.test/a'])
    expect((await runListPageTargets({ port: PORT, log: () => undefined })).map((t) => t.id)).toEqual(['T1', 'T2'])
  })

  it('checkChromeActivity: waits for a person who is browsing and proceeds when Chrome is idle', async () => {
    const defaultDir = useHome()
    writeHistory(defaultDir, [{ url: 'https://docs.test/a', title: 'Docs', visits: 4, secondsAgo: 30 }])
    chrome.tabs = [tab('T1', 'https://docs.test/a')]
    const busy = await runCheckChromeActivity({ port: PORT, log: () => undefined })
    expect(busy.safeToProceed).toBe(false)
    expect(busy.report.activePages).toBe(1)
    expect(busy.report.recentlyUsed).toBe(true)
    expect(busy.report.lastVisit?.url).toBe('https://docs.test/a')

    chrome.tabs = [tab('T9', 'about:blank')]
    const idle = await runCheckChromeActivity({ port: PORT, withinMinutes: 0.001, log: () => undefined })
    expect(idle.safeToProceed).toBe(true)
    expect(idle.report.activePages).toBe(0)
  })

  it('getPageContext: describes an open tab from CDP, the cookie jar and history, and reports a missing tab', async () => {
    const defaultDir = useHome()
    writeHistory(defaultDir, [{ url: 'https://docs.test/a', title: 'Docs', visits: 4, secondsAgo: 30 }])
    useCdp({
      meta: { name: 'page-context', origin: 'synthetic-protocol-conformant' },
      steps: [{
        when: { method: 'Target.getTargetInfo', params: { targetId: 'T1' } },
        reply: { result: { targetInfo: { targetId: 'T1', type: 'page', title: 'Docs', url: 'https://docs.test/a' } } },
      }],
    })
    const logs: string[] = []
    const found = await runGetPageContext({ targetId: 'T1', port: PORT, log: (l) => logs.push(l) })
    expect(found.found).toBe(true)
    expect(found.context).toMatchObject({ targetId: 'T1', url: 'https://docs.test/a', title: 'Docs', hasHistory: true, historyVisits: 4 })
    expect(logs[0]).toContain('Docs <https://docs.test/a>')

    const missing = await runGetPageContext({ targetId: 'GONE', port: PORT, log: (l) => logs.push(l) })
    expect(missing).toEqual({ found: false, context: null })
    expect(logs[1]).toContain('no longer exists')
  })
})

describe('8468f7b1 [prod-examples.6] namespace examples (PA7.2, PA7.4)', () => {
  it('cdp: inspects a running Chrome and enables the Page domain over a raw session', async () => {
    chrome.tabs = [tab('T1', 'https://docs.test/a')]
    const cdpServer = useCdp({ meta: { name: 'page-enable', origin: 'synthetic-protocol-conformant' }, steps: [{ when: { method: 'Page.enable' } }] })
    const out = await runCdp({ port: PORT })
    expect(out).toEqual({ reachable: true, browser: 'Chrome/150.0.1', tabs: [{ id: 'T1', url: 'https://docs.test/a' }], pageDomainEnabled: true })
    expect(cdpServer.received.map((c) => c.method)).toEqual(['Page.enable'])

    chrome.up = false
    expect(await runCdp({ port: PORT })).toEqual({ reachable: false, tabs: [], pageDomainEnabled: false })
  })

  it('storage: audits the open tabs, bookmarks and top sites of a profile read-only', async () => {
    const fx = makeProfile()
    tempDirs.push(fx.root)
    writeHistory(fx.defaultDir, [
      { url: 'https://docs.test/a', title: 'Docs', visits: 4, secondsAgo: 60 },
      { url: 'https://news.test/', title: 'News', visits: 1, secondsAgo: 600 },
    ])
    fx.json('Bookmarks', { roots: { bookmark_bar: { id: '1', name: 'Bar', type: 'folder', children: [{ id: '2', name: 'API docs', type: 'url', url: 'https://docs.test/api' }] } } })
    const top = fx.db('Top Sites', ['CREATE TABLE top_sites (url TEXT, title TEXT, url_rank INTEGER)'])
    top.prepare('INSERT INTO top_sites VALUES (?,?,?)').run('https://docs.test/', 'Docs', 9)
    top.close()
    chrome.tabs = [tab('T1', 'https://docs.test/a'), tab('T2', 'https://unknown.test/')]

    const audit = await runStorage({ port: PORT, profileDir: fx.root, topic: 'docs' })
    expect(audit.tabs).toEqual([{ url: 'https://docs.test/a', visitCount: 4 }, { url: 'https://unknown.test/', visitCount: null }])
    expect(audit.recentVisitUrls).toEqual(['https://docs.test/a', 'https://news.test/'])
    expect(audit.bookmarks).toEqual([{ name: 'API docs', url: 'https://docs.test/api', path: 'Bar' }])
    expect(audit.topSites).toEqual([{ url: 'https://docs.test/', title: 'Docs', score: 9 }])
  })

  it('capture: captures a page load, finds no ban and advises no retry', async () => {
    chrome.tabs = [tab('T1', 'about:blank')]
    useCdp(fixtureWith('doc-200', () => undefined))
    const report = await runCapture({ url: 'https://site.test/home', port: PORT })
    expect(report).toMatchObject({ status: 200, ban: null, retry: { shouldRetry: false } })
    expect(report.bytes).toBeGreaterThan(0)
  })

  it('capture: a CAPTCHA wall is recognised and a retry with backoff is advised', async () => {
    chrome.tabs = [tab('T1', 'about:blank')]
    useCdp(fixtureWith('doc-200', (f) => {
      stepFor(f, 'Network.getResponseBody').reply = { result: { body: '<html>Our systems have detected unusual traffic</html>', base64Encoded: false } }
    }))
    const report = await runCapture({ url: 'https://site.test/home', port: PORT })
    expect(report.ban).toBe('captcha')
    expect(report.retry.shouldRetry).toBe(true)
    expect(report.retry.delayMs).toBeGreaterThan(0)
  })

  it('capture: without an open tab it fails with a typed CDP_UNREACHABLE', async () => {
    await expect(runCapture({ url: 'https://site.test/home', port: PORT })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
  })

  it('parsers: reads a JSON API response, an HTML page and falls back to XPath', async () => {
    chrome.tabs = [tab('T1', 'about:blank')]
    const withBody = (text: string): CdpFixture => fixtureWith('doc-200', (f) => {
      stepFor(f, 'Network.getResponseBody').reply = { result: { body: text, base64Encoded: false } }
    })

    useCdp(withBody(JSON.stringify({ items: [{ name: 'Alpha', href: 'https://a.test/', summary: 'first' }, { name: 'Beta', href: 'https://b.test/', summary: 'second' }] })))
    const json = await runParsers({ url: 'https://site.test/home', port: PORT })
    expect(json.parser).toBe('json')
    expect(json.rows.map((r) => r.title)).toEqual(['Alpha', 'Beta'])
    restoreWs?.()

    useCdp(withBody('<html><body><article><h2>Gamma</h2><a href="https://g.test/">go</a><p>third</p></article></body></html>'))
    const html = await runParsers({ url: 'https://site.test/home', port: PORT })
    expect(html.parser).toBe('html')
    expect(html.rows[0]).toMatchObject({ title: 'Gamma', url: 'https://g.test/', snippet: 'third' })
    restoreWs?.()

    useCdp(withBody('<html><body><p>nothing structured here</p></body></html>'))
    const none = await runParsers({ url: 'https://site.test/home', port: PORT })
    expect(none).toEqual({ parser: 'xpath', rows: [] })
  })

  it('chromeManager: classifies tabs and reports the manager state without launching Chrome', async () => {
    chrome.tabs = [tab('T1', 'https://docs.test/a'), tab('T2', 'chrome://newtab/')]
    const out = await runChromeManager({ port: PORT, stateDir: tempDir('state'), tabUrls: ['https://docs.test/a', 'chrome://newtab/', 'about:blank'] })
    expect(out).toEqual({ pinningTabs: ['https://docs.test/a'], reapTimeoutMs: 3_000, ready: false, httpPages: 1, breakerOpen: false })
    expect(chrome.requested.every((u) => u.includes(`:${PORT}/`))).toBe(true)
  })

  it('lifecycle: a web page keeps Chrome alive, idle Chrome may be reaped, and the breaker allows a launch', () => {
    expect(runLifecycle({ port: PORT, openWebPages: 2 })).toMatchObject({ action: 'keep', pinnedBy: 'page', launchAllowed: true })
    expect(runLifecycle({ port: PORT, recentHistory: true })).toMatchObject({ action: 'keep', pinnedBy: 'history' })
    const idle = runLifecycle({ port: PORT })
    expect(idle.action).toBe('reap')
    expect(idle.stateDir).toContain(`-${PORT}`)
  })

  it('recording: stores the exchange with credential headers masked', async () => {
    chrome.tabs = [tab('T1', 'about:blank')]
    useCdp(fixtureWith('doc-200', (f) => {
      const sent = (stepFor(f, 'Page.navigate').emit ?? []).find((e) => e.method === 'Network.requestWillBeSent')
      if (!sent) throw new Error('fixture has no requestWillBeSent event')
      ;(sent.params['request'] as { headers: Record<string, string> }).headers['Cookie'] = 'session=secret'
    }))
    const out = await runRecording({ url: 'https://site.test/home', port: PORT })
    expect(out.stored).toBe(1)
    expect(out.requestHeaders['Cookie']).toBe(out.mask)
    expect(out.mask).toBe('[REDACTED]')
    expect(JSON.stringify(out.requestHeaders)).not.toContain('secret')
  })
})

describe('8468f7b1 [prod-examples.4] examples never touch the default port (PA7.4)', () => {
  it('every request the examples made went to the explicit example port', async () => {
    chrome.tabs = [tab('T1', 'https://docs.test/a')]
    await runChromeStatus({ port: PORT, log: () => undefined })
    await runListPageTargets({ port: PORT, log: () => undefined })
    expect(chrome.requested.length).toBeGreaterThan(0)
    expect(chrome.requested.every((u) => new URL(u).port === String(PORT))).toBe(true)
  })
})
