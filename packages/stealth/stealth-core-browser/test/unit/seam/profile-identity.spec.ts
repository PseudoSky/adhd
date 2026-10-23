/**
 * Profile identity before a process is touched (backlog 7f881aa7): the attach
 * and kill paths act only on this tool's own Chrome (its `--user-data-dir` is
 * the RESOLVED profile), never on the operator's real Chrome that happens to
 * hold the default port 9222.
 * Ticket 8468f7b1 · [core-seam.6] · backlog 7f881aa7 (defaults per 8332a825).
 *
 * The process probe is injected: a simulated machine of listeners and command
 * lines. node:child_process is mocked to fail loudly if anything reaches it,
 * node:fs is a MemFs, process.kill is replaced and the CDP reachability check
 * is a stub: no real Chrome is attached to or signalled and port 9222 is never
 * contacted.
 * guards: launchChrome on 9222 attaches to a Chrome whose --user-data-dir is the resolved default profile (probe sees it)
 * tier: S
 * cites: 8468f7b1 [core-seam.6]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  execSync: vi.fn(() => {
    throw new Error('the unit lane must never run a real command')
  }),
  spawn: vi.fn(() => {
    throw new Error('the unit lane must never spawn')
  }),
  isChromeReachable: vi.fn(async () => true),
}))

vi.mock('node:child_process', () => ({ execSync: m.execSync, spawn: m.spawn }))
vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('node:os', () => ({ homedir: () => '/home/operator', platform: () => 'darwin', tmpdir: () => '/tmp' }))
vi.mock('../../../src/lib/cdp/targets.js', () => ({ isChromeReachable: m.isChromeReachable }))

import { resetWorld, world } from '../../helpers/lifecycle/manager-world.js'
import type { ProcessProbe } from '../../../src/lib/cdp/browser.js'

type BrowserModule = typeof import('../../../src/lib/cdp/browser.js')

const PORT = 9222
const OWN_PROFILE = '/home/operator/Library/Application Support/Google/Chrome-CDP'
const REAL_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

interface Proc {
  pid: number
  pgid?: number
  cmd: string | null
}

/** A simulated machine: the processes listening on 9222 and what `ps` reports for each. */
function probeOf(procs: Proc[]): ProcessProbe {
  return {
    listeners: () => procs.map((p) => p.pid),
    commandLine: (pid) => procs.find((p) => p.pid === pid)?.cmd ?? null,
    groupOf: (pid) => procs.find((p) => p.pid === pid)?.pgid ?? null,
  }
}

const ownCmd = (dir = OWN_PROFILE): string => `${REAL_CHROME} --remote-debugging-port=${PORT} --user-data-dir=${dir} --no-first-run`
/** The operator's everyday Chrome: started by hand with only the debugging port, i.e. the default profile. */
const operatorCmd = `${REAL_CHROME} --remote-debugging-port=${PORT}`

let mod: BrowserModule
let signalled: Array<[number, string | number | undefined]>
let logs: string[]

beforeEach(async () => {
  vi.useFakeTimers()
  resetWorld()
  m.execSync.mockClear()
  m.spawn.mockClear()
  m.isChromeReachable.mockReset()
  m.isChromeReachable.mockResolvedValue(true)
  signalled = []
  logs = []
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    signalled.push([pid, sig])
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) // the signalled pid is already gone
    return true
  }) as typeof process.kill)
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => void logs.push(String(msg)))
  // One module instance (no resetModules): no launch is ever tracked here, and the MemFs `world` must stay the one the module reads.
  mod = await import('../../../src/lib/cdp/browser.js')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const real = (): Array<[number, string | number | undefined]> => signalled.filter(([, s]) => s !== 0)

describe('8468f7b1 [core-seam.6] attach: own Chrome is attached (backlog 7f881aa7)', () => {
  it('launchChrome on 9222 attaches to a Chrome whose --user-data-dir is the resolved default profile (probe sees it)', async () => {
    const probe = probeOf([{ pid: 4242, cmd: ownCmd() }])
    await expect(mod.launchChrome({ probe })).resolves.toEqual({ pid: null, port: PORT, alreadyRunning: true, profileDir: OWN_PROFILE })
    expect(m.spawn).not.toHaveBeenCalled()
  })

  it('ensureChromeRunning attaches to the own Chrome and takes no launch lock', async () => {
    const r = await mod.ensureChromeRunning({ probe: probeOf([{ pid: 4242, cmd: ownCmd() }]), quiet: true })
    expect(r).toEqual({ pid: null, port: PORT, profileDir: OWN_PROFILE })
    expect(world.fs.existsSync('/tmp/stealth-chrome-launch-9222.lock')).toBe(false)
  })

  it('the profile DevToolsActivePort naming the port proves ownership when no listener command line is readable (probe blind)', async () => {
    world.fs.mkdirSync(OWN_PROFILE, { recursive: true })
    world.fs.writeFileSync(`${OWN_PROFILE}/DevToolsActivePort`, `${PORT}\n/devtools/browser/abc`)
    const blind = probeOf([{ pid: 4242, cmd: null }])
    await expect(mod.launchChrome({ probe: blind })).resolves.toMatchObject({ alreadyRunning: true })
  })
})

