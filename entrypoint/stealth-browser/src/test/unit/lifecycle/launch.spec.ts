/**
 * Launch failsafes of src/lib/cdp/browser.ts (`launchChrome`,
 * `ensureChromeRunning`): idempotent launch, the O_EXCL per-port launch lock
 * over a shared in-memory filesystem, the 10 s CDP bound, detached spawn.
 * Ticket 8468f7b1 · [chrome-lifecycle.1] ·
 * inventory [fs-032] [fs-033] [fs-034] [fs-035] [fs-036] [fs-037] [fs-038] [fs-039] [fs-040] [fs-041] [fs-042] [fs-043]
 *
 * node:fs is routed to one `MemFs` (the filesystem every simulated process
 * shares), node:child_process `spawn` is a recording fake that "starts" Chrome
 * on the fake clock, and the CDP probe reads that simulated Chrome. No Chrome,
 * no port, no real file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemFs } from '../../support/mem-fs.js'

const sim = vi.hoisted(() => ({
  fs: null as unknown as import('../../support/mem-fs.js').MemFs,
  chromeUp: false,
  /** ms after spawn until CDP answers; null = never. */
  startMs: 300 as number | null,
  spawn: vi.fn(),
  probes: 0,
}))

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => ''), spawn: sim.spawn }))
vi.mock('node:fs', () => ({
  existsSync: (p: string) => sim.fs.existsSync(p),
  mkdirSync: (p: string, o?: { recursive?: boolean }) => sim.fs.mkdirSync(p, { recursive: true, ...o }),
  openSync: (p: string, f: string) => sim.fs.openSync(p, f),
  closeSync: (fd: number) => sim.fs.closeSync(fd),
  unlinkSync: (p: string) => sim.fs.unlinkSync(p),
}))
vi.mock('node:os', () => ({ homedir: () => '/home/u', platform: () => 'darwin', tmpdir: () => '/tmp' }))
vi.mock('../../../lib/cdp/targets.js', () => ({
  isChromeReachable: vi.fn(async () => {
    sim.probes++
    return sim.chromeUp
  }),
}))

type BrowserModule = typeof import('../../../lib/cdp/browser.js')

const PORT = 9333
const CHROME = '/Applications/Fake Chrome'
const PROFILE = '/home/u/profile'
const LOCK = `/tmp/stealth-chrome-launch-${PORT}.lock`
let mod: BrowserModule
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.useFakeTimers()
  sim.fs = new MemFs()
  sim.fs.mkdirSync('/tmp', { recursive: true })
  sim.fs.mkdirSync('/Applications', { recursive: true })
  sim.fs.writeFileSync(CHROME, 'binary')
  sim.chromeUp = false
  sim.startMs = 300
  sim.probes = 0
  let nextPid = 7000
  sim.spawn.mockReset()
  sim.spawn.mockImplementation(() => {
    const pid = nextPid++
    if (sim.startMs !== null) setTimeout(() => (sim.chromeUp = true), sim.startMs)
    return { pid, unref: vi.fn() }
  })
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.resetModules()
  mod = await import('../../../lib/cdp/browser.js')
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
    // [fs-038] if the second O_EXCL attempt also fails (a rival re-took it) the launch proceeds lock-less, never hangs.
    sim.fs.openSync(LOCK, 'wx')
    const realUnlink = sim.fs.unlinkSync.bind(sim.fs)
    let unlinks = 0
    sim.fs.unlinkSync = (path: string) => {
      unlinks++
      realUnlink(path)
      if (unlinks === 1) sim.fs.openSync(LOCK, 'wx') // a rival re-creates it between unlink and our retry
    }
    const p = mod.ensureChromeRunning(opts)
    await vi.advanceTimersByTimeAsync(15_500)
    await vi.advanceTimersByTimeAsync(400)
    await expect(p).resolves.toMatchObject({ pid: 7000 })
    expect(sim.spawn).toHaveBeenCalledTimes(1)
    // Lock-less: our process never owned the rival's lock, so it did not remove it.
    expect(sim.fs.existsSync(LOCK)).toBe(true)
  })

  it('re-checks reachability under the lock', async () => {
    // [fs-039] the winner may have just started Chrome: the probe under the lock sees it and skips the spawn.
    const { isChromeReachable } = await import('../../../lib/cdp/targets.js')
    vi.mocked(isChromeReachable).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
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
