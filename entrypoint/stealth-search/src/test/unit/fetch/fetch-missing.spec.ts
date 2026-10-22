/**
 * A missing page is never a success (backlog 86ed154e).
 * Ticket 8468f7b1 · [search-port-fetch.10]
 */
import { describe, expect, it } from 'vitest'
import { fetchPage, looksLikeSoftNotFound, redirectedToSiteRoot } from '../../../lib/fetch/fetch.js'
import { longBody, makeWorld, page, PROVIDER } from './harness.js'

describe('86ed154e: HTTP 404 and 410 return outcome error with SEARCH_FAILED', () => {
  it.each([404, 410])('a self-hosting docs URL answering %i is error with the status', async (status) => {
    const url = 'https://docs.selfhost.example.com/install/old-page'
    const w = makeWorld({ responses: [{ url, status, mimeType: 'text/html' }], html: [page('Docs', longBody())] })
    const r = await fetchPage(PROVIDER, url, { content: 'full' }, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.status).toBe(status)
    expect(r.error).toMatch(/^SEARCH_FAILED:/)
    expect(r.error).toContain(String(status))
    expect(r.content).toBeUndefined()
    expect(w.grabs).toBe(0)
  })
})

describe('86ed154e: soft-404 pages are errors', () => {
  it('a sparse 200 page titled "Page Not Found" is a soft-404 error', async () => {
    const w = makeWorld({ html: [page('Page Not Found | Acme', '<p>Sorry.</p>')] })
    const r = await fetchPage(PROVIDER, 'https://acme.example.com/gone', {}, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.status).toBe(200)
    expect(r.error).toMatch(/^SEARCH_FAILED: soft 404/)
  })

  it('a sparse 200 page whose first heading says 404 is a soft-404 error', async () => {
    const w = makeWorld({ html: [page('Acme', '<h1>404 - This page could not be found</h1>')] })
    expect((await fetchPage(PROVIDER, 'https://acme.example.com/gone', {}, w.deps)).outcome).toBe('error')
  })

  it('redirect: a marketing page reached by a deep path that lands on the site root is an error', async () => {
    const w = makeWorld({
      responses: [{ url: 'https://acme.example.com/', status: 200, mimeType: 'text/html' }],
      html: [page('Acme - build faster', longBody())],
    })
    const r = await fetchPage(PROVIDER, 'https://acme.example.com/docs/removed/feature', {}, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.finalUrl).toBe('https://acme.example.com/')
    expect(r.error).toMatch(/^SEARCH_FAILED:.*site root/)
  })

  it('redirect helper ignores locale and index normalisation and root-to-root', () => {
    expect(redirectedToSiteRoot('https://a.com/en', 'https://a.com/')).toBe(false)
    expect(redirectedToSiteRoot('https://a.com/index.html', 'https://a.com/')).toBe(false)
    expect(redirectedToSiteRoot('https://a.com/', 'https://a.com/')).toBe(false)
    expect(redirectedToSiteRoot('https://a.com/a/b', 'https://a.com/a/c')).toBe(false)
    expect(redirectedToSiteRoot('https://a.com/a/b', 'https://a.com/')).toBe(true)
  })
})

describe('86ed154e: false positive guard', () => {
  it('a long real guide page that contains the phrase "page not found" in its body stays success', async () => {
    const body = `<h1>Handling errors</h1><p>When a route is missing the server renders the page not found view.</p>${longBody(4000)}`
    const w = makeWorld({ html: [page('Handling errors - Guide', body)] })
    const r = await fetchPage(PROVIDER, 'https://guides.example.com/errors', {}, w.deps)
    expect(r.outcome).toBe('success')
  })

  it('a long page is never a soft-404 even with a not-found title; a sparse one is', () => {
    expect(looksLikeSoftNotFound('Not Found', null, 5000)).toBe(false)
    expect(looksLikeSoftNotFound('Not Found', null, 100)).toBe(true)
    expect(looksLikeSoftNotFound('Welcome', 'Getting started', 100)).toBe(false)
  })
})
