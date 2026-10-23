/**
 * guards: the SSRF policy admits a private, loopback or link-local target
 * tier: S
 * cites: ticket 8468f7b1 [search-port-fetch.3]
 * SSRF policy matrix: a security failsafe (inventory I-28).
 * Ticket 8468f7b1 · [search-port-fetch.3]
 */
import { describe, expect, it } from 'vitest'
import { fetchPage } from '../../../src/lib/fetch/fetch.js'
import { MAX_URL_LENGTH, validateFetchUrl } from '../../../src/lib/fetch/policy.js'
import { makeWorld, PROVIDER } from '../../helpers/fetch/harness.js'

const REFUSED: Array<[string, string]> = [
  ['IPv4-mapped IPv6 metadata (dotted)', 'http://[::ffff:169.254.169.254]/latest/meta-data'],
  ['IPv4-mapped IPv6 metadata (hex form ::ffff:a9fe:a9fe)', 'http://[::ffff:a9fe:a9fe]/'],
  ['IPv4-mapped IPv6 loopback hex', 'http://[::ffff:7f00:1]/'],
  ['IPv4-compatible IPv6 loopback', 'http://[::7f00:1]/'],
  ['IPv6 loopback', 'http://[::1]/'],
  ['IPv6 unique-local', 'http://[fd12:3456::1]/'],
  ['trailing-dot localhost (localhost.)', 'https://localhost./admin'],
  ['localhost', 'https://localhost/'],
  ['file: scheme', 'file:///etc/passwd'],
  ['ftp scheme (non-http(s))', 'ftp://example.com/x'],
  ['embedded credentials (user:pass@)', 'https://user:pass@example.com/'],
  ['cloud metadata 169.254.169.254', 'http://169.254.169.254/latest/meta-data/'],
  ['RFC1918 10.0.0.1', 'https://10.0.0.1/'],
  ['RFC1918 172.16.0.1', 'https://172.16.0.1/'],
  ['RFC1918 192.168.1.1', 'https://192.168.1.1/router'],
  ['loopback 127.0.0.1', 'http://127.0.0.1:9222/json'],
  ['decimal-encoded loopback', 'http://2130706433/'],
  ['CGNAT 100.64.0.1', 'https://100.64.0.1/'],
  ['single-label host', 'https://intranet/'],
  ['internal TLD', 'https://printer.local/'],
  ['not a URL', 'not a url'],
  ['empty', ''],
]

describe('SSRF targets are blocked', () => {
  it.each(REFUSED)('refuses %s', (_name, url) => {
    const v = validateFetchUrl(url)
    expect(v.ok).toBe(false)
    expect(v.reason).toBeTruthy()
  })

  it('refuses a URL over 2000 characters and accepts one at the cap', () => {
    expect(MAX_URL_LENGTH).toBe(2000)
    const base = 'https://example.com/'
    expect(validateFetchUrl(base + 'a'.repeat(2000 - base.length + 1)).ok).toBe(false)
    expect(validateFetchUrl(base + 'a'.repeat(2000 - base.length)).ok).toBe(true)
  })

  it('accepts a public https URL and upgrades http to https', () => {
    expect(validateFetchUrl('https://example.com/docs?q=1').url?.toString()).toBe('https://example.com/docs?q=1')
    expect(validateFetchUrl('http://example.com/').url?.protocol).toBe('https:')
    expect(validateFetchUrl('https://[2606:4700::1111]/').ok).toBe(true)
  })
})

describe('a refused URL is a RESPONSE outcome error carrying FETCH_URL_REFUSED', () => {
  it.each(REFUSED.slice(0, 12))('%s: no page is opened', async (_n, url) => {
    const w = makeWorld({})
    const r = await fetchPage(PROVIDER, url, {}, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.error).toMatch(/^FETCH_URL_REFUSED:/)
    expect(w.opened).toBe(0)
  })

  it('a 2001-character URL is refused before any browser contact', async () => {
    const w = makeWorld({})
    const r = await fetchPage(PROVIDER, 'https://example.com/' + 'a'.repeat(2000), {}, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.error).toContain('FETCH_URL_REFUSED')
    expect(w.opened).toBe(0)
  })
})
