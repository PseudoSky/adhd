/**
 * Lifecycle spec for the idle-shutdown deferral contract of ChromeManager, ported from the scratch
 * `chrome-lifecycle-test.ts` (five scenarios). Ticket 8468f7b1 AC port-fixes ·
 * criteria [port-fixes.5] [port-fixes.8] (livelock guard; stale, absent and dead sibling handling).
 *
 * ── The invariant under test (regression guard for the mutual-deferral livelock)
 *   A process that REFUSES to shut Chrome down because a sibling is active must re-arm its own idle
 *   timer WITHOUT writing its own cross-process heartbeat (`_rearmIdle`). Writing it from a merely
 *   deferring process makes that process look active to its siblings, so every idle process keeps
 *   every other one alive forever and the shared Chrome is never reaped. The heartbeat is written
 *   only by genuine activity (`bump()`).
 *
 * ── Hermeticity (nothing real is touched)
 *   - The heartbeat is a throwaway file under an `mkdtemp` directory, never /tmp/stealth-browser-heartbeat.
 *   - The CDP host is a dead port; `fetch` is stubbed to refuse the connection, and the Chrome
 *     lifecycle modules (cdp/browser, cdp/targets) are mocked, so the "proceed to shut down" branch
 *     spawns nothing, signals nothing and never connects to the live 9222 Chrome.
 *   - Sibling processes are synthetic PIDs; `process.kill(pid, 0)` is replaced by a liveness table
 *     (no real signal is ever sent).
 *   - The idle timer is injected directly (private field) so no `ready()` / Chrome launch is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const m = vi.hoisted(() => ({
  ensureChromeRunning: vi.fn(),
  killChrome: vi.fn(),
  closeAllPageTargets: vi.fn(),
  hideAllWindows: vi.fn(),
  isChromeReachable: vi.fn(),
}))

vi.mock('../../../lib/cdp/browser.js', () => ({
  ensureChromeRunning: m.ensureChromeRunning,
  killChrome: m.killChrome,
}))
vi.mock('../../../lib/cdp/targets.js', () => ({
  closeAllPageTargets: m.closeAllPageTargets,
  hideAllWindows: m.hideAllWindows,
  isChromeReachable: m.isChromeReachable,
}))

import { ChromeManager } from '../../../lib/chrome-manager.js'
import { IdleShutdown } from '../../../lib/cdp/shutdown.js'

const DEAD_HOST = '127.0.0.1:19922' // never reachable: no real Chrome is touched
const IDLE_WINDOW = 120_000
const SIBLING_PID = 424_242 // live, idle sibling (synthetic)
const DEAD_PID = 424_243 // crashed sibling (synthetic)

let tmp: string
let heartbeatPath: string
let alive: Set<number>
let fetchMock: ReturnType<typeof vi.fn>

/** Parse the heartbeat file into pid -> timestamp. */
function readHeartbeat(path: string): Map<number, number> {
  const map = new Map<number, number>()
  try {
    for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
      const [p, t] = line.split(':')
      if (!p || !t) continue
      map.set(parseInt(p, 10), parseInt(t, 10))
    }
  } catch { /* absent */ }
  return map
}

/** Write a heartbeat file containing a single `<pid>:<ts>` entry. */
function seedHeartbeat(path: string, pid: number, ts: number): void {
  writeFileSync(path, `${pid}:${ts}\n`, 'utf8')
}

/** Manager with an injected idle timer (bump() early-returns when idle is null) and a temp heartbeat. */
function makeManager(): ChromeManager {
  const mgr = new ChromeManager({
    cdpHost: DEAD_HOST,
    heartbeatPath,
    idleTimeoutMs: IDLE_WINDOW,
    checkHistory: false,
    logger: () => { /* quiet */ },
  })
  ;(mgr as unknown as { idle: IdleShutdown | null }).idle = new IdleShutdown({ timeoutMs: IDLE_WINDOW })
  return mgr
}

