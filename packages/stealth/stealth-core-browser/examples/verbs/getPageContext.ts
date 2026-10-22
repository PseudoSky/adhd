/**
 * Scenario: describe-an-open-tab -- given the target id of an open tab, describe the page a person is
 * looking at (URL, title, how many cookies the profile holds for its host, how
 * often it appears in history) without ever reading cookie values.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { getPageContext, type PageContextResult } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** Target id of the tab, as returned by the page-target listing. */
  targetId: string
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port of the controlled Chrome. */
  port?: number
  /** Where progress lines go (default console.log). */
  log?: (line: string) => void
}

export async function run({ targetId, host = '127.0.0.1', port = 9333, log = console.log }: RunOptions): Promise<PageContextResult> {
  const result = await getPageContext({ targetId, host, port })
  if (!result.context) {
    log(`tab ${targetId} no longer exists`)
    return result
  }
  const { url, title, cookieCount, historyVisits } = result.context
  log(`${title} <${url}>: ${cookieCount} cookies, ${historyVisits} history visits`)
  return result
}
