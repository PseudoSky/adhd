/**
 * Failsafe pins for the Chrome kill (src/lib/cdp/browser.ts `killChrome` /
 * `killProcessGroup`): the process-group kill of a tracked launch and the
 * port-occupant kill used by the reaper.
 * Ticket 8468f7b1 · [chrome-lifecycle.11] [chrome-lifecycle.12] ·
 * inventory [fs-044] [fs-045] [fs-046] [fs-047] [fs-048] [fs-049] [fs-050] [fs-051] [fs-052]
 *
 * node:child_process (execSync, spawn), node:fs, node:os and ./targets are
 * mocked and process.kill is replaced: nothing is spawned or signalled.
 * guards: sends SIGTERM to the whole process group
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.11] [chrome-lifecycle.12]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execScript, processDoubles, signals, type ProcessDoubles } from '../../helpers/lifecycle/browser-mocks.js'

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
let d: ProcessDoubles

/**
 * Fixture for the profile-identity filter (backlog 7f881aa7, [core-seam.6]): the command line `ps` reports for a
 * port occupant that is this tool's own Chrome (the default dedicated profile under the mocked HOME). The
 * assertions below are unchanged; the occupants simply identify themselves now.
 */
const OWN_PROFILE = '/fake/home/Library/Application Support/Google/Chrome-CDP'
const ownChrome = (pid: number): Record<string, string> => ({
  [`ps -o command= -p ${pid}`]: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=${PORT} --user-data-dir=${OWN_PROFILE} --no-first-run`,
})

async function loadFresh(): Promise<BrowserModule> {
  vi.resetModules()
  return import('../../../src/lib/cdp/browser.js')
}

async function launchTracked(mod: BrowserModule, pid: number): Promise<void> {
  m.spawn.mockReturnValue({ pid, unref: vi.fn() })
  m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
  const p = mod.launchChrome({ port: PORT, chromePath: '/fake/chrome', profileDir: '/fake/profile', quiet: true })
  await vi.advanceTimersByTimeAsync(250)
  await p
  d.log.length = 0
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

describe('8468f7b1 [chrome-lifecycle.11] process-group kill of a tracked launch', () => {
  it('sends SIGTERM to the whole process group', async () => {
    // [fs-044]
    const mod = await loadFresh()
    await launchTracked(mod, 4242)
    const p = mod.killChrome(PORT)
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(signals(d.log)[0]).toEqual({ pid: -4242, sig: 'SIGTERM' })
  })

  it('falls back to a single pid when the group is not addressable', async () => {
    // [fs-045]
    const mod = await loadFresh()
    d.ungrouped.add(-4242)
    const p = mod.killProcessGroup(4242)
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(signals(d.log).slice(0, 2)).toEqual([
      { pid: -4242, sig: 'SIGTERM' },
      { pid: 4242, sig: 'SIGTERM' },
    ])
  })

  it('SIGKILLs the group after 5 seconds and after the main exits', async () => {
    // [fs-046] main never dies: give up at 5 s, then SIGKILL the group.
    const mod = await loadFresh()
    d.alive.add(4242)
    let done = false
    const p = mod.killProcessGroup(4242).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(4_900)
    expect(done).toBe(false)
    expect(signals(d.log)).toEqual([{ pid: -4242, sig: 'SIGTERM' }])
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(signals(d.log)).toEqual([
      { pid: -4242, sig: 'SIGTERM' },
      { pid: -4242, sig: 'SIGKILL' },
    ])
    // Main already exited: the group is still SIGKILLed for orphaned Helpers.
    d.log.length = 0
    d.alive.clear()
    const q = mod.killProcessGroup(4343)
    await vi.advanceTimersByTimeAsync(250)
    await q
    expect(signals(d.log)).toEqual([
      { pid: -4343, sig: 'SIGTERM' },
      { pid: -4343, sig: 'SIGKILL' },
    ])
  })

  it('clears the remembered pid after a kill', async () => {
    // [fs-047]
    const mod = await loadFresh()
    await launchTracked(mod, 4242)
    const first = mod.killChrome(PORT)
    await vi.advanceTimersByTimeAsync(250)
    await first
    m.execSync.mockImplementation(execScript({ lsof: '', fuser: '' }))
    d.log.length = 0
    await mod.killChrome(PORT)
    expect(m.execSync).toHaveBeenCalledWith(`lsof -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8', timeout: 3000 })
    expect(signals(d.log)).toEqual([])
  })
})

