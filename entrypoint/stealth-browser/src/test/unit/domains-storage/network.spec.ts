/**
 * Unit spec for src/lib/domains/network.ts (NetworkService).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * CDP transport replaced by a recording fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdpCall = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/domains/transport.js', () => ({ cdpCall }))

import { NetworkService } from '../../../lib/domains/network.js'

describe('8468f7b1 AC2 [tests-unit-data.1] NetworkService', () => {
  const svc = new NetworkService('h:9')
  beforeEach(() => { cdpCall.mockReset() })

  it('getCookies passes urls when given', async () => {
    cdpCall.mockResolvedValue({ cookies: [{ name: 'a' }] })
    expect(await svc.getCookies(['https://x.test'])).toEqual([{ name: 'a' }])
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Network.getCookies', { urls: ['https://x.test'] })
  })

  it('getCookies sends empty params without urls', async () => {
    cdpCall.mockResolvedValue({ cookies: [] })
    await svc.getCookies()
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Network.getCookies', {})
  })

  it('getCookies yields [] on a null transport result (error path)', async () => {
    cdpCall.mockResolvedValue(null)
    expect(await svc.getCookies()).toEqual([])
  })

  it('getAllCookies calls Network.getAllCookies with no params and unwraps cookies', async () => {
    cdpCall.mockResolvedValue({ cookies: [{ name: 'b' }] })
    expect(await svc.getAllCookies()).toEqual([{ name: 'b' }])
    expect(cdpCall).toHaveBeenCalledWith('h:9', 'Network.getAllCookies')
  })

  it('getAllCookies yields [] when transport fails (error path)', async () => {
    cdpCall.mockResolvedValue(null)
    expect(await svc.getAllCookies()).toEqual([])
  })
})
