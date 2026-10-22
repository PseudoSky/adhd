/**
 * Scenario: when a job finishes, ask the managed Chrome to close, but only if it
 * is genuinely idle. A person's open tab or another session keeps it alive, and
 * the result says whether Chrome is still running so the caller can tell.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { shutdownChrome, type ShutdownChromeResult } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port of the managed Chrome. */
  port?: number
  /** Where progress lines go (default console.log). */
  log?: (line: string) => void
}

export async function run({ host = '127.0.0.1', port = 9333, log = console.log }: RunOptions = {}): Promise<ShutdownChromeResult> {
  const result = await shutdownChrome({ host, port })
  log(result.running ? `Chrome on port ${port} is still in use and was left running` : `Chrome on port ${port} was shut down`)
  return result
}
