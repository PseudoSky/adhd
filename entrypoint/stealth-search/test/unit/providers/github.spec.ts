/**
 * guards: the github provider misroutes repository search, mis-reports the signed-out login wall, or maps rate limits to anything other than rate_limited
 * tier: S
 * cites: ticket 8468f7b1 [search-port-providers.9] [search-port-providers.5]
 * The github provider over real captured pages (test fixtures copied byte-for-byte from the source
 * runner): repository search is API-primary with the rendered page (embedded JSON) as fallbackNetwork,
 * type:code is a network-only override that reports the signed-out login wall as login_required, and a
 * rate-limit response returns rate_limited. Inventory rows [I-22.a], [I-10.a].
 * Ticket 8468f7b1 · [search-port-providers.9] [search-port-providers.5]
 * · backlog 861571da, 224e7a44 · commits 591e1a7, c00edea.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { capture, parsers } from '@adhd/stealth-core-browser'
import { getProvider } from '../../../src/lib/providers.js'
import { fallbackView, resolveProvider } from '../../../src/lib/utils.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string => readFileSync(join(here, '..', '..', 'fixtures', 'providers', 'github', name), 'utf8')

const github = getProvider('github')
const repoBody = fixture('repo-search.html')
const codeBody = fixture('code-search-signed-out.html')
const codeProvider = resolveProvider(github, 'useState type:code')
const codeNetwork = codeProvider.network
if (!codeNetwork?.emptyRequiresLogin) throw new Error('type:code override has no network config or emptyRequiresLogin rule')
const wall = codeNetwork.emptyRequiresLogin

describe('github API primary with embedded-json fallback: repositories (861571da, 591e1a7) [search-port-providers.9]', () => {
  it('repositories: the primary network is the direct public REST fetch (api.github.com/search/repositories, no browser)', () => {
    expect(github.network?.directFetch).toBe(true)
    expect(github.network?.urlPattern).toBe('api.github.com/search/repositories')
    expect(github.network?.apiUrl).toBe('https://api.github.com/search/repositories?q=')
    expect(github.strategies).toEqual({ primary: 'network', fallback: 'network' })
    expect(github.url('vite')).toBe('https://github.com/search?q=vite&type=repositories')
  })

  it('fallbackNetwork is an embedded-json capture on github.com/search reading react-app.embeddedData', () => {
    const fb = github.fallbackNetwork
    expect(fb?.parser).toBe('embedded-json')
    expect(fb?.dataTarget).toBe('react-app.embeddedData')
    expect(fb?.resultSelector).toBe('payload.blackbirdSearchRoute.results')
    expect(new RegExp(fb?.urlPattern ?? '').test('https://github.com/search?q=vite&type=repositories')).toBe(true)
    expect(fallbackView(github).network).toBe(fb)
  })

  it('fallbackNetwork extracts the two-repo page: vitejs/vite first, stars 83351, language TypeScript', () => {
    const fb = github.fallbackNetwork
    if (!fb) throw new Error('fallbackNetwork missing')
    const r = parsers.extractResultsFromEmbeddedJson(repoBody, fb)
    expect(r).toHaveLength(2)
    expect(r[0]?.title).toBe('vitejs/vite')
    expect(r[0]?.url).toBe('https://github.com/vitejs/vite')
    expect(r[0]?.snippet).toBe("Next generation frontend tooling. It's fast!")
    expect(r[0]?.meta?.['stars']).toBe('83351')
    expect(r[0]?.meta?.['language']).toBe('TypeScript')
    expect(r[0]?.meta?.['updated']?.startsWith('2026-')).toBe(true)
  })

  it('fallbackNetwork decodes entities in snippets and strips highlight markup from titles', () => {
    const fb = github.fallbackNetwork
    if (!fb) throw new Error('fallbackNetwork missing')
    const decoded = parsers.extractResultsFromEmbeddedJson(repoBody.replace("Next generation frontend tooling. It's fast!", 'Vite &amp; Vue &lt;tools&gt;'), fb)
    expect(decoded[0]?.snippet).toBe('Vite & Vue <tools>')
    for (const r of parsers.extractResultsFromEmbeddedJson(repoBody, fb)) expect(r.title).not.toMatch(/<\/?em>/)
  })

  it('repositories: github has no dom config and no dom strategy (class names rot)', () => {
    expect(github.dom).toBeUndefined()
    expect(github.strategies.primary).not.toBe('dom')
    expect(github.strategies.fallback).not.toBe('dom')
  })

  it('sharedProfile: the repository provider searches in an isolated context', () => {
    expect(github.sharedProfile).toBeUndefined()
  })
})

describe('type:code login wall: login_required, never a silent empty (224e7a44, 591e1a7) [search-port-providers.9]', () => {
  it('type:code resolves to a network-only override: no fallback, no dom, no fallbackNetwork, sharedProfile true, snippetLines 5, extraWaitMs 500', () => {
    expect(codeProvider.strategies).toEqual({ primary: 'network' })
    expect(codeProvider.strategies.fallback).toBeUndefined()
    expect(codeProvider.dom).toBeUndefined()
    expect(codeProvider.fallbackNetwork).toBeUndefined()
    expect(codeProvider.sharedProfile).toBe(true)
    expect(codeProvider.network?.snippetLines).toBe(5)
    expect(codeProvider.network?.extraWaitMs).toBe(500)
    expect(codeProvider.network?.resultSelector).toBe(github.fallbackNetwork?.resultSelector)
    expect(codeProvider.url('useState type:code')).toMatch(/type=code$/)
  })

  it('login wall: the signed-out code page yields zero results and matches the emptyRequiresLogin rule', () => {
    expect(parsers.extractResultsFromEmbeddedJson(codeBody, codeNetwork)).toHaveLength(0)
    expect(wall.pattern.test(codeBody)).toBe(true)
    expect(wall.error).toMatch(/signed-in/)
  })

  it('login wall: loginUrl(returnTo) is the GitHub login with the encoded search URL as return_to (login_required window)', () => {
    const back = 'https://github.com/search?q=useState&type=code'
    const url = wall.loginUrl?.(back) ?? ''
    expect(url).toBe(`https://github.com/login?return_to=${encodeURIComponent(back)}`)
    expect(decodeURIComponent(url.split('return_to=')[1] ?? '')).toBe(back)
  })

  it('login wall: a signed-in variant of the fixture (logged_in true) and the repositories page never match the rule', () => {
    expect(wall.pattern.test(codeBody.replace('"logged_in":false', '"logged_in":true'))).toBe(false)
    expect(wall.pattern.test(repoBody)).toBe(false)
  })

  it('login_required: a signed-in result maps path, repo, language and snippet', () => {
    const body = `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
      payload: { blackbirdSearchRoute: { type: 'code', logged_in: true, results: [{
        path: 'src/a.ts', repo_nwo: 'o/r', ref_name: 'refs/heads/main', language_name: 'TypeScript',
        match_count: 2, line_number: 3, file_size: 10, commit_sha: 'abc',
        snippets: [{ lines: ['const <em>useState</em> = 1'] }],
      }] } },
    })}</script>`
    const r = parsers.extractResultsFromEmbeddedJson(body, codeNetwork)
    expect(r).toHaveLength(1)
    expect(r[0]?.title).toBe('src/a.ts')
    expect(r[0]?.url).toBe('https://github.com/o/r/blob/main/src/a.ts')
    expect(r[0]?.snippet).toBe('const useState = 1')
    expect(r[0]?.meta?.['repo']).toBe('o/r')
    expect(r[0]?.meta?.['language']).toBe('TypeScript')
  })

  it('login_required: a redirect to /login/ is also a login_required ban signal on the repository provider', () => {
    expect(capture.checkBans(github.bans, { url: 'https://github.com/login/?return_to=x', status: 200, body: '' })).toBe('login_required')
  })
})

describe('rate_limited: a rate-limit response is a typed outcome (861571da, c00edea) [search-port-providers.9]', () => {
  it('rate_limited: HTTP 429 and HTTP 403 from the GitHub API are rate_limited; a 200 is not', () => {
    const api = 'https://api.github.com/search/repositories?q=vite'
    expect(capture.checkBans(github.bans, { url: api, status: 429, body: '{"message":"API rate limit exceeded"}' })).toBe('rate_limited')
    expect(capture.checkBans(github.bans, { url: api, status: 403, body: '{"message":"rate limit"}' })).toBe('rate_limited')
    expect(capture.checkBans(github.bans, { url: api, status: 200, body: '{"items":[]}' })).toBeNull()
  })
  it('rate_limited: the retry policy backs off on a rate limit rather than hanging (2 attempts, retry)', () => {
    expect(github.retry).toMatchObject({ maxAttempts: 2, onRateLimit: 'retry', onTimeout: 'retry' })
  })
})
