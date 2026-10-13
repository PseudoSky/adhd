/**
 * CL3 (F5) hide windows after a launch, never on the fast path.
 * Ticket 8468f7b1 · [chrome-lifecycle.3]
 *
 * A fresh auto-launch minimizes every Chrome window (`hideAllWindows`) so the
 * default window never flashes on screen; once ready, the fast path never
 * re-hides, so a captcha window revealed for a human stays visible. A hide
 * failure is logged and rethrown and leaves the manager not ready.
 * Simulated machine (manager-world); no socket, no process, no real port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('./manager-world.js')).fsModule())
vi.mock('../../../lib/cdp/browser.js', async () => (await import('./manager-world.js')).browserModule())
vi.mock('../../../lib/cdp/targets.js', async () => (await import('./manager-world.js')).targetsModule())
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('./manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { hideAllWindows } from '../../../lib/cdp/targets.js'
import { chromeGone, HOST, resetSp, resetWorld, world } from './manager-world.js'
import { client, makeHub } from './manager-clients.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
  vi.mocked(hideAllWindows).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [chrome-lifecycle.3] hideAllWindows after a fresh launch only', () => {
  it('a fresh launch hides every window, after Chrome is up', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    expect(hideAllWindows).toHaveBeenCalledTimes(1)
    expect(hideAllWindows).toHaveBeenCalledWith(HOST)
    expect(world.spawns).toBe(1)
  })

  it('the fast path does not re-hide: a window revealed for a human stays visible', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    // A human was shown the captcha window (revealed); the agent keeps working.
    await c.manager.ready()
    await c.manager.withBrowser(async () => 'next query')
    expect(hideAllWindows).toHaveBeenCalledTimes(1)
  })

  it('a relaunch after Chrome was killed hides the new windows again', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    chromeGone()
    await c.manager.ready()
    expect(hideAllWindows).toHaveBeenCalledTimes(2)
  })

  it('a hide failure is logged and rethrown, and the manager stays not ready', async () => {
    world.failHide = true
    const c = client(makeHub(), 11)
    await expect(c.manager.ready()).rejects.toThrow('Browser.setWindowBounds failed')
    expect(c.manager.isReady).toBe(false)
    expect(c.logs).toContain('Failed to hide Chrome windows: Browser.setWindowBounds failed')
  })
})
