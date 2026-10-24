/**
 * Launch failsafes of src/lib/cdp/browser.ts (`launchChrome`,
 * `ensureChromeRunning`): idempotent launch, the O_EXCL per-port launch lock
 * over a shared in-memory filesystem, the 10 s CDP bound, detached spawn; and
 * the ChromeManager auto-start on top of it (first use launches, default host,
 * self-heal, fast path, hide windows, isReady).
 * Ticket 8468f7b1 · [chrome-lifecycle.1] [chrome-lifecycle.2] [chrome-lifecycle.3] ·
 * inventory [fs-001] [fs-002] [fs-003] [fs-004] [fs-005] [fs-006] [fs-011]
 * [fs-032] [fs-033] [fs-034] [fs-035] [fs-036] [fs-037] [fs-038] [fs-039] [fs-040] [fs-041] [fs-042] [fs-043]
 *
 * node:fs is routed to one `MemFs` (the filesystem every simulated process
 * shares), node:child_process `spawn` is a recording fake that "starts" Chrome
 * on the fake clock, and the CDP probe reads that simulated Chrome. No Chrome,
 * no port, no real file.
 * guards: does not spawn when Chrome is already reachable
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.1] [chrome-lifecycle.2] [chrome-lifecycle.3]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemFs } from '../../helpers/mem-fs.js'
import { FakeReaperHub, FakeReaperLink } from '../../helpers/lifecycle/fake-reaper-link.js'
import { resetSp, resetWorld } from '../../helpers/lifecycle/manager-world.js'

const sim = vi.hoisted(() => ({
  fs: null as unknown as import('../../helpers/mem-fs.js').MemFs,
  chromeUp: false,
  /** ms after spawn until CDP answers; null = never. */
  startMs: 300 as number | null,
  spawn: vi.fn(),
  probes: 0,
  /** The `--user-data-dir` of the simulated Chrome that answers on the port (profile-identity fixture, [core-seam.6]). */
  chromeProfile: '',
  /** A rival launcher's Chrome (this tool's own) appears while the launch lock is held: reachable only on the re-check. */
  rivalUp: false,
}))

/**
 * The simulated machine's `lsof` / `ps`: while the simulated Chrome is up it is the one listener, and its command
 * line carries the profile it was started with, so the profile-identity filter (backlog 7f881aa7) sees this
 * tool's own Chrome exactly as it would on a real machine. Nothing is executed.
 */
function simExec(cmd: string): string {
  if (!sim.chromeUp && !sim.rivalUp) return ''
  if (cmd.startsWith('lsof')) return '4242\n'
  if (cmd.startsWith('ps -o command=')) return `/Applications/Fake Chrome --remote-debugging-port=9333 --user-data-dir=${sim.chromeProfile} --no-first-run`
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
  isChromeReachable: vi.fn(async () => {
    sim.probes++
    return sim.chromeUp
  }),
  hideAllWindows: vi.fn(async () => undefined),
  closeAllPageTargets: vi.fn(async () => undefined),
  listPageTargetsOnly: vi.fn(async () => []),
}))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

type BrowserModule = typeof import('../../../src/lib/cdp/browser.js')
type ManagerModule = typeof import('../../../src/lib/chrome-manager.js')

const PORT = 9333
const CHROME = '/Applications/Fake Chrome'
const PROFILE = '/home/u/profile'
const LOCK = `/tmp/stealth-chrome-launch-${PORT}.lock`
let mod: BrowserModule
let mgr: ManagerModule
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.useFakeTimers()
  sim.fs = new MemFs()
  sim.fs.mkdirSync('/tmp', { recursive: true })
  sim.fs.mkdirSync('/Applications', { recursive: true })
  sim.fs.writeFileSync(CHROME, 'binary')
  sim.chromeUp = false
  sim.rivalUp = false
  sim.chromeProfile = PROFILE
  sim.startMs = 300
  sim.probes = 0
  let nextPid = 7000
  sim.spawn.mockReset()
  sim.spawn.mockImplementation((_bin: string, args: string[]) => {
    const pid = nextPid++
    const dirArg = args.find((a) => a.startsWith('--user-data-dir='))
    if (dirArg) sim.chromeProfile = dirArg.slice('--user-data-dir='.length)
    if (sim.startMs !== null) setTimeout(() => (sim.chromeUp = true), sim.startMs)
    return { pid, unref: vi.fn() }
  })
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.resetModules()
  mod = await import('../../../src/lib/cdp/browser.js')
  mgr = await import('../../../src/lib/chrome-manager.js')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const opts = { port: PORT, chromePath: CHROME, profileDir: PROFILE, quiet: true }

