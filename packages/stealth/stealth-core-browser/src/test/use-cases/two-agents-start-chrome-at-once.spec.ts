/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3]
 * Exercises AC5 (O_EXCL launch lock, cross-process coordination) and PA6.3 (no duplicate Chrome trees).
 *
 * Two agents ask for Chrome on the same port in the same instant. Only the holder of the per-port launch lock
 * spawns; the other waits for that Chrome to appear and attaches to it. A lock left behind by a launcher that
 * died is reclaimed after fifteen seconds.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const machine = vi.hoisted(() => ({ spawn: undefined as undefined | ((c: string, a: string[], o: Record<string, unknown>) => unknown) }))
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return { ...real, spawn: (c: string, a: string[], o: Record<string, unknown>) => machine.spawn?.(c, a, o), execSync: () => '' }
})

import { cdp } from '../../index.js'
import { FakeProc } from '../support/fake-proc.js'
import { ChromeWorld, makeLaunchRig, tempDir, type LaunchRig } from './scenario-kit.js'

const world = new ChromeWorld(9410)
const lockPath = join(tmpdir(), `stealth-chrome-launch-${world.port}.lock`)
let rig: LaunchRig
let dirs: ReturnType<typeof tempDir>
let chromePath: string
let profileDir: string

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  dirs = tempDir('lock')
  chromePath = join(dirs.dir, 'stand-in-browser')
  writeFileSync(chromePath, '')
  profileDir = join(dirs.dir, 'profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(lockPath, String(process.pid))
  world.up = false
  world.installFetch()
  rig = makeLaunchRig(new FakeProc(6000), world)
  machine.spawn = (c, a, o) => rig.spawn(c, a, o)
})
afterEach(() => {
  world.dispose()
  dirs.cleanup()
  vi.useRealTimers()
  rmSync(lockPath, { force: true })
  vi.restoreAllMocks()
})

const ensure = () => cdp.ensureChromeRunning({ port: world.port, profileDir, chromePath, probe: rig.probe, quiet: true })

describe('Scenario: two agents start Chrome at the same moment and only one process results', () => {
  it('[tests-use-cases.2] the loser waits for the winner’s Chrome and attaches without spawning', async () => {
    // The winner (another process) owns the lock and brings its Chrome up half a second later.
    const winner = rig.proc.addProcess({ command: 'winner-browser' })
    const winnerProbe = { ...rig.probe, listeners: () => (world.up ? [winner.pid] : []), commandLine: () => `winner-browser --user-data-dir=${profileDir}` }
    setTimeout(() => { world.up = true }, 500)
    const loser = cdp.ensureChromeRunning({ port: world.port, profileDir, chromePath, probe: winnerProbe, quiet: true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await loser).toEqual({ pid: null, port: world.port, profileDir })
    expect(rig.launched()).toHaveLength(0)
  })

  it('[tests-use-cases.2] a lock left by a dead launcher is reclaimed after fifteen seconds and the Chrome is launched once', async () => {
    const attempt = ensure()
    await vi.advanceTimersByTimeAsync(16_500)
    const result = await attempt
    expect(result.pid).not.toBeNull()
    expect(rig.launched()).toHaveLength(1)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('[tests-use-cases.3] no probe or request ever touched the default port', async () => {
    const attempt = ensure()
    await vi.advanceTimersByTimeAsync(16_500)
    await attempt
    expect(world.requested.length).toBeGreaterThan(0)
    expect(world.requested.every((u) => new URL(u).port === String(world.port))).toBe(true)
  })
})
