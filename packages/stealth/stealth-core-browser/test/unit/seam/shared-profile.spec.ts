/**
 * sharedProfile pages: a page opened with `sharedProfile` lands in the DEFAULT browser context (the profile's
 * cookies and sign-in apply) and its dispose closes only that target.
 * Ticket 8468f7b1 · [core-seam.7] · commit 591e1a7 (delta report row 5).
 * fetch is stubbed and CdpSession is an in-memory fake: no network, no WebSocket, no real Chrome.
 * guards: sharedProfile sends no Target.createBrowserContext and Target.createTarget carries no browserContextId (591e1a7)
 * tier: S
 * cites: 8468f7b1 [core-seam.7]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cdp = vi.hoisted(() => {
  const state = {
    sent: [] as Array<{ method: string; params: Record<string, unknown> }>,
    respond: (_method: string, _params: Record<string, unknown>): unknown => ({}),
  }
  class CdpSession {
    async connect(_url: string): Promise<void> {
      /* the fake session accepts every connection */
    }
    async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      state.sent.push({ method, params })
      return state.respond(method, params)
    }
    close(): void {
      /* nothing to release */
    }
  }
  return { state, CdpSession }
})

vi.mock('../../../src/lib/cdp/session.js', () => ({ CdpSession: cdp.CdpSession }))

import { createIsolatedPageTarget } from '../../../src/lib/cdp/targets.js'

const HOST = '127.0.0.1:9333'
const VERSION = { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/b1', Browser: 'Chrome/150.0', 'Protocol-Version': '1.3', 'User-Agent': 'Mozilla/5.0 Fake' }

const methods = (): string[] => cdp.state.sent.map((s) => s.method)

beforeEach(() => {
  cdp.state.sent.length = 0
  cdp.state.respond = (method) => {
    if (method === 'Target.createBrowserContext') return { browserContextId: 'CTX1' }
    if (method === 'Target.createTarget') return { targetId: 'T9' }
    if (method === 'Browser.getWindowForTarget') return { windowId: 77 }
    return {}
  }
  vi.stubGlobal('fetch', async (input: string) => {
    if (input.endsWith('/json/version')) return { ok: true, status: 200, json: async () => VERSION }
    return { ok: true, status: 200, json: async () => [{ id: 'T9', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1/page/T9' }] }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('8468f7b1 [core-seam.7] sharedProfile pages (commit 591e1a7)', () => {
  it('sharedProfile sends no Target.createBrowserContext and Target.createTarget carries no browserContextId (591e1a7)', async () => {
    const r = await createIsolatedPageTarget(HOST, { sharedProfile: true })
    expect(methods()).not.toContain('Target.createBrowserContext')
    const create = cdp.state.sent.find((s) => s.method === 'Target.createTarget')!
    expect(create.params).not.toHaveProperty('browserContextId')
    expect(r).toMatchObject({ targetId: 'T9', pageWsUrl: 'ws://127.0.0.1/page/T9' })
    expect(r.browserContextId).toBeUndefined()
  })

  it('dispose of a sharedProfile page sends Target.closeTarget and never Target.disposeBrowserContext (591e1a7)', async () => {
    const r = await createIsolatedPageTarget(HOST, { sharedProfile: true })
    cdp.state.sent.length = 0
    await r.dispose()
    expect(methods()).toEqual(['Target.closeTarget'])
    expect(cdp.state.sent[0]!.params).toEqual({ targetId: 'T9' })
    expect(methods()).not.toContain('Target.disposeBrowserContext')
  })

  it('without sharedProfile the isolated path still creates its Target.createBrowserContext, passes the browserContextId and disposes it (591e1a7)', async () => {
    const r = await createIsolatedPageTarget(HOST)
    expect(methods()[0]).toBe('Target.createBrowserContext')
    expect(cdp.state.sent.find((s) => s.method === 'Target.createTarget')!.params).toMatchObject({ browserContextId: 'CTX1' })
    expect(r.browserContextId).toBe('CTX1')
    cdp.state.sent.length = 0
    await r.dispose()
    expect(methods()).toEqual(['Target.disposeBrowserContext'])
    expect(cdp.state.sent[0]!.params).toEqual({ browserContextId: 'CTX1' })
    expect(methods()).not.toContain('Target.closeTarget')
  })

  it('a sharedProfile Target.createTarget failure disposes no context it never created (Target.disposeBrowserContext not sent, 591e1a7)', async () => {
    cdp.state.respond = (method) => {
      if (method === 'Target.createTarget') throw new Error('createTarget failed')
      return {}
    }
    await expect(createIsolatedPageTarget(HOST, { sharedProfile: true })).rejects.toThrow('createTarget failed')
    expect(methods()).toEqual(['Target.createTarget'])
  })
})
