/**
 * guards: a malformed percent sequence in a result link aborts the whole parse, or a site's own /search?q= link is rewritten to its query text
 * tier: S
 * cites: 8468f7b1 [resolve-findings.4] (F117)
 * plan: resolve-findings
 * teeth: red: nx run stealth-search:test --skip-nx-cache -- test/unit/engine/dom-urls.spec.ts -> exit 1 (3 failed) with normalizeUrl calling decodeURIComponent directly and matching an unanchored q=.
 * Real use: a results page contains one tracking link with a truncated escape ("%E0%A4%A"); the other nine results must still come back.
 */
import { describe, expect, it } from 'vitest'
import { normalizeUrl, safeDecode } from '../../../src/lib/dom.js'

describe('8468f7b1 [resolve-findings.4] result link normalisation', () => {
  it('a malformed escape keeps its bytes as written and never throws', () => {
    expect(() => safeDecode('%E0%A4%A')).not.toThrow()
    expect(safeDecode('a%20b%')).toBe('a b%')
    expect(safeDecode('%E0%A4%A')).toBe('%E0%A4%A')
    expect(normalizeUrl('/l/?uddg=https%3A%2F%2Fexample.com%2F%E0%A4%A&rut=x')).toBe('https://example.com/%E0%A4%A')
  })

  it('valid escapes are decoded, including multi-byte sequences', () => {
    expect(normalizeUrl('/l/?uddg=https%3A%2F%2Fexample.com%2Fcaf%C3%A9')).toBe('https://example.com/café')
    expect(normalizeUrl('/url?q=https%3A%2F%2Fa.test%2Fx&sa=U')).toBe('https://a.test/x')
    expect(normalizeUrl('https://www.google.com/url?sa=t&q=https%3A%2F%2Fa.test%2Fy')).toBe('https://a.test/y')
  })

  it("keeps a site's own search link and its query string", () => {
    expect(normalizeUrl('/search?q=foo')).toBe('/search?q=foo')
    expect(normalizeUrl('https://site.test/find?q=foo&page=2')).toBe('https://site.test/find?q=foo&page=2')
  })

  it('absolutizes protocol-relative and goto links', () => {
    expect(normalizeUrl('//cdn.test/a')).toBe('https://cdn.test/a')
    expect(normalizeUrl('/goto?url=abc')).toBe('https://www.google.com/goto?url=abc')
  })
})
