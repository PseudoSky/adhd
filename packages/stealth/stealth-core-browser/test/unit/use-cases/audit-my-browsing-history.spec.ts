/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3]
 * Exercises AC2 (read-only profile access) and PA2.1 (history reads never lock the profile).
 *
 * A person wants to audit what their Chrome profile recorded this week: the last page, what is
 * visible versus hidden redirect hops, where a short link really led and what they searched for.
 * guards: [tests-use-cases.3] the fixture history opens through the immutable read-only opener and is rich enough to audit
 * tier: S
 * cites: 8468f7b1 [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3]
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storage } from '../../../src/index.js'
import { ProfileBuilder, REDIRECT_CHAINS, openReadOnly, type BuiltProfile } from '../../helpers/profile-fixtures.js'

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0) / 1000
let profile: BuiltProfile

beforeEach(() => { profile = ProfileBuilder.realistic(NOW).build() })
afterEach(() => profile.cleanup())

describe('Scenario: audit my browsing history without disturbing the running Chrome', () => {
  it('[tests-use-cases.3] the fixture history opens through the immutable read-only opener and is rich enough to audit', () => {
    const db = openReadOnly(`${profile.defaultDir}/History`)
    try {
      const urls = db.prepare('SELECT COUNT(*) AS n FROM urls').get() as { n: bigint }
      const visits = db.prepare('SELECT COUNT(*) AS n FROM visits').get() as { n: bigint }
      expect(Number(urls.n)).toBeGreaterThanOrEqual(20)
      expect(Number(visits.n)).toBeGreaterThanOrEqual(24 + 6)
      expect(() => db.exec('DELETE FROM urls')).toThrow()
    } finally {
      db.close()
    }
  })

  it('[tests-use-cases.2] shows the newest real page first and hides the intermediate redirect hops', () => {
    const history = new storage.HistoryClient(profile.root)
    const recent = history.getRecentVisits(50)
    expect(recent[0]).toMatchObject({ url: 'https://target.test/article/42', title: 'Article 42' })
    const urls = recent.map((v) => v.url)
    expect(urls).not.toContain('http://short.test/x1')
    expect(urls).not.toContain('https://login.test/sso')
    expect(recent.length).toBe(24 + REDIRECT_CHAINS.length)
    expect(history.getLastVisit()?.url).toBe('https://target.test/article/42')
  })

  it('[tests-use-cases.2] follows a short link back through every redirect hop', () => {
    const history = new storage.HistoryClient(profile.root)
    const chain = history.getRedirectChain(profile.chainLandingVisitIds[0]!)
    expect(chain.map((h) => h.url)).toEqual(['https://target.test/article/42', 'https://short.test/x1', 'http://short.test/x1'])
    expect(chain.map((h) => h.depth)).toEqual([0, 1, 2])
  })

  it('[tests-use-cases.2] answers recency, search and statistics questions', () => {
    const history = new storage.HistoryClient(profile.root)
    expect(history.searchUrls('wiki.test', 50).length).toBeGreaterThan(0)
    expect(history.getUrlInfo('https://docs.test/page/0')).toMatchObject({ title: 'docs.test page 0', visitCount: 1 })
    expect(history.getUrlInfo('https://nowhere.test/')).toBeNull()
    expect(history.getSearchTermsForUrl('https://wiki.test/page/5')).toEqual([{ term: 'chrome history schema', normalizedTerm: 'chrome history schema' }])
    expect(Object.keys(history.getTransitionBreakdown(3650))).toEqual(expect.arrayContaining(['LINK', 'TYPED']))
  })
})
