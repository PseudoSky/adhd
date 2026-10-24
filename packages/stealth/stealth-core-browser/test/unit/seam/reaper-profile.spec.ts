/**
 * The reaper's port-occupant kill uses the RESOLVED profile: `ChromeReaperConfig.profileDir` reaches
 * `killChrome(port, { profileDir })` through `runChromeReaper`, so a Chrome started with an override
 * `--user-data-dir` is reaped and a foreign Chrome (the operator's real one) is never signalled.
 * Ticket 8468f7b1 · [core-seam.11] (orchestrator finding, reaper profile).
 * The probe and the signals are injected (process.kill is replaced, the machine is a list of listeners and
 * command lines), CDP and the service proxy are the simulated world: no real process, no real Chrome, no socket.
 * guards: with an override profileDir the occupant carrying the override --user-data-dir is signalled through killChrome
 * tier: S
 * cites: 8468f7b1 [core-seam.11]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execSync: () => {
    throw new Error('the unit lane must never run a real command')
  },
  spawn: () => {
    throw new Error('the unit lane must never spawn')
  },
}))
vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('node:os', () => ({ homedir: () => '/home/operator', platform: () => 'darwin', tmpdir: () => '/tmp' }))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))
vi.mock('../../../src/lib/storage/history.js', () => ({ HistoryClient: class { isRecentlyUsed(): boolean { return false } } }))

import type { ProcessProbe } from '../../../src/lib/cdp/browser.js'
import { REAPER_TICK_MS, runChromeReaper, type ChromeReaperConfig } from '../../../src/lib/lifecycle/reaper-entry.js'
import { createProxyReaperLink } from '../../../src/lib/lifecycle/reaper-link.js'
import { PORT, resetSp, resetWorld, sp, STATE_DIR, world } from '../../helpers/lifecycle/manager-world.js'
import { must } from '../../helpers/must.js'

const DEFAULT_PROFILE = '/home/operator/Library/Application Support/Google/Chrome-CDP'
const OVERRIDE_PROFILE = '/data/other-profile'
const REAL_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const cmdOf = (dir?: string): string => `${REAL_CHROME} --remote-debugging-port=${PORT}${dir ? ` --user-data-dir=${dir}` : ''} --no-first-run`

const CFG: ChromeReaperConfig = {
  port: PORT,
  stateDir: STATE_DIR,
  socketPath: `${STATE_DIR}/reaper.sock`,
  idleTimeoutMs: 20_000,
  shutdownGraceMs: 5_000,
  orphanWindowMs: 12_000,
}

let signalled: Array<[number, string | number | undefined]>
let logs: string[]

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
  world.fs.mkdirSync(STATE_DIR, { recursive: true })
  world.chromeUp = true
  signalled = []
  logs = []
  sp.serveBackend = vi.fn(async (opts: Record<string, unknown>) => ({ socketPath: String(opts['socketPath']), close: async () => undefined }))
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    signalled.push([pid, sig])
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    return true
  }) as typeof process.kill)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const real = (): number[] => signalled.filter(([, s]) => s !== 0).map(([pid]) => Math.abs(pid))

function probeOf(pid: number, cmd: string): ProcessProbe {
  return { listeners: () => [pid], commandLine: () => cmd, groupOf: () => pid }
}

/** Start the reaper, let the idle tick reap, and stop it. */
async function reapWith(cfg: Partial<ChromeReaperConfig>, probe: ProcessProbe) {
  const r = await runChromeReaper({ ...CFG, ...cfg }, { logger: (m) => logs.push(m), killOptions: { probe } })
  await vi.advanceTimersByTimeAsync(CFG.idleTimeoutMs + CFG.shutdownGraceMs + REAPER_TICK_MS)
  await r.close()
}

describe('8468f7b1 [core-seam.11] runChromeReaper kills only the resolved profile (ChromeReaperConfig.profileDir)', () => {
  it('with an override profileDir the occupant carrying the override --user-data-dir is signalled through killChrome', async () => {
    await reapWith({ profileDir: OVERRIDE_PROFILE }, probeOf(7001, cmdOf(OVERRIDE_PROFILE)))
    expect(real()).toContain(7001)
  })

  it('with an override profileDir an occupant of the default profile is foreign: skipped with a logged reason, never signalled', async () => {
    await reapWith({ profileDir: OVERRIDE_PROFILE }, probeOf(7002, cmdOf(DEFAULT_PROFILE)))
    expect(real()).toEqual([])
    expect(logs.some((l) => l.includes('killChrome: skipped pid 7002') && l.includes(`--user-data-dir=${OVERRIDE_PROFILE}`))).toBe(true)
  })

  it("an occupant with no --user-data-dir (the operator's real Chrome) is foreign: never signalled", async () => {
    await reapWith({ profileDir: OVERRIDE_PROFILE }, probeOf(7003, cmdOf()))
    expect(real()).toEqual([])
  })

  it('without an override profileDir the default-profile occupant is reaped', async () => {
    await reapWith({}, probeOf(7004, cmdOf(DEFAULT_PROFILE)))
    expect(real()).toContain(7004)
  })

  it('without an override profileDir an occupant of another --user-data-dir is foreign and skipped', async () => {
    await reapWith({}, probeOf(7005, cmdOf(OVERRIDE_PROFILE)))
    expect(real()).toEqual([])
  })
})

describe('8468f7b1 [core-seam.11] createProxyReaperLink hands the resolved profileDir to the reaper (ChromeReaperConfig)', () => {
  it('the config the detached reaper receives carries the override profileDir, and none when no override is set', async () => {
    const configs: ChromeReaperConfig[] = []
    sp.ensureBackend = vi.fn(async (o: Record<string, unknown>) => {
      const argv = (o['args'] ?? o['argv'] ?? []) as string[]
      const json = argv.find((a) => a.startsWith('{'))
      if (json) configs.push(JSON.parse(json) as ChromeReaperConfig)
      return { disposition: 'started', detail: 'test' }
    })
    const common = { port: PORT, stateDir: STATE_DIR, pid: 1, checkHistory: true, idleTimeoutMs: 1, shutdownGraceMs: 1, orphanWindowMs: 1, scope: 'port-occupant' as const, entryPath: '/pkg/dist/index.js' }
    for (const profileDir of [OVERRIDE_PROFILE, undefined]) {
      const link = createProxyReaperLink({ ...common, ...(profileDir ? { profileDir } : {}), logger: () => undefined })
      void link.ensureAndHello().catch(() => false)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(configs.length).toBeGreaterThanOrEqual(2)
    expect(must(configs[0]).profileDir).toBe(OVERRIDE_PROFILE)
    expect(configs[1]).not.toHaveProperty('profileDir')
  })
})
