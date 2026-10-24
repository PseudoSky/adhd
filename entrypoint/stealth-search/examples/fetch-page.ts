/**
 * Example: read a URL as markdown, window by window.
 *
 * The `fetch` provider renders the page in Chrome and returns it as markdown. `content: 'full'`
 * returns a window of `maxContentSize` bytes; the `nextOffset` of one result is the `offset` of the
 * next call. Ticket 8468f7b1 · [search-examples.1]
 */
import type { ExampleDeps } from './types.js'

/** Run the example against the injected operations; returns the whole document. */
export async function run({ api }: ExampleDeps): Promise<string> {
  let document = ''
  let offset = 0
  for (let guard = 0; guard < 50; guard += 1) {
    const out = await api.search({
      provider: 'fetch',
      query: 'https://example.com/docs/getting-started',
      content: 'full',
      offset,
      maxContentSize: 20_000,
    })
    if (out.outcome !== 'success') return `fetch: ${out.outcome}`
    document += out.content ?? ''
    if (out.nextOffset === undefined) break
    offset = out.nextOffset
  }
  return document
}
