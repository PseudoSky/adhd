/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.4]
 * Exercises AC5 (launch circuit breaker, no launch storms) and PA5.4 (CHROME_UNREACHABLE_AFTER_LAUNCH, LAUNCH_FAILED, LAUNCH_CIRCUIT_OPEN).
 *
 * A broken install makes Chrome start but never answer. After three failed launches in a minute the manager
 * stops spawning processes and tells the caller when to try again; once the cooldown has passed and the
 * install is fixed, the next attempt works and the breaker closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const machine = vi.hoisted(() => ({ spawn: undefined as undefined | ((c: string, a: string[], o: Record<string, unknown>) => unknown) }))
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return { ...real, spawn: (c: string, a: string[], o: Record<string, unknown>) => machine.spawn?.(c, a, o), execSync: () => '/usr/bin/stand-in-browser\n' }
})
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return { ...real, existsSync: (p: string) => /MacOS\/Google Chrome$|stand-in-browser$/.test(String(p)) || real.existsSync(p) }
})

import { chromeManager, lifecycle } from '../../index.js'
import { FakeProc } from '../support/fake-proc.js'
import { ChromeWorld, PolicyReaperLink, makeLaunchRig, tempDir, type LaunchRig } from './scenario-kit.js'

const world = new ChromeWorld(9409)
let rig: LaunchRig
let dirs: ReturnType<typeof tempDir>
let manager: chromeManager.ChromeManager

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  dirs = tempDir('breaker')
  world.up = false
  world.installFetch()
  world.useCdp({ meta: { name: 'window-hiding', origin: 'synthetic-protocol-conformant' }, steps: [] })
  rig = makeLaunchRig(new FakeProc(9000), world)
  machine.spawn = (c, a, o) => rig.spawn(c, a, o)
  manager = new chromeManager.ChromeManager({
    cdpHost: `127.0.0.1:${world.port}`, keepAlive: true, stateDir: dirs.dir, userDataDir: `${dirs.dir}/profile`,
    link: new PolicyReaperLink(world, () => false), logger: () => undefined,
  })
})
afterEach(() => {
  world.dispose()
  dirs.cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function failOnce(): Promise<unknown> {
  const attempt = manager.ready().catch((e: unknown) => e)
  await vi.advanceTimersByTimeAsync(10_500)
  return attempt
}

describe('Scenario: stop hammering a Chrome that will not start', () => {
  it('[tests-use-cases.4] a Chrome that starts but never answers is CHROME_UNREACHABLE_AFTER_LAUNCH', async () => {
    rig.behaviour = 'silent'
    expect(await failOnce()).toMatchObject({ code: 'CHROME_UNREACHABLE_AFTER_LAUNCH', detail: { port: world.port } })
    expect(manager.isReady).toBe(false)
  })

  it('[tests-use-cases.4] the fourth attempt is refused with LAUNCH_CIRCUIT_OPEN and spawns nothing', async () => {
    rig.behaviour = 'silent'
    for (let i = 0; i < lifecycle.LAUNCH_FAILURE_THRESHOLD; i++) await failOnce()
    expect(rig.launched()).toHaveLength(lifecycle.LAUNCH_FAILURE_THRESHOLD)

    const refused = await manager.ready().catch((e: unknown) => e)
    expect(refused).toMatchObject({ code: 'LAUNCH_CIRCUIT_OPEN', detail: { port: world.port } })
    expect((refused as { detail: { retryAfterMs: number } }).detail.retryAfterMs).toBeGreaterThan(0)
    expect(rig.launched()).toHaveLength(lifecycle.LAUNCH_FAILURE_THRESHOLD)
    expect((await manager.status()).breaker.open).toBe(true)
  })

  it('[tests-use-cases.2] after the cooldown a fixed install launches again and the breaker closes', async () => {
    rig.behaviour = 'silent'
    for (let i = 0; i < lifecycle.LAUNCH_FAILURE_THRESHOLD; i++) await failOnce()
    await vi.advanceTimersByTimeAsync(lifecycle.LAUNCH_COOLDOWN_MS + 1_000)

    rig.behaviour = 'answers'
    const recovering = manager.ready()
    await vi.advanceTimersByTimeAsync(300)
    await recovering
    expect(manager.isReady).toBe(true)
    expect((await manager.status()).breaker.open).toBe(false)
  })

  it('[tests-use-cases.4] a binary the OS cannot execute is LAUNCH_FAILED naming the port', async () => {
    rig.behaviour = { errno: 'EACCES' }
    const attempt = manager.ready().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(300)
    expect(await attempt).toMatchObject({ code: 'LAUNCH_FAILED', detail: { port: world.port } })
  })
})
