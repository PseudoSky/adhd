/**
 * The six chrome-runner verbs delegate to the library with the right arguments
 * and return the documented JSON shapes (`managed: boolean` always present).
 * Ticket 8468f7b1 · [tests-unit-surface.1] [tests-unit-surface.2] · surface-api.
 *
 * Every library touch point (CDP targets, the manager seam, the activity and
 * context queries) is replaced with a mock: no process, no socket, no Chrome.
 * guards: reports a stopped Chrome without asking for its version; an invalidEndpoint failure is a typed error told apart by its code
 * tier: S
 * cites: 8468f7b1 [tests-unit-surface.1] [tests-unit-surface.2] [fix-core-errors.2] [audit-fixes.5]
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

import { ERROR_CODES, StealthCoreBrowserError, exitCodeFor } from '../../../src/errors.js'
import { chromeStatus, checkChromeActivity, getPageContext, launchChrome, listPageTargets, shutdownChrome } from '../../../src/api.js'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('chromeStatus', () => {
  it('reports a stopped Chrome without asking for its version', async () => {
    lib.isChromeReachable.mockResolvedValue(false)
    expect(await chromeStatus()).toEqual({ running: false, managed: false })
    expect(lib.isChromeReachable).toHaveBeenCalledWith('127.0.0.1:9222')
    expect(lib.getChromeInfo).not.toHaveBeenCalled()
  })

  it('targets the host and port the caller gives and always returns managed as a boolean', async () => {
    lib.isChromeReachable.mockResolvedValue(true)
    lib.getChromeInfo.mockResolvedValue({ browserVersion: 'Chrome/126', protocolVersion: '1.3' })
    lib.isManagedAt.mockReturnValue(false)
    const r = await chromeStatus({ host: 'localhost', port: 9333 })
    expect(r).toEqual({ running: true, version: 'Chrome/126', protocol: '1.3', managed: false })
    expect(typeof r.managed).toBe('boolean')
    expect(lib.getChromeInfo).toHaveBeenCalledWith('localhost:9333')
    expect(lib.isManagedAt).toHaveBeenCalledWith('localhost', 9333)
  })

  it('rejects an out-of-range port and a host with a path or whitespace without touching Chrome', async () => {
    await expect(chromeStatus({ port: 0 })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    await expect(chromeStatus({ port: 70000 })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    await expect(chromeStatus({ port: 1.5 })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    await expect(chromeStatus({ host: 'a/b' })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    await expect(chromeStatus({ host: 'a b' })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    expect(lib.isChromeReachable).not.toHaveBeenCalled()
  })

  it('an invalidEndpoint failure carries a typed code a host reads to pick its exit status, with no prototype bridge', async () => {
    const caught = await chromeStatus({ port: 0 }).then(
      () => undefined,
      (e: unknown) => e as StealthCoreBrowserError,
    )
    expect(caught).toBeDefined()
    const error = caught as StealthCoreBrowserError
    expect(error.code === 'CDP_UNREACHABLE').toBe(true)
    expect(ERROR_CODES).toContain(error.code)
    expect(error.name).toBe('StealthCoreBrowserError')
    expect(error.detail).toEqual({ reason: 'invalid-endpoint' })
    expect(error.remediation).toMatch(/launchChrome/)
    expect(exitCodeFor(error.code)).toBe(21)
    // a plain typed error of the package, not a RangeError dressed up as one
    expect(error.constructor).toBe(StealthCoreBrowserError)
    expect(Object.prototype.hasOwnProperty.call(StealthCoreBrowserError, Symbol.hasInstance)).toBe(false)
  })

  it('trims the host and falls back to the default for a blank one', async () => {
    lib.isChromeReachable.mockResolvedValue(false)
    await chromeStatus({ host: '  ' })
    expect(lib.isChromeReachable).toHaveBeenCalledWith('127.0.0.1:9222')
  })
})

describe('launchChrome', () => {
  it('readies the manager of the port and profile and returns ok with the port', async () => {
    const ready = vi.fn().mockResolvedValue(undefined)
    lib.managerFor.mockReturnValue({ ready })
    expect(await launchChrome({ port: 9444, userDataDir: '/p/profile' })).toEqual({ ok: true, port: 9444 })
    expect(lib.managerFor).toHaveBeenCalledWith('127.0.0.1', 9444, '/p/profile')
    expect(ready).toHaveBeenCalledOnce()
  })

  it('defaults to port 9222 with no profile override', async () => {
    lib.managerFor.mockReturnValue({ ready: vi.fn().mockResolvedValue(undefined) })
    expect(await launchChrome()).toEqual({ ok: true, port: 9222 })
    expect(lib.managerFor).toHaveBeenCalledWith('127.0.0.1', 9222, undefined)
  })
})

describe('shutdownChrome', () => {
  it('asks for the soft shutdown and reports whether Chrome still answers', async () => {
    lib.shutdownIdleAt.mockResolvedValue(undefined)
    lib.isChromeReachable.mockResolvedValue(true)
    expect(await shutdownChrome({ port: 9555 })).toEqual({ ok: true, running: true })
    expect(lib.shutdownIdleAt).toHaveBeenCalledWith('127.0.0.1', 9555)
    expect(lib.isChromeReachable).toHaveBeenCalledWith('127.0.0.1:9555')
  })
})

describe('listPageTargets', () => {
  it('projects each page to id, type, url and socket and notes activity', async () => {
    lib.listPageTargetsOnly.mockResolvedValue([
      { id: 'T1', type: 'page', url: 'https://a.test/', webSocketDebuggerUrl: 'ws://x/1', title: 'dropped' },
    ])
    const r = await listPageTargets({ port: 9222 })
    expect(r).toEqual({ targets: [{ id: 'T1', type: 'page', url: 'https://a.test/', webSocketDebuggerUrl: 'ws://x/1' }] })
    expect(lib.listPageTargetsOnly).toHaveBeenCalledWith('127.0.0.1:9222')
    expect(lib.noteManagerActivity).toHaveBeenCalledWith('127.0.0.1', 9222)
  })
})

describe('checkChromeActivity', () => {
  it('serializes the last visit time to ISO text and passes the recency window', async () => {
    lib.readActivity.mockResolvedValue({
      running: true,
      activeWebPages: 1,
      lastVisit: { url: 'https://a.test/', title: 't', visitTime: new Date('2026-01-02T03:04:05.000Z') },
    })
    const r = await checkChromeActivity({ withinMinutes: 7 })
    expect(r.lastVisit).toMatchObject({ url: 'https://a.test/', visitTime: '2026-01-02T03:04:05.000Z' })
    expect(lib.readActivity).toHaveBeenCalledWith('127.0.0.1:9222', 7, undefined)
    expect(lib.noteManagerActivity).toHaveBeenCalledWith('127.0.0.1', 9222)
  })

  it('returns a null lastVisit when history has none', async () => {
    lib.readActivity.mockResolvedValue({ running: true, activeWebPages: 0, lastVisit: null })
    expect((await checkChromeActivity()).lastVisit).toBeNull()
  })
})

describe('getPageContext', () => {
  it('[audit-fixes.5] P24 passes a custom userDataDir to the context and activity reads', async () => {
    lib.readContext.mockResolvedValue(null)
    await getPageContext({ targetId: 'T1', userDataDir: '/profiles/custom' })
    expect(lib.readContext).toHaveBeenCalledWith('T1', '127.0.0.1:9222', '/profiles/custom')
    lib.readActivity.mockResolvedValue({ running: false, activeWebPages: 0, lastVisit: null })
    await checkChromeActivity({ userDataDir: '/profiles/custom' })
    expect(lib.readActivity).toHaveBeenLastCalledWith('127.0.0.1:9222', undefined, '/profiles/custom')
  })

  it('returns found true with the context', async () => {
    const context = { url: 'https://a.test/', title: 't', cookieCount: 2, visitCount: 3 }
    lib.readContext.mockResolvedValue(context)
    expect(await getPageContext({ targetId: 'T1', port: 9333 })).toEqual({ found: true, context })
    expect(lib.readContext).toHaveBeenCalledWith('T1', '127.0.0.1:9333', undefined)
    expect(lib.noteManagerActivity).toHaveBeenCalledWith('127.0.0.1', 9333)
  })

  it('returns found false with a null context when the target is gone', async () => {
    lib.readContext.mockResolvedValue(null)
    expect(await getPageContext({ targetId: 'gone' })).toEqual({ found: false, context: null })
  })
})
