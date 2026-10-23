/**
 * Example: see which providers are blocked and clear one after solving the wall by hand.
 *
 * A CAPTCHA, rate limit or ban trips a per-provider guard that refuses further searches until its
 * TTL ends or a human clears it. `tripwireStatus` lists the tripped providers; `clearTripwire`
 * resets one. Ticket 8468f7b1 · [search-examples.1]
 */
import type { SearchProvider } from '../src/api.js'
import type { ExampleDeps } from './types.js'

/** Run the example against the injected operations; returns the printed text. */
export async function run({ api }: ExampleDeps): Promise<string> {
  const tripped = await api.tripwireStatus()
  const lines: string[] = []
  for (const [provider, record] of Object.entries(tripped)) {
    lines.push(`${provider}: ${record.reason} until ${record.expiresAt} (${record.blockedCount} refused)`)
    const cleared = await api.clearTripwire({ provider: record.provider as SearchProvider })
    lines.push(cleared.cleared ? `  cleared ${cleared.provider}` : `  ${cleared.provider} was not tripped`)
  }
  return lines.length > 0 ? lines.join('\n') : 'no provider is blocked'
}
