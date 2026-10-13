/**
 * CL15 (F24 N1 N5) the reaper host process body, `runChromeReaper(cfg)`.
 * Ticket 8468f7b1 · [chrome-lifecycle.15]
 *
 * The detached reaper serves the pure host over `serveBackend` (handler plus
 * the connection hooks, so a killed client's connection drops it at once),
 * ticks every 5 s to reap an idle Chrome, and retires itself through
 * `createIdleRetirer` over `orphanWindowMs` once Chrome is gone: a host nobody
 * uses must still exit. vi.mock('@adhd/sox-service-proxy') keeps the real
 * `createIdleRetirer` and replaces only `serveBackend`; CDP, kills and history
 * act on the simulated machine (manager-world). No socket, no process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('./manager-world.js')).fsModule())
vi.mock('../../../lib/cdp/browser.js', async () => (await import('./manager-world.js')).browserModule(vi.fn))
vi.mock('../../../lib/cdp/targets.js', async () => (await import('./manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('./manager-world.js')).spModule(await orig<Record<string, unknown>>()))
vi.mock('../../../lib/storage/history.js', async () => {
  const { world } = await import('./manager-world.js')
  return {
    HistoryClient: class {
      isRecentlyUsed(): boolean {
        if (world.history instanceof Error) throw world.history
        return world.history
      }
    },
  }
})

import { REAPER_TICK_MS, runChromeReaper, type ChromeReaperConfig } from '../../../lib/lifecycle/reaper-entry.js'
import type { RpcRequest, RpcResponse } from '../../../lib/lifecycle/reaper-host.js'
import { chromeGone, openPage, PORT, resetSp, resetWorld, sp, STATE_DIR, world } from './manager-world.js'

interface Served {
  socketPath: string
  handler: (req: RpcRequest, ctx: { connectionId: string }) => Promise<RpcResponse | undefined>
  onClientConnect: (id: string) => void
  onClientDisconnect: (id: string, reason: 'end' | 'error' | 'closed-by-backend') => void
}

const orphanWindowMs = 12_000
const CFG: ChromeReaperConfig = {
  port: PORT,
  stateDir: STATE_DIR,
  socketPath: `${STATE_DIR}/reaper.sock`,
  idleTimeoutMs: 20_000,
  shutdownGraceMs: 5_000,
  orphanWindowMs,
}

let served: Served | null
let closeBackend: ReturnType<typeof vi.fn>
let logs: string[]

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
  world.fs.mkdirSync(STATE_DIR, { recursive: true })
  served = null
  logs = []
  closeBackend = vi.fn(async () => undefined)
  sp.serveBackend = vi.fn(async (opts: Record<string, unknown>) => {
    served = opts as unknown as Served
    return { socketPath: String(opts['socketPath']), close: closeBackend }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function start(cfg: Partial<ChromeReaperConfig> = {}) {
  return runChromeReaper({ ...CFG, ...cfg }, { logger: (m) => logs.push(m) })
}

function retiredFlag(p: Promise<void>): { done: boolean } {
  const f = { done: false }
  void p.then(() => (f.done = true))
  return f
}

describe('8468f7b1 [chrome-lifecycle.15] runChromeReaper serves the host', () => {
  it('serveBackend gets the socket, the host handler and both connection hooks', async () => {
    world.chromeUp = true
    const r = await start()
    expect(sp.serveBackend).toHaveBeenCalledTimes(1)
    expect(served!.socketPath).toBe(CFG.socketPath)
    served!.onClientConnect('c1')
    await served!.handler({ jsonrpc: '2.0', id: 1, method: 'hello', params: { pid: 77, checkHistory: true } }, { connectionId: 'c1' })
    expect(r.host.clients()).toEqual([{ id: 'c1', pid: 77, checkHistory: true, lastActivityAt: null }])
    expect(await served!.handler({ jsonrpc: '2.0', id: 2, method: 'ping' }, { connectionId: 'c1' })).toEqual({ jsonrpc: '2.0', id: 2, result: 'pong' })
    await r.close()
  })

  it('a killed client (kill -9) is dropped at once through onClientDisconnect', async () => {
    world.chromeUp = true
    const r = await start()
    served!.onClientConnect('c1')
    await served!.handler({ jsonrpc: '2.0', id: 1, method: 'hello', params: { pid: 77 } }, { connectionId: 'c1' })
    await served!.handler({ jsonrpc: '2.0', method: 'activity' }, { connectionId: 'c1' })
    served!.onClientDisconnect('c1', 'end')
    expect(r.host.clients()).toEqual([])
    await r.close()
  })

  it('the 5 s ticker reaps an idle Chrome (pages closed first, then the port occupant)', async () => {
    world.chromeUp = true
    await start()
    expect(REAPER_TICK_MS).toBe(5_000)
    await vi.advanceTimersByTimeAsync(CFG.idleTimeoutMs + CFG.shutdownGraceMs + REAPER_TICK_MS)
    expect(world.chromeUp).toBe(false)
    expect(world.events).toEqual(['close-pages', `kill:${PORT}`])
    expect(logs).toContain('reaped idle Chrome')
  })
})

describe('8468f7b1 [chrome-lifecycle.15] createIdleRetirer over orphanWindowMs', () => {
  it('a host nobody uses retires orphanWindowMs after Chrome is gone (ticker stopped, socket closed)', async () => {
    world.chromeUp = false
    const r = await start()
    const f = retiredFlag(r.retired)
    await vi.advanceTimersByTimeAsync(orphanWindowMs - 1)
    expect(f.done).toBe(false)
    await vi.advanceTimersByTimeAsync(REAPER_TICK_MS)
    expect(f.done).toBe(true)
    expect(closeBackend).toHaveBeenCalledTimes(1)
    expect(r.retirer.state).toBe('retired')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never retires while Chrome is reachable (an open page keeps Chrome, so the host stays)', async () => {
    world.chromeUp = true
    openPage('https://captcha.example/')
    const r = await start()
    const f = retiredFlag(r.retired)
    await vi.advanceTimersByTimeAsync(orphanWindowMs * 10)
    expect(f.done).toBe(false)
    expect(world.chromeUp).toBe(true)
    await r.close()
  })

  it('the orphan window starts when Chrome goes away, not when the host started', async () => {
    world.chromeUp = true
    openPage('https://captcha.example/')
    const r = await start()
    const f = retiredFlag(r.retired)
    await vi.advanceTimersByTimeAsync(60_000)
    chromeGone() // killed elsewhere
    await vi.advanceTimersByTimeAsync(REAPER_TICK_MS) // the next tick notices
    await vi.advanceTimersByTimeAsync(orphanWindowMs - REAPER_TICK_MS - 1)
    expect(f.done).toBe(false)
    await vi.advanceTimersByTimeAsync(REAPER_TICK_MS * 2)
    expect(f.done).toBe(true)
  })

  it('activity from a client defers retirement (real work), a connection alone does not', async () => {
    world.chromeUp = false
    const r = await start()
    const f = retiredFlag(r.retired)
    served!.onClientConnect('c1') // presence never pins the host (ADR-0022)
    await vi.advanceTimersByTimeAsync(orphanWindowMs / 2)
    await served!.handler({ jsonrpc: '2.0', method: 'activity' }, { connectionId: 'c1' })
    await vi.advanceTimersByTimeAsync(orphanWindowMs / 2 + 1)
    expect(f.done).toBe(false)
    await vi.advanceTimersByTimeAsync(orphanWindowMs / 2)
    expect(f.done).toBe(true)
  })

  it('close() retires at once', async () => {
    world.chromeUp = true
    const r = await start()
    await r.close()
    await r.retired
    expect(closeBackend).toHaveBeenCalledTimes(1)
  })
})
