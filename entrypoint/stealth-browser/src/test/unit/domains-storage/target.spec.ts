/**
 * Unit spec for src/lib/domains/target.ts (TargetService).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * CDP transport faked; fetch stubbed. Never contacts a real Chrome (port 9222 included).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cdpCall = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/domains/transport.js', () => ({ cdpCall }))

import { TargetService } from '../../../lib/domains/target.js'

const targets = [
  { id: 'A', type: 'page', title: 'a', url: 'https://a.test', webSocketDebuggerUrl: 'ws://x' },
  { id: 'B', type: 'page', title: 'b', url: 'about:blank' },
  { id: 'C', type: 'service_worker', title: 'sw', url: 'https://sw.test' },
]

describe('8468f7b1 AC2 [tests-unit-data.1] TargetService', () => {
  const svc = new TargetService('h:9')
  let f: ReturnType<typeof vi.fn>
  beforeEach(() => {
    cdpCall.mockReset()
    f = vi.fn().mockResolvedValue({ json: async () => targets })
    vi.stubGlobal('fetch', f)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('listPageTargets keeps only pages and derives attached from the ws url', async () => {
    const pages = await svc.listPageTargets()
    expect(f).toHaveBeenCalledWith('http://h:9/json/list')
    expect(pages.map((p) => p.targetId)).toEqual(['A', 'B'])
    expect(pages[0]).toEqual({ targetId: 'A', type: 'page', title: 'a', url: 'https://a.test', attached: true })
    expect(pages[1].attached).toBe(false)
  })

  it('listPageTargets rejects when the endpoint is down (error path)', async () => {
    f.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(svc.listPageTargets()).rejects.toThrow('ECONNREFUSED')
  })

  it('countActivePages excludes about:blank', async () => {
    expect(await svc.countActivePages()).toBe(1)
  })

  it('getTargetInfo sends Target.getTargetInfo and unwraps targetInfo', async () => {
    cdpCall.mockResolvedValue({ targetInfo: { targetId: 'A' } })
    expect(await svc.getTargetInfo('A')).toEqual({ targetId: 'A' })
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Target.getTargetInfo', { targetId: 'A' })
  })

  it('getTargetInfo is null on transport failure (error path)', async () => {
    cdpCall.mockResolvedValue(null)
    expect(await svc.getTargetInfo('A')).toBeNull()
  })

  it('activateTarget is true on any non-null result, false on null', async () => {
    cdpCall.mockResolvedValueOnce({})
    expect(await svc.activateTarget('A')).toBe(true)
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Target.activateTarget', { targetId: 'A' })
    cdpCall.mockResolvedValueOnce(null)
    expect(await svc.activateTarget('A')).toBe(false)
  })
})
