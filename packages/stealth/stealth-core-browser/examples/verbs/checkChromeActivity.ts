/**
 * Scenario: before an automation job touches the shared Chrome, check that a
 * human is not actively browsing in it: no open web pages and no history visit
 * within the last few minutes.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { checkChromeActivity, type ChromeActivityReport } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port of the controlled Chrome. */
  port?: number
  /** A visit newer than this many minutes counts as recent use. */
  withinMinutes?: number
  /** Where progress lines go (default console.log). */
  log?: (line: string) => void
}

export interface ActivityDecision {
  /** True when no web page is open and nothing was visited recently. */
  safeToProceed: boolean
  report: ChromeActivityReport
}

export async function run({ host = '127.0.0.1', port = 9333, withinMinutes = 2, log = console.log }: RunOptions = {}): Promise<ActivityDecision> {
  const report = await checkChromeActivity({ host, port, withinMinutes })
  const safeToProceed = report.activePages === 0 && !report.recentlyUsed
  log(
    safeToProceed
      ? 'Chrome looks idle: safe to start the job'
      : `Chrome is in use (${report.activePages} open web pages, last visit ${report.lastVisit?.visitTime ?? 'never'}): wait`,
  )
  return { safeToProceed, report }
}
