/**
 * Unit spec for src/lib/queries/activity.ts (checkChromeActivity).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * CdpClient and HistoryClient are faked; no Chrome, no profile, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  hosts: [] as string[],
  pages: [] as Array<{ targetId: string; url: string }>,
  pagesError: null as Error | null,
  lastVisit: null as unknown,
  visitError: null as Error | null,
}))

vi.mock('../../../lib/domains/index.js', () => ({
  CdpClient: class {
    constructor(host?: string) { fake.hosts.push(host as string) }
    async listPageTargets() {
      if (fake.pagesError) throw fake.pagesError
      return fake.pages
    }
  },
}))
vi.mock('../../../lib/storage/history.js', () => ({
  HistoryClient: class {
    path = '/tmp/fake-profile/Default/History'
    getLastVisit() {
      if (fake.visitError) throw fake.visitError
      return fake.lastVisit
    }
  },
}))

import { checkChromeActivity } from '../../../lib/queries/activity.js'

const NOW = new Date('2026-01-01T12:00:00.000Z')

describe('8468f7b1 AC2 [tests-unit-data.1] checkChromeActivity', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    fake.hosts = []; fake.pages = []; fake.pagesError = null; fake.lastVisit = null; fake.visitError = null
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('counts only non-blank pages and lists their target ids', async () => {
    fake.pages = [
      { targetId: 'A', url: 'https://a.test' },
      { targetId: 'B', url: 'about:blank' },
      { targetId: 'C', url: '' },
    ]
    const r = await checkChromeActivity('h:1')
    expect(r.activePages).toBe(1)
    expect(r.pageTargets).toEqual(['A'])
  })

  it('passes the cdp host through and reports meta (profileDir stripped of Default/History)', async () => {
    const r = await checkChromeActivity('h:1')
    expect(fake.hosts).toEqual(['h:1'])
    expect(r.meta).toEqual({ checkedAt: NOW.toISOString(), cdpHost: 'h:1', profileDir: '/tmp/fake-profile' })
  })

  it('marks recentlyUsed when the last visit is within the window', async () => {
    fake.lastVisit = { visitTime: new Date(NOW.getTime() - 60_000) }
    expect((await checkChromeActivity('h:1', 2)).recentlyUsed).toBe(true)
    expect((await checkChromeActivity('h:1', 1)).recentlyUsed).toBe(false)
  })

  it('recentlyUsed is false with no visit history', async () => {
    const r = await checkChromeActivity()
    expect(r.lastVisit).toBeNull()
    expect(r.recentlyUsed).toBe(false)
  })

  it('degrades to zero pages and warns when CDP is unreachable (error path)', async () => {
    fake.pagesError = new Error('ECONNREFUSED')
    const r = await checkChromeActivity('h:1')
    expect(r.activePages).toBe(0)
    expect(warn).toHaveBeenCalledWith('[activity] CDP unreachable:', 'ECONNREFUSED')
  })

  it('degrades to lastVisit null and warns when history is unavailable (error path)', async () => {
    fake.pages = [{ targetId: 'A', url: 'https://a.test' }]
    fake.visitError = new Error('unable to open database file')
    const r = await checkChromeActivity('h:1')
    expect(r.lastVisit).toBeNull()
    expect(r.activePages).toBe(1)
    expect(warn).toHaveBeenCalledWith('[activity] history unavailable:', 'unable to open database file')
  })

  it('defaults to the 127.0.0.1:9222 host label without connecting (CdpClient is faked)', async () => {
    const r = await checkChromeActivity()
    expect(r.meta.cdpHost).toBe('127.0.0.1:9222')
    expect(fake.hosts).toEqual(['127.0.0.1:9222'])
  })
})