describe('8468f7b1 [core-seam.6] attach: a foreign-profile Chrome is refused with LAUNCH_FAILED (backlog 7f881aa7)', () => {
  it("the operator's real Chrome on 9222 (no --user-data-dir, the default profile) is not attached to: LAUNCH_FAILED reason foreign-profile", async () => {
    const probe = probeOf([{ pid: 777, cmd: operatorCmd }])
    const err = await mod.launchChrome({ probe }).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'LifecycleError' })
    expect(err).toMatchObject({ code: 'LAUNCH_FAILED', detail: { port: PORT, reason: 'foreign-profile', path: OWN_PROFILE } })
    expect(m.spawn).not.toHaveBeenCalled()
    expect(real()).toEqual([])
  })

  it('ensureChromeRunning refuses at every reachable check: the first, the lock loser wait and the re-check under the lock (foreign-profile)', async () => {
    const probe = probeOf([{ pid: 777, cmd: ownCmd('/Users/operator/Library/Application Support/Google/Chrome') }])
    // 1. reachable at once
    await expect(mod.ensureChromeRunning({ probe, quiet: true })).rejects.toMatchObject({ detail: { reason: 'foreign-profile' } })
    // 2. the operator's Chrome appears while this process waits behind a held launch lock
    m.isChromeReachable.mockReset()
    m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    const held = world.fs.openSync('/tmp/stealth-chrome-launch-9222.lock', 'wx')
    const waiting = mod.ensureChromeRunning({ probe, quiet: true })
    const asserted = expect(waiting).rejects.toMatchObject({ code: 'LAUNCH_FAILED', detail: { reason: 'foreign-profile' } })
    await vi.advanceTimersByTimeAsync(300)
    await asserted
    world.fs.closeSync(held)
    // 3. the re-check under the lock sees it
    world.fs.unlinkSync('/tmp/stealth-chrome-launch-9222.lock')
    m.isChromeReachable.mockReset()
    m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    await expect(mod.ensureChromeRunning({ probe, quiet: true })).rejects.toMatchObject({ detail: { reason: 'foreign-profile' } })
    expect(m.spawn).not.toHaveBeenCalled()
    expect(world.fs.existsSync('/tmp/stealth-chrome-launch-9222.lock')).toBe(false)
  })

  it('a stale own DevToolsActivePort never outvotes a readable foreign command line (probe evidence wins)', async () => {
    world.fs.mkdirSync(OWN_PROFILE, { recursive: true })
    world.fs.writeFileSync(`${OWN_PROFILE}/DevToolsActivePort`, `${PORT}\n/devtools/browser/old`)
    const probe = probeOf([{ pid: 777, cmd: operatorCmd }])
    await expect(mod.launchChrome({ probe })).rejects.toMatchObject({ detail: { reason: 'foreign-profile' } })
  })

  it('fails closed: an unreadable probe and no DevToolsActivePort is foreign-profile, and the refusal is logged', async () => {
    const blind = probeOf([])
    await expect(mod.launchChrome({ probe: blind })).rejects.toMatchObject({ code: 'LAUNCH_FAILED', detail: { reason: 'foreign-profile' } })
    expect(logs.some((l) => l.includes('refusing to attach'))).toBe(true)
  })

  it('a lookalike --user-data-dir (a longer path or a backup directory) is not the resolved profile', () => {
    expect(mod.commandLineCarriesProfile(ownCmd(`${OWN_PROFILE}2`), OWN_PROFILE)).toBe(false)
    expect(mod.commandLineCarriesProfile(ownCmd(`${OWN_PROFILE} Backup`), OWN_PROFILE)).toBe(false)
    expect(mod.commandLineCarriesProfile(ownCmd(`${OWN_PROFILE}/Default`), OWN_PROFILE)).toBe(false)
    expect(mod.commandLineCarriesProfile(ownCmd(OWN_PROFILE), OWN_PROFILE)).toBe(true)
    expect(mod.commandLineCarriesProfile(`${REAL_CHROME} --user-data-dir=${OWN_PROFILE}/ --no-first-run`, OWN_PROFILE)).toBe(true)
    expect(mod.commandLineCarriesProfile(`${REAL_CHROME} --user-data-dir=${OWN_PROFILE}`, OWN_PROFILE)).toBe(true)
  })
})

