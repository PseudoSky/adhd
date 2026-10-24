/**
 * CL1 (F1 F2 F4) race-free launch through ChromeManager.
 * Ticket 8468f7b1 · [chrome-lifecycle.1]
 *
 * Eight agents start at the same moment on one machine: eight ChromeManagers
 * over ONE shared in-memory filesystem race the real `ensureChromeRunning`
 * (O_EXCL per-port launch lock, 10 s CDP bound, 15 s stale-lock reclaim).
 * Exactly one Chrome is spawned; the default host is 127.0.0.1:9222; a Chrome
 * whose CDP never answers within 10 s fails as CHROME_UNREACHABLE_AFTER_LAUNCH;
 * a loser waits (bounded) for the winner; a lock older than 15 s is reclaimed.
 *
 * node:fs -> MemFs, node:child_process `spawn` -> a recording fake that
 * "starts" Chrome on the fake clock, every CDP probe reads that simulated
 * Chrome. No Chrome, no process, no socket, and port 9222 is never contacted.
 * guards: 8 concurrent ready() calls over one MemFs spawn exactly one Chrome
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.1]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemFs } from '../../helpers/mem-fs.js'

const sim = vi.hoisted(() => ({
  fs: null as unknown as import('../../helpers/mem-fs.js').MemFs,
  chromeUp: false,
  /** ms after spawn until CDP answers; null = never. */
  startMs: 300 as number | null,
  spawn: vi.fn(),
  probed: [] as string[],
}))

/**
 * Profile-identity fixture (backlog 7f881aa7, [core-seam.6]): while the simulated Chrome is up it is the one
 * listener on the port and its command line carries the default dedicated profile the managers launch with.
 */
function simExec(cmd: string): string {
  if (!sim.chromeUp) return ''
  if (cmd.startsWith('lsof')) return '4242\n'
  if (cmd.startsWith('ps -o command=')) return '/Applications/Google Chrome --user-data-dir=/home/u/Library/Application Support/Google/Chrome-CDP --no-first-run'
  return ''
}

