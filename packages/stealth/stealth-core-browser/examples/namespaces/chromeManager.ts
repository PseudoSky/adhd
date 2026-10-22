/**
 * Scenario: safe-to-close-report -- a long-lived host wants to know whether its Chrome is safe to close:
 * which open tabs count as real web pages, what the manager reports about the
 * reaper and the launch breaker, and how long a soft reap may take.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { chromeManager } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port of the managed Chrome. */
  port?: number
  /** Private state directory of this manager (default: a per-port directory under the OS temp dir). */
  stateDir?: string
  /** URLs of the open tabs to classify. */
  tabUrls?: string[]
}

export interface ManagerReport {
  /** Tabs that keep Chrome alive: http(s) documents only. */
  pinningTabs: string[]
  /** The soft-reap answer deadline in ms. */
  reapTimeoutMs: number
  ready: boolean
  /** Open http(s) pages as the manager sees them, or 'unreachable'. */
  httpPages: number | 'unreachable'
  breakerOpen: boolean
}

export async function run({ host = '127.0.0.1', port = 9333, stateDir, tabUrls = [] }: RunOptions = {}): Promise<ManagerReport> {
  const manager = new chromeManager.ChromeManager({
    cdpHost: `${host}:${port}`,
    keepAlive: true,
    stateDir,
    logger: () => undefined,
  })
  const status = await manager.status()
  return {
    pinningTabs: tabUrls.filter((url) => chromeManager.isActiveWebTarget(url)),
    reapTimeoutMs: chromeManager.REAP_IF_IDLE_TIMEOUT_MS,
    ready: status.ready,
    httpPages: status.httpPages,
    breakerOpen: status.breaker.open,
  }
}
