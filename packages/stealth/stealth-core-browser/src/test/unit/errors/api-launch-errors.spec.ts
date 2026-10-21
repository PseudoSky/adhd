/**
 * The verbs of src/api.ts never replace a typed error with a plain Error: a LifecycleError (or any
 * StealthCoreBrowserError) from the manager's ready() reaches the caller unchanged, an untyped failure becomes a
 * registry code with `cause`, and an invalid endpoint is a typed RangeError.
 * Ticket 8468f7b1 · [prod-errors.9] [prod-errors.2] · PA5.1 / PA5.4.
 * The managers seam is configured with a fake manager whose ready() rejects; targets are stubbed: no Chrome, no network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  ready: vi.fn<() => Promise<void>>(),
  managerFor: vi.fn(),
  isChromeReachable: vi.fn(),
  getChromeInfo: vi.fn(),
}))

vi.mock('../../../lib/managers.js', () => ({
  managerFor: seam.managerFor,
  isManagedAt: vi.fn(() => false),
  noteManagerActivity: vi.fn(),
  shutdownIdleAt: vi.fn(async () => undefined),
}))
vi.mock('../../../lib/cdp/targets.js', () => ({
  isChromeReachable: seam.isChromeReachable,
  getChromeInfo: seam.getChromeInfo,
  listPageTargetsOnly: vi.fn(async () => []),
}))

import { chromeStatus, launchChrome } from '../../../api.js'
import { StealthCoreBrowserError } from '../../../errors.js'
import { LifecycleError, lifecycleError, lifecycleErrors } from '../../../lib/lifecycle/errors.js'

beforeEach(() => {
  seam.ready.mockReset()
  seam.managerFor.mockReset()
  seam.managerFor.mockReturnValue({ ready: seam.ready })
  seam.isChromeReachable.mockReset()
  seam.getChromeInfo.mockReset()
})

describe('8468f7b1 [prod-errors.9] launchChrome keeps a typed LifecycleError unchanged (PA5.4)', () => {
  it('launchChrome rethrows the LifecycleError LAUNCH_FAILED of a foreign-profile refusal with its reason detail', async () => {
    const refusal = lifecycleError('LAUNCH_FAILED', "Chrome on port 9333 is not this tool's own Chrome", { detail: { port: 9333, path: '/p', reason: 'foreign-profile' } })
    seam.ready.mockRejectedValue(refusal)
    const p = launchChrome({ port: 9333 })
    await expect(p).rejects.toBe(refusal)
    await expect(p).rejects.toMatchObject({ code: 'LAUNCH_FAILED', detail: { reason: 'foreign-profile', port: 9333 } })
    await expect(p).rejects.toBeInstanceOf(LifecycleError)
    await expect(p).rejects.toBeInstanceOf(StealthCoreBrowserError)
  })

  it('launchChrome rethrows LAUNCH_CIRCUIT_OPEN with its retryAfterMs detail', async () => {
    seam.ready.mockRejectedValue(lifecycleErrors.circuitOpen(9333, 42_000))
    const p = launchChrome({ port: 9333 })
    await expect(p).rejects.toMatchObject({ code: 'LAUNCH_CIRCUIT_OPEN', detail: { retryAfterMs: 42_000, port: 9333 } })
    await expect(p).rejects.toBeInstanceOf(LifecycleError)
  })

  it('launchChrome rethrows LAUNCH_LOCK_TIMEOUT and CHROME_UNREACHABLE_AFTER_LAUNCH as the same LifecycleError instances', async () => {
    const lock = lifecycleErrors.launchLockTimeout(9333, '/tmp/x.lock')
    seam.ready.mockRejectedValueOnce(lock)
    await expect(launchChrome({ port: 9333 })).rejects.toBe(lock)
    const dead = lifecycleErrors.unreachableAfterLaunch(9333)
    seam.ready.mockRejectedValueOnce(dead)
    await expect(launchChrome({ port: 9333 })).rejects.toBe(dead)
  })

  it('launchChrome rethrows a plain StealthCoreBrowserError (CHROME_NOT_FOUND) unchanged', async () => {
    const missing = new StealthCoreBrowserError('CHROME_NOT_FOUND', 'Chrome binary not found at "/nowhere"')
    seam.ready.mockRejectedValue(missing)
    await expect(launchChrome({ port: 9333 })).rejects.toBe(missing)
  })

  it('launchChrome maps a non-typed rejection to LAUNCH_FAILED with the cause set and the message preserved', async () => {
    const cause = new Error('no chrome binary')
    seam.ready.mockRejectedValue(cause)
    const p = launchChrome({ port: 9333 })
    await expect(p).rejects.toMatchObject({ code: 'LAUNCH_FAILED', cause, message: expect.stringContaining('Failed to launch Chrome: no chrome binary'), detail: { port: 9333 } })
    await expect(p).rejects.toBeInstanceOf(StealthCoreBrowserError)
  })

  it('launchChrome maps a rejection that is not even an Error to LAUNCH_FAILED with the string as cause', async () => {
    seam.ready.mockRejectedValue('plain string')
    await expect(launchChrome({ port: 9333 })).rejects.toMatchObject({ code: 'LAUNCH_FAILED', cause: 'plain string', message: expect.stringContaining('Failed to launch Chrome: plain string') })
  })
})

describe('8468f7b1 [prod-errors.9] chromeStatus keeps typed errors and types the rest', () => {
  it('chromeStatus rethrows a typed CDP error from the DevTools endpoint unchanged', async () => {
    const typed = new StealthCoreBrowserError('CDP_BAD_RESPONSE', 'non-JSON /json/version response')
    seam.isChromeReachable.mockResolvedValue(true)
    seam.getChromeInfo.mockRejectedValue(typed)
    await expect(chromeStatus()).rejects.toBe(typed)
  })

  it('chromeStatus wraps a non-typed failure as CDP_UNREACHABLE with the cause set', async () => {
    const cause = new Error('bad json')
    seam.isChromeReachable.mockResolvedValue(true)
    seam.getChromeInfo.mockRejectedValue(cause)
    await expect(chromeStatus({ host: 'chrome.local', port: 9444 })).rejects.toMatchObject({
      code: 'CDP_UNREACHABLE',
      cause,
      message: expect.stringContaining('Failed to check Chrome status: bad json'),
      detail: { host: 'chrome.local', port: 9444 },
    })
  })
})

describe('8468f7b1 [prod-errors.2] an invalid endpoint is a typed RangeError', () => {
  it('rejects an out-of-range port and a host with a path with CDP_UNREACHABLE that is also a RangeError', async () => {
    for (const input of [{ port: 0 }, { port: 70_000 }, { port: 1.5 }, { host: 'a/b' }, { host: 'a b' }]) {
      const p = chromeStatus(input)
      await expect(p).rejects.toMatchObject({ code: 'CDP_UNREACHABLE', detail: { reason: 'invalid-endpoint' } })
      await expect(p).rejects.toBeInstanceOf(RangeError)
      await expect(p).rejects.toBeInstanceOf(StealthCoreBrowserError)
    }
    expect(seam.isChromeReachable).not.toHaveBeenCalled()
  })
})
