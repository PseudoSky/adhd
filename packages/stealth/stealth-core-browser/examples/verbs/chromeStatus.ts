/**
 * Scenario: preflight-status-check -- before a scraping job starts, find out whether the dedicated Chrome
 * already answers on its debugging port (and which version), so the job can
 * decide between reusing it and launching a fresh one.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { chromeStatus, type ChromeStatus } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port of the dedicated Chrome. */
  port?: number
  /** Where progress lines go (default console.log). */
  log?: (line: string) => void
}

export async function run({ host = '127.0.0.1', port = 9333, log = console.log }: RunOptions = {}): Promise<ChromeStatus> {
  const status = await chromeStatus({ host, port })
  if (status.running) {
    log(`Chrome ${status.version ?? 'unknown'} (protocol ${status.protocol ?? 'unknown'}) is up on port ${port}; managed by this process: ${status.managed}`)
  } else {
    log(`nothing answers on port ${port}: launch Chrome before the job starts`)
  }
  return status
}
