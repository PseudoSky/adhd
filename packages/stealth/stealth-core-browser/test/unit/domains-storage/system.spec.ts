/**
 * Unit spec for src/lib/domains/system.ts (SystemService).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [resolve-findings.1].
 * CDP transport replaced by a recording fake. Failures reject (never null/[]); Memory.getDOMCounters rides a page session.
 * guards: getSystemInfo flattens gpu vendor/device/driver
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [resolve-findings.1]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StealthCoreBrowserError } from '../../../src/errors.js'

const cdpCall = vi.hoisted(() => vi.fn())
const cdpPageCall = vi.hoisted(() => vi.fn())
const resolvePageTarget = vi.hoisted(() => vi.fn())
vi.mock('../../../src/lib/domains/transport.js', () => ({ cdpCall, cdpPageCall, resolvePageTarget }))

import { SystemService } from '../../../src/lib/domains/system.js'

describe('8468f7b1 AC2 [tests-unit-data.1] SystemService', () => {
  const svc = new SystemService('h:9')
  const failure = StealthCoreBrowserError.of('CDP_REMOTE_ERROR', 'boom')
  beforeEach(() => {
    cdpCall.mockReset()
    cdpPageCall.mockReset()
    resolvePageTarget.mockReset()
    resolvePageTarget.mockImplementation(async (_host: string, id?: string) => id ?? 'FIRST')
  })

  it('getSystemInfo flattens gpu vendor/device/driver', async () => {
    cdpCall.mockResolvedValue({
      gpu: { vendorString: 'V', deviceString: 'D', driverVersion: '1' },
      modelName: 'M', modelVersion: '2', commandLine: 'cmd',
    })
    expect(await svc.getSystemInfo()).toEqual({
      modelName: 'M', modelVersion: '2', commandLine: 'cmd', gpu: { vendor: 'V', device: 'D', driverVersion: '1' },
    })
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'SystemInfo.getInfo')
  })

  it('getSystemInfo defaults missing fields to empty strings', async () => {
    cdpCall.mockResolvedValue({})
    const info = await svc.getSystemInfo()
    expect(info.gpu).toEqual({ vendor: '', device: '', driverVersion: '' })
    expect(info.modelName).toBe('')
  })

  it('getSystemInfo rejects with the transport error (error path)', async () => {
    cdpCall.mockRejectedValue(failure)
    await expect(svc.getSystemInfo()).rejects.toBe(failure)
  })

  it('getProcessInfo returns processInfo and rejects on failure', async () => {
    cdpCall.mockResolvedValueOnce({ processInfo: [{ type: 'browser', id: 1, cpuTime: 2 }] })
    expect(await svc.getProcessInfo()).toEqual([{ type: 'browser', id: 1, cpuTime: 2 }])
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'SystemInfo.getProcessInfo')
    cdpCall.mockRejectedValueOnce(failure)
    await expect(svc.getProcessInfo()).rejects.toBe(failure)
  })

  it('getMemoryCounters maps DOM counters via Memory.getDOMCounters (no Runtime.evaluate)', async () => {
    cdpPageCall.mockResolvedValue({ documents: 1, nodes: 2, jsEventListeners: 3, layouts: 4, recalcStyleCount: 5 })
    expect(await svc.getMemoryCounters()).toEqual({ documents: 1, nodes: 2, jsEventListeners: 3, layouts: 4, recalcStyleCount: 5 })
    expect(cdpPageCall).toHaveBeenCalledWith('h:9', 'FIRST', 'Memory.getDOMCounters')
    expect(cdpCall).not.toHaveBeenCalled()
  })

  it('getMemoryCounters zero-fills partial results and rejects on failure (error path)', async () => {
    cdpPageCall.mockResolvedValueOnce({ nodes: 9 })
    expect(await svc.getMemoryCounters('T3')).toEqual({ documents: 0, nodes: 9, jsEventListeners: 0, layouts: 0, recalcStyleCount: 0 })
    expect(cdpPageCall).toHaveBeenLastCalledWith('h:9', 'T3', 'Memory.getDOMCounters')
    cdpPageCall.mockRejectedValueOnce(failure)
    await expect(svc.getMemoryCounters()).rejects.toBe(failure)
  })
})
