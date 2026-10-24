/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3] [tests-use-cases.4]
 * Exercises AC5 (the three idle-safety tiers: other clients, open web pages, history recency),
 * PA6.1 (soft shutdown never kills a Chrome in use) and PA6.2 (activity report before touching Chrome).
 *
 * An automation job shares a Chrome with a human. Before it closes Chrome it asks whether the person is still
 * browsing; the soft shutdown defers to an open web page, to another client and to a recent history visit, and
 * only closes Chrome once the browser is genuinely idle.
 * guards: [tests-use-cases.2] launchChrome starts the managed Chrome once and chromeStatus reports it as managed
 * tier: S
 * cites: 8468f7b1 [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3] [tests-use-cases.4]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const machine = vi.hoisted(() => ({
  spawn: undefined as undefined | ((c: string, a: string[], o: Record<string, unknown>) => unknown),
  manager: undefined as undefined | import('../../../src/lib/chrome-manager.js').ChromeManager,
}))
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return { ...real, spawn: (c: string, a: string[], o: Record<string, unknown>) => machine.spawn?.(c, a, o), execSync: () => '/usr/bin/stand-in-browser\n' }
})
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return { ...real, existsSync: (p: string) => /MacOS\/Google Chrome$|stand-in-browser$/.test(String(p)) || real.existsSync(p) }
})
vi.mock('../../../src/lib/managers.js', async (orig) => {
  const real = await orig<typeof import('../../../src/lib/managers.js')>()
  return {
    ...real,
    managerFor: () => machine.manager,
    shutdownIdleAt: async () => machine.manager?.shutdownIfIdle(),
    isManagedAt: () => machine.manager?.isReady ?? false,
    noteManagerActivity: () => machine.manager?.bump(),
  }
})

import { chromeManager, checkChromeActivity, chromeStatus, launchChrome, lifecycle, shutdownChrome, storage } from '../../../src/index.js'
import { FakeProc } from '../../helpers/fake-proc.js'
import { ProfileBuilder, type BuiltProfile } from '../../helpers/profile-fixtures.js'
import { ChromeWorld, PolicyReaperLink, makeLaunchRig, tempDir, useProfileHome } from '../../helpers/use-cases/scenario-kit.js'
import { must } from '../../helpers/must.js'

const world = new ChromeWorld(9408)
let state: ReturnType<typeof tempDir>
let home: ReturnType<typeof useProfileHome>
let link: PolicyReaperLink
let profile: BuiltProfile
let personBrowsing: boolean

beforeEach(() => {
  const now = Date.now() / 1000
  personBrowsing = true
  profile = new ProfileBuilder(now).history([{ url: 'https://docs.test/guide', title: 'Guide', secondsAgo: 20 }]).build()
  home = useProfileHome(profile)
  state = tempDir('idle')
  world.up = false
  world.tabs = []
  world.installFetch()
  world.useCdp({ meta: { name: 'window-hiding', origin: 'synthetic-protocol-conformant' }, steps: [] })
  const rig = makeLaunchRig(new FakeProc(8000), world)
  machine.spawn = (c, a, o) => rig.spawn(c, a, o)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  link = new PolicyReaperLink(world, () => (personBrowsing ? new storage.HistoryClient(home.profileDir).isRecentlyUsed(2) : false))
  machine.manager = new chromeManager.ChromeManager({
    cdpHost: `127.0.0.1:${world.port}`, keepAlive: true, stateDir: state.dir, userDataDir: home.profileDir, link, logger: () => undefined,
  })
})
afterEach(() => {
  world.dispose()
  state.cleanup()
  home.restore()
  vi.restoreAllMocks()
})

