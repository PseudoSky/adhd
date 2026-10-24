/**
 * Unit spec for src/lib/queries/context.ts (getPageContext).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [resolve-findings.1].
 * CdpClient, CookieClient and HistoryClient are faked; no Chrome, no profile, no network.
 * guards: returns null when the target is unknown (error path)
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [audit-fixes.5] [resolve-findings.1]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StealthCoreBrowserError } from '../../../src/errors.js'

const fake = vi.hoisted(() => ({
  info: null as null | { targetId: string; url: string; title: string },
  /** What the cookie store answers for the page hostname (the host matching itself is proven against SQLite in cookies.spec). */
  cookies: [] as Array<{ host: string }>,
  hostnames: [] as string[],
  profiles: [] as Array<string | undefined>,
  cookieError: false,
  urlInfo: null as null | { visitCount: number },
  historyError: false,
  asked: [] as string[],
  /** When set, getTargetInfo rejects with it instead of answering. */
  failure: null as null | StealthCoreBrowserError,
}))

vi.mock('../../../src/lib/domains/index.js', () => ({
  CdpClient: class {
    async getTargetInfo(id: string) {
      fake.asked.push(id)
      if (fake.failure) throw fake.failure
      if (!fake.info) throw StealthCoreBrowserError.of('TARGET_NOT_FOUND', `no target ${id}`)
      return fake.info
    }
  },
}))
vi.mock('../../../src/lib/storage/cookies.js', () => ({
  CookieClient: class {
    constructor(profileDir?: string) { fake.profiles.push(profileDir) }
    getCookiesForHostname(hostname: string) { fake.hostnames.push(hostname); if (fake.cookieError) throw new Error('no cookies db'); return fake.cookies }
  },
}))
vi.mock('../../../src/lib/storage/history.js', () => ({
  HistoryClient: class {
    constructor(profileDir?: string) { fake.profiles.push(profileDir) }
    getUrlInfo(url: string) { fake.asked.push(url); if (fake.historyError) throw new Error('no history db'); return fake.urlInfo }
  },
}))

import { getPageContext } from '../../../src/lib/queries/context.js'

describe('8468f7b1 AC2 [tests-unit-data.1] getPageContext', () => {
  beforeEach(() => {
    fake.info = { targetId: 'T', url: 'https://www.a.test/page', title: 'A' }
    fake.cookies = []; fake.hostnames = []; fake.profiles = []; fake.cookieError = false; fake.urlInfo = null; fake.historyError = false; fake.asked = []; fake.failure = null
  })

  it('propagates a typed Chrome failure other than a missing target instead of reporting the tab as gone', async () => {
    fake.failure = StealthCoreBrowserError.of('CDP_UNREACHABLE', 'chrome is down')
    await expect(getPageContext('T')).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
  })

  it('returns null when the target is unknown (error path)', async () => {
    fake.info = null
    expect(await getPageContext('T')).toBeNull()
  })

  it('[fs-185] returns null for an unknown target', async () => {
    fake.info = null
    expect(await getPageContext('missing-target', 'h:1')).toBeNull()
    expect(fake.asked).toEqual(['missing-target']) // history is never consulted
  })

  it('[fs-186] counts cookies and history visits for the page', async () => {
    fake.cookies = [{ host: 'www.a.test' }, { host: '.a.test' }]
    fake.urlInfo = { visitCount: 3 }
    expect(await getPageContext('T')).toMatchObject({ cookieCount: 2, hasHistory: true, historyVisits: 3 })
    // each lookup is best effort: a failing cookie store does not hide the history facts
    fake.cookieError = true
    expect(await getPageContext('T')).toMatchObject({ cookieCount: 0, hasHistory: true, historyVisits: 3 })
    fake.historyError = true
    expect(await getPageContext('T')).toMatchObject({ cookieCount: 0, hasHistory: false, historyVisits: 0 })
  })

  it('returns null when the target has no url (error path)', async () => {
    fake.info = { targetId: 'T', url: '', title: '' }
    expect(await getPageContext('T')).toBeNull()
  })

  it('combines target info, matching cookie count and history visits', async () => {
    fake.cookies = [{ host: 'www.a.test' }, { host: '.www.a.test' }]
    fake.urlInfo = { visitCount: 7 }
    const ctx = await getPageContext('T', 'h:1')
    expect(ctx).toEqual({
      targetId: 'T', url: 'https://www.a.test/page', title: 'A', cookieCount: 2, hasHistory: true, historyVisits: 7,
    })
    expect(fake.asked).toEqual(['T', 'https://www.a.test/page'])
  })

  it('[audit-fixes.5] P24 reads cookies and history from the given profile, and P25 asks the store for the page hostname', async () => {
    fake.urlInfo = { visitCount: 1 }
    await getPageContext('T', 'h:1', '/profiles/custom')
    expect(fake.profiles).toEqual(['/profiles/custom', '/profiles/custom'])
    expect(fake.hostnames).toEqual(['www.a.test'])
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