vi.mock('node:child_process', () => ({ execSync: vi.fn((cmd: string) => simExec(cmd)), spawn: sim.spawn }))
vi.mock('node:fs', () => ({
  existsSync: (p: string) => sim.fs.existsSync(p),
  mkdirSync: (p: string, o?: { recursive?: boolean }) => sim.fs.mkdirSync(p, { recursive: true, ...o }),
  openSync: (p: string, f: string) => sim.fs.openSync(p, f),
  closeSync: (fd: number) => sim.fs.closeSync(fd),
  unlinkSync: (p: string) => sim.fs.unlinkSync(p),
  readFileSync: (p: string) => sim.fs.readFileSync(p),
  writeFileSync: (p: string, d: string, o?: { mode?: number }) => sim.fs.writeFileSync(p, d, o),
  renameSync: (a: string, b: string) => sim.fs.renameSync(a, b),
  statSync: (p: string) => sim.fs.statSync(p),
}))
vi.mock('node:os', () => ({ homedir: () => '/home/u', platform: () => 'darwin', tmpdir: () => '/tmp' }))
vi.mock('../../../src/lib/cdp/targets.js', () => ({
  isChromeReachable: vi.fn(async (host: string) => {
    sim.probed.push(host)
    return sim.chromeUp
  }),
  hideAllWindows: vi.fn(async () => undefined),
  closeAllPageTargets: vi.fn(async () => undefined),
  listPageTargetsOnly: vi.fn(async () => []),
}))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { ChromeManager } from '../../../src/lib/chrome-manager.js'
import { isLifecycleError } from '../../../src/lib/lifecycle/errors.js'
import { FakeReaperHub, FakeReaperLink } from '../../helpers/lifecycle/fake-reaper-link.js'
import { resetSp, resetWorld } from '../../helpers/lifecycle/manager-world.js'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333
const lockOf = (port: number) => `/tmp/stealth-chrome-launch-${port}.lock`

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
  sim.fs = new MemFs()
  sim.fs.mkdirSync('/tmp', { recursive: true })
  sim.fs.mkdirSync('/Applications/Google Chrome.app/Contents/MacOS', { recursive: true })
  sim.fs.writeFileSync(CHROME, 'binary')
  sim.chromeUp = false
  sim.startMs = 300
  sim.probed = []
  let nextPid = 7000
  sim.spawn.mockReset()
  sim.spawn.mockImplementation(() => {
    const pid = nextPid++
    if (sim.startMs !== null) setTimeout(() => (sim.chromeUp = true), sim.startMs)
    return { pid, unref: vi.fn() }
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** One agent process: a manager whose reaper is unavailable (this spec is about launching). */
function agent(i: number, cdpHost: string | null = `127.0.0.1:${PORT}`): ChromeManager {
  const hub = new FakeReaperHub({
    makeHost: () => {
      throw new Error('no reaper host in this spec')
    },
  })
  hub.available = false
  return new ChromeManager({
    ...(cdpHost ? { cdpHost } : {}),
    stateDir: '/tmp/stealth-browser-state',
    link: new FakeReaperLink(hub, { pid: 100 + i, checkHistory: true }),
    logger: () => undefined,
  })
}

describe('8468f7b1 [chrome-lifecycle.1] eight managers race one launch', () => {
  it('8 concurrent ready() calls over one MemFs spawn exactly one Chrome', async () => {
    const managers = Array.from({ length: 8 }, (_, i) => agent(i))
    const all = Promise.all(managers.map((m) => m.ready()))
    await vi.advanceTimersByTimeAsync(2_000)
    await all
    expect(sim.spawn).toHaveBeenCalledTimes(1)
    expect(managers.every((m) => m.isReady)).toBe(true)
    // Exactly one of them launched (and owns) this Chrome.
    const owned = await Promise.all(managers.map(async (m) => (await m.status()).owned))
    expect(owned.filter(Boolean)).toHaveLength(1)
    expect(sim.fs.existsSync(lockOf(PORT))).toBe(false)
  })

  it('the default host is 127.0.0.1:9222 (every probe is the simulated Chrome, never the real port)', async () => {
    sim.chromeUp = true
    const managers = Array.from({ length: 8 }, (_, i) => agent(i, null))
    await Promise.all(managers.map((m) => m.ready()))
    expect(new Set(sim.probed)).toEqual(new Set(['127.0.0.1:9222']))
    expect(sim.spawn).not.toHaveBeenCalled()
  })

  it('a CDP that never becomes ready within 10 s gives CHROME_UNREACHABLE_AFTER_LAUNCH', async () => {
    sim.startMs = null
    const m = agent(0)
    const p = m.ready().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(9_900)
    expect(sim.spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    const err = await p
    expect(isLifecycleError(err, 'CHROME_UNREACHABLE_AFTER_LAUNCH')).toBe(true)
    expect((err as { detail?: { port?: number } }).detail?.port).toBe(PORT)
    expect(m.isReady).toBe(false)
    expect(sim.fs.existsSync(lockOf(PORT))).toBe(false)
  })

  it("a loser waits, bounded, for the winner's Chrome", async () => {
    const held = sim.fs.openSync(lockOf(PORT), 'wx') // the winner holds the lock mid-launch
    const loser = agent(1)
    const p = loser.ready()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sim.spawn).not.toHaveBeenCalled()
    expect(loser.isReady).toBe(false)
    sim.chromeUp = true // the winner's Chrome answers
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(loser.isReady).toBe(true)
    expect(sim.spawn).not.toHaveBeenCalled()
    sim.fs.closeSync(held)
  })

  it('a launch lock older than 15 s is reclaimed', async () => {
    sim.fs.openSync(lockOf(PORT), 'wx') // the holder died mid-launch
    const m = agent(2)
    const p = m.ready()
    await vi.advanceTimersByTimeAsync(14_900)
    expect(sim.spawn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(sim.spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    await p
    expect(m.isReady).toBe(true)
  })
})
