/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3] [tests-use-cases.4]
 * Exercises AC3 (stealth launch flags), AC5 (process-group kill, foreign-profile refusal), PA5.4 (typed launch codes).
 *
 * The Chrome a job was using has crashed and left helper processes behind. The job relaunches it on the same
 * port without ever attaching to somebody else's Chrome, cleans the orphaned process group, and meets a typed
 * error for each way the relaunch can fail: no binary, a port in use, a Chrome that never answers.
 */
import { writeFileSync } from 'node:fs'
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

const world = new ChromeWorld(9407)
let rig: LaunchRig
let dirs: ReturnType<typeof tempDir>
let chromePath: string
let profileDir: string

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  world.up = false
  world.installFetch()
  rig = makeLaunchRig(new FakeProc(7000), world)
  machine.spawn = (c, a, o) => rig.spawn(c, a, o)
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => rig.proc.kill(pid, sig ?? 'SIGTERM')) as typeof process.kill)
  dirs = tempDir('crash')
  chromePath = join(dirs.dir, 'stand-in-browser')
  writeFileSync(chromePath, '')
  profileDir = join(dirs.dir, 'profile')
})
afterEach(() => {
  world.dispose()
  dirs.cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const launch = (extra: Record<string, unknown> = {}) =>
  cdp.launchChrome({ port: world.port, profileDir, chromePath, probe: rig.probe, logger: () => undefined, ...extra })

describe('Scenario: recover a crashed Chrome without touching anyone else’s browser', () => {
  it('[tests-use-cases.2] relaunches after a crash with the stealth flag set, on the same port and profile', async () => {
    const first = launch()
    await vi.advanceTimersByTimeAsync(300)
    const a = await first
    expect(a).toMatchObject({ alreadyRunning: false, port: world.port, profileDir })

    rig.proc.die(a.pid!)
    world.up = false
    const second = launch()
    await vi.advanceTimersByTimeAsync(300)
    const b = await second
    expect(b.pid).not.toBe(a.pid)
    const [, relaunched] = rig.launched()
    expect(relaunched!.args).toEqual(expect.arrayContaining([`--remote-debugging-port=${world.port}`, `--user-data-dir=${profileDir}`, '--no-first-run']))
    expect(relaunched!.args).not.toContain('--enable-automation')
    expect(rig.proc.spawnLog.every((s) => s.opts['detached'] === true)).toBe(true)
  })

  it('[tests-use-cases.2] launching again while its own Chrome is up reuses it instead of spawning a second one', async () => {
    const first = launch()
    await vi.advanceTimersByTimeAsync(300)
    await first
    const again = await launch()
    expect(again).toMatchObject({ alreadyRunning: true, pid: null })
    expect(rig.launched()).toHaveLength(1)
  })

  it('[tests-use-cases.4] refuses to attach to a Chrome that runs a different profile (LAUNCH_FAILED foreign-profile)', async () => {
    const stranger = rig.proc.addProcess({ command: 'someone-elses-browser' })
    world.up = true
    const foreign = { ...rig.probe, listeners: () => [stranger.pid], commandLine: () => 'browser --user-data-dir=/home/other/profile --remote-debugging-port=9407' }
    await expect(launch({ probe: foreign })).rejects.toMatchObject({ code: 'LAUNCH_FAILED', detail: { reason: 'foreign-profile', port: world.port } })
    expect(rig.launched()).toHaveLength(0)
    expect(rig.proc.killLog).toEqual([])
  })

  it('[tests-use-cases.4] a missing browser binary is CHROME_NOT_FOUND before anything is spawned', async () => {
    await expect(launch({ chromePath: join(dirs.dir, 'not-installed') })).rejects.toMatchObject({ code: 'CHROME_NOT_FOUND' })
    expect(rig.launched()).toHaveLength(0)
  })

  it('[tests-use-cases.4] a Chrome that never answers is CHROME_START_TIMEOUT after ten seconds', async () => {
    rig.behaviour = 'silent'
    const pending = launch().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(10_500)
    expect(await pending).toMatchObject({ code: 'CHROME_START_TIMEOUT', detail: { port: world.port } })
  })

  it('[tests-use-cases.4] a port another program holds is PORT_IN_USE', async () => {
    rig.behaviour = { errno: 'EADDRINUSE' }
    const pending = launch().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(300)
    expect(await pending).toMatchObject({ code: 'PORT_IN_USE' })
  })

  it('[tests-use-cases.4] a binary that cannot be executed is CHROME_NOT_FOUND', async () => {
    rig.behaviour = { errno: 'ENOENT' }
    const pending = launch().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(300)
    expect(await pending).toMatchObject({ code: 'CHROME_NOT_FOUND' })
  })

  it('[tests-use-cases.2] killing the crashed Chrome signals its whole process group so renderer helpers do not linger', async () => {
    const first = launch()
    await vi.advanceTimersByTimeAsync(300)
    const a = await first
    const helper = rig.proc.addProcess({ pid: 7500, pgid: a.pid! })
    rig.proc.die(a.pid!)

    const killing = cdp.killChrome(world.port, { profileDir, probe: rig.probe, logger: () => undefined })
    await vi.advanceTimersByTimeAsync(1_000)
    await killing
    expect(rig.proc.killLog[0]).toEqual({ target: -a.pid!, signal: 'SIGTERM' })
    expect(rig.proc.pidAlive(helper.pid)).toBe(false)
  })

  it('[tests-use-cases.3] never touches the default port', () => {
    expect(world.requested.every((u) => new URL(u).port !== '9222')).toBe(true)
  })
})
