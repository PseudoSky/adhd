/**
 * CL11 (F18) group kill: `killProcessGroup(pid)` is the tracked branch of
 * `killChrome`, extracted unchanged. For the same process behavior it issues
 * the identical `process.kill` call log as the tracked-launch kill: SIGTERM to
 * the group (single-pid fallback), a bounded wait (200 ms polls, 5 s cap) on
 * the main pid, then an unconditional SIGKILL of the group.
 * Ticket 8468f7b1 · [chrome-lifecycle.11]
 *
 * node:child_process, node:fs, node:os and ./targets are mocked and
 * process.kill is replaced: nothing is spawned or signalled.
 * guards: main exits at once: SIGTERM the group, one probe, then SIGKILL the group — identical logs
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.11]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { processDoubles, signals, type KillEntry, type ProcessDoubles } from '../../helpers/lifecycle/browser-mocks.js'

const m = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 11),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(),
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
}))
vi.mock('node:os', () => ({ homedir: () => '/fake/home', platform: () => 'darwin', tmpdir: () => '/fake/tmp' }))
vi.mock('../../../src/lib/cdp/targets.js', () => ({ isChromeReachable: m.isChromeReachable }))

type BrowserModule = typeof import('../../../src/lib/cdp/browser.js')

const PORT = 9333
const PID = 4242

let d: ProcessDoubles

async function loadFresh(): Promise<BrowserModule> {
  vi.resetModules()
  return import('../../../src/lib/cdp/browser.js')
}

/** Launch through launchChrome so the module tracks PID, then kill via killChrome; returns the call log. */
async function trackedLog(setup: (d: ProcessDoubles) => void, advanceMs: number): Promise<KillEntry[]> {
  const mod = await loadFresh()
  m.spawn.mockReturnValue({ pid: PID, unref: vi.fn() })
  m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
  const launched = mod.launchChrome({ port: PORT, chromePath: '/fake/chrome', profileDir: '/fake/profile', quiet: true })
  await vi.advanceTimersByTimeAsync(250)
  await launched
  d.log.length = 0
  setup(d)
  const p = mod.killChrome(PORT)
  await vi.advanceTimersByTimeAsync(advanceMs)
  await p
  return [...d.log]
}

async function extractedLog(setup: (d: ProcessDoubles) => void, advanceMs: number): Promise<KillEntry[]> {
  const mod = await loadFresh()
  d.log.length = 0
  d.alive.clear()
  d.ungrouped.clear()
  setup(d)
  const p = mod.killProcessGroup(PID)
  await vi.advanceTimersByTimeAsync(advanceMs)
  await p
  return [...d.log]
}

beforeEach(() => {
  vi.useFakeTimers()
  m.spawn.mockReset()
  m.execSync.mockReset()
  m.isChromeReachable.mockReset()
  d = processDoubles()
  vi.spyOn(process, 'kill').mockImplementation(d.kill)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [chrome-lifecycle.11] killProcessGroup equals the tracked branch of killChrome', () => {
  it('main exits at once: SIGTERM the group, one probe, then SIGKILL the group — identical logs', async () => {
    const tracked = await trackedLog(() => undefined, 250)
    const extracted = await extractedLog(() => undefined, 250)
    expect(extracted).toEqual(tracked)
    expect(signals(extracted)).toEqual([
      { pid: -PID, sig: 'SIGTERM' },
      { pid: -PID, sig: 'SIGKILL' },
    ])
  })

  it('main never dies: bounded 5 s wait, then SIGKILL the group — identical logs', async () => {
    const tracked = await trackedLog((x) => x.alive.add(PID), 5200)
    const extracted = await extractedLog((x) => x.alive.add(PID), 5200)
    expect(extracted).toEqual(tracked)
    const probes = extracted.filter((e) => e.sig === 0)
    // 200 ms polls up to the 5000 ms cap: 25 probes (the 5000 ms poll is scheduled before the cap timer), never more.
    expect(probes.length).toBe(25)
    expect(signals(extracted)).toEqual([
      { pid: -PID, sig: 'SIGTERM' },
      { pid: -PID, sig: 'SIGKILL' },
    ])
  })

  it('group not addressable: falls back to the single pid for SIGTERM — identical logs', async () => {
    const setup = (x: ProcessDoubles) => x.ungrouped.add(-PID)
    const tracked = await trackedLog(setup, 250)
    const extracted = await extractedLog(setup, 250)
    expect(extracted).toEqual(tracked)
    expect(signals(extracted).slice(0, 2)).toEqual([
      { pid: -PID, sig: 'SIGTERM' },
      { pid: PID, sig: 'SIGTERM' },
    ])
  })

  it('never shells out (no lsof, no fuser, no ps)', async () => {
    await extractedLog(() => undefined, 250)
    expect(m.execSync).not.toHaveBeenCalled()
  })

  it('does not resolve before the main pid exits or the 5 s cap', async () => {
    const mod = await loadFresh()
    d.alive.add(PID)
    let done = false
    const p = mod.killProcessGroup(PID).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(4_900)
    expect(done).toBe(false)
    d.alive.delete(PID)
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(done).toBe(true)
  })
})
