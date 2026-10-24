/**
 * Chrome kill timers: the 5 s cap of killProcessGroup never outlives the exit that made it moot.
 * Ticket 8468f7b1 · criteria [resolve-findings.2] F123.
 * guards: killProcessGroup leaves its 5 s fallback timer armed after the main pid exited, holding the event loop for up to 5 s
 * tier: S
 * cites: 8468f7b1 [resolve-findings.2] F123
 * plan: stealth-browser, state resolve-findings, task resolve-findings-implementer
 * teeth: red: nx run stealth-core-browser:test --skip-nx-cache -- test/unit/lifecycle/kill-fixes.spec.ts -> exit 1 with `clearTimeout(cap)` removed from killProcessGroup: 2 failed | 1 passed (vi.getTimerCount() is 1 after the kill resolved).
 * node:child_process, node:fs, node:os and ./targets are mocked and process.kill is replaced: nothing is spawned or signalled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { processDoubles, type ProcessDoubles } from '../../helpers/lifecycle/browser-mocks.js'

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

const PID = 4242

let d: ProcessDoubles

async function loadFresh(): Promise<BrowserModule> {
  vi.resetModules()
  return import('../../../src/lib/cdp/browser.js')
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

describe('[resolve-findings.2] F123 killProcessGroup cancels its fallback timer', () => {
  it('main exits at once: no timer is left pending once the kill resolved', async () => {
    const mod = await loadFresh()
    const p = mod.killProcessGroup(PID)
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(vi.getTimerCount()).toBe(0)
  })

  it('main exits after a few polls: the poll and the cap are both cancelled', async () => {
    const mod = await loadFresh()
    d.alive.add(PID)
    const p = mod.killProcessGroup(PID)
    await vi.advanceTimersByTimeAsync(1_000)
    d.alive.delete(PID)
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(vi.getTimerCount()).toBe(0)
  })

  it('main never exits: the cap resolves it at 5 s and nothing is left pending', async () => {
    const mod = await loadFresh()
    d.alive.add(PID)
    const p = mod.killProcessGroup(PID)
    await vi.advanceTimersByTimeAsync(5_200)
    await p
    expect(vi.getTimerCount()).toBe(0)
  })
})