describe('8468f7b1 [chrome-lifecycle.12] port-occupant kill (the reaper scope)', () => {
  it('closes the port occupant found with lsof', async () => {
    // [fs-048]
    const { killChrome } = await loadFresh()
    m.execSync.mockImplementation(execScript({ lsof: '111\n', ...ownChrome(111), 'ps -o pgid= -p 111': '111' }))
    await killChrome(PORT)
    expect(m.execSync).toHaveBeenCalledWith(`lsof -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8', timeout: 3000 })
    expect(signals(d.log)[0]).toEqual({ pid: -111, sig: 'SIGTERM' })
  })

  it('falls back to fuser when lsof finds nothing', async () => {
    // [fs-049]
    const { killChrome } = await loadFresh()
    m.execSync.mockImplementation(execScript({ lsof: '', fuser: '333', ...ownChrome(333), 'ps -o pgid= -p 333': '333' }))
    await killChrome(PORT)
    expect(m.execSync).toHaveBeenCalledWith(`fuser ${PORT}/tcp 2>/dev/null`, { encoding: 'utf8', timeout: 3000 })
    expect(signals(d.log)[0]).toEqual({ pid: -333, sig: 'SIGTERM' })
  })

  it("signals the occupant's process group", async () => {
    // [fs-050] the pgid comes from `ps -o pgid=`; a failed lookup keeps the pid.
    const { killChrome } = await loadFresh()
    m.execSync.mockImplementation(execScript({ lsof: '111\n222', ...ownChrome(111), ...ownChrome(222), 'ps -o pgid= -p 111': '900', 'ps -o pgid= -p 222': new Error('ps failed') }))
    await killChrome(PORT)
    expect(signals(d.log).filter((e) => e.sig === 'SIGTERM')).toEqual([
      { pid: -900, sig: 'SIGTERM' },
      { pid: -222, sig: 'SIGTERM' },
    ])
  })

  it('SIGKILLs the occupant group when it lingers', async () => {
    // [fs-051] the first listener dies after three 200 ms polls; its group (Helpers) is then SIGKILLed.
    const { killChrome } = await loadFresh()
    m.execSync.mockImplementation(execScript({ lsof: '111', ...ownChrome(111), 'ps -o pgid= -p 111': '111' }))
    d.alive.add(111)
    const p = killChrome(PORT)
    await vi.advanceTimersByTimeAsync(600)
    d.alive.delete(111)
    await vi.advanceTimersByTimeAsync(400)
    await p
    expect(signals(d.log)).toEqual([
      { pid: -111, sig: 'SIGTERM' },
      { pid: -111, sig: 'SIGKILL' },
    ])
  })

  it('the occupant wait is bounded to 25 polls and never SIGKILLs a listener that will not die', async () => {
    const { killChrome } = await loadFresh()
    m.execSync.mockImplementation(execScript({ lsof: '111', ...ownChrome(111), 'ps -o pgid= -p 111': '111' }))
    d.alive.add(111)
    const p = killChrome(PORT)
    await vi.advanceTimersByTimeAsync(5_200)
    await p
    expect(d.log.filter((e) => e.sig === 0).length).toBe(25)
    expect(signals(d.log)).toEqual([{ pid: -111, sig: 'SIGTERM' }])
  })

  it('does nothing when no process owns the port', async () => {
    // [fs-052]
    const { killChrome } = await loadFresh()
    m.execSync.mockImplementation(execScript({ lsof: new Error('lsof: not found'), fuser: new Error('fuser: not found') }))
    await expect(killChrome(PORT)).resolves.toBeUndefined()
    expect(d.log).toEqual([])
  })
})
