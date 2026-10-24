/**
 * Unit spec for src/lib/domains/page.ts (PageService).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [resolve-findings.1].
 * The CDP transport is replaced by a recording fake. guards: every Page command goes through the page-session
 * entry points (no targetId parameter, F146), a transport failure rejects (never null), metrics come from the Performance domain.
 * guards: getNavigationHistory sends Page.getNavigationHistory on the target's page session
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [resolve-findings.1]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StealthCoreBrowserError } from '../../../src/errors.js'

const cdpPageCall = vi.hoisted(() => vi.fn())
const cdpPageSession = vi.hoisted(() => vi.fn())
vi.mock('../../../src/lib/domains/transport.js', () => ({ cdpPageCall, cdpPageSession }))

import { PageService } from '../../../src/lib/domains/page.js'

const failure = StealthCoreBrowserError.of('CDP_REMOTE_ERROR', 'boom')

describe('8468f7b1 AC2 [tests-unit-data.1] PageService', () => {
  const svc = new PageService('h:9')
  beforeEach(() => { cdpPageCall.mockReset(); cdpPageSession.mockReset() })

  it('getNavigationHistory sends Page.getNavigationHistory on the target page session with no params', async () => {
    cdpPageCall.mockResolvedValue({ currentIndex: 0, entries: [] })
    expect(await svc.getNavigationHistory('T')).toEqual({ currentIndex: 0, entries: [] })
    expect(cdpPageCall).toHaveBeenCalledWith('h:9', 'T', 'Page.getNavigationHistory')
  })

  it('getNavigationHistory rejects with the transport error (error path)', async () => {
    cdpPageCall.mockRejectedValue(failure)
    await expect(svc.getNavigationHistory('T')).rejects.toBe(failure)
  })

  it('getFrameTree unwraps frameTree', async () => {
    cdpPageCall.mockResolvedValue({ frameTree: { f: 1 } })
    expect(await svc.getFrameTree('T')).toEqual({ f: 1 })
    expect(cdpPageCall).toHaveBeenCalledWith('h:9', 'T', 'Page.getFrameTree')
  })

  it('getResourceTree unwraps frameTree and rejects on failure', async () => {
    cdpPageCall.mockResolvedValueOnce({ frameTree: { r: 1 } })
    expect(await svc.getResourceTree('T')).toEqual({ r: 1 })
    expect(cdpPageCall).toHaveBeenCalledWith('h:9', 'T', 'Page.getResourceTree')
    cdpPageCall.mockRejectedValueOnce(failure)
    await expect(svc.getResourceTree('T')).rejects.toBe(failure)
  })

  it('getLayoutMetrics returns the raw result', async () => {
    cdpPageCall.mockResolvedValue({ cssLayoutViewport: {} })
    expect(await svc.getLayoutMetrics('T')).toEqual({ cssLayoutViewport: {} })
    expect(cdpPageCall).toHaveBeenCalledWith('h:9', 'T', 'Page.getLayoutMetrics')
  })

  it('captureScreenshot defaults to png and returns the data', async () => {
    cdpPageCall.mockResolvedValue({ data: 'BASE64' })
    expect(await svc.captureScreenshot('T')).toBe('BASE64')
    expect(cdpPageCall).toHaveBeenCalledWith('h:9', 'T', 'Page.captureScreenshot', { format: 'png' })
  })

  it('captureScreenshot honours the requested format and rejects on failure (error path)', async () => {
    cdpPageCall.mockResolvedValueOnce({ data: 'x' })
    await svc.captureScreenshot('T', 'webp')
    expect(cdpPageCall).toHaveBeenLastCalledWith('h:9', 'T', 'Page.captureScreenshot', { format: 'webp' })
    cdpPageCall.mockRejectedValueOnce(failure)
    await expect(svc.captureScreenshot('T')).rejects.toBe(failure)
  })

  it('getPageMetrics enables the Performance domain, reads Performance.getMetrics, folds it with 0 defaults and disables it again', async () => {
    const calls: string[] = []
    cdpPageSession.mockImplementation(async (_host: string, _target: string, fn: (send: (m: string) => Promise<unknown>) => Promise<unknown>) =>
      fn(async (method: string) => {
        calls.push(method)
        return method === 'Performance.getMetrics' ? { metrics: [{ name: 'Nodes', value: 7 }, { name: 'Timestamp', value: 1.5 }] } : {}
      }))
    const m = await svc.getPageMetrics('T')
    expect(cdpPageSession).toHaveBeenCalledWith('h:9', 'T', expect.any(Function))
    expect(calls).toEqual(['Performance.enable', 'Performance.getMetrics', 'Performance.disable'])
    expect(m.nodes).toBe(7)
    expect(m.timestamp).toBe(1.5)
    expect(m.layoutCount).toBe(0)
  })

  it('getPageMetrics still disables the domain when the read fails, and rejects with that failure (error path)', async () => {
    const calls: string[] = []
    cdpPageSession.mockImplementation(async (_h: string, _t: string, fn: (send: (m: string) => Promise<unknown>) => Promise<unknown>) =>
      fn(async (method: string) => {
        calls.push(method)
        if (method === 'Performance.getMetrics') throw failure
        return {}
      }))
    await expect(svc.getPageMetrics('T')).rejects.toBe(failure)
    expect(calls).toEqual(['Performance.enable', 'Performance.getMetrics', 'Performance.disable'])
  })
})
