/**
 * Failsafe pins of the six verbs: error wrapping, soft shutdown that never
 * throws, and the documented result shapes.
 * Ticket 8468f7b1 · [tests-unit-surface.6] · [fs-187] [fs-188] [fs-189] [fs-190] [fs-191] [fs-192] [fs-193] [fs-194]
 *
 * Library touch points are mocked; no process, socket or Chrome is involved.
 * guards: [fs-187] chromeStatus reports a stopped Chrome
 * tier: S
 * cites: 8468f7b1 [tests-unit-surface.6]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lib = vi.hoisted(() => ({
  isChromeReachable: vi.fn(),
  getChromeInfo: vi.fn(),
  listPageTargetsOnly: vi.fn(),
  isManagedAt: vi.fn(),
  managerFor: vi.fn(),
  noteManagerActivity: vi.fn(),
  shutdownIdleAt: vi.fn(),
  readActivity: vi.fn(),
  readContext: vi.fn(),
}))

vi.mock('../../../src/lib/cdp/targets.js', () => ({
  isChromeReachable: lib.isChromeReachable,
  getChromeInfo: lib.getChromeInfo,
  listPageTargetsOnly: lib.listPageTargetsOnly,
}))
vi.mock('../../../src/lib/managers.js', () => ({
  isManagedAt: lib.isManagedAt,
  managerFor: lib.managerFor,
  noteManagerActivity: lib.noteManagerActivity,
  shutdownIdleAt: lib.shutdownIdleAt,
}))
vi.mock('../../../src/lib/queries/activity.js', () => ({ checkChromeActivity: lib.readActivity }))
vi.mock('../../../src/lib/queries/context.js', () => ({ getPageContext: lib.readContext }))

import { chromeStatus, checkChromeActivity, getPageContext, launchChrome, listPageTargets, shutdownChrome } from '../../../src/api.js'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('verb failsafes', () => {
  it('[fs-187] chromeStatus reports a stopped Chrome', async () => {
    lib.isChromeReachable.mockResolvedValue(false)
    expect(await chromeStatus()).toEqual({ running: false, managed: false })
  })

  it('[fs-188] chromeStatus reports version and managed', async () => {
    lib.isChromeReachable.mockResolvedValue(true)
    lib.getChromeInfo.mockResolvedValue({ browserVersion: 'Chrome/126', protocolVersion: '1.3' })
    lib.isManagedAt.mockReturnValue(true)
    expect(await chromeStatus()).toEqual({ running: true, version: 'Chrome/126', protocol: '1.3', managed: true })
  })

  it('[fs-189] chromeStatus wraps unexpected failures', async () => {
    lib.isChromeReachable.mockResolvedValue(true)
    lib.getChromeInfo.mockRejectedValue(new Error('bad json'))
    await expect(chromeStatus()).rejects.toThrow('Failed to check Chrome status: bad json')
  })

  it('[fs-190] launchChrome starts Chrome and wraps failures', async () => {
    const ready = vi.fn().mockResolvedValue(undefined)
    lib.managerFor.mockReturnValue({ ready })
    expect(await launchChrome({ port: 9300 })).toEqual({ ok: true, port: 9300 })
    expect(ready).toHaveBeenCalledOnce()
    lib.managerFor.mockReturnValue({ ready: vi.fn().mockRejectedValue(new Error('no chrome binary')) })
    await expect(launchChrome()).rejects.toThrow('Failed to launch Chrome: no chrome binary')
    lib.managerFor.mockReturnValue({ ready: vi.fn().mockRejectedValue('plain string') })
    await expect(launchChrome()).rejects.toThrow('Failed to launch Chrome: plain string')
  })

  it('[fs-191] shutdownChrome is soft and never throws', async () => {
    lib.shutdownIdleAt.mockRejectedValue(new Error('kill refused'))
    lib.isChromeReachable.mockResolvedValue(true)
    // the soft shutdown deferred or failed: still ok, and `running` tells the caller what happened
    expect(await shutdownChrome()).toEqual({ ok: true, running: true })
    lib.shutdownIdleAt.mockResolvedValue(undefined)
    lib.isChromeReachable.mockResolvedValue(false)
    expect(await shutdownChrome()).toEqual({ ok: true, running: false })
  })

  it('[fs-192] listPageTargets lists the page targets', async () => {
    lib.listPageTargetsOnly.mockResolvedValue([
      { id: 'A', type: 'page', url: 'https://a.test/', webSocketDebuggerUrl: 'ws://x/A' },
      { id: 'B', type: 'page', url: 'https://b.test/', webSocketDebuggerUrl: 'ws://x/B' },
    ])
    const r = await listPageTargets()
    expect(r.targets.map((t) => t.id)).toEqual(['A', 'B'])
  })

  it('[fs-193] checkChromeActivity reports page and history activity', async () => {
    lib.readActivity.mockResolvedValue({
      running: true,
      activeWebPages: 2,
      lastVisit: { url: 'https://a.test/', title: 't', visitTime: new Date('2026-05-06T07:08:09.000Z') },
    })
    const r = await checkChromeActivity()
    expect(r).toMatchObject({ running: true, activeWebPages: 2 })
    expect(r.lastVisit?.visitTime).toBe('2026-05-06T07:08:09.000Z')
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })

  it("[fs-194] getPageContext reports a target's context", async () => {
    const context = { url: 'https://a.test/', title: 't', cookieCount: 1, visitCount: 4 }
    lib.readContext.mockResolvedValue(context)
    expect(await getPageContext({ targetId: 'T9' })).toEqual({ found: true, context })
  })
})
