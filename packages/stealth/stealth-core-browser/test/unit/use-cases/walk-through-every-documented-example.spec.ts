/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.3] [tests-use-cases.4]
 * Exercises AC7 (runnable documentation: every example is executed), PA7.2 (examples import only the package root)
 * and PA7.4 (examples target an explicit port, never the default 9222).
 *
 * A new user follows the README: every example under examples/verbs and examples/namespaces is run against the
 * simulated Chrome, a real-shape profile and the shared CDP traces, and must produce the documented result.
 * guards: [tests-use-cases.4] verbs/chromeStatus reports a running and a missing Chrome
 * tier: S
 * cites: 8468f7b1 [tests-use-cases.1] [tests-use-cases.3] [tests-use-cases.4]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/lib/managers.js', async (orig) => {
  const real = await orig<typeof import('../../../src/lib/managers.js')>()
  return { ...real, managerFor: vi.fn(), shutdownIdleAt: vi.fn() }
})

import { managerFor, shutdownIdleAt } from '../../../src/lib/managers.js'
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
import { run as runEndpoint } from '../../../examples/namespaces/endpoint.js'
import { articleListTrace, captchaWallTrace, pageTraceFor, searchApiTrace, emptyShellHtml } from '../../helpers/page-fixtures.js'
import { ProfileBuilder, type BuiltProfile } from '../../helpers/profile-fixtures.js'
import { ChromeWorld, tempDir, useProfileHome } from '../../helpers/use-cases/scenario-kit.js'

const world = new ChromeWorld(9413)
const noLog = (): void => undefined
let profile: BuiltProfile
let home: ReturnType<typeof useProfileHome>

beforeEach(() => {
  profile = ProfileBuilder.realistic().history([{ url: 'https://docs.test/a', title: 'Docs', secondsAgo: 30, visits: 4 }]).build()
  home = useProfileHome(profile)
  world.up = true
  world.installFetch()
  world.tabs = [world.tab('T1', 'about:blank')]
})
afterEach(() => {
  expect(world.requested.every((u) => new URL(u).port === String(world.port))).toBe(true)
  world.dispose()
  home.restore()
  vi.clearAllMocks()
})

