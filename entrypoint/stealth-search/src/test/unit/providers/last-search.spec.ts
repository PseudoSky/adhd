/**
 * Google-history keyword recovery over a history fixture (a result, an empty history, a non-Google
 * URL), through the core storage.history API shape. Inventory row I-31.
 * Ticket 8468f7b1 · [search-port-providers.4].
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ChromeVisit } from '@adhd/stealth-core-browser'
import { getLastSearchFromHistory } from '../../../lib/queries/last-search.js'
import type { LastVisitSource } from '../../../lib/queries/last-search.js'

const visit = (url: string, title = 't'): ChromeVisit => ({
  id: 1, urlId: 1, url, title, visitTimeUnix: 1_790_000_000, visitTime: new Date(1_790_000_000_000),
  transitionType: 'typed', transitionRaw: 1, fromVisitId: 0, visitDurationMs: 10, openerVisitId: 0,
})

function history(last: ChromeVisit | null, terms: Record<string, string> = {}): LastVisitSource {
  return {
    getLastVisit: () => last,
    getSearchTermsForUrl: (url) => (terms[url] ? [{ term: terms[url], normalizedTerm: terms[url].toLowerCase() }] : []),
  }
}

describe('recovers keywords from history [search-port-providers.4]', () => {
  it('recovers keywords from history: a Google results page yields its q keyword and the google engine', () => {
    const r = getLastSearchFromHistory(history(visit('https://www.google.com/search?q=vite+plugin+api&hl=en')))
    expect(r?.isFromSearchEngine).toBe(true)
    expect(r?.searchEngine).toBe('google')
    expect(r?.keyword).toBe('vite plugin api')
  })

  it('a Google URL without q falls back to the history keyword-search-terms table', () => {
    const url = 'https://www.google.com/search?tbm=isch'
    const r = getLastSearchFromHistory(history(visit(url), { [url]: 'cats' }))
    expect(r?.keyword).toBe('cats')
  })

  it('an empty history returns null', () => {
    expect(getLastSearchFromHistory(history(null))).toBeNull()
  })

  it('a non-Google URL: a plain page is not a search engine and has no keyword; an npm registry visit is the npm engine without a keyword', () => {
    const plain = getLastSearchFromHistory(history(visit('https://react.dev/learn')))
    expect(plain).toMatchObject({ isFromSearchEngine: false, searchEngine: null, keyword: null })
    const npm = getLastSearchFromHistory(history(visit('https://registry.npmjs.org/-/v1/search?text=vite')))
    expect(npm).toMatchObject({ isFromSearchEngine: true, searchEngine: 'npm', keyword: null })
  })

  it('last-search.ts reads the core storage API and holds no SQL, no node:sqlite and no profile path', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '../../../lib/queries/last-search.ts'), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    expect(src).toContain("from '@adhd/stealth-core-browser'")
    expect(src).toContain('storage')
    expect(src).not.toMatch(/node:sqlite|\bSELECT\b|Library\/Application Support|\.config\/google-chrome/)
  })
})