describe('8468f7b1 [chrome-lifecycle.1] launchChrome', () => {
  it('does not spawn when Chrome is already reachable', async () => {
    // [fs-032]
    sim.chromeUp = true
    await expect(mod.launchChrome(opts)).resolves.toEqual({ pid: null, port: PORT, alreadyRunning: true, profileDir: PROFILE })
    expect(sim.spawn).not.toHaveBeenCalled()
  })

  it('fails when CDP never answers within 10 seconds', async () => {
    // [fs-041] spawn, poll every 200 ms, give up after 10 s.
    sim.startMs = null
    const p = mod.launchChrome(opts)
    const assertion = expect(p).rejects.toThrow(`Chrome did not start CDP on port ${PORT} within 10s`)
    await vi.advanceTimersByTimeAsync(9_900)
    expect(sim.spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    await assertion
  })

  it('spawns detached with ignored stdio and remembers the pid', async () => {
    // [fs-042]
    const p = mod.launchChrome(opts)
    await vi.advanceTimersByTimeAsync(400)
    const r = await p
    const [bin, args, o] = sim.spawn.mock.calls[0] as [string, string[], Record<string, unknown>]
    expect(bin).toBe(CHROME)
    expect(args).toContain(`--remote-debugging-port=${PORT}`)
    expect(args).not.toContain('--enable-automation')
    expect(o).toEqual({ stdio: 'ignore', detached: true })
    const child = sim.spawn.mock.results[0].value as { unref: ReturnType<typeof vi.fn> }
    expect(child.unref).toHaveBeenCalledTimes(1)
    expect(r.pid).toBe(7000)
    // Remembered: the next kill is the tracked group kill of exactly this pid.
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('ESRCH')
    }) as typeof process.kill)
    const k = mod.killChrome(PORT)
    await vi.advanceTimersByTimeAsync(250)
    await k
    expect(kill).toHaveBeenCalledWith(-7000, 'SIGTERM')
  })

  it('quiet suppresses the launch diagnostic', async () => {
    // [fs-043]
    const quiet = mod.ensureChromeRunning(opts)
    await vi.advanceTimersByTimeAsync(400)
    await quiet
    expect(errSpy).not.toHaveBeenCalled()
    sim.chromeUp = false
    const loud = mod.ensureChromeRunning({ ...opts, quiet: false })
    await vi.advanceTimersByTimeAsync(400)
    await loud
    expect(errSpy).toHaveBeenCalledWith(`[cdp] Chrome not found on port ${PORT} — launching...`)
  })
})

