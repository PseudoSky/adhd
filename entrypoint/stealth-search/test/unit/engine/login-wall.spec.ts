/**
 * guards: a signed-out zero-result page is reported as empty or error instead of hitl login_required with the sign-in page
 * tier: S
 * cites: ticket 8468f7b1 [search-port-engine.11]
 * A zero-result page behind a login wall is a hitl interrupt, not an error: GitHub code search signed out
 * renders zero results; the engine answers outcome hitl reason login_required with the sign-in page.
 * Inventory row [I-24.b] (login wall returns hitl login_required). Fixtures are byte-copies of the captured pages.
 * Ticket 8468f7b1 · [search-port-engine.11] · commit 591e1a7.
 */
import { describe, expect, it } from 'vitest'
import { getProvider } from '../../../src/lib/providers.js'
import { loginWallResponse, networkSearch } from '../../../src/lib/network.js'
import type { ProviderConfig } from '../../../src/lib/types.js'
import { fallbackView, resolveProvider } from '../../../src/lib/utils.js'
import { body, githubFixture, makeDeps, recordingCapture } from '../../helpers/engine/harness.js'

const github = getProvider('github')
const QUERY = 'useState type:code'
const code = resolveProvider(github, QUERY)
const CODE_URL = 'https://github.com/search?q=useState&type=code'
const signedOut = githubFixture('code-search-signed-out.html')
const repoPage = githubFixture('repo-search.html')

/** The same page, signed in, carrying one result (the signed-in shape is not captured live; it follows the parser's contract). */
const signedIn = signedOut.replace('"logged_in":false', '"logged_in":true').replace(
  '"results":[]',
  `"results":${JSON.stringify([
    { path: 'src/hooks.ts', repo_nwo: 'acme/app', ref_name: 'refs/heads/main', language_name: 'TypeScript', match_count: 2, line_number: 7, file_size: 90, commit_sha: 'abc', snippets: [{ lines: ['const [n, setN] = <em>useState</em>(0)'] }] },
  ])}`,
)

const run = (page: string, provider: ProviderConfig = code, query = QUERY): ReturnType<typeof networkSearch> => {
  const rec = recordingCapture(async () => body(page, { url: CODE_URL }))
  return networkSearch('ws://page', provider, query, {}, makeDeps({ capture: rec.capture }))
}

describe('591e1a7: login wall returns hitl login_required from the emptyRequiresLogin rule [search-port-engine.11]', () => {
  it('signed-out: the code-search page with zero results is outcome hitl with reason login_required, strategy network and count 0', async () => {
    const r = await run(signedOut)
    expect(r.outcome).toBe('hitl')
    expect(r.count).toBe(0)
    expect(r.results).toEqual([])
    expect(r.hitl?.reason).toBe('login_required')
    expect(r.hitl?.strategy).toBe('network')
    expect(r.hitl?.provider).toBe('github')
    expect(r.hitl?.query).toBe(QUERY)
    expect(r.strategy).toBe('network')
  })

  it('return_to: the hitl pageUrl is the GitHub login whose decoded return_to is the code-search url', async () => {
    const r = await run(signedOut)
    const pageUrl = r.hitl?.pageUrl ?? ''
    expect(pageUrl.startsWith('https://github.com/login?return_to=')).toBe(true)
    expect(decodeURIComponent(pageUrl.slice('https://github.com/login?return_to='.length))).toBe(CODE_URL)
    expect(pageUrl).toBe(code.network?.emptyRequiresLogin?.loginUrl?.(CODE_URL))
  })

  it('emptyRequiresLogin: the error carries the rule text, which mentions the signed-in session', async () => {
    const r = await run(signedOut)
    expect(r.error).toBe(`Login required: ${code.network?.emptyRequiresLogin?.error}`)
    expect(r.error).toMatch(/signed-in/)
  })

  it('signed-in: the same page with logged_in true returns its results', async () => {
    const r = await run(signedIn)
    expect(r.outcome).toBe('success')
    expect(r.count).toBe(1)
    expect(r.results[0]).toMatchObject({ title: 'src/hooks.ts', url: 'https://github.com/acme/app/blob/main/src/hooks.ts' })
    expect(r.hitl).toBeUndefined()
  })

  it('emptyRequiresLogin applies only when zero results parsed: a logged_in false page that still has results is success', async () => {
    const withResults = signedIn.replace('"logged_in":true', '"logged_in":false')
    const r = await run(withResults)
    expect(r.outcome).toBe('success')
    expect(r.count).toBe(1)
  })

  it('emptyRequiresLogin: repo-search.html never matches the rule (repositories carry no wall) and returns its two repos', async () => {
    expect(code.network?.emptyRequiresLogin?.pattern.test(repoPage)).toBe(false)
    const rec = recordingCapture(async () => body(repoPage, { url: 'https://github.com/search?q=vite&type=repositories' }))
    const r = await networkSearch('ws://page', fallbackView(github), 'vite', {}, makeDeps({ capture: rec.capture }))
    expect(r.outcome).toBe('success')
    expect(r.count).toBe(2)
    expect(r.results[0]?.title).toBe('vitejs/vite')
    expect(r.hitl).toBeUndefined()
  })

  it('emptyRequiresLogin: a rule without loginUrl keeps the window on the captured page url', async () => {
    const network = { ...code.network, urlPattern: code.network?.urlPattern ?? '', parser: 'embedded-json' as const, resultSelector: code.network?.resultSelector ?? '', fields: code.network?.fields ?? { title: '', url: '', snippet: '' }, emptyRequiresLogin: { pattern: /"logged_in":false/, error: 'sign in' } }
    const rec = recordingCapture(async () => body(signedOut, { url: CODE_URL }))
    const r = await networkSearch('ws://page', { ...code, network }, QUERY, {}, makeDeps({ capture: rec.capture }))
    expect(r.outcome).toBe('hitl')
    expect(r.hitl?.pageUrl).toBe(CODE_URL)
  })
})

describe('591e1a7: loginWallResponse is a pure shape [search-port-engine.11]', () => {
  it('loginWallResponse builds hitl login_required with the page url, query, provider and took time', () => {
    const pageUrl = 'https://github.com/login?return_to=x'
    const r = loginWallResponse(github, 'q', pageUrl, 'sign in to search code', 42)
    expect(r).toMatchObject({ provider: 'github', query: 'q', count: 0, results: [], outcome: 'hitl', error: 'Login required: sign in to search code', tookMs: 42, attempts: 1, strategy: 'network' })
    expect(r.hitl).toMatchObject({ pageUrl, reason: 'login_required', provider: 'github', query: 'q', strategy: 'network' })
    expect(Number.isNaN(Date.parse(r.hitl?.trippedAt ?? ''))).toBe(false)
  })
})
