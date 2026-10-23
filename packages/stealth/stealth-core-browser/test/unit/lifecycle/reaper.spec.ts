/**
 * Out-of-process reaper failsafes, proven through the reaper host process (the
 * replacement of the detached `node -e` killer script and the pid registry
 * file of the source runner). The FEATURE of each row is unchanged; the
 * mechanism is `runChromeReaper` served over the service proxy, reached
 * through `createProxyReaperLink`.
 * Ticket 8468f7b1 · [chrome-lifecycle.12] [chrome-lifecycle.15] [chrome-lifecycle.16] [chrome-lifecycle.18] ·
 * inventory [fs-204] [fs-205] [fs-206] [fs-207] [fs-208] [fs-209]
 *
 * vi.mock('@adhd/sox-service-proxy') replaces ensure/dial/serve only; CDP,
 * kills and history act on the simulated machine (manager-world). No socket,
 * no process, no real port.
 * guards: a detached reaper closes Chrome after the idle delay
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.12] [chrome-lifecycle.15] [chrome-lifecycle.16] [chrome-lifecycle.18]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))
vi.mock('../../../src/lib/storage/history.js', () => ({
  HistoryClient: class {
    isRecentlyUsed(): boolean {
      return false
    }
  },
}))

import { createReaperHost } from '../../../src/lib/lifecycle/reaper-host.js'
import { runChromeReaper } from '../../../src/lib/lifecycle/reaper-entry.js'
import { createProxyReaperLink, REAPER_ENTRY_SCRIPT } from '../../../src/lib/lifecycle/reaper-link.js'
import { GRACE, IDLE, makeHost, PORT, resultOf } from '../../helpers/lifecycle/host-fixture.js'
import { FakeBackend } from '../../helpers/lifecycle/fake-backend.js'
import { client, makeHub, worldHost } from '../../helpers/lifecycle/manager-clients.js'
import { GRACE as WORLD_GRACE, PORT as WORLD_PORT, resetSp, resetWorld, sp, STATE_DIR, world } from '../../helpers/lifecycle/manager-world.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
  world.fs.mkdirSync(STATE_DIR, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [chrome-lifecycle.15] the out-of-process reaper', () => {
  it('a detached reaper closes Chrome after the idle delay', async () => {
    // [fs-204] a CLI run used Chrome, then exited. The reaper process (runChromeReaper), not the CLI, closes the
    // now-idle Chrome once the delay (shutdownGraceMs after the last client left) has passed — never before.
    world.chromeUp = true
    let served: { handler: (r: unknown, c: { connectionId: string }) => Promise<unknown>; onClientConnect: (id: string) => void } | null = null
    sp.serveBackend = vi.fn(async (o: Record<string, unknown>) => {
      served = o as unknown as typeof served
      return { socketPath: `${STATE_DIR}/r.sock`, close: async () => undefined }
    })
    const idleDelay = 20_000
    await runChromeReaper(
      { port: WORLD_PORT, stateDir: STATE_DIR, socketPath: `${STATE_DIR}/r.sock`, idleTimeoutMs: 120_000, shutdownGraceMs: idleDelay, orphanWindowMs: 30_000 },
      { logger: () => undefined },
    )
    // The CLI: connect, hello, a search (activity), then exit (release).
    served!.onClientConnect('cli')
    await served!.handler({ jsonrpc: '2.0', id: 1, method: 'hello', params: { pid: 31337 } }, { connectionId: 'cli' })
    await served!.handler({ jsonrpc: '2.0', method: 'activity' }, { connectionId: 'cli' })
    await served!.handler({ jsonrpc: '2.0', id: 2, method: 'release' }, { connectionId: 'cli' })
    await vi.advanceTimersByTimeAsync(idleDelay - 1)
    expect(world.chromeUp).toBe(true)
    await vi.advanceTimersByTimeAsync(5_001) // the next 5 s tick after the delay
    expect(world.chromeUp).toBe(false)
    expect(world.events).toEqual(['close-pages', `kill:${WORLD_PORT}`])
  })

  it('keep-alive disables the delayed reaper', async () => {
    // [fs-205] a client whose reaper is unavailable (not started, or disabled by the host's --keep-alive)
    // never asks for a reap and never closes Chrome on idle; only an explicit shutdown() does.
    const hub = makeHub()
    hub.available = false
    const c = client(hub, 11, { idleTimeoutMs: 1_000 })
    await c.manager.ready()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.link.reapCalls).toBe(0)
    expect(world.chromeUp).toBe(true)
    expect(world.events.filter((e) => e.includes('kill'))).toEqual([])
  })

  it('the reaper outlives the CLI', async () => {
    // [fs-206] the reaper is its own detached process: ensureBackend spawns `node -e <entry>` with stdio severed
    // (stderr to a log file in the private state dir, never the CLI's pipes), and the CLI leaving only closes its
    // connection: the host keeps running and keeps Chrome's reap pending.
    const backend = new FakeBackend()
    backend.host = worldHost()
    world.chromeUp = true
    sp.ensureBackend = vi.fn(async () => ({ disposition: 'spawned', detail: 'spawned', pid: 9090 }))
    sp.dialBackend = vi.fn(backend.dial)
    const link = createProxyReaperLink({
      port: WORLD_PORT,
      stateDir: STATE_DIR,
      pid: 11,
      checkHistory: true,
      idleTimeoutMs: 120_000,
      shutdownGraceMs: 30_000,
      orphanWindowMs: 30_000,
      scope: 'port-occupant',
      entryPath: '/pkg/dist/index.js',
    })
    expect(await link.ensureAndHello()).toBe(true)
    const opts = vi.mocked(sp.ensureBackend).mock.calls[0]![0] as Record<string, unknown>
    expect(opts['command']).toBe(process.execPath)
    expect((opts['args'] as string[]).slice(0, 2)).toEqual(['-e', REAPER_ENTRY_SCRIPT])
    expect(opts['stderrLogPath']).toBe(`${STATE_DIR}/reaper-${WORLD_PORT}.log`)
    expect(opts['lockDir']).toBe(STATE_DIR)
    expect(opts).not.toHaveProperty('env')
    expect(opts).not.toHaveProperty('cwd')
    // The CLI exits: it releases its connection, nothing tells the host to stop.
    await link.release()
    const methods = backend.dials.flatMap((d) => d.sent.map((r) => r.method))
    expect(methods).toEqual(['hello', 'release'])
    expect(backend.host).not.toBeNull()
    expect(await backend.host!.tick()).toMatchObject({ action: 'wait', pinnedBy: 'grace' })
    await vi.advanceTimersByTimeAsync(WORLD_GRACE)
    expect(await backend.host!.tick()).toMatchObject({ action: 'reap', reaped: true })
  })
})

describe('8468f7b1 [chrome-lifecycle.12] the reaper closes Chrome', () => {
  it('the reaper signals the port occupant', async () => {
    // [fs-207] no owner record + scope port-occupant: the host reap kills the TCP listener of the CDP port.
    const h = makeHost()
    h.advance(IDLE + GRACE)
    const out = await h.host.tick()
    expect(out).toMatchObject({ action: 'reap', reaped: true })
    expect(h.world.events).toContain(`kill-port:${PORT}`)
  })
})

describe('8468f7b1 [chrome-lifecycle.18] sibling diagnostic', () => {
  it('warns about many sibling instances without killing', async () => {
    // [fs-208] at the threshold (default 4 connected clients) status says so; nothing is ever signalled for it.
    const h = makeHost()
    for (const [i, id] of ['a', 'b', 'c'].entries()) await h.join(id, 100 + i)
    expect(resultOf<{ siblingWarning: boolean; clients: number }>(await h.call('a', 'status'))).toMatchObject({ clients: 3, siblingWarning: false })
    await h.join('d', 104)
    const s = resultOf<{ siblingWarning: boolean; clients: number; siblingThreshold: number }>(await h.call('a', 'status'))
    expect(s).toMatchObject({ clients: 4, siblingWarning: true, siblingThreshold: 4 })
    expect(h.world.events).toEqual([])
  })
})

describe('8468f7b1 [chrome-lifecycle.16] live instance registry', () => {
  it('maintains the live instance registry', async () => {
    // [fs-209] hello adds the live process, disconnect and release drop it, and after a host
    // restart the next activity re-registers it. In memory only.
    const h = makeHost()
    await h.join('c1', 1)
    await h.join('c2', 2)
    await h.join('c3', 3)
    h.host.onClientDisconnect('c1', 'end') // the process died
    await h.call('c2', 'release') // the process left on exit
    expect(h.host.clients().map((c) => c.id)).toEqual(['c3'])
    const restarted = createReaperHost(h.deps)
    await restarted.handler({ jsonrpc: '2.0', method: 'activity' }, { connectionId: 'c3' })
    expect(restarted.clients().map((c) => c.id)).toEqual(['c3'])
  })
})
