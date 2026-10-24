/**
 * CL7 (F10 F11 F12) the page tier, evaluated in the reaper host.
 * Ticket 8468f7b1 · [chrome-lifecycle.7]
 *
 * An open http or https page pins Chrome; browser-internal targets
 * (`chrome://newtab/`, `about:blank`, `devtools://`, `chrome-untrusted://`)
 * never do; an unreachable CDP during the check proceeds.
 * guards: chrome-manager keeps exporting the same predicate
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.7]
 */
import { describe, expect, it } from 'vitest'
import { countActiveWebPages, isActiveWebTarget } from '../../../src/lib/lifecycle/page-tier.js'
import { isActiveWebTarget as fromManager } from '../../../src/lib/chrome-manager.js'
import { makeHost, resultOf } from '../../helpers/lifecycle/host-fixture.js'

const INTERNAL = [
  'chrome://newtab/',
  'about:blank',
  'devtools://devtools/bundled/inspector.html',
  'chrome-untrusted://new-tab-page/one-google-bar',
  'chrome://omnibox-popup.top-chrome/',
  'chrome-extension://abcdefgh/background.html',
]

describe('8468f7b1 [chrome-lifecycle.7] isActiveWebTarget', () => {
  it.each(['http://example.com/', 'https://www.google.com/search?q=x', 'HTTPS://CAPS.example/'])('%s pins Chrome', (url) => {
    expect(isActiveWebTarget(url)).toBe(true)
  })

  it.each(INTERNAL)('%s never pins Chrome', (url) => {
    expect(isActiveWebTarget(url)).toBe(false)
  })

  it('chrome-manager keeps exporting the same predicate', () => {
    expect(fromManager).toBe(isActiveWebTarget)
  })
})

describe('8468f7b1 [chrome-lifecycle.7] countActiveWebPages', () => {
  it('counts only http(s) pages among the listed targets', async () => {
    const n = await countActiveWebPages(async () => [
      { url: 'https://a.example/' },
      { url: 'http://b.example/' },
      ...INTERNAL.map((url) => ({ url })),
      {},
    ])
    expect(n).toBe(2)
  })

  it("an unreachable CDP during the check yields 'unreachable'", async () => {
    const n = await countActiveWebPages(async () => {
      throw new Error('CDP unreachable on 127.0.0.1:9333')
    })
    expect(n).toBe('unreachable')
  })
})

describe('8468f7b1 [chrome-lifecycle.7] the host page tier', () => {
  it('an open http page keeps Chrome', async () => {
    const h = makeHost({}, { httpPages: 1 })
    await h.join('A', 1)
    expect(resultOf(await h.call('A', 'reapIfIdle'))).toEqual({ action: 'keep', pinnedBy: 'page', reaped: false })
    expect(h.world.events).toEqual([])
  })

  it('an open https page keeps Chrome on the periodic tick too', async () => {
    const h = makeHost({ countHttpPages: () => countActiveWebPages(async () => [{ url: 'https://captcha.example/' }]) })
    expect(await h.host.tick()).toEqual({ action: 'keep', pinnedBy: 'page', reaped: false })
  })

  it('only browser-internal targets (chrome://newtab/, about:blank, devtools://, chrome-untrusted://) do not keep Chrome', async () => {
    const h = makeHost({ countHttpPages: () => countActiveWebPages(async () => INTERNAL.map((url) => ({ url }))) })
    await h.join('A', 1)
    expect(resultOf<{ action: string }>(await h.call('A', 'reapIfIdle')).action).toBe('reap')
  })

  it('an unreachable CDP during the page check proceeds (does not defer forever)', async () => {
    const h = makeHost({}, { httpPages: new Error('ECONNREFUSED') })
    await h.join('A', 1)
    expect(resultOf<{ action: string }>(await h.call('A', 'reapIfIdle')).action).toBe('reap')
  })
})
