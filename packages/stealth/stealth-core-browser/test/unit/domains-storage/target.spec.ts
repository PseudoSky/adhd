/**
 * Unit spec for src/lib/domains/target.ts (TargetService).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [resolve-findings.1].
 * CDP transport faked; fetch stubbed. A listing carries a deadline signal and a status check (F152); an unknown target is TARGET_NOT_FOUND. Never contacts a real Chrome (port 9222 included).
 * guards: listPageTargets keeps only pages and derives attached from the ws url
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [resolve-findings.1]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StealthCoreBrowserError } from '../../../src/errors.js'

const cdpCall = vi.hoisted(() => vi.fn())
vi.mock('../../../src/lib/domains/transport.js', () => ({ cdpCall }))

import { TargetService } from '../../../src/lib/domains/target.js'

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
    f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => targets })
    vi.stubGlobal('fetch', f)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('listPageTargets keeps only pages and derives attached from the ws url', async () => {
    const pages = await svc.listPageTargets()
    expect(f.mock.calls[0]?.[0]).toBe('http://h:9/json/list')
    expect(f.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) })
    expect(pages.map((p) => p.targetId)).toEqual(['A', 'B'])
    expect(pages[0]).toEqual({ targetId: 'A', type: 'page', title: 'a', url: 'https://a.test', attached: true })
    expect(pages[1].attached).toBe(false)
  })

  it('listPageTargets rejects when the endpoint is down (error path)', async () => {
    f.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(svc.listPageTargets()).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
  })

  it('listPageTargets rejects CDP_BAD_RESPONSE on a non-2xx status or a body that is not an array (error path)', async () => {
    f.mockResolvedValue({ ok: false, status: 502, json: async () => targets })
    await expect(svc.listPageTargets()).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { status: 502 } })
    f.mockResolvedValue({ ok: true, status: 200, json: async () => ({ not: 'an array' }) })
    await expect(svc.listPageTargets()).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { reason: 'not-an-array' } })
  })

  it('countActivePages excludes about:blank', async () => {
    expect(await svc.countActivePages()).toBe(1)
  })

  it('[resolve-findings.2] F131 countActivePages uses the same rule as the reaper: chrome://newtab/ and other internal pages do not count', async () => {
    f.mockResolvedValue({ ok: true, status: 200, json: async () => [
      { id: 'N', type: 'page', title: 'New Tab', url: 'chrome://newtab/', webSocketDebuggerUrl: 'ws://x/N' },
      { id: 'W', type: 'page', title: 'Web', url: 'https://web.test/', webSocketDebuggerUrl: 'ws://x/W' },
    ] })
    expect(await svc.countActivePages()).toBe(1)
  })

  it('getTargetInfo sends Target.getTargetInfo and unwraps targetInfo', async () => {
    cdpCall.mockResolvedValue({ targetInfo: { targetId: 'A' } })
    expect(await svc.getTargetInfo('A')).toEqual({ targetId: 'A' })
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Target.getTargetInfo', { targetId: 'A' })
  })

  it('getTargetInfo rejects with the transport error, e.g. TARGET_NOT_FOUND (error path)', async () => {
    const gone = StealthCoreBrowserError.of('TARGET_NOT_FOUND', 'no such target')
    cdpCall.mockRejectedValue(gone)
    await expect(svc.getTargetInfo('A')).rejects.toBe(gone)
  })

  it('activateTarget sends Target.activateTarget and rejects when Chrome refuses', async () => {
    cdpCall.mockResolvedValueOnce({})
    await expect(svc.activateTarget('A')).resolves.toBeUndefined()
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Target.activateTarget', { targetId: 'A' })
    const gone = StealthCoreBrowserError.of('TARGET_NOT_FOUND', 'no such target')
    cdpCall.mockRejectedValueOnce(gone)
    await expect(svc.activateTarget('A')).rejects.toBe(gone)
  })
})
