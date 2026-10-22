/**
 * Scenario: start (or reuse) a hidden stealth Chrome on a dedicated debugging
 * port, with its own profile directory, before a job drives it. Calling it twice
 * is safe: a Chrome that is already running is reused.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { launchChrome, type LaunchChromeResult } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** CDP remote-debugging port to start Chrome on. */
  port?: number
  /** Dedicated Chrome user data directory (default: the library's CDP profile). */
  userDataDir?: string
  /** Where progress lines go (default console.log). */
  log?: (line: string) => void
}

export async function run({ port = 9333, userDataDir, log = console.log }: RunOptions = {}): Promise<LaunchChromeResult> {
  const result = await launchChrome({ port, userDataDir })
  log(`Chrome is ready on port ${result.port}${userDataDir ? ` with profile ${userDataDir}` : ''}`)
  return result
}
