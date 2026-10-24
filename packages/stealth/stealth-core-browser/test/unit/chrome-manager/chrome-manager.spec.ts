/**
 * Unit spec for src/lib/chrome-manager.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4] and the
 * chrome-lifecycle composition [chrome-lifecycle.26] (the manager on the ReaperLink port).
 *
 * The Chrome process lifecycle (cdp/browser), CDP (cdp/targets), node:fs (MemFs) and the I/O of
 * @adhd/sox-service-proxy are mocked through the simulated machine of ../lifecycle/manager-world;
 * the reaper host is the real pure `createReaperHost` behind a FakeReaperLink; time is faked.
 * No Chrome, no activity file, no profile, no socket, no signal, and port 9222 is never contacted.
 * guards: counts http and https documents (any case) as active
 * tier: S
 * cites: 8468f7b1 [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4] [chrome-lifecycle.26] [audit-fixes.5]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { ensureChromeRunning } from '../../../src/lib/cdp/browser.js'
import { hideAllWindows } from '../../../src/lib/cdp/targets.js'
import { ChromeManager, isActiveWebTarget, REAP_IF_IDLE_TIMEOUT_MS } from '../../../src/lib/chrome-manager.js'
import { isLifecycleError } from '../../../src/lib/lifecycle/errors.js'
import { ownerRecordPath } from '../../../src/lib/lifecycle/ownership.js'
import type { ReaperLink } from '../../../src/lib/lifecycle/reaper-link.js'
import { client, makeHub } from '../../helpers/lifecycle/manager-clients.js'
import { HOST, IDLE, openPage, PORT, resetSp, resetWorld, STATE_DIR, world } from '../../helpers/lifecycle/manager-world.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
  vi.mocked(ensureChromeRunning).mockClear()
  vi.mocked(hideAllWindows).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 AC2 [tests-unit-core.1] isActiveWebTarget', () => {
  it('counts http and https documents (any case) as active', () => {
    expect(isActiveWebTarget('https://example.com/')).toBe(true)
    expect(isActiveWebTarget('http://example.com/')).toBe(true)
    expect(isActiveWebTarget('HTTPS://EXAMPLE.COM/')).toBe(true)
  })

  it('does not count browser-internal pages (negative)', () => {
    for (const url of ['chrome://newtab/', 'chrome-untrusted://x', 'about:blank', 'devtools://devtools/x', 'chrome-extension://abc/bg.js', '']) {
      expect(isActiveWebTarget(url)).toBe(false)
    }
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] ChromeManager.ready', () => {
  it('ensures Chrome on the cdpHost port, hides windows, records ownership and registers with the reaper', async () => {
    const hub = makeHub()
    const c = client(hub, 11)
    expect(c.manager.isReady).toBe(false)
    await c.manager.ready()
    expect(ensureChromeRunning).toHaveBeenCalledWith({ port: PORT })
    expect(hideAllWindows).toHaveBeenCalledWith(HOST)
    expect(c.manager.isReady).toBe(true)
    expect(JSON.parse(world.fs.readFileSync(ownerRecordPath(STATE_DIR, PORT)))).toMatchObject({ pid: world.nextPid - 1, port: PORT, profileDir: '/profile' })
    expect(hub.host!.clients()).toMatchObject([{ pid: 11, checkHistory: true }])
  })

  it('[audit-fixes.5] P34 the port of a bracketed IPv6 cdpHost is the number after the last colon, not the second colon-separated field', async () => {
    const c = client(makeHub(), 11, { cdpHost: '[::1]:9333' })
    await c.manager.ready()
    expect(ensureChromeRunning).toHaveBeenCalledWith({ port: 9333 })
    expect(hideAllWindows).toHaveBeenCalledWith('[::1]:9333')
  })

  it('[audit-fixes.5] P34 a cdpHost without a valid port falls back to 9222', async () => {
    const c = client(makeHub(), 11, { cdpHost: 'localhost' })
    await c.manager.ready()
    expect(ensureChromeRunning).toHaveBeenCalledWith({ port: 9222 })
  })

  it('takes the fast path (no relaunch, no re-hide) while Chrome is still reachable', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    await c.manager.ready()
    expect(ensureChromeRunning).toHaveBeenCalledTimes(1)
    expect(hideAllWindows).toHaveBeenCalledTimes(1)
  })

  it('self-heals a stale ready: relaunches when Chrome was killed by another process', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    world.chromeUp = false
    await c.manager.ready()
    expect(c.logs.some((l) => l.includes('stale _ready'))).toBe(true)
    expect(ensureChromeRunning).toHaveBeenCalledTimes(2)
    expect(hideAllWindows).toHaveBeenCalledTimes(2)
    expect(c.manager.isReady).toBe(true)
  })

  it('logs and rethrows a typed LAUNCH_FAILED when Chrome cannot be started (error path)', async () => {
    world.launch = 'fail'
    const c = client(makeHub(), 11)
    const err = await c.manager.ready().catch((e: unknown) => e)
    expect(isLifecycleError(err, 'LAUNCH_FAILED')).toBe(true)
    expect((err as Error).message).toContain('Chrome binary not found')
    expect(c.logs.some((l) => l.startsWith('Failed to ensure Chrome running: Chrome binary not found'))).toBe(true)
    expect(c.manager.isReady).toBe(false)
    expect(hideAllWindows).not.toHaveBeenCalled()
  })

  it('logs and rethrows when windows cannot be hidden, leaving the manager not ready', async () => {
    world.failHide = true
    const c = client(makeHub(), 11)
    await expect(c.manager.ready()).rejects.toThrow('Browser.setWindowBounds failed')
    expect(c.logs).toContain('Failed to hide Chrome windows: Browser.setWindowBounds failed')
    expect(c.manager.isReady).toBe(false)
  })

  it('stringifies a non-Error start failure into the typed error', async () => {
    vi.mocked(ensureChromeRunning).mockRejectedValueOnce('plain string')
    const c = client(makeHub(), 11)
    const err = await c.manager.ready().catch((e: unknown) => e)
    expect(isLifecycleError(err, 'LAUNCH_FAILED')).toBe(true)
    expect((err as { cause?: unknown }).cause).toBe('plain string')
    expect(c.logs).toContain('Failed to ensure Chrome running: plain string')
  })

  it('the constructor touches nothing (no state dir, no file, no reaper) until first use', () => {
    const link: ReaperLink = {
      ensureAndHello: vi.fn(async () => true),
      activity: vi.fn(),
      reapIfIdle: vi.fn(async () => null),
      release: vi.fn(async () => undefined),
      status: vi.fn(async () => null),
      isUp: vi.fn(() => false),
      lastError: vi.fn(() => null),
    }
    new ChromeManager({ cdpHost: HOST, stateDir: STATE_DIR, link, logger: () => undefined })
    expect(world.fs.existsSync(STATE_DIR)).toBe(false)
    expect(link.ensureAndHello).not.toHaveBeenCalled()
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] bump and withBrowser', () => {
  it('bump() before ready() is a no-op', () => {
    const c = client(makeHub(), 11)
    c.manager.bump()
    expect(c.link.activityCalls).toBe(0)
  })

  it('bump() after ready() sends activity and pushes the idle deadline out', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    const sent = c.link.activityCalls
    await vi.advanceTimersByTimeAsync(IDLE - 100)
    c.manager.bump()
    expect(c.link.activityCalls).toBe(sent + 1)
    await vi.advanceTimersByTimeAsync(IDLE - 1)
    expect(c.link.reapCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.link.reapCalls).toBe(1)
  })

  it('withBrowser readies Chrome, returns the callback result and bumps afterwards', async () => {
    const c = client(makeHub(), 11)
    const bump = vi.spyOn(c.manager, 'bump')
    await expect(c.manager.withBrowser(async () => 42)).resolves.toBe(42)
    expect(c.manager.isReady).toBe(true)
    expect(bump).toHaveBeenCalledTimes(1)
  })

  it('withBrowser still bumps when the callback throws (error path)', async () => {
    const c = client(makeHub(), 11)
    const bump = vi.spyOn(c.manager, 'bump')
    await expect(c.manager.withBrowser(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(bump).toHaveBeenCalledTimes(1)
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] idle shutdown tiers (evaluated by the reaper host)', () => {
  it('shuts Chrome down after the idle window when nothing is using it', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(false)
    expect(c.manager.isReady).toBe(false)
  })

  it('tier 1: defers to a sibling that bumped within the window, without advertising its own activity', async () => {
    const hub = makeHub()
    const a = client(hub, 11)
    const b = client(hub, 22, { idleTimeoutMs: IDLE * 10 })
    await a.manager.ready()
    await b.manager.ready()
    await vi.advanceTimersByTimeAsync(IDLE / 2)
    b.manager.bump()
    const sent = a.link.activityCalls
    await vi.advanceTimersByTimeAsync(IDLE / 2)
    expect(a.link.reapCalls).toBe(1)
    expect(world.chromeUp).toBe(true)
    expect(a.link.activityCalls).toBe(sent)
  })

  it('tier 1: once the sibling ages out the next idle window shuts down', async () => {
    const hub = makeHub()
    const a = client(hub, 11)
    const b = client(hub, 22, { idleTimeoutMs: IDLE * 10 })
    await a.manager.ready()
    await b.manager.ready()
    await vi.advanceTimersByTimeAsync(IDLE / 2)
    b.manager.bump()
    await vi.advanceTimersByTimeAsync(IDLE / 2) // A fires; deferred: B is fresh
    expect(world.chromeUp).toBe(true)
    await vi.advanceTimersByTimeAsync(IDLE) // A fires again; B has been quiet for longer than the window
    expect(world.chromeUp).toBe(false)
  })

  it('tier 2: defers while a real http(s) page is open; browser-internal pages do not count', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    openPage('https://example.com/')
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(true)
    world.pages = [{ id: 'N', url: 'chrome://newtab/' }]
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(false)
  })

  it('tier 3: defers on recent history; checkHistory:false skips it; an unavailable history DB does not block', async () => {
    world.history = true
    const on = client(makeHub(), 11)
    await on.manager.ready()
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(true)

    resetWorld()
    world.history = true
    const off = client(makeHub(), 22, { checkHistory: false })
    await off.manager.ready()
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(false)

    resetWorld()
    world.history = new Error('SQLITE_CANTOPEN')
    const broken = client(makeHub(), 33)
    await broken.manager.ready()
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(false)
  })

  it('a host that does not answer within the reapIfIdle bound defers (re-arms) instead of hanging', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    vi.spyOn(c.link, 'reapIfIdle').mockImplementation(() => new Promise(() => undefined))
    await vi.advanceTimersByTimeAsync(IDLE + REAP_IF_IDLE_TIMEOUT_MS)
    expect(world.chromeUp).toBe(true)
    expect(c.manager.isReady).toBe(true)
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] shutdown and shutdownIfIdle', () => {
  it('shutdown() is forced: kills Chrome even with an active page and a busy sibling', async () => {
    const hub = makeHub()
    const a = client(hub, 11)
    const b = client(hub, 22)
    await a.manager.ready()
    await b.manager.ready()
    b.manager.bump()
    openPage('https://example.com/')
    await a.manager.shutdown()
    expect(world.events).toContain(`kill:${PORT}`)
    expect(world.chromeUp).toBe(false)
    expect(world.fs.existsSync(ownerRecordPath(STATE_DIR, PORT))).toBe(false)
  })

  it('shutdown() cancels the pending idle timer so it cannot fire a second time', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    await c.manager.shutdown()
    await vi.advanceTimersByTimeAsync(IDLE * 5)
    expect(c.link.reapCalls).toBe(0)
  })

  it('shutdownIfIdle() defers to an open web page and leaves Chrome alone', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    openPage('https://example.com/')
    await c.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(true)
  })

  it('shutdownIfIdle() shuts down when genuinely idle', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    await c.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(false)
    expect(c.manager.isReady).toBe(false)
  })

  it('release() leaves the reaper registry; the process lives on and its next ready() re-registers', async () => {
    const hub = makeHub()
    const c = client(hub, 11)
    await c.manager.ready()
    await c.manager.release()
    expect(hub.host!.clients()).toEqual([])
    expect(c.manager.isReady).toBe(true)
    await c.manager.ready()
    expect(hub.host!.clients().map((x) => x.pid)).toEqual([11])
  })
})
