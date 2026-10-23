/**
 * Unit spec for src/lib/domains/page.ts (PageService).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * CDP transport replaced by a recording fake.
 * guards: getNavigationHistory sends Page.getNavigationHistory and returns the result
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdpCall = vi.hoisted(() => vi.fn())
vi.mock('../../../src/lib/domains/transport.js', () => ({ cdpCall }))

import { PageService } from '../../../src/lib/domains/page.js'

describe('8468f7b1 AC2 [tests-unit-data.1] PageService', () => {
  const svc = new PageService('h:9')
  beforeEach(() => { cdpCall.mockReset() })

  it('getNavigationHistory sends Page.getNavigationHistory and returns the result', async () => {
    cdpCall.mockResolvedValue({ currentIndex: 0, entries: [] })
    expect(await svc.getNavigationHistory('T')).toEqual({ currentIndex: 0, entries: [] })
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Page.getNavigationHistory', { targetId: 'T' })
  })

  it('getNavigationHistory yields null on transport failure (error path)', async () => {
    cdpCall.mockResolvedValue(null)
    expect(await svc.getNavigationHistory('T')).toBeNull()
  })

  it('getFrameTree unwraps frameTree', async () => {
    cdpCall.mockResolvedValue({ frameTree: { f: 1 } })
    expect(await svc.getFrameTree('T')).toEqual({ f: 1 })
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Page.getFrameTree', { targetId: 'T' })
  })

  it('getResourceTree unwraps frameTree and nulls on failure', async () => {
    cdpCall.mockResolvedValueOnce({ frameTree: { r: 1 } })
    expect(await svc.getResourceTree('T')).toEqual({ r: 1 })
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Page.getResourceTree', { targetId: 'T' })
    cdpCall.mockResolvedValueOnce(null)
    expect(await svc.getResourceTree('T')).toBeNull()
  })

  it('getLayoutMetrics returns the raw result', async () => {
    cdpCall.mockResolvedValue({ cssLayoutViewport: {} })
    expect(await svc.getLayoutMetrics('T')).toEqual({ cssLayoutViewport: {} })
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Page.getLayoutMetrics', { targetId: 'T' })
  })

  it('captureScreenshot defaults to png and returns the data', async () => {
    cdpCall.mockResolvedValue({ data: 'BASE64' })
    expect(await svc.captureScreenshot('T')).toBe('BASE64')
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Page.captureScreenshot', { targetId: 'T', format: 'png' })
  })

  it('captureScreenshot honours the requested format and nulls on failure (error path)', async () => {
    cdpCall.mockResolvedValueOnce({ data: 'x' })
    await svc.captureScreenshot('T', 'webp')
    expect(cdpCall).toHaveBeenLastCalledWith('h:9', 'Page.captureScreenshot', { targetId: 'T', format: 'webp' })
    cdpCall.mockResolvedValueOnce(null)
    expect(await svc.captureScreenshot('T')).toBeNull()
  })

  it('getPageMetrics folds the metrics array into a named record with 0 defaults', async () => {
    cdpCall.mockResolvedValue({ metrics: [{ name: 'Nodes', value: 7 }, { name: 'Timestamp', value: 1.5 }] })
    const m = await svc.getPageMetrics('T')
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Page.getMetrics', { targetId: 'T' })
    expect(m?.nodes).toBe(7)
    expect(m?.timestamp).toBe(1.5)
    expect(m?.layoutCount).toBe(0)
  })

  it('getPageMetrics is null when metrics are missing (error path)', async () => {
    cdpCall.mockResolvedValueOnce({})
    expect(await svc.getPageMetrics('T')).toBeNull()
    cdpCall.mockResolvedValueOnce(null)
    expect(await svc.getPageMetrics('T')).toBeNull()
  })
})
