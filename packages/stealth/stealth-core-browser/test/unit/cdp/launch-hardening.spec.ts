/**
 * Unit spec for the launch and kill hardening of src/lib/cdp/browser.ts (audit findings P14, P15, P16).
 * Ticket 8468f7b1 · criteria [audit-fixes.1] [audit-fixes.2] [audit-fixes.3].
 * node:child_process, node:fs, node:os and ./targets are mocked and process.kill is spied: no Chrome is launched,
 * no process is signalled, no lock file is touched and the developer's live Chrome is never contacted.
 * guards: killChrome signals only the pid tracked for its own port and only while the pid still runs that port's Chrome
 * guards: a stale launch lock is reclaimed by an atomic rename and a launch never proceeds without the lock
 * guards: a launch that never answers CDP kills its process group and forgets the pid
 * tier: S
 * cites: 8468f7b1 [audit-fixes.1] [audit-fixes.2] [audit-fixes.3]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(),
  renameSync: vi.fn(),
  isChromeReachable: vi.fn(),
}))

vi.mock('node:child_process', () => ({ execSync: m.execSync, spawn: m.spawn }))
vi.mock('node:fs', () => ({
  existsSync: m.existsSync,
  mkdirSync: m.mkdirSync,
  openSync: m.openSync,
  closeSync: m.closeSync,
  unlinkSync: m.unlinkSync,
  statSync: m.statSync,
  renameSync: m.renameSync,
}))
vi.mock('node:os', () => ({ homedir: () => '/fake/home', platform: () => 'darwin', tmpdir: () => '/fake/tmp' }))
vi.mock('../../../src/lib/cdp/targets.js', () => ({ isChromeReachable: m.isChromeReachable }))

type BrowserModule = typeof import('../../../src/lib/cdp/browser.js')

async function loadFresh(): Promise<BrowserModule> {
  vi.resetModules()
  return import('../../../src/lib/cdp/browser.js')
}

const CHROME = '/fake/bin/chrome'
const PROFILE = '/fake/profile'
const lockOf = (port: number): string => `/fake/tmp/stealth-chrome-launch-${port}.lock`

let kill: ReturnType<typeof vi.spyOn>
/** The 'exit' listener each fake child registered, by pid: calling it simulates that child exiting. */
const exits = new Map<number, () => void>()
const signals: Array<[number, string | number | undefined]> = []

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of Object.values(m)) fn.mockReset()
  m.existsSync.mockReturnValue(true)
  m.openSync.mockReturnValue(11)
  m.isChromeReachable.mockResolvedValue(false)
  signals.length = 0
  exits.clear()
  kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    signals.push([pid, sig])
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    return true
  }) as typeof process.kill)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function launchOn(mod: BrowserModule, port: number, pid: number): Promise<void> {
  const child = { pid, unref: vi.fn(), once: vi.fn((event: string, cb: () => void) => { exits.set(pid, event === 'exit' ? cb : (exits.get(pid) ?? cb)) }) }
  m.spawn.mockReturnValue(child)
  m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
  const p = mod.launchChrome({ port, chromePath: CHROME, profileDir: PROFILE })
  await vi.advanceTimersByTimeAsync(250)
  await p
  m.isChromeReachable.mockReset()
  m.isChromeReachable.mockResolvedValue(false)
}

const quiet = (): void => undefined
const noListeners = { listeners: (): number[] => [], commandLine: (): string | null => null, groupOf: (): number | null => null }

describe('8468f7b1 [audit-fixes.1] P14 killChrome is scoped to its own port and drops the pid when the child exits', () => {
  it('a Chrome launched on one port is not signalled by a kill of another port', async () => {
    const mod = await loadFresh()
    await launchOn(mod, 9333, 5001)
    await mod.killChrome(9444, { profileDir: PROFILE, probe: noListeners, logger: quiet })
    expect(signals.filter(([pid]) => Math.abs(pid) === 5001)).toEqual([])
  })

  it('kills the tracked group of its own port', async () => {
    const mod = await loadFresh()
    await launchOn(mod, 9333, 5001)
    const killing = mod.killChrome(9333, { profileDir: PROFILE, probe: noListeners, logger: quiet })
    await vi.advanceTimersByTimeAsync(300)
    await killing
    expect(signals).toContainEqual([-5001, 'SIGTERM'])
    expect(signals).toContainEqual([-5001, 'SIGKILL'])
  })

  it('does not signal a pid after its child exited (the OS may have recycled it)', async () => {
    const mod = await loadFresh()
    await launchOn(mod, 9333, 5001)
    exits.get(5001)?.()
    await mod.killChrome(9333, { profileDir: PROFILE, probe: noListeners, logger: quiet })
    expect(signals).toEqual([])
  })

  it('an exit of an older launch does not drop the record of a newer launch on the same port', async () => {
    const mod = await loadFresh()
    await launchOn(mod, 9333, 5001)
    const olderExit = exits.get(5001)
    await launchOn(mod, 9333, 5002)
    olderExit?.()
    const killing = mod.killChrome(9333, { profileDir: PROFILE, probe: noListeners, logger: quiet })
    await vi.advanceTimersByTimeAsync(300)
    await killing
    expect(signals).toContainEqual([-5002, 'SIGTERM'])
  })

  it('falls through to the verified listener path when nothing is tracked', async () => {
    const mod = await loadFresh()
    const probe = {
      listeners: (): number[] => [7002],
      commandLine: (): string | null => `chrome --remote-debugging-port=9333 --user-data-dir=${PROFILE}`,
      groupOf: (): number | null => null,
    }
    const killing = mod.killChrome(9333, { profileDir: PROFILE, probe, logger: quiet })
    await vi.advanceTimersByTimeAsync(300)
    await killing
    expect(signals.some(([pid]) => Math.abs(pid) === 7002)).toBe(true)
  })

  it('forgets the tracked pid after one kill', async () => {
    const mod = await loadFresh()
    await launchOn(mod, 9333, 5001)
    const first = mod.killChrome(9333, { profileDir: PROFILE, probe: noListeners, logger: quiet })
    await vi.advanceTimersByTimeAsync(300)
    await first
    signals.length = 0
    await mod.killChrome(9333, { profileDir: PROFILE, probe: noListeners, logger: quiet })
    expect(signals).toEqual([])
  })
})

