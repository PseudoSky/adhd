/**
 * CL4 (F6 F7) the activity-bumped idle timer, client side.
 * Ticket 8468f7b1 · [chrome-lifecycle.4]
 *
 * A user keeps working through one ChromeManager: every `bump()` pushes the
 * idle deadline out by the full window (no fire at 299 ms, fire at 300 ms after
 * the last bump), the timer re-arms after it fired, `withBrowser` bumps even
 * when its callback throws, and every timer the manager arms is unref'd so an
 * idle Chrome never keeps the client process alive. Simulated machine
 * (manager-world): fake clock, scripted Chrome, the real reaper host behind a
 * FakeReaperLink. No socket, no process, no real port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('./manager-world.js')).fsModule())
vi.mock('../../../lib/cdp/browser.js', async () => (await import('./manager-world.js')).browserModule())
vi.mock('../../../lib/cdp/targets.js', async () => (await import('./manager-world.js')).targetsModule())
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('./manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { openPage, resetSp, resetWorld } from './manager-world.js'
import { client, makeHub } from './manager-clients.js'

const WINDOW = 300

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [chrome-lifecycle.4] the idle timer is bumped by activity', () => {
  it('bump() re-arms the full window: no fire at 299 ms, fire at 300 ms after the last bump', async () => {
    const c = client(makeHub(), 11, { idleTimeoutMs: WINDOW })
    await c.manager.ready()
    await vi.advanceTimersByTimeAsync(200)
    c.manager.bump()
    await vi.advanceTimersByTimeAsync(299)
    expect(c.link.reapCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.link.reapCalls).toBe(1)
  })

  it('the timer re-arms after it fired (a deferred fire arms the next window)', async () => {
    const c = client(makeHub(), 11, { idleTimeoutMs: WINDOW })
    await c.manager.ready()
    openPage('https://captcha.example/') // tier 2 pins Chrome, so the fire defers
    await vi.advanceTimersByTimeAsync(300)
    expect(c.link.reapCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(299)
    expect(c.link.reapCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.link.reapCalls).toBe(2)
    // A bump after a fire still re-arms a full window.
    c.manager.bump()
    await vi.advanceTimersByTimeAsync(299)
    expect(c.link.reapCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.link.reapCalls).toBe(3)
  })

  it('withBrowser bumps when fn succeeds and when fn throws', async () => {
    const c = client(makeHub(), 11, { idleTimeoutMs: WINDOW })
    const bump = vi.spyOn(c.manager, 'bump')
    await expect(c.manager.withBrowser(async () => 'ok')).resolves.toBe('ok')
    expect(bump).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(250)
    const sent = c.link.activityCalls
    await expect(
      c.manager.withBrowser(async () => {
        throw new Error('page crashed')
      }),
    ).rejects.toThrow('page crashed')
    expect(bump).toHaveBeenCalledTimes(2)
    expect(c.link.activityCalls).toBeGreaterThan(sent)
    // The throwing call still counted as activity: the window restarted at 250 ms.
    await vi.advanceTimersByTimeAsync(299)
    expect(c.link.reapCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.link.reapCalls).toBe(1)
  })

  it('bump() before ready() is a no-op (no timer, no activity)', () => {
    const c = client(makeHub(), 11, { idleTimeoutMs: WINDOW })
    c.manager.bump()
    expect(c.link.activityCalls).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('every timer the manager arms is unref\'d (an idle Chrome never keeps the process alive)', async () => {
    const handles: Array<{ hasRef(): boolean }> = []
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const h = real(fn, ms) as unknown as { hasRef(): boolean }
      handles.push(h)
      return h
    }) as typeof setTimeout)
    const c = client(makeHub(), 11, { idleTimeoutMs: WINDOW })
    await c.manager.ready()
    c.manager.bump()
    await c.manager.shutdownIfIdle()
    expect(handles.length).toBeGreaterThan(0)
    expect(handles.every((h) => h.hasRef() === false)).toBe(true)
  })
})
