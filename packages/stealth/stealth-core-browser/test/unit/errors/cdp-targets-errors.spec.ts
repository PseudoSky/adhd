/**
 * The CDP discovery failure modes (/json/version, /json/list) reach the caller as typed codes.
 * Ticket 8468f7b1 · [prod-errors.2] · PA5.1 / PA5.4 · CDP_UNREACHABLE, CDP_BAD_RESPONSE, TARGET_NOT_FOUND.
 * fetch is stubbed and the session is an in-memory fake: no network, no WebSocket.
 * guards: getChromeInfo rejects with CDP_UNREACHABLE when nothing listens, keeping the cause and the remediation message
 * tier: S
 * cites: 8468f7b1 [prod-errors.2]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cdp = vi.hoisted(() => {
  class CdpSession {
    async connect(): Promise<void> {
      /* in memory */
    }
    async send(method: string): Promise<unknown> {
      if (method === 'Target.createTarget') return { targetId: 'T1' }
      if (method === 'Target.createBrowserContext') return { browserContextId: 'CTX1' }
      return {}
    }
    close(): void {
      /* in memory */
    }
  }
  return { CdpSession }
})

vi.mock('../../../src/lib/cdp/session.js', () => ({ CdpSession: cdp.CdpSession }))

import { createIsolatedPageTarget, createPageTarget, getChromeInfo } from '../../../src/lib/cdp/targets.js'

const HOST = '127.0.0.1:9333'

let versionStatus = 200
let versionBody: () => unknown = () => ({})
let fetchError: unknown = null

beforeEach(() => {
  versionStatus = 200
  versionBody = () => ({ webSocketDebuggerUrl: 'ws://fake/b', Browser: 'Chrome/150', 'Protocol-Version': '1.3', 'User-Agent': 'x' })
  fetchError = null
  vi.stubGlobal('fetch', async (input: string) => {
    if (fetchError) throw fetchError
    if (input.endsWith('/json/version')) return { ok: versionStatus < 400, status: versionStatus, json: async () => versionBody() }
    return { ok: true, status: 200, json: async () => [] }
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('8468f7b1 [prod-errors.2] discovery rejects with a typed code (PA5.4)', () => {
  it('getChromeInfo rejects with CDP_UNREACHABLE when nothing listens, keeping the cause and the remediation message', async () => {
    fetchError = Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:9333') })
    await expect(getChromeInfo(HOST)).rejects.toMatchObject({ code: 'CDP_UNREACHABLE', message: expect.stringContaining('connect ECONNREFUSED 127.0.0.1:9333'), cause: fetchError })
    await expect(getChromeInfo(HOST)).rejects.toMatchObject({ detail: { cdpHost: HOST }, message: expect.stringContaining('launchChrome') })
  })

  it('getChromeInfo rejects with CDP_BAD_RESPONSE on an HTTP error status', async () => {
    versionStatus = 503
    await expect(getChromeInfo(HOST)).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', detail: { status: 503, path: '/json/version' }, message: expect.stringContaining('HTTP 503') })
  })

  it('getChromeInfo rejects with CDP_BAD_RESPONSE when /json/version is not JSON', async () => {
    versionBody = () => {
      throw new SyntaxError('Unexpected token <')
    }
    await expect(getChromeInfo(HOST)).rejects.toMatchObject({ code: 'CDP_BAD_RESPONSE', message: expect.stringContaining('non-JSON /json/version response (Unexpected token <)') })
  })

  it('createPageTarget rejects with TARGET_NOT_FOUND when the new page never registers within 3 s', async () => {
    vi.useFakeTimers()
    const p = createPageTarget(HOST)
    const assertion = expect(p).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND', detail: { targetId: 'T1' }, message: expect.stringContaining('Target T1 not found in /json/list after 3s') })
    await vi.advanceTimersByTimeAsync(3500)
    await assertion
  })

  it('createIsolatedPageTarget rejects with TARGET_NOT_FOUND when the isolated page never registers within 3 s', async () => {
    vi.useFakeTimers()
    const p = createIsolatedPageTarget(HOST)
    const assertion = expect(p).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND', message: expect.stringContaining('Isolated target T1 not found') })
    await vi.advanceTimersByTimeAsync(3500)
    await assertion
  })
})
