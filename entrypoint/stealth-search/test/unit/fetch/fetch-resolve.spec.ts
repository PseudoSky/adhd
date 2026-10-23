/**
 * guards: a public hostname that resolves to a private, loopback, link-local or unique-local address passes the SSRF check
 * tier: S
 * cites: ticket 8468f7b1 [fix-search-fetch.1]
 * DNS-rebinding failsafe: the fetch provider resolves the host through an INJECTED resolver (no
 * network in the unit lane) and refuses with FETCH_URL_REFUSED, carrying the offending address in
 * `detail`, before any page is opened or any request is made.
 * Ticket 8468f7b1 · [fix-search-fetch.1]
 */
import { describe, expect, it } from 'vitest'
import { fetchPage } from '../../../src/lib/fetch/fetch.js'
import { longBody, makeWorld, page, PROVIDER } from '../../helpers/fetch/harness.js'

const HOST = 'docs.example.test'
const URL_ = `https://${HOST}/guide`

/** Run a fetch whose injected resolver answers `addresses`; count every request that could leave. */
async function run(resolveHost: (host: string) => Promise<string[]>) {
  const requested: string[] = []
  const w = makeWorld(
    { html: [page('Guide', longBody())] },
    {
      resolveHost,
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        requested.push(String(input))
        return new Response('x')
      }) as typeof fetch,
    },
  )
  const r = await fetchPage(PROVIDER, URL_, {}, w.deps)
  return { r, w, requested }
}

describe('a public hostname that resolves to a private address is refused (injected resolver, FETCH_URL_REFUSED)', () => {
  const CASES: Array<[string, string[]]> = [
    ['cloud metadata 169.254.169.254', ['169.254.169.254']],
    ['RFC1918 10.0.0.5', ['10.0.0.5']],
    ['loopback 127.0.0.1', ['127.0.0.1']],
    ['IPv6 loopback ::1', ['::1']],
    ['IPv6 unique-local fd00::1', ['fd00::1']],
    ['one public and one private address (10.0.0.5 hides second)', ['93.184.216.34', '10.0.0.5']],
  ]

  it.each(CASES)('hostname resolves to %s via injected resolver: FETCH_URL_REFUSED before any request', async (_label, addresses) => {
    const seen: string[] = []
    const { r, w, requested } = await run(async (host) => {
      seen.push(host)
      return addresses
    })
    expect(r.outcome).toBe('error')
    expect(r.error).toContain('FETCH_URL_REFUSED')
    const offending = addresses.find((a) => a === '10.0.0.5' || a === '169.254.169.254' || a === '127.0.0.1' || a === '::1' || a === 'fd00::1')
    expect(offending).toBeDefined()
    expect(r.error).toContain(offending ?? '')
    expect(seen).toEqual([HOST])
    expect(w.opened).toBe(0)
    expect(requested).toEqual([])
  })

  it('the typed error carries the offending address in detail', async () => {
    const { resolveAndCheck } = await import('../../../src/lib/fetch/policy.js')
    const err = await resolveAndCheck(HOST, async () => ['93.184.216.34', '10.0.0.5']).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'FETCH_URL_REFUSED', detail: { address: '10.0.0.5', host: HOST } })
  })

  it('a resolver failure is a typed error, before any request', async () => {
    const { r, w, requested } = await run(async () => {
      throw new Error('ENOTFOUND')
    })
    expect(r.outcome).toBe('error')
    expect(r.error).toContain('SEARCH_FAILED')
    expect(r.error).toContain('ENOTFOUND')
    expect(w.opened).toBe(0)
    expect(requested).toEqual([])
  })

  it('an empty answer from the resolver is a typed error', async () => {
    const { r, w } = await run(async () => [])
    expect(r.outcome).toBe('error')
    expect(r.error).toContain('SEARCH_FAILED')
    expect(w.opened).toBe(0)
  })

  it('a public hostname that resolves only to public addresses still fetches', async () => {
    const { r, w } = await run(async () => ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])
    expect(r.outcome).toBe('success')
    expect(w.opened).toBe(1)
  })
})
