/**
 * Unit spec for src/lib/domains/system.ts (SystemService).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * CDP transport replaced by a recording fake.
 * guards: getSystemInfo flattens gpu vendor/device/driver
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdpCall = vi.hoisted(() => vi.fn())
vi.mock('../../../src/lib/domains/transport.js', () => ({ cdpCall }))

import { SystemService } from '../../../src/lib/domains/system.js'

describe('8468f7b1 AC2 [tests-unit-data.1] SystemService', () => {
  const svc = new SystemService('h:9')
  beforeEach(() => { cdpCall.mockReset() })

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
    expect(info?.gpu).toEqual({ vendor: '', device: '', driverVersion: '' })
    expect(info?.modelName).toBe('')
  })

  it('getSystemInfo is null on transport failure (error path)', async () => {
    cdpCall.mockResolvedValue(null)
    expect(await svc.getSystemInfo()).toBeNull()
  })

  it('getProcessInfo returns processInfo or [] on failure', async () => {
    cdpCall.mockResolvedValueOnce({ processInfo: [{ type: 'browser', id: 1, cpuTime: 2 }] })
    expect(await svc.getProcessInfo()).toEqual([{ type: 'browser', id: 1, cpuTime: 2 }])
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'SystemInfo.getProcessInfo')
    cdpCall.mockResolvedValueOnce(null)
    expect(await svc.getProcessInfo()).toEqual([])
  })

  it('getMemoryCounters maps DOM counters via Memory.getDOMCounters (no Runtime.evaluate)', async () => {
    cdpCall.mockResolvedValue({ documents: 1, nodes: 2, jsEventListeners: 3, layouts: 4, recalcStyleCount: 5 })
    expect(await svc.getMemoryCounters()).toEqual({ documents: 1, nodes: 2, jsEventListeners: 3, layouts: 4, recalcStyleCount: 5 })
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Memory.getDOMCounters')
  })

  it('getMemoryCounters zero-fills partial results and nulls on failure (error path)', async () => {
    cdpCall.mockResolvedValueOnce({ nodes: 9 })
    expect(await svc.getMemoryCounters()).toEqual({ documents: 0, nodes: 9, jsEventListeners: 0, layouts: 0, recalcStyleCount: 0 })
    cdpCall.mockResolvedValueOnce(null)
    expect(await svc.getMemoryCounters()).toBeNull()
  })
})
