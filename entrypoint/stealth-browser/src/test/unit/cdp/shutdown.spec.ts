/**
 * Unit spec for src/lib/cdp/shutdown.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.4].
 * Pure timer logic driven by fake timers: no process, network or profile access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdleShutdown, createPageTargetIdleShutdown } from '../../../lib/cdp/shutdown.js'

describe('8468f7b1 AC2 [tests-unit-core.1] IdleShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('[fs-077] fires after the idle timeout: fires onShutdown once the default 120s idle window elapses', async () => {
    const onShutdown = vi.fn(async () => undefined)
    const idle = new IdleShutdown({ onShutdown })
    await vi.advanceTimersByTimeAsync(119_999)
    expect(onShutdown).not.toHaveBeenCalled()
    expect(idle.fired).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(onShutdown).toHaveBeenCalledTimes(1)
    expect(idle.fired).toBe(true)
  })

  it('honours a custom timeoutMs and logs the shutdown', async () => {
    const logger = vi.fn()
    new IdleShutdown({ timeoutMs: 500, logger, onShutdown: async () => undefined })
    await vi.advanceTimersByTimeAsync(500)
    expect(logger).toHaveBeenCalledWith('[idle-shutdown] no activity for 500ms — shutting down')
  })

  it('reset() pushes the deadline out', async () => {
    const onShutdown = vi.fn(async () => undefined)
    const idle = new IdleShutdown({ timeoutMs: 1000, onShutdown })
    await vi.advanceTimersByTimeAsync(900)
    idle.reset()
    await vi.advanceTimersByTimeAsync(900)
    expect(onShutdown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(onShutdown).toHaveBeenCalledTimes(1)
  })

  it('[fs-080] cancel stops the timer without firing: cancel() stops the timer without firing', async () => {
    const onShutdown = vi.fn(async () => undefined)
    const idle = new IdleShutdown({ timeoutMs: 1000, onShutdown })
    idle.cancel()
    await vi.advanceTimersByTimeAsync(5000)
    expect(onShutdown).not.toHaveBeenCalled()
    expect(idle.fired).toBe(false)
  })

  it('[fs-078] re-arms after it has fired: re-arms after a fire so a relaunched browser is auto-shut-down again', async () => {
    const onShutdown = vi.fn(async () => undefined)
    const idle = new IdleShutdown({ timeoutMs: 1000, onShutdown })
    await vi.advanceTimersByTimeAsync(1000)
    expect(idle.fired).toBe(true)
    idle.reset()
    expect(idle.fired).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onShutdown).toHaveBeenCalledTimes(2)
  })

  it('[fs-081] a throwing shutdown handler is logged not thrown: swallows an onShutdown rejection and logs it (error path)', async () => {
    const logger = vi.fn()
    const idle = new IdleShutdown({
      timeoutMs: 100,
      logger,
      onShutdown: async () => {
        throw new Error('close failed')
      },
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(logger).toHaveBeenCalledWith('[idle-shutdown] error: close failed')
    expect(idle.fired).toBe(true)
  })

  it('fires harmlessly with no onShutdown or logger configured', async () => {
    const idle = new IdleShutdown({ timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    expect(idle.fired).toBe(true)
  })

  it(`[fs-079] the idle timer is unref'd: unrefs its timer so a pending idle window cannot hold the process open`, () => {
    const unref = vi.fn()
    const realSetTimeout = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const handle = realSetTimeout(fn, ms) as unknown as { unref: () => void }
      handle.unref = unref
      return handle
    }) as unknown as typeof setTimeout)
    const idle = new IdleShutdown({ timeoutMs: 1000 })
    expect(unref).toHaveBeenCalled()
    idle.cancel()
    spy.mockRestore()
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] createPageTargetIdleShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes page targets after the idle timeout and leaves Chrome running by default', async () => {
    const closeTargets = vi.fn(async () => undefined)
    const onShutdown = vi.fn(async () => undefined)
    createPageTargetIdleShutdown(closeTargets, { timeoutMs: 200, onShutdown })
    await vi.advanceTimersByTimeAsync(200)
    expect(closeTargets).toHaveBeenCalledTimes(1)
    expect(onShutdown).not.toHaveBeenCalled()
  })

  it('[fs-082] closes page targets then optionally chains the Chrome shutdown: also runs the Chrome shutdown callback when shutDownChrome is set', async () => {
    const order: string[] = []
    createPageTargetIdleShutdown(
      async () => { order.push('targets') },
      { timeoutMs: 200, shutDownChrome: true, onShutdown: async () => { order.push('chrome') } },
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(order).toEqual(['targets', 'chrome'])
  })

  it('defaults to a 120s window and surfaces closeTargets failures to the logger', async () => {
    const logger = vi.fn()
    const closeTargets = vi.fn(async () => {
      throw new Error('cdp down')
    })
    createPageTargetIdleShutdown(closeTargets, { logger })
    await vi.advanceTimersByTimeAsync(119_999)
    expect(closeTargets).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(closeTargets).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith('[idle-shutdown] error: cdp down')
  })
})
