/**
 * guards: a throwing ban rule or parser escapes networkSearch, or a direct fetch ignores the declared parser
 * tier: S
 * cites: ticket 8468f7b1 [resolve-findings.4]
 * plan: resolve-findings
 * teeth: red: npx vitest run test/unit/engine/post-capture-faults.spec.ts -> exit 1; the throwing ban rule rethrown from networkSearch fails 'returns outcome error', and the direct fetch on the html parser fails 'extracts the island results'
 * networkSearch returns data for every outcome: a failure after the capture (ban rules, parser) becomes an
 * `error` outcome, and the direct fetch honours the provider's declared parser (embedded-json included).
 * Ticket 8468f7b1 · [resolve-findings.4] · F141, F142.
 */
import { describe, expect, it } from 'vitest'
import { getProvider } from '../../../src/lib/providers.js'
import { networkSearch, selectCandidate } from '../../../src/lib/network.js'
import type { ProviderConfig } from '../../../src/lib/types.js'
import { body, exchange, fixture, makeDeps, recordingCapture } from '../../helpers/engine/harness.js'

const ddg = getProvider('duckduckgo')

describe('post-capture processing never throws out of networkSearch [resolve-findings.4]', () => {
  it('a ban rule that throws on the captured body returns outcome error with the cause', async () => {
    const rec = recordingCapture(async () => body(fixture('ddg-results.html')))
    const r = await networkSearch('ws://page', ddg, 'tree-sitter', {}, makeDeps({
      capture: rec.capture,
      checkBans: () => {
        throw new Error('ban rule exploded')
      },
    }))
    expect(r.outcome).toBe('error')
    expect(r.error).toMatch(/ban rule exploded/)
    expect(r.results).toEqual([])
  })
})

describe('direct fetch uses the declared parser [resolve-findings.4]', () => {
  it('an embedded-json direct fetch extracts the island results instead of running the html parser', async () => {
    const gh = getProvider('github')
    const fb = gh.fallbackNetwork as NonNullable<ProviderConfig['network']>
    const view: ProviderConfig = { ...gh, network: { ...fb, directFetch: true, apiUrl: 'https://github.com/search?type=repositories&q=' } }
    const page = fixture('../providers/github/repo-search.html')
    const r = await networkSearch('', view, 'vite', {}, makeDeps({ checkBans: () => null, fetchImpl: async () => new Response(page, { status: 200 }) }))
    expect(r.outcome).toBe('success')
    expect(r.count).toBeGreaterThan(0)
  })
})

describe('selectCandidate size fallback [resolve-findings.4]', () => {
  it('prefers the largest body when no candidate carries #rso', () => {
    const small = exchange({ url: 'https://a', body: 'x' })
    const large = exchange({ url: 'https://b', body: 'xxxxxxxx' })
    expect(selectCandidate([small, large])).toBe(large)
  })
})