describe('8468f7b1 [chrome-lifecycle.1] ensureChromeRunning and the O_EXCL launch lock', () => {
  it('returns immediately when Chrome is reachable', async () => {
    // [fs-033]
    sim.chromeUp = true
    await expect(mod.ensureChromeRunning(opts)).resolves.toEqual({ pid: null, port: PORT, profileDir: PROFILE })
    expect(sim.fs.existsSync(LOCK)).toBe(false)
    expect(sim.spawn).not.toHaveBeenCalled()
  })

  it('eight concurrent starters spawn exactly one Chrome', async () => {
    // [fs-034] eight processes sharing one filesystem race the check-then-spawn window.
    const all = Promise.all(Array.from({ length: 8 }, () => mod.ensureChromeRunning(opts)))
    await vi.advanceTimersByTimeAsync(2_000)
    const results = await all
    expect(sim.spawn).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.pid !== null)).toHaveLength(1)
    expect(results.every((r) => r.port === PORT)).toBe(true)
    expect(sim.fs.existsSync(LOCK)).toBe(false)
  })

  it('uses one lock per port', async () => {
    // [fs-035]
    sim.startMs = 300
    const a = mod.ensureChromeRunning(opts)
    await vi.advanceTimersByTimeAsync(0)
    expect(sim.fs.existsSync(LOCK)).toBe(true)
    expect(sim.fs.existsSync('/tmp/stealth-chrome-launch-9444.lock')).toBe(false)
    await vi.advanceTimersByTimeAsync(400)
    await a
  })

  it("the loser waits for the winner's Chrome", async () => {
    // [fs-036] a held lock: the loser polls every 250 ms and returns as soon as Chrome answers.
    const held = sim.fs.openSync(LOCK, 'wx')
    const p = mod.ensureChromeRunning(opts)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sim.spawn).not.toHaveBeenCalled()
    sim.chromeUp = true
    await vi.advanceTimersByTimeAsync(250)
    await expect(p).resolves.toEqual({ pid: null, port: PORT, profileDir: PROFILE })
    sim.fs.closeSync(held)
  })

  it('reclaims a launch lock older than 15 seconds', async () => {
    // [fs-037] the holder died mid-launch: after 15 s the waiter removes the lock and launches itself.
    sim.fs.openSync(LOCK, 'wx')
    const p = mod.ensureChromeRunning(opts)
    await vi.advanceTimersByTimeAsync(14_900)
    expect(sim.spawn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(sim.spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    await expect(p).resolves.toMatchObject({ pid: 7000 })
  })

  it('reclaiming a stale lock re-attempts the exclusive create', async () => {
    // [fs-038] [audit-fixes.2] if a rival re-takes the lock between our reclaim and our retry, the launch never
    // proceeds lock-less: it keeps waiting (bounded) and ends in LAUNCH_LOCK_TIMEOUT without spawning a second Chrome.
    sim.fs.openSync(LOCK, 'wx')
    const realRename = sim.fs.renameSync.bind(sim.fs)
    sim.fs.renameSync = (from: string, to: string) => {
      realRename(from, to)
      sim.fs.openSync(LOCK, 'wx') // a rival re-creates it between our reclaim and our retry
    }
    const p = mod.ensureChromeRunning(opts)
    const assertion = expect(p).rejects.toMatchObject({ code: 'LAUNCH_LOCK_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(31_000)
    await assertion
    expect(sim.spawn).not.toHaveBeenCalled()
    // The rival's lock is theirs: our process never removed it.
    expect(sim.fs.existsSync(LOCK)).toBe(true)
  })

  it('re-checks reachability under the lock', async () => {
    // [fs-039] the winner may have just started Chrome: the probe under the lock sees it and skips the spawn.
    const { isChromeReachable } = await import('../../../src/lib/cdp/targets.js')
    vi.mocked(isChromeReachable).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    sim.rivalUp = true
    await expect(mod.ensureChromeRunning(opts)).resolves.toEqual({ pid: null, port: PORT, profileDir: PROFILE })
    expect(sim.spawn).not.toHaveBeenCalled()
    expect(sim.fs.existsSync(LOCK)).toBe(false)
  })

  it('releases the lock on success and on failure', async () => {
    // [fs-040]
    const ok = mod.ensureChromeRunning(opts)
    await vi.advanceTimersByTimeAsync(400)
    await ok
    expect(sim.fs.existsSync(LOCK)).toBe(false)
    sim.chromeUp = false
    sim.startMs = null
    const bad = mod.ensureChromeRunning(opts)
    const assertion = expect(bad).rejects.toThrow('within 10s')
    await vi.advanceTimersByTimeAsync(10_500)
    await assertion
    expect(sim.fs.existsSync(LOCK)).toBe(false)
  })
})

describe('8468f7b1 [chrome-lifecycle.1] [chrome-lifecycle.2] [chrome-lifecycle.3] ChromeManager auto-start', () => {
  const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  let logs: string[]

  beforeEach(() => {
    resetWorld()
    resetSp()
    sim.fs.mkdirSync('/Applications/Google Chrome.app/Contents/MacOS', { recursive: true })
    sim.fs.writeFileSync(DEFAULT_CHROME, 'binary')
    sim.chromeProfile = '/home/u/Library/Application Support/Google/Chrome-CDP'
    logs = []
  })

  /** A manager whose reaper is unavailable (this file is about launching, not reaping). */
  function manager(cdpHost?: string) {
    const hub = new FakeReaperHub({
      makeHost: () => {
        throw new Error('no reaper host in launch.spec')
      },
    })
    hub.available = false
    return new mgr.ChromeManager({
      ...(cdpHost ? { cdpHost } : {}),
      stateDir: '/tmp/stealth-browser-test-state',
      link: new FakeReaperLink(hub, { pid: 1, checkHistory: true }),
      logger: (m) => logs.push(m),
    })
  }

  async function settle<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(400)
    return p
  }

  it('auto-starts Chrome on first use on the configured port', async () => {
    // [fs-001] Chrome unreachable -> ready() launches through the locked launcher on the manager's port.
    const cm = manager(`127.0.0.1:${PORT}`)
    await settle(cm.ready())
    expect(sim.spawn).toHaveBeenCalledTimes(1)
    const [bin, args] = sim.spawn.mock.calls[0] as [string, string[]]
    expect(bin).toBe(DEFAULT_CHROME)
    expect(args).toContain(`--remote-debugging-port=${PORT}`)
    expect(sim.fs.existsSync(LOCK)).toBe(false)
  })

  it('defaults to the shared Chrome on 127.0.0.1:9222', async () => {
    // [fs-002] no cdpHost -> 127.0.0.1:9222; a cdpHost without a port falls back to 9222. (Every probe is mocked:
    // nothing ever connects to a real port.)
    const { isChromeReachable } = await import('../../../src/lib/cdp/targets.js')
    sim.chromeUp = true
    await manager().ready()
    expect(vi.mocked(isChromeReachable).mock.calls.map((c) => c[0])).toContain('127.0.0.1:9222')
    vi.mocked(isChromeReachable).mockClear()
    await manager('localhost').ready()
    expect(vi.mocked(isChromeReachable).mock.calls.map((c) => c[0])).toContain('127.0.0.1:9222')
    expect(sim.spawn).not.toHaveBeenCalled()
  })

  it('relaunches when the shared Chrome was killed under a ready manager', async () => {
    // [fs-003]
    const cm = manager(`127.0.0.1:${PORT}`)
    await settle(cm.ready())
    sim.chromeUp = false // another process killed it
    await settle(cm.ready())
    expect(sim.spawn).toHaveBeenCalledTimes(2)
    expect(logs.some((l) => l.includes('stale _ready'))).toBe(true)
  })

  it('fast path returns without relaunching', async () => {
    // [fs-004] a ready manager whose Chrome still answers: one probe, no launch.
    const cm = manager(`127.0.0.1:${PORT}`)
    await settle(cm.ready())
    const probes = sim.probes
    await cm.ready()
    expect(sim.probes).toBe(probes + 1)
    expect(sim.spawn).toHaveBeenCalledTimes(1)
  })

  it('hides windows after a fresh launch', async () => {
    // [fs-005] hideAllWindows after the launch; a hide failure is logged and rethrown.
    const { hideAllWindows } = await import('../../../src/lib/cdp/targets.js')
    const cm = manager(`127.0.0.1:${PORT}`)
    await settle(cm.ready())
    expect(hideAllWindows).toHaveBeenCalledWith(`127.0.0.1:${PORT}`)
    vi.mocked(hideAllWindows).mockRejectedValueOnce(new Error('no window'))
    sim.chromeUp = false
    const again = cm.ready()
    const assertion = expect(again).rejects.toThrow('no window')
    await vi.advanceTimersByTimeAsync(400)
    await assertion
    expect(logs).toContain('Failed to hide Chrome windows: no window')
  })

  it('does not re-hide a revealed window on the fast path', async () => {
    // [fs-006]
    const { hideAllWindows } = await import('../../../src/lib/cdp/targets.js')
    vi.mocked(hideAllWindows).mockClear()
    const cm = manager(`127.0.0.1:${PORT}`)
    await settle(cm.ready())
    await cm.ready()
    await cm.ready()
    expect(hideAllWindows).toHaveBeenCalledTimes(1)
  })

  it('isReady reflects the managed state', async () => {
    // [fs-011] false before, true once Chrome is verified, false after a real shutdown.
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }) as typeof process.kill)
    const cm = manager(`127.0.0.1:${PORT}`)
    expect(cm.isReady).toBe(false)
    await settle(cm.ready())
    expect(cm.isReady).toBe(true)
    expect((await cm.status()).ready).toBe(true)
    const down = cm.shutdown()
    await vi.advanceTimersByTimeAsync(400)
    await down
    expect(cm.isReady).toBe(false)
  })
})
