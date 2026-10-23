/**
 * The host-neutral manager seam (src/lib/managers.ts): a host configures idle
 * shutdown, keep-alive and the reaper entry once, reads managers through
 * `managerFor` and wires its process exit hooks to every live manager through
 * `chromeExitTarget`, without constructing a ChromeManager itself.
 * Ticket 8468f7b1 · [core-seam.1] [core-seam.2] [core-seam.3] [core-seam.5] · backlog e093636f.
 *
 * Real `managers.ts` and real `ChromeManager`; only the process boundary is
 * simulated (manager-world: scripted Chrome, MemFs, fake clock, a real pure
 * reaper host behind a FakeReaperLink). The link factory is intercepted so each
 * spec reads the config a manager handed to the reaper link. No socket, no
 * process, no real Chrome, port 9222 is never contacted.
 * guards: returns the same manager for the same host and port and another for another port
 * tier: S
 * cites: 8468f7b1 [core-seam.1] [core-seam.2] [core-seam.3] [core-seam.5]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

const seam = vi.hoisted(() => ({
  make: null as null | ((cfg: Record<string, unknown>) => unknown),
}))
vi.mock('../../../src/lib/lifecycle/reaper-link.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createProxyReaperLink: (cfg: Record<string, unknown>) => seam.make!(cfg),
}))

import type { ChromeManagerOptions } from '../../../src/lib/chrome-manager.js'
import { installProcessExitHooks, type ExitHookProcess } from '../../../src/lib/lifecycle/exit-hooks.js'
import { isLifecycleError } from '../../../src/lib/lifecycle/errors.js'
import { chromeExitTarget, configureManagers, managerFor } from '../../../src/lib/managers.js'
import { FakeReaperLink } from '../../helpers/lifecycle/fake-reaper-link.js'
import { makeHub } from '../../helpers/lifecycle/manager-clients.js'
import { ensureChromeRunning } from '../../../src/lib/cdp/browser.js'
import { resetSp, resetWorld, world } from '../../helpers/lifecycle/manager-world.js'

interface Made {
  cfg: Record<string, unknown>
  link: FakeReaperLink
}

let made: Made[]
/** Each spec uses its own ports: the seam's manager map lives for the module, as it does in a host process. */
let nextPort = 18000

const portFor = (): number => nextPort++
const linkOf = (cfg: Record<string, unknown>): FakeReaperLink => made.find((m) => m.cfg['port'] === cfg['port'])!.link
void linkOf

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
  made = []
  const hub = makeHub()
  seam.make = (cfg) => {
    const link = new FakeReaperLink(hub, { pid: Number(cfg['pid']), checkHistory: Boolean(cfg['checkHistory']) })
    made.push({ cfg, link })
    return link
  }
  configureManagers({})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const madeFor = (port: number): Made => made.find((m) => m.cfg['port'] === port)!