describe('8468f7b1 [core-seam.6] killChrome signals only a pid whose command line carries the resolved --user-data-dir (backlog 7f881aa7)', () => {
  it("killChrome(9222) skips the operator's real Chrome with a logged reason and signals nothing", async () => {
    const probe = probeOf([{ pid: 777, pgid: 777, cmd: operatorCmd }])
    await mod.killChrome(PORT, { probe })
    expect(real()).toEqual([])
    expect(signalled).toEqual([])
    expect(logs.join('\n')).toMatch(/skipped pid 777 on port 9222.*--user-data-dir=/)
  })

  it('killChrome of an own occupant: its process group gets SIGTERM, then the lingering group SIGKILL', async () => {
    const probe = probeOf([{ pid: 4242, pgid: 4200, cmd: ownCmd() }])
    await mod.killChrome(PORT, { probe })
    expect(real()[0]).toEqual([-4200, 'SIGTERM'])
    expect(real()[real().length - 1]).toEqual([-4242, 'SIGKILL'])
    expect(logs).toEqual([])
  })

  it('killChrome of two listeners signals only the own one (an unrelated server on 9222 is spared)', async () => {
    const probe = probeOf([
      { pid: 100, pgid: 100, cmd: 'node /srv/other-service.js --port 9222' },
      { pid: 4242, pgid: 4242, cmd: ownCmd() },
      { pid: 5, cmd: null },
    ])
    await mod.killChrome(PORT, { probe })
    expect(real().filter(([, s]) => s === 'SIGTERM')).toEqual([[-4242, 'SIGTERM']])
    expect(logs.filter((l) => l.includes('skipped pid'))).toHaveLength(2)
    expect(logs.join('\n')).toContain('unreadable')
  })

  it('killChrome with nobody on the port does nothing', async () => {
    await mod.killChrome(PORT, { probe: probeOf([]) })
    expect(signalled).toEqual([])
  })
})

describe('8468f7b1 [core-seam.6] an override profile dir is honored by every check (user-data-dir, probe, backlog 7f881aa7)', () => {
  const OVERRIDE = '/srv/crawler/profile'

  it('attach: a Chrome on the override user-data-dir is attached to, the default-profile Chrome is foreign-profile', async () => {
    await expect(mod.launchChrome({ profileDir: OVERRIDE, probe: probeOf([{ pid: 9, cmd: ownCmd(OVERRIDE) }]) })).resolves.toMatchObject({
      alreadyRunning: true,
      profileDir: OVERRIDE,
    })
    await expect(mod.launchChrome({ profileDir: OVERRIDE, probe: probeOf([{ pid: 9, cmd: ownCmd() }]) })).rejects.toMatchObject({
      detail: { reason: 'foreign-profile', path: OVERRIDE },
    })
  })

  it('killChrome: only the override-profile occupant is signalled; the default-profile Chrome is skipped', async () => {
    await mod.killChrome(PORT, { profileDir: OVERRIDE, probe: probeOf([{ pid: 9, pgid: 9, cmd: ownCmd() }]) })
    expect(real()).toEqual([])
    await mod.killChrome(PORT, { profileDir: OVERRIDE, probe: probeOf([{ pid: 9, pgid: 9, cmd: ownCmd(OVERRIDE) }]) })
    expect(real()[0]).toEqual([-9, 'SIGTERM'])
  })

  it('the defaults are exported constants: port 9222 and the Chrome-CDP profile name', () => {
    expect(mod.DEFAULT_CDP_PORT).toBe(9222)
    expect(mod.DEFAULT_PROFILE_NAME).toBe('Chrome-CDP')
  })
})

describe('8468f7b1 [core-seam.6] the manager keeps the refusal typed and never counts it as a failed launch (foreign-profile, LAUNCH_FAILED)', () => {
  it('ChromeManager.ready() rethrows the foreign-profile LifecycleError unchanged and the circuit breaker stays closed', async () => {
    vi.resetModules()
    vi.doMock('../../../src/lib/cdp/browser.js', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      ensureChromeRunning: async (o: { port?: number; profileDir?: string }) => {
        const { lifecycleError } = await import('../../../src/lib/lifecycle/errors.js')
        throw lifecycleError('LAUNCH_FAILED', 'foreign', { detail: { port: o.port, path: o.profileDir, reason: 'foreign-profile' } })
      },
    }))
    const { ChromeManager } = await import('../../../src/lib/chrome-manager.js')
    const { FakeReaperHub, FakeReaperLink } = await import('../../helpers/lifecycle/fake-reaper-link.js')
    const hub = new FakeReaperHub({
      makeHost: () => {
        throw new Error('no host')
      },
    })
    const manager = new ChromeManager({
      cdpHost: `127.0.0.1:${PORT}`,
      userDataDir: OWN_PROFILE,
      stateDir: '/state/identity',
      link: new FakeReaperLink(hub, { pid: 1, checkHistory: true }),
      logger: () => undefined,
    })
    for (let i = 0; i < 5; i++) {
      const err = await manager.ready().catch((e: unknown) => e)
      expect(err).toMatchObject({ code: 'LAUNCH_FAILED', detail: { reason: 'foreign-profile', path: OWN_PROFILE } })
    }
    expect((await manager.status()).breaker.open).toBe(false)
    vi.doUnmock('../../../src/lib/cdp/browser.js')
  })
})
