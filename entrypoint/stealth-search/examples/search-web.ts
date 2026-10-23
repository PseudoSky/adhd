/**
 * Example: search the web with a provider and print the hits.
 *
 * `search` returns outcomes as data (`success`, `empty`, `hitl`, ...), so the example branches on
 * `outcome` instead of catching an exception. Ticket 8468f7b1 · [search-examples.1]
 */
import type { ExampleDeps } from './types.js'

/** Run the example against the injected operations; returns the printed text. */
export async function run({ api }: ExampleDeps): Promise<string> {
  const out = await api.search({
    provider: 'duckduckgo',
    query: 'headless chrome detection',
    qualifier: 'site:developer.chrome.com',
    strategy: 'auto',
    timeoutMs: 30_000,
  })
  if (out.outcome !== 'success') return `${out.provider}: ${out.outcome}${out.error ? ` (${out.error})` : ''}`
  return out.results.map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}`).join('\n')
}
