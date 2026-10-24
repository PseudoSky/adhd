/**
 * Unit spec for src/lib/cdp/monitor.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4].
 * CdpSession is replaced by an in-memory fake (no WebSocket) and node:os is mocked.
 * guards: sums per-process private memory and reads the model name
 * tier: S
 * cites: 8468f7b1 [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', () => ({ cpus: () => [{}, {}, {}, {}] }))

import {
  checkWatermark,
  clearBrowserCache,
  collectResourceUsage,
  formatResourceUsage,
} from '../../../src/lib/cdp/monitor.js'
import type { ResourceUsage } from '../../../src/lib/cdp/monitor.js'
import type { CdpSession } from '../../../src/lib/cdp/session.js'

type Responder = (method: string, params?: Record<string, unknown>) => unknown

function fakeSession(respond: Responder): { session: CdpSession; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => respond(method, params))
  return { session: { send } as unknown as CdpSession, send }
}

const MB = 1024 * 1024

function usage(over: Partial<ResourceUsage> = {}): ResourceUsage {
  return {
    rssMb: 100,
    heapUsedMb: 50,
    heapTotalMb: 80,
    cpuInfo: { modelName: 'Fake CPU', cores: 4 },
    storage: { cacheBytes: 0, localStorageBytes: 0, sessionStorageBytes: 0 },
    performance: { domNodes: 12, eventListeners: 3, jsHeapSize: 0 },
    ...over,
  }
}

describe('8468f7b1 AC2 [tests-unit-core.1] collectResourceUsage', () => {
  it('sums per-process private memory and reads the model name', async () => {
    const { session } = fakeSession((m) => {
      if (m === 'SystemInfo.getProcessInfo') {
        return { processInfo: [{ privateMemory: 100 * MB }, { privateMemory: 50.5 * MB }, {}] }
      }
      if (m === 'SystemInfo.getInfo') return { modelName: 'Apple M-Fake' }
      return {}
    })
    const u = await collectResourceUsage(session)
    expect(u.rssMb).toBe(150.5)
    expect(u.cpuInfo).toEqual({ modelName: 'Apple M-Fake', cores: 4 })
    expect(u.heapUsedMb).toBe(0)
  })

  it('reads heap and DOM stats from the page session only', async () => {
    const { session: browser, send: browserSend } = fakeSession(() => ({}))
    const { session: page, send: pageSend } = fakeSession((m) =>
      m === 'Performance.getMetrics'
        ? {
            metrics: [
              { name: 'JSHeapUsedSize', value: 10 * MB },
              { name: 'JSHeapTotalSize', value: 20 * MB },
              { name: 'DomNodes', value: 321 },
              { name: 'EventListeners', value: 9 },
              { name: 'Ignored', value: 1 },
            ],
          }
        : {},
    )
    const u = await collectResourceUsage(browser, page)
    expect(u.heapUsedMb).toBe(10)
    expect(u.heapTotalMb).toBe(20)
    expect(u.performance).toEqual({ domNodes: 321, eventListeners: 9, jsHeapSize: 0 })
    expect(pageSend).toHaveBeenCalledWith('Performance.getMetrics')
    expect(browserSend).not.toHaveBeenCalledWith('Performance.getMetrics')
  })

  it('leaves heap values at 0 and skips Performance.getMetrics without a page session', async () => {
    const { session, send } = fakeSession(() => ({}))
    const u = await collectResourceUsage(session)
    expect(u.heapUsedMb).toBe(0)
    expect(u.heapTotalMb).toBe(0)
    expect(send).not.toHaveBeenCalledWith('Performance.getMetrics')
  })

  it('[fs-110] resource collection tolerates CDP failures: tolerates every CDP call failing (non-fatal) and still reports cores', async () => {
    const boom = (): never => {
      throw new Error('cdp unavailable')
    }
    const { session: browser } = fakeSession(boom)
    const { session: page } = fakeSession(boom)
    const u = await collectResourceUsage(browser, page)
    expect(u.rssMb).toBe(0)
    expect(u.cpuInfo).toEqual({ modelName: '', cores: 4 })
    expect(u.performance.domNodes).toBe(0)
  })

  it('tolerates missing processInfo and metrics arrays', async () => {
    const { session: browser } = fakeSession(() => ({}))
    const { session: page } = fakeSession(() => ({}))
    const u = await collectResourceUsage(browser, page)
    expect(u.rssMb).toBe(0)
    expect(u.heapTotalMb).toBe(0)
  })

  it('rounds figures to two decimals', async () => {
    const { session } = fakeSession((m) =>
      m === 'SystemInfo.getProcessInfo' ? { processInfo: [{ privateMemory: 1.23456 * MB }] } : {},
    )
    const u = await collectResourceUsage(session)
    expect(u.rssMb).toBe(1.23)
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] checkWatermark', () => {
  it('is healthy under the default thresholds (500 RSS / 300 heap / 100 cache MB)', () => {
    const r = checkWatermark(usage())
    expect(r).toMatchObject({ overMemory: false, overCache: false, shouldRestart: false })
  })

  it('[fs-111] watermark thresholds default and trigger restart: flags RSS above the default and requests a restart', () => {
    const r = checkWatermark(usage({ rssMb: 501 }))
    expect(r.overMemory).toBe(true)
    expect(r.shouldRestart).toBe(true)
  })

  it('treats a value exactly at the threshold as healthy (boundary)', () => {
    const r = checkWatermark(usage({ rssMb: 500, heapUsedMb: 300 }))
    expect(r.overMemory).toBe(false)
  })

  it('flags heap above the default', () => {
    expect(checkWatermark(usage({ heapUsedMb: 301 })).overMemory).toBe(true)
  })

  it('flags an oversized cache without forcing a restart', () => {
    const r = checkWatermark(usage({ storage: { cacheBytes: 101 * MB, localStorageBytes: 0, sessionStorageBytes: 0 } }))
    expect(r.overCache).toBe(true)
    expect(r.shouldRestart).toBe(false)
  })

  it('honours custom thresholds and echoes the usage', () => {
    const u = usage({ rssMb: 150 })
    const r = checkWatermark(u, { maxRssMb: 100 })
    expect(r.overMemory).toBe(true)
    expect(r.usage).toBe(u)
    expect(checkWatermark(u, { maxRssMb: 200 }).overMemory).toBe(false)
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] clearBrowserCache', () => {
  let calls: Array<[string, Record<string, unknown> | undefined]>
  beforeEach(() => {
    calls = []
  })

  it('clears cache storage and the network cache on the page session', async () => {
    const { session, send } = fakeSession((m, p) => {
      calls.push([m, p])
      return {}
    })
    await clearBrowserCache(session)
    expect(send).toHaveBeenCalledTimes(2)
    expect(calls).toContainEqual(['Storage.clearDataForOrigin', { origin: '*', storageTypes: 'cache_storage' }])
    expect(calls.map(([m]) => m)).toContain('Network.clearBrowserCache')
  })

  it('[fs-112] cache clearing tolerates a failing call: does not reject when a clear call fails (allSettled, error path)', async () => {
    const { session } = fakeSession(() => {
      throw new Error('no storage domain')
    })
    await expect(clearBrowserCache(session)).resolves.toBeUndefined()
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] formatResourceUsage', () => {
  it('[fs-113] formats resource usage on one line: renders a single pipe-separated line', () => {
    const line = formatResourceUsage(usage({ rssMb: 123.6, heapUsedMb: 10.4, heapTotalMb: 20.5 }))
    expect(line).toBe('RSS: 124MB | heap: 10/21MB | DOM: 12 nodes | CPU: Fake CPU (4 cores)')
  })

  it('never emits NaN for a zeroed usage record', () => {
    const line = formatResourceUsage(usage({ rssMb: 0, heapUsedMb: 0, heapTotalMb: 0 }))
    expect(line).not.toContain('NaN')
    expect(line).toContain('RSS: 0MB')
  })
})