describe('8468f7b1 [core-seam.1] managerFor: one cached manager per Chrome', () => {
  it('returns the same manager for the same host and port and another for another port', () => {
    const a = managerFor('127.0.0.1', portFor())
    const b = managerFor('127.0.0.1', nextPort - 1)
    const c = managerFor('127.0.0.1', portFor())
    expect(b).toBe(a)
    expect(c).not.toBe(a)
  })

  it('defaults reproduce the manager as it is today: 120 s idle timeout and the history check on', async () => {
    // No configureManagers setting: the reaper link gets the manager's own defaults.
    const port = portFor()
    await managerFor('127.0.0.1', port).ready()
    expect(madeFor(port).cfg).toMatchObject({ idleTimeoutMs: 120_000, checkHistory: true })
    expect(madeFor(port).cfg['entryPath']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(119_999)
    expect(madeFor(port).link.reapCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(madeFor(port).link.reapCalls).toBe(1)
  })
})

describe('8468f7b1 [core-seam.1] [core-seam.2] configureManagers reaches the managers', () => {
  it('checkHistory: false, the idle timeout and the entryPath reach the manager and its reaper link', async () => {
    configureManagers({ checkHistory: false, idleTimeoutMs: 1_000, entryPath: '/host/pkg/dist/index.js' })
    const port = portFor()
    await managerFor('127.0.0.1', port).ready()
    expect(madeFor(port).cfg).toMatchObject({ checkHistory: false, idleTimeoutMs: 1_000, entryPath: '/host/pkg/dist/index.js' })
    expect(madeFor(port).link.hello.checkHistory).toBe(false)
  })

  it('the host logger receives the manager diagnostics', async () => {
    const lines: string[] = []
    configureManagers({ logger: (m) => lines.push(m), idleTimeoutMs: 500 })
    const m = managerFor('127.0.0.1', portFor())
    await m.ready()
    await m.shutdown()
    expect(lines.some((l) => l.includes('shutting down'))).toBe(true)
  })

  it('a second configureManagers call replaces the settings for managers created afterwards only', async () => {
    configureManagers({ idleTimeoutMs: 1_000, checkHistory: true })
    const p1 = portFor()
    await managerFor('127.0.0.1', p1).ready()
    configureManagers({ idleTimeoutMs: 2_000, checkHistory: false })
    const p2 = portFor()
    await managerFor('127.0.0.1', p2).ready()
    expect(madeFor(p1).cfg).toMatchObject({ idleTimeoutMs: 1_000, checkHistory: true })
    expect(madeFor(p2).cfg).toMatchObject({ idleTimeoutMs: 2_000, checkHistory: false })
    // The replacement is total: a setting the second call omits is back to its default.
    configureManagers({})
    const p3 = portFor()
    await managerFor('127.0.0.1', p3).ready()
    expect(madeFor(p3).cfg).toMatchObject({ idleTimeoutMs: 120_000, checkHistory: true })
  })
})

describe('8468f7b1 [core-seam.1] [core-seam.2] keepAlive: true never arms the idle timer', () => {
  it('an idle host keeps its Chrome: no reap is ever requested however long it idles', async () => {
    configureManagers({ keepAlive: true, idleTimeoutMs: 1_000 })
    const port = portFor()
    const m = managerFor('127.0.0.1', port)
    await m.ready()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(madeFor(port).link.reapCalls).toBe(0)
    expect(world.chromeUp).toBe(true)
    // Control: the same host without keepAlive is reaped when idle.
    configureManagers({ keepAlive: false, idleTimeoutMs: 1_000 })
    const control = portFor()
    await managerFor('127.0.0.1', control).ready()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(madeFor(control).link.reapCalls).toBe(1)
  })

  it('work is still activity: bump() reports it to the reaper even though no timer exists', async () => {
    configureManagers({ keepAlive: true })
    const port = portFor()
    const m = managerFor('127.0.0.1', port)
    m.bump()
    expect(madeFor(port)).toBeUndefined() // before ready() nothing is wired and nothing is sent
    await m.ready()
    const before = madeFor(port).link.activityCalls
    m.bump()
    expect(madeFor(port).link.activityCalls).toBe(before + 1)
  })

  it('every other shutdown path is unchanged: shutdownIfIdle asks the reaper and shutdown() kills', async () => {
    configureManagers({ keepAlive: true })
    const port = portFor()
    const m = managerFor('127.0.0.1', port)
    await m.ready()
    await m.shutdownIfIdle()
    expect(madeFor(port).link.reapCalls).toBe(1)
    await m.shutdown()
    expect(world.events).toContain(`kill:${port}`)
    expect(m.isReady).toBe(false)
  })
})

describe('8468f7b1 [core-seam.1] [core-seam.2] chromeExitTarget reaches every live manager', () => {
  it('release() and shutdownIfIdle() through chromeExitTarget reach every live manager', async () => {
    const ports = [portFor(), portFor(), portFor()]
    for (const p of ports) await managerFor('127.0.0.1', p).ready()
    await chromeExitTarget.release()
    for (const p of ports) expect(madeFor(p).link.releaseCalls).toBe(1)
    for (const p of ports) await managerFor('127.0.0.1', p).ready() // re-register after the release
    await chromeExitTarget.shutdownIfIdle()
    for (const p of ports) expect(madeFor(p).link.reapCalls).toBeGreaterThanOrEqual(1)
  })

  it('a manager created after the exit hooks were wired is reached too (the target reads the live map)', async () => {
    const target = chromeExitTarget
    const port = portFor()
    await managerFor('127.0.0.1', port).ready()
    await target.release()
    expect(madeFor(port).link.releaseCalls).toBe(1)
  })

  it('error path: one manager failing its soft shutdown does not stop the others, and the failure surfaces', async () => {
    const [p1, p2] = [portFor(), portFor()]
    const bad = managerFor('127.0.0.1', p1)
    const good = managerFor('127.0.0.1', p2)
    await bad.ready()
    await good.ready()
    vi.spyOn(bad, 'shutdownIfIdle').mockRejectedValue(new Error('reaper socket gone'))
    const goodSoft = vi.spyOn(good, 'shutdownIfIdle')
    await expect(chromeExitTarget.shutdownIfIdle()).rejects.toThrow('reaper socket gone')
    expect(goodSoft).toHaveBeenCalledTimes(1)
  })

  it('wired to installProcessExitHooks, a SIGTERM releases and soft-shuts every live manager, then exits 143', async () => {
    const handlers = new Map<string, (...a: unknown[]) => void>()
    const proc: ExitHookProcess = {
      on: (ev, fn) => void handlers.set(ev, fn),
      removeListener: (ev) => void handlers.delete(ev),
    }
    const exit = vi.fn()
    const logs: string[] = []
    const port = portFor()
    const live = managerFor('127.0.0.1', port)
    await live.ready()
    const soft = vi.spyOn(live, 'shutdownIfIdle')
    const uninstall = installProcessExitHooks(chromeExitTarget, { proc, exit, logger: (m) => logs.push(m) })
    handlers.get('SIGTERM')!()
    await vi.advanceTimersByTimeAsync(10)
    expect(madeFor(port).link.releaseCalls).toBeGreaterThanOrEqual(1)
    expect(soft).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(143)
    uninstall()
  })

  it('error path: a launch that fails surfaces as a typed LifecycleError through the seam manager', async () => {
    world.launch = 'fail'
    const m = managerFor('127.0.0.1', portFor())
    const err = await m.ready().catch((e: unknown) => e)
    expect(isLifecycleError(err, 'LAUNCH_FAILED')).toBe(true)
    expect(vi.mocked(ensureChromeRunning)).toHaveBeenCalled()
  })
})

describe('8468f7b1 [core-seam.5] legacyHeartbeatPath stays out of the core (backlog e093636f, @ts-expect-error)', () => {
  it('@ts-expect-error: ChromeManagerOptions has no legacyHeartbeatPath and no heartbeatPath e093636f', () => {
    // Each assignment below must NOT compile; `tsc` (typecheck-spec) fails if either @ts-expect-error is unused.
    // @ts-expect-error legacyHeartbeatPath is not an option of the core
    const legacy: ChromeManagerOptions = { legacyHeartbeatPath: '/tmp/agent-search-heartbeat.json' }
    // @ts-expect-error heartbeatPath is not an option of the core
    const plain: ChromeManagerOptions = { heartbeatPath: '/tmp/heartbeat.json' }
    expect(Object.keys(legacy)).toEqual(['legacyHeartbeatPath'])
    expect(Object.keys(plain)).toEqual(['heartbeatPath'])
  })

  it('configuring the seam and launching a manager reads no heartbeat file (legacyHeartbeatPath e093636f)', async () => {
    const read = vi.spyOn(world.fs, 'readFileSync')
    const exists = vi.spyOn(world.fs, 'existsSync')
    configureManagers({ idleTimeoutMs: 1_000, keepAlive: false, checkHistory: true })
    await managerFor('127.0.0.1', portFor()).ready()
    const touched = [...read.mock.calls, ...exists.mock.calls].map((c) => String(c[0]))
    expect(touched.filter((p) => /heartbeat/i.test(p))).toEqual([])
  })
})
