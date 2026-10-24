/**
 * Unit spec for walkDomTree's wait-for-load and the shared redirect-link normalizer.
 * Ticket 8468f7b1 · criteria [resolve-findings.2] F121 F122.
 * guards: walkDomTree sends Page.loadEventFired as a command (a CDP_REMOTE_ERROR swallowed, so it never waits for load), leaks its subscription, or rewrites a site's own relative /search?q= link to the bare query
 * tier: S
 * cites: 8468f7b1 [resolve-findings.2] F121 F122
 * plan: stealth-browser, state resolve-findings, task resolve-findings-implementer
 * teeth: red: nx run stealth-core-browser:test --skip-nx-cache -- test/unit/capture-parsers/dom-load.spec.ts -> exit 1 with walkDomTree reverted to `send('Page.loadEventFired')` and normalizeUrl reverted to the unanchored q= match; 3 failed | 5 passed: the two wait-for-load cases and the /search?q= case fail.
 * The session is an in-memory fake; no socket, no Chrome.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { walkDomTree } from '../../../src/lib/capture/dom.js'
import { normalizeUrl } from '../../../src/lib/redirect-url.js'
import { pageEvents } from '../../helpers/capture/capture-kit.js'

const EMPTY_DOC = { root: { nodeId: 1, nodeType: 9, nodeName: '#document' } }
const opts = { navigateUrl: 'https://search.test/?q=a', waitFor: '#res', timeoutMs: 2_000 }

function rig(navigate?: () => Promise<unknown>) {
  const events = pageEvents()
  const log: string[] = []
  const send = vi.fn(async (method: string) => {
    log.push(method)
    if (method === 'Page.navigate' && navigate) return navigate()
    if (method === 'DOM.getDocument') return EMPTY_DOC
    if (method === 'DOM.querySelector') return { nodeId: 7 }
    return {}
  })
  return { events, log, send, session: { send, on: events.on } as never }
}

afterEach(() => { vi.useRealTimers() })

describe('[resolve-findings.2] F121 walkDomTree waits for the page load event', () => {
  it('does not look for the result selector until Page.loadEventFired arrives, and never sends it as a command', async () => {
    const r = rig()
    const walk = walkDomTree(r.session, opts, {})
    await vi.waitFor(() => expect(r.log).toContain('Page.navigate'))
    expect(r.events.subscribers('Page.loadEventFired')).toBe(1) // subscribed before navigating
    await Promise.resolve()
    expect(r.log).not.toContain('DOM.getDocument') // still waiting for load
    r.events.fire('Page.loadEventFired')
    await expect(walk).resolves.toEqual([])
    expect(r.log).not.toContain('Page.loadEventFired')
    expect(r.log.indexOf('Page.navigate')).toBeLessThan(r.log.indexOf('DOM.getDocument'))
    expect(r.events.subscribers('Page.loadEventFired')).toBe(0)
  })

  it('an event that fires during navigate (before the command returns) is not missed', async () => {
    const r = rig(async () => { r.events.fire('Page.loadEventFired'); return {} })
    await expect(walkDomTree(r.session, opts, {})).resolves.toEqual([])
  })

  it('a page that never fires load continues after the timeout and leaves no subscription behind', async () => {
    vi.useFakeTimers()
    const r = rig()
    const walk = walkDomTree(r.session, opts, {})
    await vi.advanceTimersByTimeAsync(1_999)
    expect(r.log).not.toContain('DOM.getDocument')
    await vi.advanceTimersByTimeAsync(2)
    await expect(walk).resolves.toEqual([])
    expect(r.events.subscribers('Page.loadEventFired')).toBe(0)
  })

  it('a rejected Page.navigate propagates and unsubscribes', async () => {
    const boom = new Error('navigate failed')
    const r = rig(async () => { throw boom })
    await expect(walkDomTree(r.session, opts, {})).rejects.toBe(boom)
    expect(r.events.subscribers('Page.loadEventFired')).toBe(0)
  })
})

describe('[resolve-findings.2] F122 normalizeUrl unwraps only redirect links', () => {
  it('keeps a site\'s own relative search link and its query', () => {
    expect(normalizeUrl('/search?q=foo')).toBe('/search?q=foo')
    expect(normalizeUrl('/?q=foo&page=2')).toBe('/?q=foo&page=2')
    expect(normalizeUrl('https://plain.test/?q=keep')).toBe('https://plain.test/?q=keep')
  })

  it('unwraps the Google /url?q= redirect, relative or absolute, with q anywhere in the query', () => {
    expect(normalizeUrl('/url?q=https%3A%2F%2Fg.test%2Fa&sa=U')).toBe('https://g.test/a')
    expect(normalizeUrl('/url?sa=t&q=https%3A%2F%2Fg.test%2Fb&ved=1')).toBe('https://g.test/b')
    expect(normalizeUrl('https://www.google.com/url?q=https%3A%2F%2Fg.test%2Fc')).toBe('https://g.test/c')
  })

  it('a malformed percent sequence in a redirect target does not throw', () => {
    expect(() => normalizeUrl('/url?q=https%3A%2F%2Fg.test%2F%E0%A4%A')).not.toThrow()
    expect(() => normalizeUrl('/l/?uddg=%E0%A4%A')).not.toThrow()
  })

  it('still absolutizes protocol-relative, goto and arxiv links', () => {
    expect(normalizeUrl('//cdn.test/a')).toBe('https://cdn.test/a')
    expect(normalizeUrl('/goto?url=tok')).toBe('https://www.google.com/goto?url=tok')
    expect(normalizeUrl('/abs/2401.1')).toBe('https://arxiv.org/abs/2401.1')
  })
})
