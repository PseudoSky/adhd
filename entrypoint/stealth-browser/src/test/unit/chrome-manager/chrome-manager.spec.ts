/**
 * Unit spec for src/lib/chrome-manager.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4].
 * Chrome lifecycle (cdp/browser, cdp/targets), the target and history services and node:fs are mocked,
 * process.kill is spied and time is faked: no Chrome, no heartbeat file, no profile, no signals.
 * The real IdleShutdown drives the idle-shutdown tiers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  ensureChromeRunning: vi.fn(),
  killChrome: vi.fn(),
  closeAllPageTargets: vi.fn(),
  hideAllWindows: vi.fn(),
  isChromeReachable: vi.fn(),
  listPageTargets: vi.fn(),
  isRecentlyUsed: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}))

vi.mock('../../../lib/cdp/browser.js', () => ({
  ensureChromeRunning: m.ensureChromeRunning,
  killChrome: m.killChrome,
}))
vi.mock('../../../lib/cdp/targets.js', () => ({
  closeAllPageTargets: m.closeAllPageTargets,
  hideAllWindows: m.hideAllWindows,
  isChromeReachable: m.isChromeReachable,
}))
vi.mock('../../../lib/domains/target.js', () => ({
  TargetService: class {
    listPageTargets = m.listPageTargets
  },
}))
vi.mock('../../../lib/storage/history.js', () => ({
  HistoryClient: class {
    isRecentlyUsed = m.isRecentlyUsed
  },
}))
vi.mock('node:fs', () => ({ writeFileSync: m.writeFileSync, readFileSync: m.readFileSync }))

import { ChromeManager, isActiveWebTarget } from '../../../lib/chrome-manager.js'
import type { ChromeManagerOptions } from '../../../lib/chrome-manager.js'

const HOST = '127.0.0.1:9333'
const HB = '/fake/heartbeat'
const T0 = 1_700_000_000_000
const OTHER = 99991
const DEAD = 99992

let logs: string[]
let alive: Set<number>
let heartbeatFile: string | null

function make(opts: ChromeManagerOptions = {}): ChromeManager {
  return new ChromeManager({
    cdpHost: HOST,
    idleTimeoutMs: 1000,
    heartbeatPath: HB,
    logger: (msg) => logs.push(msg),
    ...opts,
  })
}

function heartbeatWrites(): string[] {
  return m.writeFileSync.mock.calls.map((c) => String(c[1]))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  for (const fn of Object.values(m)) fn.mockReset()
  logs = []
  alive = new Set([OTHER])
  heartbeatFile = null
  m.ensureChromeRunning.mockResolvedValue({ pid: null, port: 9333, profileDir: '/fake/profile' })
  m.killChrome.mockResolvedValue(undefined)
  m.closeAllPageTargets.mockResolvedValue(undefined)
  m.hideAllWindows.mockResolvedValue(undefined)
  m.isChromeReachable.mockResolvedValue(true)
  m.listPageTargets.mockResolvedValue([])
  m.isRecentlyUsed.mockReturnValue(false)
  m.readFileSync.mockImplementation(() => {
    if (heartbeatFile === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return heartbeatFile
  })
  // Fully replaced: no real process is ever signalled.
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0 && !alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    return true
  }) as typeof process.kill)
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
  it('ensures Chrome on the cdpHost port, hides windows, becomes ready and writes the heartbeat', async () => {
    const cm = make()
    expect(cm.isReady).toBe(false)
    await cm.ready()
    expect(m.ensureChromeRunning).toHaveBeenCalledWith({ port: 9333 })
    expect(m.hideAllWindows).toHaveBeenCalledWith(HOST)
    expect(cm.isReady).toBe(true)
    expect(m.writeFileSync).toHaveBeenCalledWith(HB, `${process.pid}:${T0}\n`, 'utf8')
    await cm.shutdownIfIdle()
  })

  it('takes the fast path (no relaunch, no re-hide) while Chrome is still reachable', async () => {
    const cm = make()
    await cm.ready()
    await cm.ready()
    expect(m.ensureChromeRunning).toHaveBeenCalledTimes(1)
    expect(m.hideAllWindows).toHaveBeenCalledTimes(1)
    expect(m.isChromeReachable).toHaveBeenCalledWith(HOST)
    expect(m.writeFileSync).toHaveBeenCalledTimes(2)
  })

  it('self-heals a stale _ready: relaunches when Chrome was killed by another process', async () => {
    const cm = make()
    await cm.ready()
    m.isChromeReachable.mockResolvedValue(false)
    await cm.ready()
    expect(logs.some((l) => l.includes('stale _ready'))).toBe(true)
    expect(m.ensureChromeRunning).toHaveBeenCalledTimes(2)
    expect(m.hideAllWindows).toHaveBeenCalledTimes(2)
    expect(cm.isReady).toBe(true)
  })

  it('logs and rethrows when Chrome cannot be started (error path)', async () => {
    m.ensureChromeRunning.mockRejectedValue(new Error('no binary'))
    const cm = make()
    await expect(cm.ready()).rejects.toThrow('no binary')
    expect(logs).toContain('Failed to ensure Chrome running: no binary')
    expect(cm.isReady).toBe(false)
    expect(m.hideAllWindows).not.toHaveBeenCalled()
  })

  it('logs and rethrows when windows cannot be hidden, leaving the manager not ready', async () => {
    m.hideAllWindows.mockRejectedValue(new Error('cdp gone'))
    const cm = make()
    await expect(cm.ready()).rejects.toThrow('cdp gone')
    expect(logs).toContain('Failed to hide Chrome windows: cdp gone')
    expect(cm.isReady).toBe(false)
  })

  it('stringifies a non-Error start failure', async () => {
    m.ensureChromeRunning.mockRejectedValue('plain string')
    await expect(make().ready()).rejects.toBe('plain string')
    expect(logs).toContain('Failed to ensure Chrome running: plain string')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] heartbeat file', () => {
  it('defaults to the shared /tmp/stealth-browser-heartbeat path', async () => {
    const cm = new ChromeManager({ cdpHost: HOST, idleTimeoutMs: 1000, logger: (m2) => logs.push(m2) })
    await cm.ready()
    expect(m.writeFileSync.mock.calls[0][0]).toBe('/tmp/stealth-browser-heartbeat')
    await cm.shutdownIfIdle()
  })

  it('merges live sibling pids with our own entry', async () => {
    heartbeatFile = `${OTHER}:${T0 - 50}\n`
    const cm = make()
    await cm.ready()
    expect(heartbeatWrites()[0]).toBe(`${OTHER}:${T0 - 50}\n${process.pid}:${T0}\n`)
  })

  it('drops dead pids and skips malformed lines (negative)', async () => {
    heartbeatFile = [`${DEAD}:${T0}`, 'garbage', 'a:b', ':5', `${OTHER}:${T0}`].join('\n')
    const cm = make()
    await cm.ready()
    const written = heartbeatWrites()[0]
    expect(written).not.toContain(String(DEAD))
    expect(written).not.toContain('garbage')
    expect(written).toContain(`${OTHER}:${T0}`)
  })

  it('treats a heartbeat write failure as best effort', async () => {
    m.writeFileSync.mockImplementation(() => {
      throw new Error('EACCES')
    })
    const cm = make()
    await expect(cm.ready()).resolves.toBeUndefined()
    expect(cm.isReady).toBe(true)
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] bump and withBrowser', () => {
  it('bump() before ready() is a no-op', () => {
    make().bump()
    expect(m.writeFileSync).not.toHaveBeenCalled()
  })

  it('bump() after ready() writes the heartbeat and pushes the idle deadline out', async () => {
    const cm = make()
    await cm.ready()
    m.writeFileSync.mockClear()
    await vi.advanceTimersByTimeAsync(900)
    cm.bump()
    expect(m.writeFileSync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(900)
    expect(m.killChrome).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(m.killChrome).toHaveBeenCalledTimes(1)
  })

  it('withBrowser readies Chrome, returns the callback result and bumps afterwards', async () => {
    const cm = make()
    const result = await cm.withBrowser(async () => 'value')
    expect(result).toBe('value')
    expect(m.ensureChromeRunning).toHaveBeenCalledTimes(1)
    expect(m.writeFileSync).toHaveBeenCalledTimes(2)
    await cm.shutdownIfIdle()
  })

  it('withBrowser still bumps when the callback throws (error path)', async () => {
    const cm = make()
    await expect(cm.withBrowser(async () => { throw new Error('page crashed') })).rejects.toThrow('page crashed')
    expect(m.writeFileSync).toHaveBeenCalledTimes(2)
    await cm.shutdownIfIdle()
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] idle shutdown tiers', () => {
  it('shuts Chrome down after the idle window when nothing is using it', async () => {
    const cm = make()
    await cm.ready()
    await vi.advanceTimersByTimeAsync(999)
    expect(m.killChrome).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(m.closeAllPageTargets).toHaveBeenCalledWith(HOST)
    expect(m.killChrome).toHaveBeenCalledWith(9333)
    expect(cm.isReady).toBe(false)
    expect(logs).toContain('shutting down...')
  })

  it('after a real shutdown bump() is a no-op and ready() arms a fresh idle timer', async () => {
    const cm = make()
    await cm.ready()
    await vi.advanceTimersByTimeAsync(1000)
    m.writeFileSync.mockClear()
    cm.bump()
    expect(m.writeFileSync).not.toHaveBeenCalled()
    await cm.ready()
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.killChrome).toHaveBeenCalledTimes(2)
  })

  it('tier 1: defers to a sibling that bumped within the window, WITHOUT stamping our own heartbeat', async () => {
    const cm = make()
    await cm.ready()
    heartbeatFile = `${OTHER}:${T0 + 500}\n`
    const writesBefore = m.writeFileSync.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.killChrome).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes(`pid ${OTHER} active`) && l.includes('deferring'))).toBe(true)
    // Anti-livelock invariant: deferral re-arms but never advertises activity.
    expect(m.writeFileSync.mock.calls.length).toBe(writesBefore)
  })

  it('tier 1: once the sibling heartbeat ages out the next idle window shuts down', async () => {
    const cm = make()
    await cm.ready()
    heartbeatFile = `${OTHER}:${T0 + 500}\n`
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.killChrome).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.killChrome).toHaveBeenCalledTimes(1)
  })

  it('tier 1: our own pid in the heartbeat never counts as another process', async () => {
    const cm = make()
    await cm.ready()
    heartbeatFile = `${process.pid}:${T0 + 500}\n`
    alive.add(process.pid)
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.killChrome).toHaveBeenCalledTimes(1)
  })

  it('tier 2: defers while a real http(s) page is open', async () => {
    m.listPageTargets.mockResolvedValue([
      { targetId: 'a', type: 'page', title: 'x', url: 'https://example.com/', attached: true },
    ])
    const cm = make()
    await cm.ready()
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.killChrome).not.toHaveBeenCalled()
    expect(logs).toContain('1 active page(s) found — Chrome in use')
    expect(cm.isReady).toBe(true)
  })

  it('tier 2: browser-internal pages (newtab, about:blank) do not keep Chrome alive', async () => {
    m.listPageTargets.mockResolvedValue([
      { targetId: 'a', type: 'page', title: '', url: 'chrome://newtab/', attached: true },
      { targetId: 'b', type: 'page', title: '', url: 'about:blank', attached: true },
      { targetId: 'c', type: 'page', title: '', url: '', attached: true },
    ])
    const cm = make()
    await cm.ready()
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.killChrome).toHaveBeenCalledTimes(1)
  })

  it('tier 2: an unreachable CDP target list does not block shutdown', async () => {
    m.listPageTargets.mockRejectedValue(new Error('refused'))
    const cm = make()
    await cm.ready()
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.killChrome).toHaveBeenCalledTimes(1)
  })

  it('tier 3: defers when Chrome history shows recent visits', async () => {
    m.isRecentlyUsed.mockReturnValue(true)
    const cm = make()
    await cm.ready()
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.isRecentlyUsed).toHaveBeenCalledWith(2)
    expect(m.killChrome).not.toHaveBeenCalled()
    expect(logs).toContain('recent history activity found — Chrome in use')
  })

  it('tier 3: checkHistory:false skips the history probe entirely', async () => {
    m.isRecentlyUsed.mockReturnValue(true)
    const cm = make({ checkHistory: false })
    await cm.ready()
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.isRecentlyUsed).not.toHaveBeenCalled()
    expect(m.killChrome).toHaveBeenCalledTimes(1)
  })

  it('tier 3: an unavailable history DB does not block shutdown', async () => {
    m.isRecentlyUsed.mockImplementation(() => {
      throw new Error('unable to open database file')
    })
    const cm = make()
    await cm.ready()
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.killChrome).toHaveBeenCalledTimes(1)
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] shutdown and shutdownIfIdle', () => {
  it('shutdown() is forced: kills Chrome even with an active page and a busy sibling', async () => {
    m.listPageTargets.mockResolvedValue([{ targetId: 'a', type: 'page', title: '', url: 'https://example.com/', attached: true }])
    heartbeatFile = `${OTHER}:${T0 + 500}\n`
    const cm = make()
    await cm.ready()
    await cm.shutdown()
    expect(m.listPageTargets).not.toHaveBeenCalled()
    expect(m.closeAllPageTargets).toHaveBeenCalledWith(HOST)
    expect(m.killChrome).toHaveBeenCalledWith(9333)
    expect(cm.isReady).toBe(false)
  })

  it('shutdown() cancels the pending idle timer so it cannot fire a second time', async () => {
    const cm = make()
    await cm.ready()
    await cm.shutdown()
    await vi.advanceTimersByTimeAsync(5000)
    expect(m.killChrome).toHaveBeenCalledTimes(1)
  })

  it('shutdown() works before ready() (no idle timer yet)', async () => {
    const cm = make()
    await cm.shutdown()
    expect(m.killChrome).toHaveBeenCalledWith(9333)
  })

  it('shutdownIfIdle() defers to an open web page and leaves Chrome alone', async () => {
    m.listPageTargets.mockResolvedValue([{ targetId: 'a', type: 'page', title: '', url: 'https://example.com/', attached: true }])
    const cm = make()
    await cm.ready()
    await cm.shutdownIfIdle()
    expect(m.killChrome).not.toHaveBeenCalled()
    expect(cm.isReady).toBe(true)
  })

  it('shutdownIfIdle() shuts down when genuinely idle', async () => {
    const cm = make()
    await cm.ready()
    await cm.shutdownIfIdle()
    expect(m.killChrome).toHaveBeenCalledTimes(1)
    expect(cm.isReady).toBe(false)
  })

  it('keeps going and logs when closing page targets fails (error path)', async () => {
    m.closeAllPageTargets.mockRejectedValue(new Error('cdp gone'))
    const cm = make()
    await cm.ready()
    await cm.shutdown()
    expect(logs).toContain('Failed to close page targets during shutdown: cdp gone')
    expect(m.killChrome).toHaveBeenCalledTimes(1)
    expect(cm.isReady).toBe(false)
  })

  it('logs a kill failure and still resets state (error path)', async () => {
    m.killChrome.mockRejectedValue(new Error('EPERM'))
    const cm = make()
    await cm.ready()
    await expect(cm.shutdown()).resolves.toBeUndefined()
    expect(logs).toContain('Failed to kill Chrome during shutdown: EPERM')
    expect(cm.isReady).toBe(false)
  })
})
