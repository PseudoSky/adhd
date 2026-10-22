/**
 * @adhd/stealth-search — src/lib/utils.ts
 *
 * Shared search utilities: qualifier handling, the GitHub code-search override and the
 * fallback-capture view.
 *
 * Inventory rows: I-10 (qualifier prepend; github `type:code` resolves to the code-search
 * configuration), I-10.a (resolveProvider and fallbackView: the code override carries
 * sharedProfile and no dom; a second network strategy runs against fallbackNetwork).
 * Ticket 8468f7b1 · plan state search-port-providers · commit 591e1a7.
 */
import type { ProviderConfig } from './types.js'

/**
 * Strip the `type:code` qualifier from a query. Used to turn a GitHub search query into a
 * code-search URL.
 */
export function stripTypeCode(query: string): string {
  return query.replace(/\btype:code\b/, '').replace(/\s+/g, ' ').trim()
}

/**
 * Prepend a qualifier (`repo:owner/name`, `site:example.com`) to a query. An empty qualifier
 * leaves the query alone. The `fetch` provider's query IS a URL, so a qualifier is never
 * prepended there (it would corrupt the URL).
 */
export function applyQualifier(provider: ProviderConfig, qualifier: string, query: string): string {
  if (provider.strategies.primary === 'fetch' || qualifier.trim() === '') return query
  return `${qualifier.trim()} ${query}`
}

/**
 * The provider view the FALLBACK 'network' strategy runs against: `fallbackNetwork` becomes the
 * `network` config when the provider defines one (GitHub: the rendered search page), otherwise
 * the provider itself.
 */
export function fallbackView(p: ProviderConfig): ProviderConfig {
  return p.fallbackNetwork ? { ...p, network: p.fallbackNetwork } : p
}

/**
 * Resolve the effective provider config for a query.
 *
 * A GitHub query carrying `type:code` resolves to the code-search override: the search page
 * whose results ride in the `react-app.embeddedData` JSON island at
 * `payload.blackbirdSearchRoute.results`. Code search requires a signed-in session: a
 * signed-out page carries `logged_in:false` and zero results, which `emptyRequiresLogin`
 * reports as `login_required`. Every other provider and query returns the provider itself.
 */
export function resolveProvider(p: ProviderConfig, fullQuery: string): ProviderConfig {
  if (p.id === 'github' && /\btype:code\b/.test(fullQuery)) {
    // The override is network-only: no dom config, no fallback strategy, no fallbackNetwork.
    const base: ProviderConfig = { ...p }
    delete base.fallbackNetwork
    delete base.dom
    return {
      ...base,
      url: (q) => `https://github.com/search?q=${encodeURIComponent(stripTypeCode(q))}&type=code`,
      strategies: { primary: 'network' },
      network: {
        urlPattern: 'github.com/search',
        parser: 'embedded-json',
        resultSelector: 'payload.blackbirdSearchRoute.results',
        fields: {
          title: 'path',
          url: 'path',
          snippet: '',
          meta: {
            repo: 'repo_nwo',
            language: 'language_name',
            matches: 'match_count',
            line: 'line_number',
            file_size: 'file_size',
            branch: 'ref_name',
            commit: 'commit_sha',
          },
        },
        dataTarget: 'react-app.embeddedData',
        snippetLines: 5,
        extraWaitMs: 500,
        emptyRequiresLogin: {
          pattern: /"type":"code"[\s\S]*?"logged_in":false/,
          error: 'GitHub code search requires a signed-in GitHub session; the signed-out search page has no results.',
          loginUrl: (returnTo) => `https://github.com/login?return_to=${encodeURIComponent(returnTo)}`,
        },
      },
      // Signed-in results live in the profile session, so search in the shared profile.
      sharedProfile: true,
    }
  }
  return p
}
