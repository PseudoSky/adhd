/**
 * Unit spec for src/lib/queries/context.ts (getPageContext).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * CdpClient, CookieClient and HistoryClient are faked; no Chrome, no profile, no network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  info: null as null | { targetId: string; url: string; title: string },
  cookies: [] as Array<{ host: string }>,
  cookieError: false,
  urlInfo: null as null | { visitCount: number },
  historyError: false,
  asked: [] as string[],
}))

vi.mock('../../../lib/domains/index.js', () => ({
  CdpClient: class {
    async getTargetInfo(id: string) { fake.asked.push(id); return fake.info }
  },
}))
vi.mock('../../../lib/storage/cookies.js', () => ({
  CookieClient: class {
    getCookies() { if (fake.cookieError) throw new Error('no cookies db'); return fake.cookies }
  },
}))
vi.mock('../../../lib/storage/history.js', () => ({
  HistoryClient: class {
    getUrlInfo(url: string) { fake.asked.push(url); if (fake.historyError) throw new Error('no history db'); return fake.urlInfo }
  },
}))

import { getPageContext } from '../../../lib/queries/context.js'

describe('8468f7b1 AC2 [tests-unit-data.1] getPageContext', () => {
  beforeEach(() => {
    fake.info = { targetId: 'T', url: 'https://www.a.test/page', title: 'A' }
    fake.cookies = []; fake.cookieError = false; fake.urlInfo = null; fake.historyError = false; fake.asked = []
  })

  it('returns null when the target is unknown (error path)', async () => {
    fake.info = null
    expect(await getPageContext('T')).toBeNull()
  })

  it('returns null when the target has no url (error path)', async () => {
    fake.info = { targetId: 'T', url: '', title: '' }
    expect(await getPageContext('T')).toBeNull()
  })

  it('combines target info, matching cookie count and history visits', async () => {
    fake.cookies = [{ host: 'www.a.test' }, { host: '.www.a.test' }, { host: 'other.test' }]
    fake.urlInfo = { visitCount: 7 }
    const ctx = await getPageContext('T', 'h:1')
    expect(ctx).toEqual({
      targetId: 'T', url: 'https://www.a.test/page', title: 'A', cookieCount: 2, hasHistory: true, historyVisits: 7,
    })
    expect(fake.asked).toEqual(['T', 'https://www.a.test/page'])
  })

  it('hasHistory is false when the url was never visited', async () => {
    const ctx = await getPageContext('T')
    expect(ctx?.hasHistory).toBe(false)
    expect(ctx?.historyVisits).toBe(0)
  })

  it('swallows a cookie-store failure and still reports history (best effort)', async () => {
    fake.cookieError = true
    fake.urlInfo = { visitCount: 1 }
    const ctx = await getPageContext('T')
    expect(ctx?.cookieCount).toBe(0)
    expect(ctx?.historyVisits).toBe(1)
  })

  it('swallows a history failure and still reports cookies (best effort)', async () => {
    fake.cookies = [{ host: 'www.a.test' }]
    fake.historyError = true
    const ctx = await getPageContext('T')
    expect(ctx?.cookieCount).toBe(1)
    expect(ctx?.hasHistory).toBe(false)
  })
})
