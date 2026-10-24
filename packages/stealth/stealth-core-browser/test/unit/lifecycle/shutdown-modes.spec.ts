/**
 * CL9 (F14 F15) the two shutdown modes.
 * Ticket 8468f7b1 · [chrome-lifecycle.9]
 *
 * `shutdown()` is the force path a user asks for explicitly: it ignores every
 * safety tier and is local (no reaper round-trip). `shutdownIfIdle()` is the
 * soft path for exit hooks: it goes through the link (`reapIfIdle`, evaluated
 * by the host with graceMs 0, the caller excluded) and defers to a sibling, to
 * an open page and to recent history.
 * Simulated machine (manager-world); no socket, no process, no real port.
 * guards: shutdown() closes Chrome despite a busy sibling, an open page and recent history
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.9]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { openPage, PORT, resetSp, resetWorld, world } from '../../helpers/lifecycle/manager-world.js'
import { client, makeHub } from '../../helpers/lifecycle/manager-clients.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A busy world: a sibling just worked, a captcha page is open, history is recent. */
async function busyWorld() {
  const hub = makeHub()
  const a = client(hub, 11)
  const b = client(hub, 22)
  await a.manager.ready()
  await b.manager.ready()
  b.manager.bump()
  openPage('https://captcha.example/')
  world.history = true
  return { hub, a, b }
}

describe('8468f7b1 [chrome-lifecycle.9] shutdown() is forced and local', () => {
  it('shutdown() closes Chrome despite a busy sibling, an open page and recent history', async () => {
    const { a } = await busyWorld()
    await a.manager.shutdown()
    expect(world.events.filter((e) => e !== 'hide')).toEqual(['close-pages', `kill:${PORT}`])
    expect(world.chromeUp).toBe(false)
    expect(a.manager.isReady).toBe(false)
  })

  it('shutdown() never asks the host (no reapIfIdle round-trip) and releases the link', async () => {
    const { a } = await busyWorld()
    await a.manager.shutdown()
    expect(a.link.reapCalls).toBe(0)
    expect(a.link.releaseCalls).toBe(1)
    expect(a.link.isUp()).toBe(false)
  })

  it('shutdown() cancels the pending idle timer so it cannot fire a second time', async () => {
    const { a } = await busyWorld()
    await a.manager.shutdown()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(a.link.reapCalls).toBe(0)
  })

  it('shutdown() works before ready() (no idle timer, no link yet)', async () => {
    world.chromeUp = true
    const c = client(makeHub(), 11)
    await expect(c.manager.shutdown()).resolves.toBeUndefined()
    expect(world.events).toEqual(['close-pages', `kill:${PORT}`])
  })
})

describe('8468f7b1 [chrome-lifecycle.9] shutdownIfIdle() goes through the link', () => {
  it('shutdownIfIdle() asks the host with reapIfIdle and the host reaps a genuinely idle Chrome at once (graceMs 0)', async () => {
    const hub = makeHub()
    const a = client(hub, 11)
    const b = client(hub, 22)
    await a.manager.ready()
    await b.manager.ready()
    // B leaves while active: a host TICK would now wait the grace window, the soft path does not.
    await b.manager.release()
    await vi.advanceTimersByTimeAsync(1)
    await a.manager.shutdownIfIdle()
    expect(a.link.reapCalls).toBe(1)
    expect(world.chromeUp).toBe(false)
    expect(world.events).toContain('host:close-pages')
    expect(a.manager.isReady).toBe(false)
  })

  it('shutdownIfIdle() defers to a sibling active within the window', async () => {
    const hub = makeHub()
    const a = client(hub, 11)
    const b = client(hub, 22)
    await a.manager.ready()
    await b.manager.ready()
    b.manager.bump()
    await a.manager.shutdownIfIdle()
    expect(a.link.reapCalls).toBe(1)
    expect(world.chromeUp).toBe(true)
    expect(a.logs).toContain('Chrome in use (client) — deferring')
  })

  it('shutdownIfIdle() defers to an open http(s) page', async () => {
    const a = client(makeHub(), 11)
    await a.manager.ready()
    openPage('https://example.com/result')
    await a.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(true)
    expect(a.logs).toContain('Chrome in use (page) — deferring')
  })

  it('shutdownIfIdle() defers to recent history', async () => {
    const a = client(makeHub(), 11)
    await a.manager.ready()
    world.history = true
    await a.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(true)
    expect(a.logs).toContain('Chrome in use (history) — deferring')
  })
})
