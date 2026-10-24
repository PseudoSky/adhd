/**
 * CL29 no respawn loop.
 * Ticket 8468f7b1 · [chrome-lifecycle.29]
 *
 * Chrome is gone and the reaper host retired `orphanWindowMs` later while N
 * idle clients were still connected. If a dropped connection triggered a
 * re-ensure, every idle client would respawn the reaper forever. Proven: a
 * disconnect never ensures (zero calls), and a re-ensure happens only on
 * `ready()`, on a `bump()` / `withBrowser` settle while the link is down AND
 * Chrome is reachable (rate-limited to one per 2 s), and on one retry of a
 * previously failed ensure at idle fire.
 *
 * Both through the FakeReaperLink (manager-level) and through the real
 * `createProxyReaperLink` over vi.mock('@adhd/sox-service-proxy') with a fake
 * backend whose host retires. Simulated machine (manager-world); no socket,
 * no process.
 * guards: the disconnect itself ensures nothing (zero calls), for every client
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.29]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { ChromeManager, RECONNECT_MIN_INTERVAL_MS } from '../../../src/lib/chrome-manager.js'
import { FakeBackend } from '../../helpers/lifecycle/fake-backend.js'
import { client, makeHub, worldHost } from '../../helpers/lifecycle/manager-clients.js'
import { chromeGone, HOST, IDLE, resetSp, resetWorld, sp, STATE_DIR, world } from '../../helpers/lifecycle/manager-world.js'
import { must } from '../../helpers/must.js'

/** The reaper retires this long after Chrome is gone (the option every client passes to it). */
const orphanWindowMs = 2_000

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function retiredWithIdleClients(n: number) {
  const hub = makeHub()
  const cs = Array.from({ length: n }, (_, i) => client(hub, 100 + i, { orphanWindowMs }))
  for (const c of cs) await c.manager.ready()
  // Chrome is closed elsewhere; the host notices on a tick, waits orphanWindowMs and retires,
  // closing every held connection (closed-by-backend).
  chromeGone()
  await vi.advanceTimersByTimeAsync(orphanWindowMs)
  hub.retire()
  const ensures = cs.map((c) => vi.spyOn(c.link, 'ensureAndHello'))
  return { hub, cs, ensures }
}

describe('8468f7b1 [chrome-lifecycle.29] a retired reaper with idle clients is not respawned', () => {
  it('the disconnect itself ensures nothing (zero calls), for every client', async () => {
    const { hub, cs, ensures } = await retiredWithIdleClients(3)
    for (const c of cs) expect(c.link.isUp()).toBe(false)
    for (const e of ensures) expect(e).toHaveBeenCalledTimes(0)
    expect(hub.host).toBeNull()
  })

  it('idle fires with Chrome gone never ensure (the last ensure succeeded, so no retry is owed)', async () => {
    const { hub, ensures } = await retiredWithIdleClients(3)
    await vi.advanceTimersByTimeAsync(IDLE * 10)
    for (const e of ensures) expect(e).toHaveBeenCalledTimes(0)
    expect(hub.spawns).toBe(1)
  })

  it('bump() while Chrome is down never ensures', async () => {
    const { cs, ensures } = await retiredWithIdleClients(2)
    for (const c of cs) c.manager.bump()
    await vi.advanceTimersByTimeAsync(RECONNECT_MIN_INTERVAL_MS * 3)
    for (const c of cs) c.manager.bump()
    await vi.advanceTimersByTimeAsync(1)
    for (const e of ensures) expect(e).toHaveBeenCalledTimes(0)
  })
})

describe('8468f7b1 [chrome-lifecycle.29] the only re-ensure triggers', () => {
  it('ready() re-ensures (and relaunches Chrome)', async () => {
    const { hub, cs, ensures } = await retiredWithIdleClients(2)
    await must(cs[0]).manager.ready()
    expect(ensures[0]).toHaveBeenCalledTimes(1)
    expect(ensures[1]).toHaveBeenCalledTimes(0)
    expect(hub.spawns).toBe(2)
    expect(must(cs[0]).link.isUp()).toBe(true)
  })

  it('a bump() settle while the link is down AND Chrome is reachable re-ensures once per 2 s', async () => {
    const { hub, cs, ensures } = await retiredWithIdleClients(1)
    world.chromeUp = true // someone else relaunched Chrome
    const c = must(cs[0])
    c.manager.bump()
    c.manager.bump() // rate-limited: same 2 s window
    await vi.advanceTimersByTimeAsync(1)
    expect(ensures[0]).toHaveBeenCalledTimes(1)
    expect(c.link.isUp()).toBe(true)
    // The reconnect reports this activity to the new host.
    expect(must(must(hub.host).clients()[0]).lastActivityAt).toBe(Date.now() - 1)
  })

  it('a withBrowser settle while the link is down and Chrome is reachable re-ensures', async () => {
    const { cs, ensures } = await retiredWithIdleClients(1)
    world.chromeUp = true
    await must(cs[0]).manager.withBrowser(async () => 'ok')
    await vi.advanceTimersByTimeAsync(1)
    // ready() inside withBrowser is itself a trigger; the settle bump finds the link up and does not ensure again.
    expect(ensures[0]).toHaveBeenCalledTimes(1)
    expect(must(cs[0]).link.isUp()).toBe(true)
  })

  it('a previously FAILED ensure is retried exactly once at idle fire', async () => {
    const hub = makeHub()
    hub.available = false
    const c = client(hub, 11)
    await c.manager.ready() // ensure #1 fails
    const ensure = vi.spyOn(c.link, 'ensureAndHello')
    await vi.advanceTimersByTimeAsync(IDLE) // the one retry
    expect(ensure).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(IDLE * 5) // no further retries
    expect(ensure).toHaveBeenCalledTimes(1)
    // A retry that succeeds re-registers and the next fire evaluates through the host.
    hub.available = true
    await c.manager.ready()
    expect(c.link.isUp()).toBe(true)
  })
})

describe('8468f7b1 [chrome-lifecycle.29] the real proxy link never re-ensures on disconnect', () => {
  it('the backend retires and closes the connection: ensureBackend is not called again', async () => {
    const backend = new FakeBackend()
    backend.host = worldHost()
    sp.ensureBackend = vi.fn(async () => ({ disposition: 'spawned', detail: 'ok', pid: 5 }))
    sp.dialBackend = vi.fn(backend.dial)
    const m = new ChromeManager({ cdpHost: HOST, idleTimeoutMs: IDLE, orphanWindowMs, stateDir: STATE_DIR, entryPath: '/pkg/dist/index.js', logger: () => undefined })
    await m.ready()
    expect(sp.ensureBackend).toHaveBeenCalledTimes(1)
    chromeGone()
    await vi.advanceTimersByTimeAsync(orphanWindowMs)
    backend.retire()
    vi.mocked(sp.ensureBackend).mockClear()
    await vi.advanceTimersByTimeAsync(IDLE * 10)
    m.bump()
    await vi.advanceTimersByTimeAsync(RECONNECT_MIN_INTERVAL_MS)
    expect(sp.ensureBackend).toHaveBeenCalledTimes(0)
    expect(sp.dialBackend).toHaveBeenCalledTimes(1)
    // Only the next ready() ensures again.
    await m.ready()
    expect(sp.ensureBackend).toHaveBeenCalledTimes(1)
  })
})
