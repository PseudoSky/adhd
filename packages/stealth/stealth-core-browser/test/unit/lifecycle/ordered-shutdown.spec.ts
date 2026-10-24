/**
 * CL10 (F16) ordered shutdown, in the host reap and in the force path.
 * Ticket 8468f7b1 · [chrome-lifecycle.10]
 *
 * Chrome is never killed with page targets still open: every page is closed
 * first (allSettled), then Chrome is killed, then the owner record is removed.
 * Each step is non-fatal: a failing close or kill is reported through the
 * logger and the remaining steps still run.
 * Simulated machine (manager-world) plus the host test world (host-fixture);
 * no socket, no process, no real port.
 * guards: a valid owner record: close-pages -> group kill of the recorded pid -> remove-record
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.10]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { IDLE, openPage, PORT, resetSp, resetWorld, world } from '../../helpers/lifecycle/manager-world.js'
import { client, makeHub } from '../../helpers/lifecycle/manager-clients.js'
import { GRACE as HOST_GRACE, IDLE as HOST_IDLE, makeHost, PORT as HOST_PORT } from '../../helpers/lifecycle/host-fixture.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [chrome-lifecycle.10] the host reap closes pages, then kills, then forgets the record', () => {
  it('a valid owner record: close-pages -> group kill of the recorded pid -> remove-record', async () => {
    const h = makeHost({}, { owner: { pid: 4242, procStart: 's', port: HOST_PORT }, ownerValid: true })
    h.advance(HOST_IDLE + HOST_GRACE)
    expect(await h.host.tick()).toMatchObject({ action: 'reap', reaped: true })
    expect(h.world.events).toEqual(['close-pages', 'kill-group:4242', 'remove-record'])
  })

  it('a failing page close is logged through the logger and the kill and record removal still run', async () => {
    const h = makeHost({
      closeAllPageTargets: async () => {
        throw new Error('Target.closeTarget failed')
      },
    })
    h.advance(HOST_IDLE + HOST_GRACE)
    await h.host.tick()
    expect(h.world.events).toEqual([`kill-port:${HOST_PORT}`, 'remove-record'])
    expect(h.world.logs).toContain('closing page targets failed: Target.closeTarget failed')
  })

  it('a failing kill is logged and the record is still removed', async () => {
    const h = makeHost({
      killChrome: async () => {
        throw new Error('kill EPERM')
      },
    })
    h.advance(HOST_IDLE + HOST_GRACE)
    await expect(h.host.tick()).resolves.toMatchObject({ reaped: true })
    expect(h.world.events).toEqual(['close-pages', 'remove-record'])
    expect(h.world.logs).toContain('killing Chrome failed: kill EPERM')
  })

  it('end to end: an idle client fire makes the host close the pages before the kill', async () => {
    const logs: string[] = []
    const c = client(makeHub({ logs }), 11)
    await c.manager.ready()
    openPage('chrome://newtab/') // a browser-internal target never pins, but it is still closed first
    await vi.advanceTimersByTimeAsync(IDLE)
    const pid = world.nextPid - 1
    expect(world.events).toEqual(['hide', 'host:close-pages', `host:kill-group:${pid}`, 'host:remove-record'])
    expect(logs).toContain('reaping idle Chrome: closing page targets')
  })
})

describe('8468f7b1 [chrome-lifecycle.10] the force path closes pages before the kill', () => {
  it('shutdown(): close-pages then kill', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    openPage('https://a.example/')
    await c.manager.shutdown()
    expect(world.events.slice(1)).toEqual(['close-pages', `kill:${PORT}`])
  })

  it('a failing page close is logged through the logger and Chrome is still killed', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    world.failClose = true
    await c.manager.shutdown()
    expect(world.events.slice(1)).toEqual(['close-pages', `kill:${PORT}`])
    expect(c.logs).toContain('Failed to close page targets during shutdown: close failed')
  })

  it('a failing kill is logged, swallowed, and the state still resets', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    world.failKill = true
    await expect(c.manager.shutdown()).resolves.toBeUndefined()
    expect(c.logs).toContain('Failed to kill Chrome during shutdown: kill EPERM')
    expect(c.manager.isReady).toBe(false)
    expect(c.link.releaseCalls).toBe(1)
  })
})
