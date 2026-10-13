/**
 * CL20 typed lifecycle errors.
 * Ticket 8468f7b1 · [chrome-lifecycle.20]
 *
 * `LifecycleError` has exactly six codes: LAUNCH_FAILED, LAUNCH_LOCK_TIMEOUT,
 * CHROME_UNREACHABLE_AFTER_LAUNCH, LAUNCH_CIRCUIT_OPEN, REAPER_UNAVAILABLE,
 * ISOLATED_CONTEXT_FAILED. Each is reachable with `cause` or `detail`
 * (`retryAfterMs`, `port`, `path`) and a one-line message that names the fix.
 */
import { describe, expect, it } from 'vitest'
import {
  LIFECYCLE_ERROR_CODES,
  LifecycleError,
  isLifecycleError,
  lifecycleError,
  lifecycleErrors,
  type LifecycleErrorCode,
} from '../../../lib/lifecycle/errors.js'

const oneLine = (e: LifecycleError) => {
  expect(e.message).not.toContain('\n')
  expect(e.message.length).toBeGreaterThan(20)
}

describe('8468f7b1 [chrome-lifecycle.20] the code set', () => {
  it('has exactly the six lifecycle codes', () => {
    expect([...LIFECYCLE_ERROR_CODES]).toEqual([
      'LAUNCH_FAILED',
      'LAUNCH_LOCK_TIMEOUT',
      'CHROME_UNREACHABLE_AFTER_LAUNCH',
      'LAUNCH_CIRCUIT_OPEN',
      'REAPER_UNAVAILABLE',
      'ISOLATED_CONTEXT_FAILED',
    ])
  })

  it('is an Error subclass carrying name, code, cause and detail', () => {
    const cause = new Error('root')
    const e = lifecycleError('LAUNCH_FAILED', 'x', { cause, detail: { port: 1 } })
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(LifecycleError)
    expect(e.name).toBe('LifecycleError')
    expect(e.code).toBe('LAUNCH_FAILED')
    expect(e.cause).toBe(cause)
    expect(e.detail).toEqual({ port: 1 })
    expect(isLifecycleError(e)).toBe(true)
    expect(isLifecycleError(e, 'LAUNCH_FAILED')).toBe(true)
    expect(isLifecycleError(e, 'REAPER_UNAVAILABLE')).toBe(false)
    expect(isLifecycleError(new Error('plain'))).toBe(false)
  })
})

describe('8468f7b1 [chrome-lifecycle.20] every code is reachable with cause/detail and a fix-naming message', () => {
  it('LAUNCH_FAILED keeps the spawn cause and the port', () => {
    const cause = Object.assign(new Error('spawn /x ENOENT'), { code: 'ENOENT' })
    const e = lifecycleErrors.launchFailed(9333, cause)
    expect(e.code).toBe('LAUNCH_FAILED')
    expect(e.cause).toBe(cause)
    expect(e.detail).toEqual({ port: 9333 })
    expect(e.message).toMatch(/install Chrome or pass chromePath/)
    oneLine(e)
  })

  it('LAUNCH_LOCK_TIMEOUT names the lock path and port', () => {
    const e = lifecycleErrors.launchLockTimeout(9333, '/tmp/stealth-chrome-launch-9333.lock')
    expect(e.code).toBe('LAUNCH_LOCK_TIMEOUT')
    expect(e.detail).toEqual({ port: 9333, path: '/tmp/stealth-chrome-launch-9333.lock' })
    expect(e.message).toMatch(/remove the stale lock file/)
    oneLine(e)
  })

  it('CHROME_UNREACHABLE_AFTER_LAUNCH carries the port and the underlying cause', () => {
    const cause = new Error('Chrome did not start CDP on port 9333 within 10s')
    const e = lifecycleErrors.unreachableAfterLaunch(9333, cause)
    expect(e.code).toBe('CHROME_UNREACHABLE_AFTER_LAUNCH')
    expect(e.cause).toBe(cause)
    expect(e.detail).toEqual({ port: 9333 })
    expect(e.message).toMatch(/within 10 s; check that nothing else holds the port/)
    oneLine(e)
  })

  it('LAUNCH_CIRCUIT_OPEN carries retryAfterMs', () => {
    const e = lifecycleErrors.circuitOpen(9333, 12_345)
    expect(e.code).toBe('LAUNCH_CIRCUIT_OPEN')
    expect(e.detail).toEqual({ port: 9333, retryAfterMs: 12_345 })
    expect(e.message).toMatch(/retry in 13 s after fixing the launch error/)
    oneLine(e)
  })

  it('REAPER_UNAVAILABLE keeps the transport cause (E_UDS_DIR_UNSAFE) and the state path', () => {
    const cause = Object.assign(new Error('socket dir is writable by others'), { code: 'E_UDS_DIR_UNSAFE' })
    const e = lifecycleErrors.reaperUnavailable(9333, cause, '/tmp/stealth-browser-501-9333')
    expect(e.code).toBe('REAPER_UNAVAILABLE')
    expect(e.cause).toBe(cause)
    expect(e.detail).toEqual({ port: 9333, path: '/tmp/stealth-browser-501-9333' })
    expect(e.message).toMatch(/state directory is private \(0700, own uid\)/)
    oneLine(e)
    expect(lifecycleErrors.reaperUnavailable(9333).detail).toEqual({ port: 9333 })
  })

  it('ISOLATED_CONTEXT_FAILED names the failed step and keeps the cause', () => {
    const cause = new Error('WebSocket connection failed')
    const e = lifecycleErrors.isolatedContextFailed('connect', cause)
    expect(e.code).toBe('ISOLATED_CONTEXT_FAILED')
    expect(e.cause).toBe(cause)
    expect(e.detail).toEqual({ step: 'connect' })
    expect(e.message).toMatch(/the context was disposed, check that Chrome is reachable and retry/)
    oneLine(e)
  })

  it('every code is produced by exactly one factory', () => {
    const produced: LifecycleErrorCode[] = [
      lifecycleErrors.launchFailed(1, 'x').code,
      lifecycleErrors.launchLockTimeout(1, '/p').code,
      lifecycleErrors.unreachableAfterLaunch(1).code,
      lifecycleErrors.circuitOpen(1, 1).code,
      lifecycleErrors.reaperUnavailable(1).code,
      lifecycleErrors.isolatedContextFailed('s', 'x').code,
    ]
    expect(produced.sort()).toEqual([...LIFECYCLE_ERROR_CODES].sort())
  })
})
