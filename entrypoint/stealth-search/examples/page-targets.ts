/**
 * Example: list the open pages and read the context of one.
 *
 * `listPageTargets` returns the pages of the controlled Chrome; `getPageContext` returns the url,
 * title, cookie count and history of one target without evaluating script in it. Ticket 8468f7b1 ·
 * [search-examples.1]
 */
import type { ExampleDeps } from './types.js'

/** Run the example against the injected operations; returns the printed text. */
export async function run({ api }: ExampleDeps): Promise<string> {
  const { targets } = await api.listPageTargets({ port: 9333 })
  const page = targets.find((t) => t.type === 'page')
  if (!page) return 'no open page'
  const { found, context } = await api.getPageContext({ port: 9333, targetId: page.id })
  if (!found || !context) return `${page.id} closed meanwhile`
  return `${context.title} <${context.url}> cookies=${context.cookieCount} visits=${context.historyVisits}`
}
