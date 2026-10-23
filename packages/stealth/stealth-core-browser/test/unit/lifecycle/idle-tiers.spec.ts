/**
 * The idle shutdown and its three safety tiers, as a user experiences them
 * through one ChromeManager: the idle window armed at launch and bumped by
 * work, the soft path on expiry, and the tiers the reaper host evaluates
 * (another client, an open http(s) page, recent history) plus the force path
 * that ignores them all.
 * Ticket 8468f7b1 · [chrome-lifecycle.4] [chrome-lifecycle.7] [chrome-lifecycle.8] [chrome-lifecycle.9] ·
 * inventory [fs-007] [fs-008] [fs-009] [fs-010] [fs-020] [fs-021] [fs-022] [fs-023] [fs-024] [fs-025] [fs-026] [fs-027]
 *
 * Simulated machine (manager-world): fake clock, scripted Chrome and history,
 * the real reaper host behind a FakeReaperLink. No socket, no process, no real port.
 * guards: arms a fresh idle window after launch
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.4] [chrome-lifecycle.7] [chrome-lifecycle.8] [chrome-lifecycle.9]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { IDLE, openPage, PORT, resetSp, resetWorld, world } from '../../helpers/lifecycle/manager-world.js'
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

describe('8468f7b1 [chrome-lifecycle.4] the idle window', () => {
  it('arms a fresh idle window after launch', async () => {
    // [fs-007] ready() starts the timer at the launch moment and stamps activity.
    const hub = makeHub()
    const c = client(hub, 11)
    await vi.advanceTimersByTimeAsync(5_000) // time passing before first use does not count
    await c.manager.ready()
    expect(hub.host!.clients()[0]!.lastActivityAt).toBe(Date.now())
    await vi.advanceTimersByTimeAsync(IDLE - 1)
    expect(c.link.reapCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.link.reapCalls).toBe(1)
  })

  it('idle expiry runs the soft shutdown path', async () => {
    // [fs-008] expiry asks the host (soft, tiers apply), never the forced local kill.
    const c = client(makeHub(), 11)
    await c.manager.ready()
    openPage('https://captcha.example/')
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(c.link.reapCalls).toBe(1)
    expect(world.events).not.toContain(`kill:${PORT}`)
    expect(world.chromeUp).toBe(true)
  })

  it('bump re-arms the idle window', async () => {
    // [fs-009] bump() resets the timer and stamps activity; before ready() it is a no-op.
    const hub = makeHub()
    const c = client(hub, 11)
    c.manager.bump()
    expect(c.link.activityCalls).toBe(0)
    await c.manager.ready()
    await vi.advanceTimersByTimeAsync(IDLE - 10)
    c.manager.bump()
    expect(hub.host!.clients()[0]!.lastActivityAt).toBe(Date.now())
    await vi.advanceTimersByTimeAsync(IDLE - 1)
    expect(c.link.reapCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.link.reapCalls).toBe(1)
  })

  it('withBrowser bumps when fn throws', async () => {
    // [fs-010] the finally-bump counts a throwing fn as activity.
    const c = client(makeHub(), 11)
    const bump = vi.spyOn(c.manager, 'bump')
    await expect(c.manager.withBrowser(async () => Promise.reject(new Error('navigation failed')))).rejects.toThrow('navigation failed')
    expect(bump).toHaveBeenCalledTimes(1)
    expect(c.manager.isReady).toBe(true)
  })
})

describe('8468f7b1 [chrome-lifecycle.7] tier 2: open pages', () => {
  it('an open https page keeps Chrome alive', async () => {
    // [fs-020] the fire defers and re-arms WITHOUT stamping activity.
    const hub = makeHub()
    const c = client(hub, 11)
    await c.manager.ready()
    openPage('https://captcha.example/challenge')
    const stamp = hub.host!.clients()[0]!.lastActivityAt
    await vi.advanceTimersByTimeAsync(IDLE * 3)
    expect(c.link.reapCalls).toBe(3)
    expect(world.chromeUp).toBe(true)
    expect(hub.host!.clients()[0]!.lastActivityAt).toBe(stamp)
  })

  it('browser-internal targets never pin Chrome', async () => {
    // [fs-021] the newtab fix: chrome://newtab/, chrome-untrusted://, about:, devtools:// and extension pages do not count.
    const c = client(makeHub(), 11)
    await c.manager.ready()
    for (const url of ['chrome://newtab/', 'chrome-untrusted://new-tab-page/', 'about:blank', 'devtools://devtools/inspector.html', 'chrome-extension://abc/bg.html']) openPage(url)
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(false)
  })

  it('proceeds when CDP is unreachable during the page check', async () => {
    // [fs-022] a failing page listing never defers forever.
    const c = client(makeHub(), 11)
    await c.manager.ready()
    openPage('https://example.com/')
    world.listFails = true
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(false)
  })
})

describe('8468f7b1 [chrome-lifecycle.8] tier 3: history recency', () => {
  it('a recent history visit keeps Chrome alive', async () => {
    // [fs-023]
    const hub = makeHub()
    const c = client(hub, 11)
    await c.manager.ready()
    world.history = true
    const stamp = hub.host!.clients()[0]!.lastActivityAt
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(true)
    expect(c.logs).toContain('Chrome in use (history) — deferring')
    expect(hub.host!.clients()[0]!.lastActivityAt).toBe(stamp)
  })

  it('checkHistory defaults on and false skips the tier', async () => {
    // [fs-024]
    world.history = true
    const on = client(makeHub(), 11)
    await on.manager.ready()
    await on.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(true)

    resetWorld()
    world.history = true
    const off = client(makeHub(), 22, { checkHistory: false })
    await off.manager.ready()
    await off.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(false)
  })

  it('proceeds when the history database is unavailable', async () => {
    // [fs-025] missing, locked or unreadable history skips tier 3.
    const c = client(makeHub(), 11)
    await c.manager.ready()
    world.history = new Error('SQLITE_BUSY: database is locked')
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(false)
  })
})

describe('8468f7b1 [chrome-lifecycle.9] force and soft shutdown', () => {
  it('shutdown ignores every safety tier', async () => {
    // [fs-026] a sibling active, a page open, history recent: the force path still closes Chrome.
    const hub = makeHub()
    const a = client(hub, 11)
    const b = client(hub, 22)
    await a.manager.ready()
    await b.manager.ready()
    b.manager.bump()
    openPage('https://example.com/')
    world.history = true
    await a.manager.shutdown()
    expect(world.chromeUp).toBe(false)
    expect(world.events).toContain(`kill:${PORT}`)
  })

  it('shutdownIfIdle defers to a sibling a page and history', async () => {
    // [fs-027] the soft path never closes a sibling's or a human's Chrome.
    const hub = makeHub()
    const a = client(hub, 11)
    const b = client(hub, 22)
    await a.manager.ready()
    await b.manager.ready()
    b.manager.bump()
    await a.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(true)

    await b.manager.release() // the sibling leaves
    openPage('https://captcha.example/')
    await a.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(true)

    world.pages = []
    world.history = true
    await a.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(true)

    world.history = false
    await a.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(false)
  })
})
