/**
 * Unit spec for src/lib/domains/browser.ts (BrowserService).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [resolve-findings.1].
 * The CDP transport is replaced by a recording fake; fetch is stubbed. guards: failures reject typed (never null/[]);
 * getWindowBounds resolves the windowId first because Browser.getWindowBounds takes a windowId, not a targetId (F147).
 * guards: getVersion maps /json/version fields
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [resolve-findings.1]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StealthCoreBrowserError } from '../../../src/errors.js'

const cdpCall = vi.hoisted(() => vi.fn())
const cdpBrowserSession = vi.hoisted(() => vi.fn())
vi.mock('../../../src/lib/domains/transport.js', () => ({ cdpCall, cdpBrowserSession }))

import { BrowserService } from '../../../src/lib/domains/browser.js'

const failure = StealthCoreBrowserError.of('CDP_REMOTE_ERROR', 'boom')

describe('8468f7b1 AC2 [tests-unit-data.1] BrowserService', () => {
  const svc = new BrowserService('127.0.0.1:9')
  beforeEach(() => { cdpCall.mockReset(); cdpBrowserSession.mockReset() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('getVersion maps /json/version fields', async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ Browser: 'Chrome/1', 'Protocol-Version': '1.3', 'User-Agent': 'UA', 'V8-Version': 'v8', webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/browser/x' }),
    })
    vi.stubGlobal('fetch', f)
    const v = await svc.getVersion()
    expect(f.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9/json/version')
    expect(v).toEqual({ browserVersion: 'Chrome/1', protocolVersion: '1.3', userAgent: 'UA', jsVersion: 'v8', v8Version: 'v8' })
  })

  it('getVersion rejects CDP_UNREACHABLE when fetch rejects (error path)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    await expect(svc.getVersion()).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
  })

  it('getVersion rejects CDP_BAD_RESPONSE on a non-2xx answer and on a debugger URL for another host (F150, F152)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    await expect(svc.getVersion()).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { status: 500 } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: 'ws://evil.example:9/x' }) }))
    await expect(svc.getVersion()).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { reason: 'ws-host-mismatch' } })
  })

  it('getHistograms sends Browser.getHistograms with and without query', async () => {
    cdpCall.mockResolvedValue({ histograms: [{ n: 1 }] })
    expect(await svc.getHistograms('x')).toEqual([{ n: 1 }])
    expect(cdpCall).toHaveBeenLastCalledWith('127.0.0.1:9', 'Browser.getHistograms', { query: 'x' })
    await svc.getHistograms()
    expect(cdpCall).toHaveBeenLastCalledWith('127.0.0.1:9', 'Browser.getHistograms', {})
  })

  it('getHistograms rejects with the transport error instead of returning [] (error path)', async () => {
    cdpCall.mockRejectedValue(failure)
    await expect(svc.getHistograms()).rejects.toBe(failure)
  })

  it('getHistogram sends the name and unwraps histogram', async () => {
    cdpCall.mockResolvedValue({ histogram: { name: 'a' } })
    expect(await svc.getHistogram('a')).toEqual({ name: 'a' })
    expect(cdpCall).toHaveBeenCalledWith('127.0.0.1:9', 'Browser.getHistogram', { name: 'a' })
  })

  it('getHistogram rejects when the browser refuses (error path)', async () => {
    cdpCall.mockRejectedValue(failure)
    await expect(svc.getHistogram('a')).rejects.toBe(failure)
  })

  it('getWindowBounds asks for the window of the target, then sends that windowId (never the targetId) to Browser.getWindowBounds', async () => {
    const sent: Array<[string, Record<string, unknown> | undefined]> = []
    cdpBrowserSession.mockImplementation(async (_host: string, fn: (send: (m: string, p?: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>) =>
      fn(async (method, params) => {
        sent.push([method, params])
        return method === 'Browser.getWindowForTarget' ? { windowId: 12, bounds: {} } : { bounds: { left: 1 } }
      }))
    expect(await svc.getWindowBounds('T')).toEqual({ left: 1 })
    expect(sent).toEqual([['Browser.getWindowForTarget', { targetId: 'T' }], ['Browser.getWindowBounds', { windowId: 12 }]])
  })

  it('getWindowBounds rejects when the transport fails (error path)', async () => {
    cdpBrowserSession.mockRejectedValue(failure)
    await expect(svc.getWindowBounds('T')).rejects.toBe(failure)
  })

  it('getWindowForTarget returns the whole result', async () => {
    cdpCall.mockResolvedValue({ windowId: 3, bounds: {} })
    expect(await svc.getWindowForTarget('T')).toEqual({ windowId: 3, bounds: {} })
    expect(cdpCall).toHaveBeenCalledWith('127.0.0.1:9', 'Browser.getWindowForTarget', { targetId: 'T' })
  })

  it('getBrowserCommandLine returns arguments, and rejects on failure', async () => {
    cdpCall.mockResolvedValueOnce({ arguments: ['--remote-debugging-port=1'] })
    const args = await svc.getBrowserCommandLine()
    expect(args).toEqual(['--remote-debugging-port=1'])
    expect(args).not.toContain('--enable-automation')
    cdpCall.mockRejectedValueOnce(failure)
    await expect(svc.getBrowserCommandLine()).rejects.toBe(failure)
  })
})
