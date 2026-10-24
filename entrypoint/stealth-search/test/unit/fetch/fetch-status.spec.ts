/**
 * guards: an HTTP error status other than 404 and 410 is reported as a fetch success
 * guards: challenge detection ignores the real main-document status
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.4]
 * Audit findings P20 and P21: the fetch passes the captured main status to the ban rules and never returns an
 * error status as a success. No Chrome, no network: the CDP session, resolver and direct fetch are all scripted.
 */
import { describe, expect, it } from 'vitest'
import { fetchPage } from '../../../src/lib/fetch/fetch.js'
import { longBody, makeWorld, page } from '../../helpers/fetch/harness.js'

const URL_ = 'https://docs.example.com/guide'
const respond = (status: number): { responses: Array<{ url: string; status: number; mimeType: string }> } => ({
  responses: [{ url: URL_, status, mimeType: 'text/html' }],
})
const NO_BANS = { id: 'fetch', bans: [] }

describe('[audit-fixes.4] P21: error statuses are never a success', () => {
  it.each([401, 403, 500, 502, 503])('a content-bearing %i page is outcome error, with the body kept for the caller', async (status) => {
    const w = makeWorld({ ...respond(status), html: [page('Denied', `<h1>Denied</h1>${longBody()}`)] })
    const r = await fetchPage(NO_BANS, URL_, { content: 'full' }, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.status).toBe(status)
    expect(r.error).toBe(`SEARCH_FAILED: HTTP ${status} for ${URL_}`)
    expect(r.content).toContain('Denied')
  })

  it('a 429 page is outcome rate_limited', async () => {
    const w = makeWorld({ ...respond(429), html: [page('Slow down', longBody())] })
    const r = await fetchPage(NO_BANS, URL_, {}, w.deps)
    expect(r.outcome).toBe('rate_limited')
    expect(r.error).toMatch(/^SEARCH_FAILED: HTTP 429/)
  })

  it.each([200, 204, 301, 304])('a %i page is not turned into an error', async (status) => {
    const w = makeWorld({ ...respond(status), html: [page('Fine', longBody())] })
    expect((await fetchPage(NO_BANS, URL_, {}, w.deps)).outcome).toBe('success')
  })

  it('a 403 Cloudflare wall that clears into a 200 page is a success: the status of the cleared document wins', async () => {
    const wall = page('Just a moment', '<p>Just a moment</p>')
    const w = makeWorld({
      ...respond(403),
      laterResponses: [{ url: URL_, status: 200, mimeType: 'text/html' }],
      html: [wall, page('Real', longBody())],
    })
    const r = await fetchPage({ id: 'fetch', bans: [{ name: 'cf', signal: 'captcha', checkBody: /Just a moment/ }] }, URL_, { challengeWaitMs: 20_000 }, w.deps)
    expect(r.outcome).toBe('success')
    expect(r.status).toBe(200)
  })

  it('a 403 wall whose content cleared but whose document status stayed 403 is an error, never a silent success', async () => {
    const wall = page('Just a moment', '<p>Just a moment</p>')
    const w = makeWorld({ ...respond(403), html: [wall, page('Real', longBody())] })
    const r = await fetchPage({ id: 'fetch', bans: [{ name: 'cf', signal: 'captcha', checkBody: /Just a moment/ }] }, URL_, { challengeWaitMs: 20_000 }, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.error).toMatch(/HTTP 403/)
  })
})

describe('[audit-fixes.4] P20: ban rules see the real main-document status', () => {
  it('a sparse 429 page matches a checkStatus rule and returns that signal, not success', async () => {
    const w = makeWorld({ ...respond(429), html: [page('x', '<p>busy</p>')] })
    const r = await fetchPage({ id: 'fetch', bans: [{ name: 'rate', signal: 'rate_limited', checkStatus: [429] }] }, URL_, { challengeWaitMs: 0 }, w.deps)
    expect(r.outcome).toBe('rate_limited')
    expect(r.error).toMatch(/^Challenge \(rate_limited\)/)
  })

  it('a sparse 403 page matches a checkStatus [403] rule as banned', async () => {
    const w = makeWorld({ ...respond(403), html: [page('x', '<p>no</p>')] })
    const r = await fetchPage({ id: 'fetch', bans: [{ name: 'forbidden', signal: 'banned', checkStatus: [403] }] }, URL_, { challengeWaitMs: 0 }, w.deps)
    expect(r.outcome).toBe('banned')
  })

  it('a 200 page never matches a checkStatus rule', async () => {
    const w = makeWorld({ ...respond(200), html: [page('x', '<p>ok</p>')] })
    const r = await fetchPage({ id: 'fetch', bans: [{ name: 'rate', signal: 'rate_limited', checkStatus: [429] }] }, URL_, { challengeWaitMs: 0 }, w.deps)
    expect(r.outcome).not.toBe('rate_limited')
  })
})