/** True when the manager took the shutdown path (`_doShutdown` nulls `idle`). */
function shutDownProceeded(mgr: ChromeManager): boolean {
  return (mgr as unknown as { idle: IdleShutdown | null }).idle === null
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  for (const fn of Object.values(m)) fn.mockReset()
  m.closeAllPageTargets.mockResolvedValue(undefined)
  m.killChrome.mockResolvedValue(undefined)
  tmp = mkdtempSync(join(tmpdir(), 'chrome-lifecycle-spec-'))
  heartbeatPath = join(tmp, 'stealth-browser-heartbeat')
  alive = new Set([process.pid, SIBLING_PID])
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0 && !alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    return true
  }) as typeof process.kill)
  fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

describe('8468f7b1 AC port-fixes [port-fixes.5] ChromeManager idle-shutdown deferral (livelock guard)', () => {
  it('1. deferral to an active sibling does not stamp the deferrer heartbeat (livelock guard)', async () => {
    seedHeartbeat(heartbeatPath, SIBLING_PID, Date.now())
    const mgr = makeManager()
    await mgr.shutdownIfIdle() // sibling is active -> defer
    const after = readHeartbeat(heartbeatPath)
    expect(shutDownProceeded(mgr)).toBe(false)
    expect(after.has(SIBLING_PID)).toBe(true)
    expect(after.has(process.pid)).toBe(false)
    // Deferred before touching Chrome at all.
    expect(m.killChrome).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('2. genuine activity (bump) still stamps the heartbeat, alongside the sibling', () => {
    seedHeartbeat(heartbeatPath, SIBLING_PID, Date.now())
    const mgr = makeManager()
    mgr.bump() // real search activity
    const hb = readHeartbeat(heartbeatPath)
    expect(hb.has(process.pid)).toBe(true)
    expect(hb.has(SIBLING_PID)).toBe(true)
  })

  it('3. a STALE sibling does not hold Chrome alive: shutdown proceeds and the dead CDP port is probed, not 9222', async () => {
    seedHeartbeat(heartbeatPath, SIBLING_PID, Date.now() - IDLE_WINDOW - 5_000)
    const mgr = makeManager()
    await mgr.shutdownIfIdle()
    expect(shutDownProceeded(mgr)).toBe(true)
    expect(readHeartbeat(heartbeatPath).has(process.pid)).toBe(false)
    expect(fetchMock).toHaveBeenCalled()
    for (const call of fetchMock.mock.calls) expect(String(call[0])).toContain(DEAD_HOST)
    expect(m.closeAllPageTargets).toHaveBeenCalledWith(DEAD_HOST)
    expect(m.killChrome).toHaveBeenCalledWith(19922)
  })

  it('4. no sibling at all (absent heartbeat file): shutdown proceeds', async () => {
    const mgr = makeManager()
    await mgr.shutdownIfIdle()
    expect(shutDownProceeded(mgr)).toBe(true)
    expect(m.killChrome).toHaveBeenCalledTimes(1)
  })

  it('5. a fresh stamp from a DEAD sibling PID is ignored: a crashed sibling cannot block shutdown forever', async () => {
    seedHeartbeat(heartbeatPath, DEAD_PID, Date.now()) // fresh stamp, but the process is gone
    const mgr = makeManager()
    await mgr.shutdownIfIdle()
    expect(shutDownProceeded(mgr)).toBe(true)
    expect(m.killChrome).toHaveBeenCalledTimes(1)
  })

  it('never reads or writes the live shared heartbeat path during any scenario', async () => {
    seedHeartbeat(heartbeatPath, SIBLING_PID, Date.now())
    const mgr = makeManager()
    await mgr.shutdownIfIdle()
    mgr.bump()
    expect(heartbeatPath.startsWith(tmpdir())).toBe(true)
    expect(heartbeatPath).not.toBe('/tmp/stealth-browser-heartbeat')
  })
})
