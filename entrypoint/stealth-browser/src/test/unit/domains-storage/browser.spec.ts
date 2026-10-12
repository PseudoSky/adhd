/**
 * Unit spec for src/lib/domains/browser.ts (BrowserService).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * The CDP transport is replaced by a recording fake; fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cdpCall = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/domains/transport.js', () => ({ cdpCall }))

import { BrowserService } from '../../../lib/domains/browser.js'

describe('8468f7b1 AC2 [tests-unit-data.1] BrowserService', () => {
  const svc = new BrowserService('h:9')
  beforeEach(() => { cdpCall.mockReset() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('getVersion maps /json/version fields', async () => {
    const f = vi.fn().mockResolvedValue({
      json: async () => ({ Browser: 'Chrome/1', 'Protocol-Version': '1.3', 'User-Agent': 'UA', 'V8-Version': 'v8' }),
    })
    vi.stubGlobal('fetch', f)
    const v = await svc.getVersion()
    expect(f).toHaveBeenCalledWith('http://h:9/json/version')
    expect(v).toEqual({ browserVersion: 'Chrome/1', protocolVersion: '1.3', userAgent: 'UA', jsVersion: 'v8', v8Version: 'v8' })
  })

  it('getVersion returns null when fetch rejects (error path)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    expect(await svc.getVersion()).toBeNull()
  })

  it('getHistograms sends Browser.getHistograms with and without query', async () => {
    cdpCall.mockResolvedValue({ histograms: [{ n: 1 }] })
    expect(await svc.getHistograms('x')).toEqual([{ n: 1 }])
    expect(cdpCall).toHaveBeenLastCalledWith('h:9', 'Browser.getHistograms', { query: 'x' })
    await svc.getHistograms()
    expect(cdpCall).toHaveBeenLastCalledWith('h:9', 'Browser.getHistograms', {})
  })

  it('getHistograms yields [] on a null transport result (error path)', async () => {
    cdpCall.mockResolvedValue(null)
    expect(await svc.getHistograms()).toEqual([])
  })

  it('getHistogram sends the name and unwraps histogram', async () => {
    cdpCall.mockResolvedValue({ histogram: { name: 'a' } })
    expect(await svc.getHistogram('a')).toEqual({ name: 'a' })
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Browser.getHistogram', { name: 'a' })
  })

  it('getHistogram yields null when absent', async () => {
    cdpCall.mockResolvedValue(null)
    expect(await svc.getHistogram('a')).toBeNull()
  })

  it('getWindowBounds sends targetId and unwraps bounds', async () => {
    cdpCall.mockResolvedValue({ bounds: { left: 1 } })
    expect(await svc.getWindowBounds('T')).toEqual({ left: 1 })
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Browser.getWindowBounds', { targetId: 'T' })
  })

  it('getWindowBounds yields null when transport fails (error path)', async () => {
    cdpCall.mockResolvedValue(null)
    expect(await svc.getWindowBounds('T')).toBeNull()
  })

  it('getWindowForTarget returns the whole result', async () => {
    cdpCall.mockResolvedValue({ windowId: 3, bounds: {} })
    expect(await svc.getWindowForTarget('T')).toEqual({ windowId: 3, bounds: {} })
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Browser.getWindowForTarget', { targetId: 'T' })
  })

  it('getBrowserCommandLine returns arguments, and [] on failure', async () => {
    cdpCall.mockResolvedValueOnce({ arguments: ['--remote-debugging-port=1'] })
    const args = await svc.getBrowserCommandLine()
    expect(args).toEqual(['--remote-debugging-port=1'])
    expect(args).not.toContain('--enable-automation')
    cdpCall.mockResolvedValueOnce(null)
    expect(await svc.getBrowserCommandLine()).toEqual([])
  })
})