describe('Scenario: keep a shared Chrome open while a person is browsing and close it only when idle', () => {
  it('[tests-use-cases.2] launchChrome starts the managed Chrome once and chromeStatus reports it as managed', async () => {
    expect(await chromeStatus({ port: world.port })).toEqual({ running: false, managed: false })
    expect(await launchChrome({ port: world.port, userDataDir: home.profileDir })).toEqual({ ok: true, port: world.port })
    const status = await chromeStatus({ port: world.port })
    expect(status).toMatchObject({ running: true, version: 'Chrome/150.0.1', managed: true })
    await launchChrome({ port: world.port, userDataDir: home.profileDir })
    expect(link.activities).toBe(2) // one activity per launchChrome call: exactly two calls were made
  })

  it('[tests-use-cases.2] checkChromeActivity tells the job a person is on the page and recently visited it', async () => {
    world.up = true
    world.tabs = [world.tab('T1', 'https://docs.test/guide', 'Guide')]
    const report = await checkChromeActivity({ port: world.port })
    expect(report.activePages).toBe(1)
    expect(report.recentlyUsed).toBe(true)
    expect(report.lastVisit).toMatchObject({ url: 'https://docs.test/guide' })
    expect(typeof report.lastVisit?.visitTime).toBe('string')
  })

  it('[tests-use-cases.2] shutdownChrome defers to an open web page, then to recent history, then closes an idle Chrome', async () => {
    await launchChrome({ port: world.port, userDataDir: home.profileDir })

    world.tabs = [world.tab('T1', 'https://docs.test/guide')]
    expect(await shutdownChrome({ port: world.port })).toEqual({ ok: true, running: true })
    expect(link.lastDecision()).toMatchObject({ action: 'keep', pinnedBy: 'page', reaped: false })

    world.tabs = [world.tab('T2', 'about:blank'), world.tab('T3', 'chrome://newtab/')]
    expect(await shutdownChrome({ port: world.port })).toEqual({ ok: true, running: true })
    expect(link.lastDecision()).toMatchObject({ action: 'keep', pinnedBy: 'history' })

    personBrowsing = false
    expect(await shutdownChrome({ port: world.port })).toEqual({ ok: true, running: false })
    expect(link.lastDecision()).toMatchObject({ action: 'reap', reaped: true })
    expect(machine.manager?.isReady).toBe(false)
  })

  it('[tests-use-cases.2] another active client keeps Chrome open even when no page and no history pins it', async () => {
    personBrowsing = false
    const sibling: lifecycle.ClientView = { id: 'other-agent', pid: 4242, checkHistory: false, lastActivityAt: Date.now() - 5_000 }
    link = new PolicyReaperLink(world, () => false, () => [sibling])
    machine.manager = new chromeManager.ChromeManager({ cdpHost: `127.0.0.1:${world.port}`, keepAlive: true, stateDir: state.dir, userDataDir: home.profileDir, link, logger: () => undefined })
    await launchChrome({ port: world.port, userDataDir: home.profileDir })
    expect(await shutdownChrome({ port: world.port })).toEqual({ ok: true, running: true })
    expect(link.lastDecision()).toMatchObject({ action: 'keep', pinnedBy: 'client' })
  })

  it('[tests-use-cases.2] the manager status reports pages, the reaper link and a closed launch breaker', async () => {
    await launchChrome({ port: world.port, userDataDir: home.profileDir })
    world.tabs = [world.tab('T1', 'https://docs.test/guide')]
    const status = await must(machine.manager).status()
    expect(status).toMatchObject({ ready: true, owned: true, httpPages: 1, reaper: true, breaker: { open: false } })
    expect(chromeManager.isActiveWebTarget('https://docs.test/guide')).toBe(true)
    expect(chromeManager.isActiveWebTarget('chrome://newtab/')).toBe(false)
  })

  it('[tests-use-cases.2] an idle manager asks the reaper to close Chrome by itself when its idle timer fires', async () => {
    vi.useFakeTimers()
    try {
      personBrowsing = false
      machine.manager = new chromeManager.ChromeManager({ cdpHost: `127.0.0.1:${world.port}`, idleTimeoutMs: 1_000, stateDir: state.dir, userDataDir: home.profileDir, link, logger: () => undefined })
      const starting = machine.manager.ready()
      await vi.advanceTimersByTimeAsync(300)
      await starting
      expect(world.up).toBe(true)
      await vi.advanceTimersByTimeAsync(1_500)
      expect(world.up).toBe(false)
      expect(link.lastDecision()).toMatchObject({ reaped: true })
    } finally {
      vi.useRealTimers()
    }
  })
})