describe('8468f7b1 [audit-fixes.2] P15 stale launch lock reclaim is atomic and never lock-less', () => {
  const enoent = (): never => {
    throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
  }

  it('renames a stale lock away, retries the exclusive open and launches while holding the lock', async () => {
    const mod = await loadFresh()
    let held = true
    m.openSync.mockImplementation(() => {
      if (held) return enoent()
      return 12
    })
    m.statSync.mockReturnValue({ mtimeMs: Date.now() - 60_000 })
    m.renameSync.mockImplementation(() => {
      held = false
    })
    m.spawn.mockReturnValue({ pid: 77, unref: vi.fn() })
    const p = mod.ensureChromeRunning({ port: 9555, chromePath: CHROME, profileDir: PROFILE, quiet: true })
    // reachable only after the spawn
    m.isChromeReachable.mockImplementation(async () => m.spawn.mock.calls.length > 0)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toMatchObject({ pid: 77, port: 9555 })
    expect(m.renameSync).toHaveBeenCalledTimes(1)
    expect(m.renameSync.mock.calls[0]?.[0]).toBe(lockOf(9555))
    expect(String(m.renameSync.mock.calls[0]?.[1])).toContain('.stale-')
    expect(m.closeSync).toHaveBeenCalledWith(12)
  })

  it('does not reclaim a fresh lock and raises LAUNCH_LOCK_TIMEOUT without launching', async () => {
    const mod = await loadFresh()
    m.openSync.mockImplementation(enoent)
    m.statSync.mockImplementation(() => ({ mtimeMs: Date.now() }))
    const p = mod.ensureChromeRunning({ port: 9555, chromePath: CHROME, profileDir: PROFILE, quiet: true })
    const assertion = expect(p).rejects.toMatchObject({ code: 'LAUNCH_LOCK_TIMEOUT' })
    // a fresh lock is refreshed continuously, so its age never passes the stale limit
    await vi.advanceTimersByTimeAsync(31_000)
    await assertion
    expect(m.renameSync).not.toHaveBeenCalled()
    expect(m.spawn).not.toHaveBeenCalled()
  })

  it('a lost rename race neither throws nor launches without the lock', async () => {
    const mod = await loadFresh()
    m.openSync.mockImplementation(enoent)
    m.statSync.mockImplementation(() => ({ mtimeMs: Date.now() - 60_000 }))
    m.renameSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const p = mod.ensureChromeRunning({ port: 9555, chromePath: CHROME, profileDir: PROFILE, quiet: true })
    const assertion = expect(p).rejects.toMatchObject({ code: 'LAUNCH_LOCK_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(31_000)
    await assertion
    expect(m.spawn).not.toHaveBeenCalled()
  })

  it('returns the winner\'s Chrome without launching when it appears while waiting', async () => {
    const mod = await loadFresh()
    m.openSync.mockImplementation(enoent)
    m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    const probeLine = `chrome --remote-debugging-port=9555 --user-data-dir=${PROFILE}`
    m.execSync.mockImplementation((cmd: string) => (cmd.includes('lsof') ? '4242' : probeLine))
    const p = mod.ensureChromeRunning({ port: 9555, chromePath: CHROME, profileDir: PROFILE, quiet: true })
    await vi.advanceTimersByTimeAsync(600)
    await expect(p).resolves.toEqual({ pid: null, port: 9555, profileDir: PROFILE })
    expect(m.spawn).not.toHaveBeenCalled()
  })
})

describe('8468f7b1 [audit-fixes.3] P16 a launch that never answers is torn down', () => {
  it('kills the spawned process group and forgets the pid on CHROME_START_TIMEOUT', async () => {
    const mod = await loadFresh()
    m.spawn.mockReturnValue({ pid: 6001, unref: vi.fn() })
    const p = mod.launchChrome({ port: 9666, chromePath: CHROME, profileDir: PROFILE })
    const assertion = expect(p).rejects.toMatchObject({ code: 'CHROME_START_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(10_500)
    await assertion
    expect(signals).toContainEqual([-6001, 'SIGKILL'])
    // The pid is forgotten: a later kill of the port signals nothing from the stale record.
    signals.length = 0
    await mod.killChrome(9666, { profileDir: PROFILE, probe: noListeners, logger: quiet })
    expect(signals).toEqual([])
  })
})
