/**
 * Example: discover the providers, then read one provider's guide.
 *
 * `listProviders` names every provider and its strategies; `describeProvider` adds the qualifier
 * syntax and the ban signals worth knowing before the first search. Ticket 8468f7b1 ·
 * [search-examples.1]
 */
import type { ExampleDeps } from './types.js'

/** Run the example against the injected operations; returns the printed text. */
export async function run({ api }: ExampleDeps): Promise<string> {
  const { providers } = await api.listProviders()
  const lines = providers.map((p) => `${p.id}: ${p.strategies.join(', ')}`)
  const github = await api.describeProvider({ provider: 'github' })
  lines.push('', `${github.name} qualifiers:`, ...github.qualifierExamples.map((q) => `  ${q}`))
  return lines.join('\n')
}