describe('Scenario: follow the README by running every documented verb example', () => {
  it('[tests-use-cases.4] verbs/chromeStatus reports a running and a missing Chrome', async () => {
    expect(await runChromeStatus({ port: world.port, log: noLog })).toEqual({ running: true, version: 'Chrome/150.0.1', protocol: '1.3', managed: false })
    world.up = false
    expect(await runChromeStatus({ port: world.port, log: noLog })).toEqual({ running: false, managed: false })
  })

  it('[tests-use-cases.4] verbs/launchChrome asks the manager of the port to be ready', async () => {
    const ready = vi.fn().mockResolvedValue(undefined)
    vi.mocked(managerFor).mockReturnValue({ ready } as never)
    expect(await runLaunchChrome({ port: world.port, userDataDir: home.profileDir, log: noLog })).toEqual({ ok: true, port: world.port })
    expect(managerFor).toHaveBeenCalledWith('127.0.0.1', world.port, home.profileDir)
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('[tests-use-cases.4] verbs/shutdownChrome reports whether Chrome survived the soft shutdown', async () => {
    vi.mocked(shutdownIdleAt).mockResolvedValue(undefined)
    expect(await runShutdownChrome({ port: world.port, log: noLog })).toEqual({ ok: true, running: true })
    world.up = false
    expect(await runShutdownChrome({ port: world.port, log: noLog })).toEqual({ ok: true, running: false })
  })

  it('[tests-use-cases.4] verbs/listPageTargets finds the tab on a site', async () => {
    world.tabs = [world.tab('T1', 'https://docs.test/a'), world.tab('T2', 'https://other.test/')]
    expect((await runListPageTargets({ port: world.port, urlIncludes: 'docs.test', log: noLog })).map((t) => t.id)).toEqual(['T1'])
  })

  it('[tests-use-cases.4] verbs/checkChromeActivity waits for a person who is browsing', async () => {
    world.tabs = [world.tab('T1', 'https://docs.test/a')]
    const busy = await runCheckChromeActivity({ port: world.port, log: noLog })
    expect(busy.safeToProceed).toBe(false)
    expect(busy.report.lastVisit?.url).toBe('https://docs.test/a')
    world.tabs = [world.tab('T9', 'about:blank')]
    expect((await runCheckChromeActivity({ port: world.port, withinMinutes: 0.0001, log: noLog })).safeToProceed).toBe(true)
  })

  it('[tests-use-cases.4] verbs/getPageContext describes an open tab and reports a missing one', async () => {
    world.useCdp({
      meta: { name: 'page-context', origin: 'synthetic-protocol-conformant' },
      steps: [{ when: { method: 'Target.getTargetInfo', params: { targetId: 'T1' } }, reply: { result: { targetInfo: { targetId: 'T1', type: 'page', title: 'Docs', url: 'https://docs.test/a' } } } }],
    })
    const found = await runGetPageContext({ targetId: 'T1', port: world.port, log: noLog })
    expect(found.context).toMatchObject({ url: 'https://docs.test/a', hasHistory: true, historyVisits: 4 })
    expect(await runGetPageContext({ targetId: 'GONE', port: world.port, log: noLog })).toEqual({ found: false, context: null })
  })
})

describe('Scenario: follow the README by running every documented namespace example', () => {
  it('[tests-use-cases.4] namespaces/cdp inspects a running Chrome over a raw session', async () => {
    world.tabs = [world.tab('T1', 'https://docs.test/a')]
    const server = world.useCdp({ meta: { name: 'page-enable', origin: 'synthetic-protocol-conformant' }, steps: [{ when: { method: 'Page.enable' } }] })
    expect(await runCdp({ port: world.port })).toEqual({ reachable: true, browser: 'Chrome/150.0.1', tabs: [{ id: 'T1', url: 'https://docs.test/a' }], pageDomainEnabled: true })
    expect(server.received.map((c) => c.method)).toEqual(['Page.enable'])
  })

  it('[tests-use-cases.4] namespaces/storage audits tabs, bookmarks and top sites of the real-shape profile', async () => {
    world.tabs = [world.tab('T1', 'https://docs.test/a'), world.tab('T2', 'https://unknown.test/')]
    const audit = await runStorage({ port: world.port, profileDir: home.profileDir, topic: 'docs' })
    expect(audit.tabs).toEqual([{ url: 'https://docs.test/a', visitCount: 4 }, { url: 'https://unknown.test/', visitCount: null }])
    expect(audit.recentVisitUrls[0]).toBe('https://docs.test/a')
    expect(audit.bookmarks).toEqual([{ name: 'API reference', url: 'https://docs.test/api', path: 'Bookmarks bar' }])
    expect(audit.topSites).toEqual([{ url: 'https://docs.test/', title: 'Docs', score: 9 }])
  })

  it('[tests-use-cases.4] namespaces/capture recognises a clean page and a CAPTCHA wall', async () => {
    world.useCdp(articleListTrace())
    expect(await runCapture({ url: 'https://site.test/home', port: world.port })).toMatchObject({ status: 200, ban: null, retry: { shouldRetry: false } })
    world.useCdp(captchaWallTrace())
    const blocked = await runCapture({ url: 'https://site.test/home', port: world.port })
    expect(blocked.ban).toBe('captcha')
    expect(blocked.retry.shouldRetry).toBe(true)
  })

  it('[tests-use-cases.4] namespaces/capture without an open tab fails with the typed CDP_UNREACHABLE', async () => {
    world.tabs = []
    await expect(runCapture({ url: 'https://site.test/home', port: world.port })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
  })

  it('[tests-use-cases.4] namespaces/parsers reads JSON, HTML and falls back to XPath', async () => {
    world.useCdp(searchApiTrace())
    const json = await runParsers({ url: 'https://site.test/home', port: world.port })
    expect(json.parser).toBe('json')
    expect(json.rows.map((r) => r.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
    world.useCdp(articleListTrace())
    const html = await runParsers({ url: 'https://site.test/home', port: world.port })
    expect(html.parser).toBe('html')
    expect(html.rows[0]).toMatchObject({ title: 'Alpha release', url: 'https://a.test/alpha' })
    world.useCdp(pageTraceFor(emptyShellHtml))
    expect(await runParsers({ url: 'https://site.test/home', port: world.port })).toEqual({ parser: 'xpath', rows: [] })
  })

  it('[tests-use-cases.4] namespaces/chromeManager classifies tabs and reports the manager state without launching', async () => {
    const state = tempDir('state')
    try {
      world.tabs = [world.tab('T1', 'https://docs.test/a'), world.tab('T2', 'chrome://newtab/')]
      const out = await runChromeManager({ port: world.port, stateDir: state.dir, tabUrls: ['https://docs.test/a', 'chrome://newtab/', 'about:blank'] })
      expect(out).toEqual({ pinningTabs: ['https://docs.test/a'], reapTimeoutMs: 3_000, ready: false, httpPages: 1, breakerOpen: false })
    } finally {
      state.cleanup()
    }
  })

  it('[tests-use-cases.4] namespaces/lifecycle decides keep or reap by the three idle tiers', () => {
    expect(runLifecycle({ port: world.port, openWebPages: 2 })).toMatchObject({ action: 'keep', pinnedBy: 'page', launchAllowed: true })
    expect(runLifecycle({ port: world.port, recentHistory: true })).toMatchObject({ action: 'keep', pinnedBy: 'history' })
    expect(runLifecycle({ port: world.port }).action).toBe('reap')
  })

  it('[tests-use-cases.4] namespaces/endpoint vets a Chrome address before any connection', () => {
    expect(runEndpoint({ port: world.port })).toMatchObject({ remoteRefusedBefore: 'CDP_UNREACHABLE', remoteAllowedAfter: true, redirectRefused: true, parsedPort: world.port })
  })

  it('[tests-use-cases.4] namespaces/recording stores the exchange with credential headers masked', async () => {
    world.useCdp(pageTraceFor('<html>ok</html>', { requestHeaders: { Cookie: 'sid=secret' } }))
    const out = await runRecording({ url: 'https://site.test/home', port: world.port })
    expect(out.stored).toBe(1)
    expect(out.requestHeaders['Cookie']).toBe(out.mask)
    expect(JSON.stringify(out.requestHeaders)).not.toContain('secret')
  })
})
