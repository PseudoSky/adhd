/**
 * Unit spec for src/lib/domains/network.ts (NetworkService).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [resolve-findings.1].
 * CDP transport replaced by a recording fake; fetch is not used. Cookie reads ride a page session (F148); no page is TARGET_NOT_FOUND; failures reject.
 * guards: getCookies passes urls when given
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [resolve-findings.1]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StealthCoreBrowserError } from '../../../src/errors.js'

const cdpPageCall = vi.hoisted(() => vi.fn())
const resolvePageTarget = vi.hoisted(() => vi.fn())
vi.mock('../../../src/lib/domains/transport.js', () => ({ cdpPageCall, resolvePageTarget }))

import { NetworkService } from '../../../src/lib/domains/network.js'

const failure = StealthCoreBrowserError.of('CDP_REMOTE_ERROR', 'boom')

describe('8468f7b1 AC2 [tests-unit-data.1] NetworkService', () => {
  const svc = new NetworkService('h:9')
  beforeEach(() => {
    cdpPageCall.mockReset()
    resolvePageTarget.mockReset()
    resolvePageTarget.mockImplementation(async (_host: string, id?: string) => id ?? 'FIRST')
  })

  it('getCookies passes urls when given, on the first open page by default', async () => {
    cdpPageCall.mockResolvedValue({ cookies: [{ name: 'a' }] })
    expect(await svc.getCookies(['https://x.test'])).toEqual([{ name: 'a' }])
    expect(cdpPageCall).toHaveBeenCalledWith('h:9', 'FIRST', 'Network.getCookies', { urls: ['https://x.test'] })
  })

  it('getCookies sends empty params without urls and honours an explicit target', async () => {
    cdpPageCall.mockResolvedValue({ cookies: [] })
    await svc.getCookies(undefined, 'T7')
    expect(cdpPageCall).toHaveBeenCalledWith('h:9', 'T7', 'Network.getCookies', {})
  })

  it('getCookies rejects with the transport error instead of an empty jar (error path)', async () => {
    cdpPageCall.mockRejectedValue(failure)
    await expect(svc.getCookies()).rejects.toBe(failure)
  })

  it('getAllCookies calls Network.getAllCookies with no params and unwraps cookies', async () => {
    cdpPageCall.mockResolvedValue({ cookies: [{ name: 'b' }] })
    expect(await svc.getAllCookies()).toEqual([{ name: 'b' }])
    expect(cdpPageCall).toHaveBeenCalledWith('h:9', 'FIRST', 'Network.getAllCookies')
  })

  it('getAllCookies rejects when no page can be resolved (error path)', async () => {
    const none = StealthCoreBrowserError.of('TARGET_NOT_FOUND', 'no page')
    resolvePageTarget.mockRejectedValue(none)
    await expect(svc.getAllCookies()).rejects.toBe(none)
    expect(cdpPageCall).not.toHaveBeenCalled()
  })
})
