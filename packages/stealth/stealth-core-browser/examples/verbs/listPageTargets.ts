/**
 * Scenario: find the target id of the tab a person left open on a given site, so
 * a follow-up call can inspect that exact page instead of opening a new one.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { listPageTargets, type PageTarget } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port of the controlled Chrome. */
  port?: number
  /** Keep only tabs whose URL contains this text. */
  urlIncludes?: string
  /** Where progress lines go (default console.log). */
  log?: (line: string) => void
}

export async function run({ host = '127.0.0.1', port = 9333, urlIncludes, log = console.log }: RunOptions = {}): Promise<PageTarget[]> {
  const { targets } = await listPageTargets({ host, port })
  const matching = urlIncludes ? targets.filter((t) => t.url.includes(urlIncludes)) : targets
  for (const tab of matching) log(`${tab.id}  ${tab.url}`)
  return matching
}
