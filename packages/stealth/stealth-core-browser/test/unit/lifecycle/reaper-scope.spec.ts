/**
 * CL12 (F19) reaper scope, through the reaper host wired to the REAL kill
 * functions of src/lib/cdp/browser.ts (exec and process.kill doubled).
 * Ticket 8468f7b1 · [chrome-lifecycle.12]
 *
 * - scope `port-occupant` (the default) with no owner record signals the port
 *   occupant: lsof, then fuser, with its pgid;
 * - a VALID owner record (`isSameProcess(pid, procStart)`: the pid is alive
 *   AND its start token matches) is killed through the tracked group kill of
 *   exactly that pid, never through port discovery;
 * - a recycled pid (same number, different procStart) is never signalled;
 * - scope `launched-only` never signals an unrecorded process.
 * guards: with no owner record signals the port occupant found by lsof, with its pgid
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.12]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeProc } from '../../helpers/fake-proc.js'
import { execScript, processDoubles, signals, type ProcessDoubles } from '../../helpers/lifecycle/browser-mocks.js'
import { makeHost, resultOf } from '../../helpers/lifecycle/host-fixture.js'
import type { OwnerRecord } from '../../../src/lib/lifecycle/reaper-host.js'
import type { ReaperScope } from '../../../src/lib/lifecycle/reap-policy.js'

const m = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  isChromeReachable: vi.fn(),
}))

vi.mock('node:child_process', () => ({ execSync: m.execSync, spawn: m.spawn }))
vi.mock('node:os', () => ({ homedir: () => '/fake/home', platform: () => 'darwin', tmpdir: () => '/fake/tmp' }))
vi.mock('../../../src/lib/cdp/targets.js', () => ({ isChromeReachable: m.isChromeReachable }))

const PORT = 9333
let d: ProcessDoubles
let procs: FakeProc

/** The pid-reuse-safe identity check (the reaper host is given `isSameProcess` of the service proxy). */
function isSameProcess(pid: number, procStart: string | null): boolean {
  return procs.pidAlive(pid) && procStart !== null && procs.procStart(pid) === procStart
}

async function hostWith(scope: ReaperScope | undefined, owner: OwnerRecord | null) {
  vi.resetModules()
  const browser = await import('../../../src/lib/cdp/browser.js')
  const h = makeHost(
    {
      ...(scope ? { scope } : {}),
      owner: {
        read: () => owner,
        isValid: (rec) => isSameProcess(rec.pid, rec.procStart),
        remove: () => undefined,
      },
      killProcessGroup: browser.killProcessGroup,
      killChrome: browser.killChrome,
    },
    { owner },
  )
  await h.join('A', 1)
  return h
}

async function reap(h: Awaited<ReturnType<typeof hostWith>>): Promise<{ action: string; reaped: boolean }> {
  const pending = h.call('A', 'reapIfIdle')
  await vi.advanceTimersByTimeAsync(5_200)
  return resultOf(await pending)
}

beforeEach(() => {
  vi.useFakeTimers()
  m.execSync.mockReset()
  d = processDoubles()
  vi.spyOn(process, 'kill').mockImplementation(d.kill)
  procs = new FakeProc()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const HOME_PROFILE = '/fake/home/Library/Application Support/Google/Chrome-CDP'
/** Profile-identity fixture (backlog 7f881aa7, [core-seam.6]): the occupant is this tool's own Chrome (default profile under the mocked HOME). */
const ownCmd = (pid: number): Record<string, string> => ({
  [`ps -o command= -p ${pid}`]: `/Applications/Google Chrome --user-data-dir=${HOME_PROFILE} --no-first-run`,
})

describe("8468f7b1 [chrome-lifecycle.12] scope 'port-occupant' (default)", () => {
  it('with no owner record signals the port occupant found by lsof, with its pgid', async () => {
    m.execSync.mockImplementation(execScript({ lsof: '5150', ...ownCmd(5150), 'ps -o pgid= -p 5150': '5100' }))
    const h = await hostWith(undefined, null)
    expect(await reap(h)).toMatchObject({ action: 'reap', reaped: true })
    expect(m.execSync).toHaveBeenCalledWith(`lsof -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null`, expect.anything())
    expect(signals(d.log)[0]).toEqual({ pid: -5100, sig: 'SIGTERM' })
  })

  it('falls back to fuser when lsof finds nothing', async () => {
    m.execSync.mockImplementation(execScript({ lsof: '', fuser: '6160', ...ownCmd(6160), 'ps -o pgid= -p 6160': '6160' }))
    const h = await hostWith('port-occupant', null)
    await reap(h)
    expect(m.execSync).toHaveBeenCalledWith(`fuser ${PORT}/tcp 2>/dev/null`, expect.anything())
    expect(signals(d.log)[0]).toEqual({ pid: -6160, sig: 'SIGTERM' })
  })

  it('with a valid owner record (isSameProcess(pid, procStart)) signals only that pid group, never port discovery', async () => {
    const chrome = procs.addProcess({ command: 'chrome' })
    const h = await hostWith('port-occupant', { pid: chrome.pid, procStart: chrome.start, port: PORT })
    await reap(h)
    expect(m.execSync).not.toHaveBeenCalled()
    expect(signals(d.log)).toEqual([
      { pid: -chrome.pid, sig: 'SIGTERM' },
      { pid: -chrome.pid, sig: 'SIGKILL' },
    ])
  })

  it('a recycled pid (procStart mismatch) is never signalled; the occupant path runs instead', async () => {
    const chrome = procs.addProcess({ command: 'chrome' })
    const stale: OwnerRecord = { pid: chrome.pid, procStart: chrome.start, port: PORT }
    procs.die(chrome.pid)
    procs.recycle(chrome.pid) // same pid, unrelated process, new start token
    m.execSync.mockImplementation(execScript({ lsof: '7170', ...ownCmd(7170), 'ps -o pgid= -p 7170': '7170' }))
    const h = await hostWith('port-occupant', stale)
    await reap(h)
    expect(d.log.some((e) => Math.abs(e.pid) === chrome.pid)).toBe(false)
    expect(signals(d.log)[0]).toEqual({ pid: -7170, sig: 'SIGTERM' })
  })
})

describe("8468f7b1 [chrome-lifecycle.12] scope 'launched-only'", () => {
  it('never signals an unrecorded process', async () => {
    m.execSync.mockImplementation(execScript({ lsof: '5150', fuser: '5150' }))
    const h = await hostWith('launched-only', null)
    expect(await reap(h)).toMatchObject({ action: 'none', reaped: false })
    expect(m.execSync).not.toHaveBeenCalled()
    expect(d.log).toEqual([])
  })

  it('never signals a recycled pid either', async () => {
    const chrome = procs.addProcess({ command: 'chrome' })
    const stale: OwnerRecord = { pid: chrome.pid, procStart: chrome.start, port: PORT }
    procs.die(chrome.pid)
    procs.recycle(chrome.pid)
    const h = await hostWith('launched-only', stale)
    expect((await reap(h)).action).toBe('none')
    expect(d.log).toEqual([])
  })

  it('kills the recorded Chrome when the owner record is valid', async () => {
    const chrome = procs.addProcess({ command: 'chrome' })
    const h = await hostWith('launched-only', { pid: chrome.pid, procStart: chrome.start, port: PORT })
    expect((await reap(h)).action).toBe('reap')
    expect(signals(d.log)[0]).toEqual({ pid: -chrome.pid, sig: 'SIGTERM' })
    expect(m.execSync).not.toHaveBeenCalled()
  })
})
